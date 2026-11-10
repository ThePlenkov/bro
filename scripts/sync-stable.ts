/**
 * sync-stable — merge `main` (the remote-tracking `origin/main` when it
 * exists) into the local `stable` branch, but only if the whole
 * verification suite is green.
 *
 * `stable` is the branch that proves a `main` sync did not silently break the
 * plugin/integration. The rule: `stable` only advances when every check
 * passes. A red suite leaves `stable` at its previous good commit — the
 * merge never lands on the branch.
 *
 *   node scripts/sync-stable.ts --sync           # merge + verify + advance stable
 *   node scripts/sync-stable.ts --sync --dry-run # plan only — mutates nothing
 *   node scripts/sync-stable.ts --sync --push    # also push stable to its remote
 *
 * How the safety works: the merge happens on a throwaway branch
 * (`bro/stable-sync-<stamp>`) checked out in THIS worktree, so the checks run
 * against the merged tree while `stable` itself is untouched. Only a green
 * suite moves the `stable` ref onto the merge commit (compare-and-swap, so
 * it never clobbers a `stable` that moved meanwhile); a red suite drops the
 * throwaway branch and leaves `stable` exactly where it was.
 *
 * Preflight is strict on purpose: a dirty worktree aborts before anything
 * moves — nobody else's uncommitted work is ever stashed, reset, or
 * discarded.
 *
 * No network writes happen unless `--push` is passed, and the push is a
 * plain (never forced) `git push`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Exit codes — 0 green, 1 a check failed, 2 usage, 3 preflight/merge. */
const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_PREFLIGHT = 3;

interface Check {
  /** the label printed in the summary and the failing-check report */
  name: string;
  /** argv passed to npm */
  args: string[];
}

/**
 * The verification set — the hermetic steps CI runs, in CI's order
 * (.github/workflows/ci.yml). `check:onboarding` is left out on purpose:
 * it installs from the npm registry, so it is a network check, not a
 * hermetic one. The hook latency baseline is a benchmark, not a gate.
 *
 * `test:e2e` is the one flaky target (nx reports it as such — a green
 * rerun after a red one). `--skip-e2e` is the escape hatch for a known
 * flake; without it, a red e2e keeps `stable` where it is, which is the
 * point of the gate.
 */
const CHECKS: Check[] = [
  { name: 'check:plugins', args: ['run', 'check:plugins'] },
  { name: 'check:docs', args: ['run', 'check:docs'] },
  { name: 'build', args: ['run', 'build'] },
  { name: 'check:embedded', args: ['run', 'check:embedded'] },
  { name: 'check:command-docs', args: ['run', 'check:command-docs'] },
  { name: 'check:contract', args: ['run', 'check:contract'] },
  { name: 'check:config-schema', args: ['run', 'check:config-schema'] },
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'test', args: ['test'] },
  { name: 'test:e2e', args: ['run', 'test:e2e'] },
];

/** The flaky target — skipped only when the operator says so. */
const FLAKY_CHECK = 'test:e2e';

function usage(): string {
  return [
    'sync-stable — merge main into stable, but only when every check passes',
    '',
    'Usage: node scripts/sync-stable.ts --sync [--dry-run] [--push] [--skip-e2e]',
    '',
    'Options:',
    '  --sync      run the sync (merge + verify + advance stable)',
    '  --dry-run   print the plan (commits to merge, checks to run) and exit',
    '  --push      push stable to its remote after a green run (never forced)',
    '  --skip-e2e  skip the flaky test:e2e target (escape hatch, logged)',
    '  --help      print this text and exit',
    '',
    'Only --sync mutates anything; without it the script prints this text.',
    'Without --push the sync never touches the network: the merge and the',
    'checks are local, and stable advances only when all checks pass.',
  ].join('\n');
}

interface Options {
  sync: boolean;
  dryRun: boolean;
  push: boolean;
  skipE2e: boolean;
  help: boolean;
}

/** An option the script does not know — the caller prints the usage
 *  and exits with the usage code. */
export class UnknownOption extends Error {
  constructor(arg: string) {
    super(`unknown option ${arg}`);
    this.name = 'UnknownOption';
  }
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { sync: false, dryRun: false, push: false, skipE2e: false, help: false };
  for (const arg of argv) {
    const set = OPTIONS[arg];
    // the caller prints the usage — a parse that exits would take the
    // whole process with it (a test importing this module would die on
    // an unknown option)
    if (set === undefined) {
      throw new UnknownOption(arg);
    }
    set(opts);
  }
  return opts;
}

/** The option table — one entry per flag, so the parse stays a table
 *  walk instead of a branch per flag. */
const OPTIONS: Record<string, (opts: Options) => void> = {
  '--sync': o => {
    o.sync = true;
  },
  '--dry-run': o => {
    o.dryRun = true;
  },
  '--push': o => {
    o.push = true;
  },
  '--skip-e2e': o => {
    o.skipE2e = true;
  },
  '--help': o => {
    o.help = true;
  },
  '-h': o => {
    o.help = true;
  },
};

interface GitResult {
  ok: boolean;
  code: number;
  out: string;
}

/** git in this repo — stdout trimmed, stderr inherited so the operator sees
 *  what git said (merge conflicts, refused pushes, …). */
function git(args: string[]): GitResult {
  const proc = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const code = proc.status === null ? -1 : proc.status;
  return { ok: code === 0, code, out: (proc.stdout ?? '').trim() };
}

/** npm without a PATH lookup: the npm CLI is a node script, so it is run by
 *  this process' node — the same trick scripts/check-pack.ts uses. Falls
 *  back to `npm` on PATH when the CLI path is unknown. */
function npmArgv(args: string[]): { cmd: string; argv: string[] } {
  const candidates = [
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  ];
  const cli = candidates.find(c => existsSync(c));
  return cli === undefined
    ? { cmd: 'npm', argv: args }
    : { cmd: process.execPath, argv: [cli, ...args] };
}

/** One check — inherits stdio so the operator watches the real output. */
function runCheck(check: Check): boolean {
  const { cmd, argv } = npmArgv(check.args);
  console.log(`\n=== sync-stable: ${check.name} ===`);
  const proc = spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit' });
  return proc.status === 0;
}

function head(ref: string): string | undefined {
  const res = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return res.ok ? res.out : undefined;
}

/** The ref the sync follows — the remote-tracking `origin/main` when it
 *  exists, else the local `main`.
 *
 *  A canary that tracks a STALE local `main` proves nothing: the local
 *  branch is where a forgotten checkout lives, and `origin/main` is what
 *  CI just merged. The local branch is the fallback for a repo with no
 *  remote — a local-only clone still gets a working canary. */
function mainRef(): string | undefined {
  return head('origin/main') ?? head('main');
}

function currentBranch(): string {
  const res = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return res.ok ? res.out : '';
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The remote `stable` tracks — its configured remote, else origin. */
function stableRemote(): string {
  const res = git(['config', '--get', 'branch.stable.remote']);
  return res.ok && res.out !== '' ? res.out : 'origin';
}

/** Another worktree may have `stable` checked out — moving the ref under
 *  it would leave that worktree pointing at a commit it no longer has.
 *  Refuse instead; the operator picks a quiet moment. */
function stableCheckedOutElsewhere(): boolean {
  const res = git(['worktree', 'list', '--porcelain']);
  if (!res.ok) {
    return false;
  }
  let current = '';
  for (const line of res.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch ') && line.slice('branch '.length).trim() === 'refs/heads/stable') {
      // both sides are canonicalised: git reports the path as the
      // filesystem gave it, ROOT is built by join() — a raw comparison
      // would refuse the main worktree over a trailing slash
      return resolve(current) !== resolve(ROOT);
    }
  }
  return false;
}

/** The plan — the refs the sync works on and the checks it will run.
 *  Read-only: nothing moves while a plan is made. */
interface Plan {
  mainSha: string;
  stableSha: string;
  /** The commits main has that stable does not. */
  ahead: string;
  /** The commits stable has that main does not. */
  behind: string;
  checks: Check[];
}

/** The plan — read the two refs and count the commits between them.
 *  Exits when a ref is missing: there is nothing to sync against. */
function planOf(opts: Options): Plan {
  const mainSha = mainRef();
  if (mainSha === undefined) {
    console.error(
      'sync-stable: no `main` ref (neither origin/main nor a local main) — nothing to sync'
    );
    process.exit(EXIT_PREFLIGHT);
  }
  const stableSha = head('stable');
  if (stableSha === undefined) {
    console.error('sync-stable: no local `stable` branch — create it first:');
    console.error('sync-stable:   git branch stable main');
    process.exit(EXIT_PREFLIGHT);
  }
  return {
    mainSha,
    stableSha,
    ahead: git(['rev-list', '--count', `${stableSha}..${mainSha}`]).out || '0',
    behind: git(['rev-list', '--count', `${mainSha}..${stableSha}`]).out || '0',
    checks: opts.skipE2e ? CHECKS.filter(c => c.name !== FLAKY_CHECK) : CHECKS,
  };
}

/** The plan, printed — what the operator reads before deciding. */
function printPlan(plan: Plan, opts: Options): void {
  const source = head('origin/main') === plan.mainSha ? 'origin/main' : 'local main';
  console.log(`main    ${shortSha(plan.mainSha)}  (${source})`);
  console.log(`stable  ${shortSha(plan.stableSha)}`);
  console.log(`commits to merge from main: ${plan.ahead}`);
  const mergeList = git([
    'log',
    '--oneline',
    '--no-decorate',
    `${plan.stableSha}..${plan.mainSha}`,
  ]).out;
  if (mergeList !== '') {
    console.log(mergeList);
  }
  if (opts.skipE2e) {
    console.log(`\nnote: skipping ${FLAKY_CHECK} (--skip-e2e)`);
  }
  console.log('\nchecks to run:');
  for (const check of plan.checks) {
    console.log(`  - ${check.name}`);
  }
}

/** The preflight — the last read-only gate before anything moves. A
 *  dirty worktree aborts: the script never stashes, resets, or
 *  discards anyone's uncommitted work. */
function preflight(): void {
  if (git(['status', '--porcelain']).out !== '') {
    console.error('\nsync-stable: the worktree has uncommitted changes — commit them or stash');
    console.error('sync-stable: them yourself. This script never stashes or discards work.');
    process.exit(EXIT_PREFLIGHT);
  }
  if (stableCheckedOutElsewhere()) {
    console.error('\nsync-stable: `stable` is checked out in another worktree — advance it there');
    console.error('sync-stable: instead, so no session is left pointing at a moved branch.');
    process.exit(EXIT_PREFLIGHT);
  }
}

/** The throwaway branch the merge runs on, and the way back. */
interface Merge {
  /** The merge commit — what `stable` advances to. */
  sha: string;
  /** back to where we started, throwaway branch gone. */
  restore(): void;
}

/** Merge main into a throwaway branch in THIS worktree — the checks
 *  then run against the MERGED tree while `stable` itself is untouched. */
function mergeOnThrowaway(plan: Plan): Merge {
  const stamp = Date.now().toString(36);
  const tmpBranch = `bro/stable-sync-${stamp}`;
  const originalBranch = currentBranch();
  const originalSha = head('HEAD') as string;

  const created = git(['checkout', '-b', tmpBranch, plan.stableSha]);
  if (!created.ok) {
    console.error(`sync-stable: could not create the throwaway branch ${tmpBranch}`);
    process.exit(EXIT_PREFLIGHT);
  }

  /**
   * Back to where we started, throwaway branch gone.
   *
   * The checkout is NOT forced: the checks take minutes, and an edit
   * made in this worktree while they ran must never be discarded. A
   * plain checkout refuses to move when it would overwrite local
   * changes — and then the throwaway branch stays checked out, with
   * the operator's work intact, and the script says so.
   */
  const restore = (): void => {
    const back = git(['checkout', originalBranch === '' ? originalSha : originalBranch]);
    if (!back.ok) {
      console.error(
        `sync-stable: could not return to ${originalBranch || originalSha} — the worktree has ` +
          'changes made while the checks ran. They are NOT discarded: the throwaway branch ' +
          `${tmpBranch} is still checked out, and nothing was reset.`
      );
      console.error(
        'sync-stable: commit or stash them yourself, then delete the throwaway branch.'
      );
      return;
    }
    git(['branch', '-D', tmpBranch]);
  };

  console.log(`\nmerging main into ${tmpBranch} …`);
  const merge = git([
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    'chore(stable): merge main into stable',
    plan.mainSha,
  ]);
  if (!merge.ok) {
    console.error('sync-stable: the merge conflicted — stable is untouched.');
    git(['merge', '--abort']);
    restore();
    process.exit(EXIT_PREFLIGHT);
  }
  const sha = head('HEAD') as string;
  console.log(`merge commit ${shortSha(sha)}`);
  return { sha, restore };
}

/** Run the checks — the name of the first one that failed, or
 *  undefined when they all passed. */
function verify(checks: Check[]): string | undefined {
  for (const check of checks) {
    if (!runCheck(check)) {
      return check.name;
    }
  }
  return undefined;
}

/** Advance `stable` onto the merge commit — a compare-and-swap, so a
 *  `stable` that moved meanwhile is never clobbered. */
function advanceStable(mergeSha: string, stableSha: string): void {
  if (!git(['update-ref', 'refs/heads/stable', mergeSha, stableSha]).ok) {
    console.error('sync-stable: stable moved while the checks ran — refusing to overwrite it');
    process.exit(EXIT_PREFLIGHT);
  }
}

/** Push `stable` to its remote — plain, never forced. */
function pushStable(): void {
  const remote = stableRemote();
  console.log(`\npushing stable → ${remote} …`);
  if (!git(['push', remote, 'stable:stable']).ok) {
    console.error(
      'sync-stable: push failed — stable is advanced locally, the remote is unchanged.'
    );
    process.exit(EXIT_CHECK_FAILED);
  }
  console.log('push:     ok');
}

/** The options, or the usage and the exit — a parse that fails is a
 *  usage error, and the script says so in one place. */
function parseOrExit(argv: string[]): Options {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UnknownOption) {
      console.error(`sync-stable: ${err.message}`);
      console.error(usage());
      process.exit(EXIT_USAGE);
    }
    throw err;
  }
  if (opts.help || argv.length === 0) {
    console.log(usage());
    process.exit(EXIT_OK);
  }
  if (!opts.sync && !opts.dryRun) {
    console.error('sync-stable: --sync is required — it is the only mode that mutates anything.');
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  return opts;
}

/** The plan needs nothing done — a dry run, or `stable` already
 *  contains main. */
function planIsDone(plan: Plan, opts: Options): boolean {
  if (opts.dryRun) {
    console.log('\ndry run — nothing was merged, stable is untouched.');
    return true;
  }
  if (plan.ahead === '0') {
    console.log('\nstable already contains main — nothing to merge, stable unchanged.');
    return true;
  }
  return false;
}

/** The summary the operator reads at the end. */
function printSummary(plan: Plan): void {
  const newStable = head('stable') as string;
  console.log('\n=== sync-stable summary ===');
  console.log('branch:   stable');
  console.log(
    `commits:  ${plan.ahead} from main (${shortSha(plan.stableSha)} → ${shortSha(newStable)})`
  );
  console.log(`checks:   ${plan.checks.length}/${plan.checks.length} passed`);
  console.log(`stable:   ${shortSha(newStable)}`);
  if (plan.behind !== '0') {
    console.log(`note:     ${plan.behind} commit(s) on stable are not in main`);
  }
}

function main(): void {
  const opts = parseOrExit(process.argv.slice(2));
  if (git(['rev-parse', '--git-dir']).code !== 0) {
    console.error('sync-stable: not a git repository');
    process.exit(EXIT_PREFLIGHT);
  }

  // --- plan (read-only) ----------------------------------------------------
  const plan = planOf(opts);
  printPlan(plan, opts);
  if (planIsDone(plan, opts)) {
    process.exit(EXIT_OK);
  }

  // --- preflight (mutating from here on) -----------------------------------
  preflight();

  // --- merge, verify, advance ----------------------------------------------
  const merge = mergeOnThrowaway(plan);
  const failedCheck = verify(plan.checks);
  if (failedCheck !== undefined) {
    console.error(
      `\nsync-stable: check "${failedCheck}" failed — stable stays at ${shortSha(plan.stableSha)}`
    );
    merge.restore();
    console.error('sync-stable: the merge commit was dropped; nothing was pushed.');
    process.exit(EXIT_CHECK_FAILED);
  }
  advanceStable(merge.sha, plan.stableSha);
  // the throwaway branch is still checked out here — restore() puts us
  // back without forcing, so an edit made during the checks survives
  merge.restore();
  printSummary(plan);

  if (!opts.push) {
    console.log('push:     skipped (no --push)');
    process.exit(EXIT_OK);
  }
  pushStable();
  process.exit(EXIT_OK);
}

// the script runs when it IS the command — importing it (a test) does
// not touch a single ref
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

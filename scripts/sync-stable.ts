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
import { dirname, join } from 'node:path';
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
    switch (arg) {
      case '--sync':
        opts.sync = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--push':
        opts.push = true;
        break;
      case '--skip-e2e':
        opts.skipE2e = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        // the caller prints the usage — a parse that exits would take
        // the whole process with it (a test importing this module would
        // die on an unknown option)
        throw new UnknownOption(arg);
    }
  }
  return opts;
}

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
      return current !== ROOT;
    }
  }
  return false;
}

function main(): void {
  const argv = process.argv.slice(2);
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

  if (git(['rev-parse', '--git-dir']).code !== 0) {
    console.error('sync-stable: not a git repository');
    process.exit(EXIT_PREFLIGHT);
  }

  // --- plan (read-only) ----------------------------------------------------
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

  const ahead = git(['rev-list', '--count', `${stableSha}..${mainSha}`]).out || '0';
  const behind = git(['rev-list', '--count', `${mainSha}..${stableSha}`]).out || '0';
  const mergeList = git(['log', '--oneline', '--no-decorate', `${stableSha}..${mainSha}`]).out;
  const checks = opts.skipE2e ? CHECKS.filter(c => c.name !== FLAKY_CHECK) : CHECKS;

  console.log(
    `main    ${shortSha(mainSha)}  (${head('origin/main') === mainSha ? 'origin/main' : 'local main'})`
  );
  console.log(`stable  ${shortSha(stableSha)}`);
  console.log(`commits to merge from main: ${ahead}`);
  if (mergeList !== '') {
    console.log(mergeList);
  }
  if (opts.skipE2e) {
    console.log(`\nnote: skipping ${FLAKY_CHECK} (--skip-e2e)`);
  }
  console.log('\nchecks to run:');
  for (const check of checks) {
    console.log(`  - ${check.name}`);
  }

  if (opts.dryRun) {
    console.log('\ndry run — nothing was merged, stable is untouched.');
    process.exit(EXIT_OK);
  }

  if (ahead === '0') {
    console.log('\nstable already contains main — nothing to merge, stable unchanged.');
    process.exit(EXIT_OK);
  }

  // --- preflight (mutating from here on) -----------------------------------
  const dirty = git(['status', '--porcelain']).out;
  if (dirty !== '') {
    console.error('\nsync-stable: the worktree has uncommitted changes — commit them or stash');
    console.error('sync-stable: them yourself. This script never stashes or discards work.');
    process.exit(EXIT_PREFLIGHT);
  }
  if (stableCheckedOutElsewhere()) {
    console.error('\nsync-stable: `stable` is checked out in another worktree — advance it there');
    console.error('sync-stable: instead, so no session is left pointing at a moved branch.');
    process.exit(EXIT_PREFLIGHT);
  }

  // --- merge on a throwaway branch -----------------------------------------
  const stamp = Date.now().toString(36);
  const tmpBranch = `bro/stable-sync-${stamp}`;
  const originalBranch = currentBranch();
  const originalSha = head('HEAD') as string;

  const created = git(['checkout', '-b', tmpBranch, stableSha]);
  if (!created.ok) {
    console.error(`sync-stable: could not create the throwaway branch ${tmpBranch}`);
    process.exit(EXIT_PREFLIGHT);
  }

  /** back to where we started, throwaway branch gone */
  const restore = (): void => {
    git(['checkout', '--force', originalBranch === '' ? originalSha : originalBranch]);
    git(['branch', '-D', tmpBranch]);
  };

  console.log(`\nmerging main into ${tmpBranch} …`);
  const merge = git([
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    'chore(stable): merge main into stable',
    mainSha,
  ]);
  if (!merge.ok) {
    console.error('sync-stable: the merge conflicted — stable is untouched.');
    git(['merge', '--abort']);
    restore();
    process.exit(EXIT_PREFLIGHT);
  }
  const mergeSha = head('HEAD') as string;
  console.log(`merge commit ${shortSha(mergeSha)}`);

  // --- verify ---------------------------------------------------------------
  let failedCheck: string | undefined;
  for (const check of checks) {
    if (!runCheck(check)) {
      failedCheck = check.name;
      break;
    }
  }

  if (failedCheck !== undefined) {
    console.error(
      `\nsync-stable: check "${failedCheck}" failed — stable stays at ${shortSha(stableSha)}`
    );
    restore();
    console.error('sync-stable: the merge commit was dropped; nothing was pushed.');
    process.exit(EXIT_CHECK_FAILED);
  }

  // --- advance stable (compare-and-swap, fast-forward only) ----------------
  const advanced = git(['update-ref', 'refs/heads/stable', mergeSha, stableSha]);
  if (!advanced.ok) {
    console.error('sync-stable: stable moved while the checks ran — refusing to overwrite it');
    restore();
    process.exit(EXIT_PREFLIGHT);
  }
  git(['checkout', '--force', originalBranch === '' ? originalSha : originalBranch]);
  git(['branch', '-D', tmpBranch]);

  const newStable = head('stable') as string;
  console.log('\n=== sync-stable summary ===');
  console.log('branch:   stable');
  console.log(`commits:  ${ahead} from main (${shortSha(stableSha)} → ${shortSha(newStable)})`);
  console.log(`checks:   ${checks.length}/${checks.length} passed`);
  console.log(`stable:   ${shortSha(newStable)}`);
  if (behind !== '0') {
    console.log(`note:     ${behind} commit(s) on stable are not in main`);
  }

  if (!opts.push) {
    console.log('push:     skipped (no --push)');
    process.exit(EXIT_OK);
  }

  const remote = stableRemote();
  console.log(`\npushing stable → ${remote} …`);
  const push = git(['push', remote, 'stable:stable']);
  if (!push.ok) {
    console.error(
      'sync-stable: push failed — stable is advanced locally, the remote is unchanged.'
    );
    process.exit(EXIT_CHECK_FAILED);
  }
  console.log('push:     ok');
  process.exit(EXIT_OK);
}

// the script runs when it IS the command — importing it (a test) does
// not touch a single ref
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

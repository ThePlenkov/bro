/**
 * `bro debt <sub>` — review-debt pipeline commands.
 *
 *   collect [OWNER REPO] [filters]   collect findings from unprocessed merged PRs
 *   status                           ledger summary + unprocessed merged-PR count
 *   prs [--limit N] [--all]          unprocessed merged PRs (--all: full matrix)
 *   list [filters]                   ledger rows
 *   mark PR collected|clean|skipped|none
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  dataRefCommit,
  dataRefPush,
  dataRefRoot,
  ensureAuth,
  facadeAuth,
  hasHelpFlag,
  reviewHost,
} from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import { parseCollectArgs, readOption, usage } from './debt-args.ts';
import { collectReviewThreads } from './debt-scan.ts';
import { cmdImport } from './debt-import.ts';
import { cmdList, cmdNext, cmdPrs, cmdStats, cmdStatus, cmdTrend } from './debt-query.ts';
import {
  cmdSync,
  collectDebtSources,
  refreshDebtLedger,
  warnUnknownSources,
} from './debt-sources.ts';
import {
  applyDebtLabel,
  applyDebtVerdicts,
  buildSummary,
  clearDebtLabels,
  DEBT_ROW_STATUSES,
  DEBT_STATES,
  ensureDebtLabels,
  parseSources,
  readDebtRecords,
  writeSummary,
  type DebtPrState,
  type DebtStatus,
  type DebtVerdict,
} from '@broject/debt';

export { parseCollectArgs } from './debt-args.ts';
export type { CollectArgs } from './debt-args.ts';
export { collectReviewThreads } from './debt-scan.ts';
export { refreshDebtLedger, syncDedupeOverlays } from './debt-sources.ts';

// --- collect ---------------------------------------------------------------

async function cmdCollect(
  argv: string[],
  opts: { throwOnAuthFailure?: boolean } = {}
): Promise<void> {
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  // Auth gate before resolveRepo — an unauthenticated `gh repo view`
  // must not beat the remediation message. `debt watch` runs this per
  // tick: there the gate throws so a transient failure retries on the
  // next tick instead of process.exit killing the loop.
  if (opts.throwOnAuthFailure) {
    const msg = facadeAuth(
      'reviews',
      { dir: process.cwd() },
      { prefer: loadBroConfig().connectors }
    );
    if (msg !== null) {
      throw new Error(msg);
    }
  } else {
    ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  }
  const args = parseCollectArgs(rev, argv);

  const debtCfg = loadBroConfig().debt;
  const configured = args.sources ?? debtCfg.sources;
  const sources = new Set(parseSources(configured));
  warnUnknownSources(configured);

  if (sources.has('review-threads')) {
    await collectReviewThreads(rev, args);
  }
  // --list-only is a read-only inspection — it must not write harvest
  // files, overlays, or the summary either.
  if (!args.listOnly) {
    collectDebtSources(args, sources, debtCfg);
  }

  if (args.dryRun || args.listOnly) {
    return;
  }
  refreshDebtLedger();
}

// --- mark ------------------------------------------------------------------

function cmdMark(argv: string[]): void {
  const positional = argv.filter(a => !a.startsWith('--'));
  const [prRaw, stateRaw, ...rest] = positional;
  const pr = Number(prRaw);
  if (!Number.isFinite(pr) || !stateRaw) {
    console.error(`Usage: bro debt mark PR <${[...DEBT_STATES, 'none'].join('|')}> [OWNER REPO]`);
    process.exit(2);
  }
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const repo = rev.resolveRepo(rest);
  if (stateRaw === 'none') {
    clearDebtLabels(rev, { repo, pr });
    console.error(`debt mark: cleared debt:* labels on ${rev.prLink(repo, pr)}`);
    return;
  }
  if (!(DEBT_STATES as readonly string[]).includes(stateRaw)) {
    console.error(`error: unknown state ${stateRaw}`);
    process.exit(2);
  }
  ensureDebtLabels(rev, repo);
  applyDebtLabel(rev, { repo, pr, state: stateRaw as DebtPrState });
  console.error(`debt mark: ${rev.prLink(repo, pr)} → debt:${stateRaw}`);
}

// --- set -------------------------------------------------------------------

type DebtRowStatus = DebtStatus;

interface SetArgs {
  threadIds: string[];
  fixPr: number | null;
  notes: string | null;
}

function parseSetFlags(argv: string[]): SetArgs {
  const out: SetArgs = { threadIds: [], fixPr: null, notes: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = readOption(argv, i);
    if (argv[i] === '--thread-id' && value !== null) {
      out.threadIds.push(value);
      i += 1;
    } else if (argv[i] === '--threads-file' && value !== null) {
      out.threadIds.push(
        ...readFileSync(value, 'utf8')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.startsWith('#'))
      );
      i += 1;
    } else if (argv[i] === '--fix-pr' && value !== null) {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`error: --fix-pr must be a positive integer, got "${value}"`);
        process.exit(2);
      }
      out.fixPr = n;
      i += 1;
    } else if (argv[i] === '--notes' && value !== null) {
      out.notes = value;
      i += 1;
    }
  }
  return out;
}

function cmdSet(argv: string[]): void {
  // Status is strictly the first positional — scanning all argv would let a
  // flag value like --notes "done" get picked up as the status.
  const status = argv[0] as DebtRowStatus | undefined;
  const { threadIds, fixPr, notes } = parseSetFlags(argv.slice(1));

  if (
    !status ||
    !(DEBT_ROW_STATUSES as readonly string[]).includes(status) ||
    threadIds.length === 0
  ) {
    console.error(
      `Usage: bro debt set <${DEBT_ROW_STATUSES.join('|')}> --thread-id ID… ` +
        '[--threads-file PATH] [--fix-pr N] [--notes T]'
    );
    process.exit(2);
  }

  applyVerdicts(
    [...new Set(threadIds)].map(thread_id => ({
      thread_id,
      status,
      fix_pr: fixPr ?? undefined,
      notes: notes ?? undefined,
    }))
  );
}

/** Apply verdicts to the ledger — shared by `debt set` (argv → uniform
 *  verdicts) and the debt plan runner (`bro run debt.toml`). */
export function applyVerdicts(verdicts: DebtVerdict[]): void {
  const { applied, missing } = applyDebtVerdicts(verdicts);
  writeSummary(buildSummary(readDebtRecords()));
  console.error(`debt set: ${applied} row(s) updated`);
  if (missing.length > 0) {
    console.error(`warning: thread id(s) not in ledger: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
}

// --- watch -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cmdWatch(argv: string[]): Promise<void> {
  let intervalSec = 300;
  const collectArgv: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--interval') {
      const value = readOption(argv, i);
      const n = Number(value);
      // setTimeout overflows above 2^31-1 ms (~24.8 days) and fires
      // immediately — bound the interval below that.
      if (value === null || !Number.isSafeInteger(n) || n <= 0 || n * 1000 > 2_147_483_647) {
        console.error(`error: --interval must be a positive integer (seconds), got "${value}"`);
        process.exit(2);
      }
      intervalSec = n;
      i += 1;
      continue;
    }
    collectArgv.push(argv[i]!);
  }
  // Startup auth is fail-fast — an unauthenticated watch exits with the
  // remediation line now rather than spinning on a failure it can never
  // fix. Inside the loop the same check throws (see cmdCollect), so a
  // later blip retries instead of killing the watcher.
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  console.error(`debt watch: collecting every ${intervalSec}s — Ctrl-C to stop`);
  for (;;) {
    try {
      await cmdCollect(collectArgv, { throwOnAuthFailure: true });
      // cmdCollect wrote ledger + overlays — publish now, per tick, but
      // only when this pass actually mutated (read-only flags write
      // nothing). The post-handler sync never runs: watch never returns.
      if (commandMutatedLedger('collect', collectArgv)) {
        maybeDataRefSync();
      }
    } catch (err) {
      // A failed pass (network blip, gh outage) must not kill the loop.
      console.error(`debt watch: collect failed — ${err instanceof Error ? err.message : err}`);
    }
    await sleep(intervalSec * 1000);
  }
}

// --- entry -----------------------------------------------------------------

// a Map keeps the dispatch table off dynamic object indexing — a
// runtime-keyed `COMMANDS[cmd]` retrieval-then-call trips
// object-injection scanners
const COMMANDS = new Map<string, (argv: string[]) => void | Promise<void>>([
  ['collect', cmdCollect],
  ['status', cmdStatus],
  ['stats', cmdStats],
  ['trend', cmdTrend],
  ['prs', cmdPrs],
  ['list', cmdList],
  ['mark', cmdMark],
  ['set', cmdSet],
  ['sync', cmdSync],
  ['next', cmdNext],
  ['watch', cmdWatch],
  ['import', cmdImport],
]);

// Whether the invocation wrote ledger state — the post-run data-ref
// publish fires only then. Read-only variants write nothing: collect
// --dry-run/--list-only, sync --dry-run, and bare `next` (only --claim
// writes). Publishing after them would push rows the run did not change,
// including ignored debt.
export function commandMutatedLedger(cmd: string, args: string[]): boolean {
  switch (cmd) {
    case 'collect':
      return !args.includes('--dry-run') && !args.includes('--list-only');
    case 'sync':
      return !args.includes('--dry-run');
    case 'next':
      return args.includes('--claim');
    case 'import':
      return !args.includes('--dry-run');
    case 'mark':
    case 'set':
      return true;
    default:
      return false;
  }
}

/** Best-effort data-ref sync after ledger mutations — gitref is opt-in;
 *  sync failures warn but never mask the command's own result. */
function maybeDataRefSync(): void {
  const cfg = loadBroConfig();
  if (!cfg.stores.includes('gitref')) {
    return;
  }
  const root = dataRefRoot();
  if (root === null) {
    return;
  }
  try {
    // mirror the store's own resolution — BRO_DEBT_DIR wins over config
    const dir = process.env.BRO_DEBT_DIR ?? cfg.debt.dir;
    const rel = relative(root, join(process.cwd(), dir));
    const head = dataRefCommit(root, rel, 'bro debt: ledger update', cfg.sync.ref);
    if (head !== null) {
      dataRefPush(root, cfg.sync.remote, cfg.sync.ref);
    }
  } catch (err) {
    console.error(`warning: data ref sync failed — ${err instanceof Error ? err.message : err}`);
  }
}

export async function runDebtCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  // zero-arg magic: bare `bro debt` is the damage report
  if (!cmd) {
    cmdStatus();
    return;
  }
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  const handler = COMMANDS.get(cmd!);
  if (!handler) {
    console.error(`unknown command: ${cmd}`);
    usage();
  }
  await handler(rest);
  if (commandMutatedLedger(cmd!, rest)) {
    maybeDataRefSync();
  }
}

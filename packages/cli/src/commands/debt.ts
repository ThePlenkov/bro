/**
 * `bro debt <sub>` — review-debt pipeline commands.
 *
 *   collect [OWNER REPO] [filters]   collect findings from unprocessed merged PRs
 *   status                           ledger summary + unprocessed merged-PR count
 *   prs [--limit N] [--all]          unprocessed merged PRs (--all: full matrix)
 *   list [filters]                   ledger rows
 *   mark PR collected|clean|skipped|none
 */
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
import { cmdMark, cmdSet } from './debt-verdicts.ts';
import {
  cmdSync,
  collectDebtSources,
  refreshDebtLedger,
  warnUnknownSources,
} from './debt-sources.ts';
import { parseSources } from '@broject/debt';

export { parseCollectArgs } from './debt-args.ts';
export type { CollectArgs } from './debt-args.ts';
export { collectReviewThreads } from './debt-scan.ts';
export { refreshDebtLedger, syncDedupeOverlays } from './debt-sources.ts';
export { applyVerdicts } from './debt-verdicts.ts';

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

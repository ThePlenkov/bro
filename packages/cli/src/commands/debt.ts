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
import { dateFlag, enumFlag, parseCollectArgs, readOption, usage } from './debt-args.ts';
import { collectReviewThreads } from './debt-scan.ts';
import { cmdImport } from './debt-import.ts';
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
  buildTrend,
  claimDebtRecord,
  clearDebtLabels,
  DEBT_ROW_STATUSES,
  DEBT_STATES,
  ensureDebtLabels,
  groupStats,
  parseSources,
  partitionByProcessed,
  prDebtState,
  readDebtRecords,
  readThreadBounds,
  writeSummary,
  type DebtPrState,
  type DebtRecord,
  type DebtStatus,
  type DebtVerdict,
  type StatsGroupBy,
  type TrendGranularity,
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

// --- status ----------------------------------------------------------------

function cmdStatus(): void {
  const records = readDebtRecords();
  const summary = buildSummary(records);

  const byStatus: Record<string, number> = {};
  for (const row of records) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }

  console.log(`rows: ${records.length} total`);
  for (const [status, count] of Object.entries(byStatus).sort()) {
    console.log(`  ${status}: ${count}`);
  }
  if (summary.open_count > 0) {
    console.log(`\nopen by area:`);
    for (const [area, count] of Object.entries(summary.by_area).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${area}: ${count}`);
    }
    console.log(`open by author:`);
    for (const [author, count] of Object.entries(summary.by_author).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${author}: ${count}`);
    }
    if (summary.duplicate_fingerprints.length > 0) {
      console.log(`duplicate fingerprints: ${summary.duplicate_fingerprints.length}`);
    }
    console.log(`oldest open: ${summary.oldest_open}`);
  }

  // Best-effort: count merged PRs still lacking a debt:* label. Skipped
  // silently when no repo resolves (not in a clone, host unreachable).
  try {
    const rev = reviewHost(undefined, loadBroConfig().connectors);
    const merged = rev.mergedPrs(rev.resolveRepo([]), { limit: 100 });
    const { pending } = partitionByProcessed(merged);
    console.log(`\nunprocessed merged PRs: ${pending.length} (of last ${merged.length})`);
  } catch {
    // no repo context — ledger stats above still stand on their own
  }
}

// --- stats -----------------------------------------------------------------

const STATS_BY: readonly StatsGroupBy[] = ['author', 'source', 'area'];

function cmdStats(argv: string[]): void {
  const json = argv.includes('--json');
  let by: StatsGroupBy = 'author';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--by') {
      const value = readOption(argv, i);
      if (!value || !(STATS_BY as readonly string[]).includes(value)) {
        console.error(`error: --by must be one of ${STATS_BY.join('|')}, got "${value}"`);
        process.exit(2);
      }
      by = value as StatsGroupBy;
      i += 1;
    }
  }

  const rows = groupStats(readDebtRecords(), by);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const label = by === 'author' ? 'reviewer' : by;
  console.log(`${label}\ttotal\topen\tclaimed\tdone\twontfix\tdup\tfix%`);
  for (const r of rows) {
    const rate = r.fixRate === null ? '—' : `${Math.round(r.fixRate * 100)}%`;
    console.log(
      `${r.key}\t${r.total}\t${r.open}\t${r.claimed}\t${r.done}\t${r.wontfix}\t${r.duplicate}\t${rate}`
    );
  }
  console.error(`debt stats: ${rows.length} ${label}(s)`);
}

// --- trend -----------------------------------------------------------------

const TREND_GRANULARITIES: readonly TrendGranularity[] = ['week', 'day'];

function cmdTrend(argv: string[]): void {
  const json = argv.includes('--json');
  let by: StatsGroupBy | null = null;
  let granularity: TrendGranularity = 'week';
  let since: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--by') {
      by = enumFlag(arg, readOption(argv, i), STATS_BY);
      i += 1;
    } else if (arg === '--bucket') {
      granularity = enumFlag(arg, readOption(argv, i), TREND_GRANULARITIES);
      i += 1;
    } else if (arg === '--since') {
      since = dateFlag(arg, readOption(argv, i));
      i += 1;
    }
  }

  const points = buildTrend(readDebtRecords(), readThreadBounds(), {
    by,
    granularity,
    since,
  });
  if (json) {
    console.log(JSON.stringify(points, null, 2));
    return;
  }
  console.log('bucket\tkey\topened\tclosed\topen');
  for (const p of points) {
    console.log(`${p.bucket}\t${p.key}\t${p.opened}\t${p.closed}\t${p.open}`);
  }
  console.error(`debt trend: ${points.length} point(s)`);
}

// --- prs -------------------------------------------------------------------

function cmdPrs(argv: string[]): void {
  const positional: string[] = [];
  let limit = 50;
  let showAll = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--all') {
      showAll = true;
      continue;
    }
    if (arg === '--limit') {
      const value = readOption(argv, i);
      if (value !== null) {
        limit = Number(value);
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const repo = rev.resolveRepo(positional);

  const prs = rev.mergedPrs(repo, { limit });
  const rows = prs
    .map(pr => ({ pr, state: prDebtState(pr.labels) ?? 'none' }))
    .filter(row => showAll || row.state === 'none');
  for (const { pr, state } of rows) {
    console.log(`${pr.number}\t${state}\t${pr.mergedAt}\t${pr.author}`);
  }
  const pending = prs.filter(pr => prDebtState(pr.labels) === null).length;
  console.error(`debt prs: ${pending} unprocessed of ${prs.length} merged PR(s)`);
}

// --- list ------------------------------------------------------------------

function rowMatchesFilters(
  row: DebtRecord,
  filters: Record<string, string | number | null>
): boolean {
  if (filters.status !== null && row.status !== filters.status) return false;
  if (filters.area !== null && row.area !== filters.area) return false;
  if (filters.author !== null && row.author !== filters.author) return false;
  if (filters.priority !== null && row.priority !== filters.priority) return false;
  if (filters.pr !== null && row.source_pr !== filters.pr) return false;
  // legacy rows predate sources — they belong to review-threads
  if (filters.source !== null && (row.source ?? 'review-threads') !== filters.source) return false;
  return true;
}

function cmdList(argv: string[]): void {
  const filters: Record<string, string | number | null> = {
    status: 'open',
    area: null,
    author: null,
    priority: null,
    pr: null,
    source: null,
  };
  let limit = 50;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = readOption(argv, i);
    if (arg === '--limit') {
      if (value !== null) {
        limit = Number(value);
        i += 1;
      }
      continue;
    }
    const key = arg.replace(/^--/, '');
    if (key in filters && value !== null) {
      filters[key] = key === 'pr' ? Number(value) : value;
      i += 1;
    }
  }

  const rows = readDebtRecords()
    .filter(row => rowMatchesFilters(row, filters))
    .slice(0, limit);
  for (const row of rows) {
    console.log(
      `${row.thread_id.slice(0, 12)}\t#${row.source_pr}\t${row.status}\t${row.priority}\t${row.area}\t${row.author}\t${row.body_preview}`
    );
  }
  console.error(`debt list: ${rows.length} row(s)`);
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

// --- next ------------------------------------------------------------------

const PRIORITY_RANK: Record<DebtRecord['priority'], number> = {
  blocking: 0,
  human: 1,
  nit: 2,
  scan: 3,
  noise: 4,
};

function cmdNext(argv: string[]): void {
  const json = argv.includes('--json');
  const claim = argv.includes('--claim');
  const filters: Record<string, string | null> = { area: null, author: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!.replace(/^--/, '');
    if (key in filters) {
      const value = readOption(argv, i);
      if (value !== null) {
        filters[key] = value;
        i += 1;
      }
    }
  }

  let row = readDebtRecords()
    .filter(r => r.status === 'open')
    .filter(r => filters.area === null || r.area === filters.area)
    .filter(r => filters.author === null || r.author === filters.author)
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.harvested_at.localeCompare(b.harvested_at)
    )[0];

  if (!row) {
    console.error('debt next: no open findings');
    process.exitCode = 1;
    return;
  }
  if (claim) {
    // Atomic compare-and-swap: the claim is written only if the row is
    // still open under the lock — a concurrent claimer loses and reruns.
    const claimed = claimDebtRecord(row.thread_id);
    if (!claimed) {
      // CAS lost — report the actual status, not just "claimed": the row
      // may have been marked done/wontfix/duplicate by another process.
      const current = readDebtRecords().find(r => r.thread_id === row!.thread_id);
      console.error(
        `debt next: ${row.thread_id.slice(0, 12)} no longer open ` +
          `(status=${current?.status ?? 'gone'}) — rerun`
      );
      process.exitCode = 1;
      return;
    }
    row = claimed;
    writeSummary(buildSummary(readDebtRecords()));
    console.error(`debt next: ${row.thread_id.slice(0, 12)} → claimed`);
  }
  if (json) {
    console.log(JSON.stringify(row));
    return;
  }
  console.log(`${row.thread_id}\t#${row.source_pr}\t${row.priority}\t${row.area}\t${row.author}`);
  console.log(`${row.path}:${row.line ?? '?'}`);
  console.log(row.body);
  console.log(row.thread_url);
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

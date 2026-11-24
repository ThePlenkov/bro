/** `bro debt`'s read-only reports — status/stats/trend over the ledger
 *  plus the prs/list/next views. Split out of debt.ts — the module was
 *  past the CodeScene file-size bar. */
import { ensureAuth, reviewHost } from '@broject/core';
import {
  buildSummary,
  buildTrend,
  claimDebtRecord,
  groupStats,
  partitionByProcessed,
  prDebtState,
  readDebtRecords,
  readThreadBounds,
  writeSummary,
  type DebtRecord,
  type StatsGroupBy,
  type TrendGranularity,
} from '@broject/debt';
import { loadBroConfig } from '../plugins.ts';
import { dateFlag, enumFlag, readOption } from './debt-args.ts';

// --- status ----------------------------------------------------------------

export function cmdStatus(): void {
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

function statsByFlag(argv: string[]): StatsGroupBy {
  let by: StatsGroupBy = 'author';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--by') {
      by = enumFlag('--by', readOption(argv, i), STATS_BY);
      i += 1;
    }
  }
  return by;
}

export function cmdStats(argv: string[]): void {
  const json = argv.includes('--json');
  const by = statsByFlag(argv);

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

export function cmdTrend(argv: string[]): void {
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

interface PrsArgs {
  positional: string[];
  limit: number;
  showAll: boolean;
}

/** One argv slot → the parsed field; returns the extra slots consumed.
 *  A --limit without a value is ignored (pre-existing leniency). */
function prsArg(argv: string[], i: number, out: PrsArgs): number {
  const arg = argv[i]!;
  if (arg === '--all') {
    out.showAll = true;
    return 0;
  }
  if (arg !== '--limit') {
    out.positional.push(arg);
    return 0;
  }
  const value = readOption(argv, i);
  if (value === null) {
    return 0;
  }
  out.limit = Number(value);
  return 1;
}

function parsePrsArgs(argv: string[]): PrsArgs {
  const out: PrsArgs = { positional: [], limit: 50, showAll: false };
  for (let i = 0; i < argv.length; i += 1) {
    i += prsArg(argv, i, out);
  }
  return out;
}

export function cmdPrs(argv: string[]): void {
  const { positional, limit, showAll } = parsePrsArgs(argv);
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

type ListFilters = Record<string, string | number | null>;

/** One predicate per filter field — a row matches when every set filter
 *  equals the row's value. `source` is special: legacy rows predate
 *  sources — they belong to review-threads. */
const FILTER_CHECKS: ReadonlyArray<(row: DebtRecord, f: ListFilters) => boolean> = [
  (r, f) => f.status === null || r.status === f.status,
  (r, f) => f.area === null || r.area === f.area,
  (r, f) => f.author === null || r.author === f.author,
  (r, f) => f.priority === null || r.priority === f.priority,
  (r, f) => f.pr === null || r.source_pr === f.pr,
  (r, f) => f.source === null || (r.source ?? 'review-threads') === f.source,
];

function rowMatchesFilters(row: DebtRecord, filters: ListFilters): boolean {
  return FILTER_CHECKS.every(check => check(row, filters));
}

export function cmdList(argv: string[]): void {
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

// --- next ------------------------------------------------------------------

const PRIORITY_RANK: Record<DebtRecord['priority'], number> = {
  blocking: 0,
  human: 1,
  nit: 2,
  scan: 3,
  noise: 4,
};

interface NextArgs {
  json: boolean;
  claim: boolean;
  filters: { area: string | null; author: string | null };
}

function parseNextArgs(argv: string[]): NextArgs {
  const out: NextArgs = {
    json: argv.includes('--json'),
    claim: argv.includes('--claim'),
    filters: { area: null, author: null },
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!.replace(/^--/, '');
    if (key in out.filters) {
      const value = readOption(argv, i);
      if (value !== null) {
        out.filters[key as keyof NextArgs['filters']] = value;
        i += 1;
      }
    }
  }
  return out;
}

/** Top open finding: priority rank first, then oldest harvest. */
function nextOpenRow(filters: NextArgs['filters']): DebtRecord | undefined {
  return readDebtRecords()
    .filter(r => r.status === 'open')
    .filter(r => filters.area === null || r.area === filters.area)
    .filter(r => filters.author === null || r.author === filters.author)
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.harvested_at.localeCompare(b.harvested_at)
    )[0];
}

/** Atomic compare-and-swap: the claim is written only if the row is
 *  still open under the lock — a concurrent claimer loses and reruns.
 *  Returns the claimed row, or null when the CAS lost (the row may have
 *  been marked done/wontfix/duplicate by another process). */
function claimNextRow(row: DebtRecord): DebtRecord | null {
  const claimed = claimDebtRecord(row.thread_id);
  if (claimed) {
    writeSummary(buildSummary(readDebtRecords()));
    console.error(`debt next: ${row.thread_id.slice(0, 12)} → claimed`);
    return claimed;
  }
  const current = readDebtRecords().find(r => r.thread_id === row.thread_id);
  console.error(
    `debt next: ${row.thread_id.slice(0, 12)} no longer open ` +
      `(status=${current?.status ?? 'gone'}) — rerun`
  );
  process.exitCode = 1;
  return null;
}

function printNextRow(row: DebtRecord): void {
  console.log(`${row.thread_id}\t#${row.source_pr}\t${row.priority}\t${row.area}\t${row.author}`);
  console.log(`${row.path}:${row.line ?? '?'}`);
  console.log(row.body);
  console.log(row.thread_url);
}

export function cmdNext(argv: string[]): void {
  const { json, claim, filters } = parseNextArgs(argv);

  let row = nextOpenRow(filters);
  if (!row) {
    console.error('debt next: no open findings');
    process.exitCode = 1;
    return;
  }
  if (claim) {
    const claimed = claimNextRow(row);
    if (claimed === null) {
      return;
    }
    row = claimed;
  }
  if (json) {
    console.log(JSON.stringify(row));
    return;
  }
  printNextRow(row);
}

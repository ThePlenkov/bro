/**
 * `bro debt <sub>` — review-debt pipeline commands.
 *
 *   collect [OWNER REPO] [filters]   collect findings from unprocessed merged PRs
 *   status                           ledger summary + unprocessed merged-PR count
 *   prs [--limit N] [--all]          unprocessed merged PRs (--all: full matrix)
 *   list [filters]                   ledger rows
 *   mark PR collected|clean|skipped|none
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  dataRefCommit,
  dataRefPush,
  dataRefRoot,
  ensureAuth,
  facadeAuth,
  gitTry,
  hasHelpFlag,
  isBdCompatError,
  normalizeRemote,
  remoteUrl,
  resolveRepo,
  reviewHost,
} from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import {
  type CollectArgs,
  dateFlag,
  enumFlag,
  parseCollectArgs,
  readOption,
  usage,
} from './debt-args.ts';
import { collectReviewThreads, reopenTerminalRows } from './debt-scan.ts';
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
  partitionByProcessed,
  prDebtState,
  readDebtRecords,
  readThreadBounds,
  syncDebtToBeads,
  upsertLedgerOverlays,
  writeHarvestFile,
  writeSummary,
  ALL_SOURCES,
  collectForSource,
  DEBT_SOURCES,
  parseSources,
  dedupeForSource,
  importSarifFiles,
  resolvedThreadIds,
  sarifArtifactPath,
  SourceSkipped,
  sverkaFileScope,
  sverkaScanScope,
  type CollectCtx,
  type DebtPrState,
  type DebtRecord,
  type DebtSource,
  type DebtStatus,
  type DebtVerdict,
  type StatsGroupBy,
  type TrendGranularity,
} from '@broject/debt';

export { parseCollectArgs } from './debt-args.ts';
export type { CollectArgs } from './debt-args.ts';
export { collectReviewThreads } from './debt-scan.ts';

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

/** Post-collect bookkeeping — refresh the summary and project into
 *  beads when configured. Every ledger-writing collect path runs this;
 *  a caller that collects rows and skips it leaves them jsonl-only —
 *  invisible to `debt status`/summary and unprojected for bd stores. */
export function refreshDebtLedger(): void {
  const totalRows = readDebtRecords().length;
  if (totalRows > 0) {
    writeSummary(buildSummary(readDebtRecords()));
    maybeProjectDebtToBeads();
  }
}

/** A configured source nothing implements would silently collect zero
 *  findings — warn so a typo'd name isn't mistaken for a clean sweep. */
function warnUnknownSources(configured: string[]): void {
  const knownSources = new Set<string>(ALL_SOURCES);
  for (const s of configured.filter(x => !knownSources.has(x))) {
    console.error(`debt collect: unknown source "${s}" — ignored`);
  }
}

/** Multi-source collectors — opt-in feeds landing in the same ledger. */
function collectDebtSources(
  args: CollectArgs,
  sources: Set<string>,
  debtCfg: { stale_days: number; sourceConfig: Record<string, Record<string, unknown>> }
): void {
  for (const source of DEBT_SOURCES) {
    if (sources.has(source)) {
      collectOneSource(source, args, debtCfg);
    }
  }
}

function collectSourceRecordsDebt(
  source: DebtSource,
  args: CollectArgs,
  debtCfg: { stale_days: number; sourceConfig: Record<string, Record<string, unknown>> },
  harvestedAt: string
): DebtRecord[] | undefined {
  try {
    return collectForSource(
      source,
      {
        repo: args.repo,
        runId: args.runId,
        harvestedAt,
        dir: gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd(),
        sourceConfig: debtCfg.sourceConfig,
      },
      debtCfg.stale_days
    );
  } catch (err) {
    console.error(
      err instanceof SourceSkipped
        ? `debt: ${source} skipped — ${err.message}`
        : `debt: source ${source} failed — ${err instanceof Error ? err.message : err}`
    );
    return undefined;
  }
}

function applyDebtDedupe(
  source: DebtSource,
  records: DebtRecord[]
): {
  records: DebtRecord[];
  existing: DebtRecord[];
  dupedIds: Set<string>;
  coveredBy: Map<string, string>;
  ran: boolean;
} {
  // PR-decorating sources dedupe against open review-thread rows — the
  // service's PR comments already landed those findings via the merged-PR
  // sweep.
  const dedupe = dedupeForSource(source);
  if (dedupe === undefined) {
    return {
      records,
      existing: [],
      dupedIds: new Set<string>(),
      coveredBy: new Map<string, string>(),
      ran: false,
    };
  }
  const existing = readDebtRecords();
  const d = dedupe(records, existing);
  const dupedIds = new Set(d.duped.map(x => x.record.thread_id));
  const coveredBy = new Map(d.duped.map(x => [x.record.thread_id, x.coveredBy]));
  if (d.duped.length > 0) {
    console.error(`debt: ${source} — ${d.duped.length} finding(s) covered by review threads`);
  }
  return { records: d.kept, existing, dupedIds, coveredBy, ran: true };
}

// Alerts/CI are server-side truth: a finding absent from the fresh
// fetch resolved upstream — close its ledger row so the queue shrinks.
// Deduped ids are covered, not resolved — they transition above.
// sverka narrows the sweep to its own artifact scope: rows imported from
// files outside the scanned dirs are out of scope for a directory sweep
// and must never be closed by it (spec bro-l8c4f.15).
function maybeResolveGoneRecords(
  source: DebtSource,
  records: DebtRecord[],
  dupedIds: Set<string>
): void {
  const inScope = source === 'sverka' ? sverkaScanScope() : undefined;
  const gone = resolvedThreadIds(readDebtRecords(), source, records, inScope).filter(
    id => !dupedIds.has(id)
  );
  if (gone.length === 0) {
    return;
  }
  upsertLedgerOverlays(
    gone.map(thread_id => ({
      thread_id,
      status: 'done' as const,
      fix_pr: null,
      fixed_at: new Date().toISOString(),
      notes: 'resolved upstream — no longer reported',
    }))
  );
  console.error(`debt: ${source} — resolved ${gone.length} row(s) no longer reported`);
}

function collectOneSource(
  source: DebtSource,
  args: CollectArgs,
  debtCfg: { stale_days: number; sourceConfig: Record<string, Record<string, unknown>> }
): void {
  const harvestedAt = new Date().toISOString();
  const raw = collectSourceRecordsDebt(source, args, debtCfg, harvestedAt);
  if (raw === undefined) {
    return;
  }
  const dedupe = applyDebtDedupe(source, raw);
  const records = dedupe.records;
  console.error(`debt: ${source} — ${records.length} finding(s)`);
  if (args.dryRun) {
    for (const row of records) {
      console.log(JSON.stringify(row));
    }
    return;
  }
  if (dedupe.ran) {
    syncDedupeOverlays(source, dedupe.existing, records, dedupe.dupedIds, dedupe.coveredBy);
  }
  if (records.length > 0) {
    writeHarvestFile({
      pr: 0,
      source,
      runId: args.runId,
      harvestedAt,
      records,
    });
  }
  maybeResolveGoneRecords(source, records, dedupe.dupedIds);
}

/** PR-decorator dedupe bookkeeping (specs: bro-huy5o.4, bro-huy5o.5) —
 *  - an open or done ledger row now covered by a review thread →
 *    `duplicate` (the finding is owned by the thread row, not fixed —
 *    fix% must not count it. `done` was either a wrong "resolved
 *    upstream" mark — the fresh fetch just re-reported it — or a stale
 *    fix verdict the live finding disproves);
 *  - a stale `duplicate` or `done` overlay on a re-emitted finding →
 *    `open` (coverage disappeared, or the auto "resolved upstream" mark
 *    proved wrong — the row is live upstream again). `wontfix` stays:
 *    a live finding IS its steady state, so reopening would churn the
 *    human verdict every collect. */
export function syncDedupeOverlays(
  source: DebtSource,
  existing: DebtRecord[],
  records: DebtRecord[],
  dupedIds: Set<string>,
  coveredBy: Map<string, string>
): void {
  const byId = new Map(existing.map(r => [r.thread_id, r]));
  const toDup = [...dupedIds].filter(id => {
    const s = byId.get(id)?.status;
    return s === 'open' || s === 'done';
  });
  const toReopen = records
    .map(r => r.thread_id)
    .filter(id => {
      const s = byId.get(id)?.status;
      return s === 'duplicate' || s === 'done';
    });
  if (toDup.length === 0 && toReopen.length === 0) {
    return;
  }
  upsertLedgerOverlays([
    ...toDup.map(thread_id => ({
      thread_id,
      status: 'duplicate' as const,
      fix_pr: null,
      fixed_at: null,
      notes: `covered by review thread ${coveredBy.get(thread_id) ?? ''}`.trim(),
    })),
    ...toReopen.map(thread_id => ({
      thread_id,
      status: 'open' as const,
      fix_pr: null,
      fixed_at: null,
      notes:
        byId.get(thread_id)?.status === 'duplicate'
          ? 'reopened — no longer covered by a review thread'
          : 'reopened — still reported upstream',
    })),
  ]);
  if (toDup.length > 0) {
    console.error(`debt: ${source} — ${toDup.length} row(s) now covered → duplicate`);
  }
  if (toReopen.length > 0) {
    console.error(`debt: ${source} — reopened ${toReopen.length} row(s) no longer covered`);
  }
}

/** store: beads|both → also project into bd. Collection results are
 *  already durable; a sync failure is reported as its own error, not
 *  allowed to mask them — but it still fails the run (no silent degrade).
 *  Exception: bd API drift degrades — beads is pre-1.0 and a bd that
 *  moved past the contract will keep failing every run, so warn once
 *  and leave the ledger jsonl-only instead of red-failing collect.
 *  Explicit values only — a typo like "beed" must fall back to jsonl,
 *  not fail in bd after the ledger was already written. */
function maybeProjectDebtToBeads(): void {
  if (!loadBroConfig().stores.includes('beads')) {
    return;
  }
  try {
    const res = syncDebtToBeads(readDebtRecords());
    console.error(
      `debt sync: ${res.created} created, ${res.closed} closed, ` +
        `${res.reopened} reopened, ${res.linked} linked`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isBdCompatError(err)) {
      console.error(`debt sync skipped: ${msg}`);
      console.error(
        'beads projection off — ledger stays jsonl-only; upgrade/downgrade bd ' +
          'or set "stores": ["jsonl"] in bro.config.json'
      );
    } else {
      console.error(`debt sync FAILED: ${msg}`);
      console.error('evidence is written; run `bro debt sync` to retry the projection');
      process.exitCode = 1;
    }
  }
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

// --- sync ------------------------------------------------------------------

function cmdSync(argv: string[]): void {
  const dryRun = argv.includes('--dry-run');
  // The explicit jsonl opt-out must hold even for a manual sync — without
  // this gate `sync` would auto-init .beads and project anyway.
  if (!loadBroConfig().stores.includes('beads')) {
    console.error(
      'debt sync: beads is not in stores — drop the opt-out or set ' +
        '"stores": ["jsonl", "beads"] in bro.config.json'
    );
    process.exit(1);
  }
  const records = readDebtRecords();
  const res = syncDebtToBeads(records, { dryRun });
  const verb = dryRun ? '[dry-run] ' : '';
  console.error(
    `${verb}debt sync: ${records.length} record(s) — ${res.created} created, ` +
      `${res.closed} closed, ${res.reopened} reopened, ${res.updated} updated, ` +
      `${res.unchanged} unchanged, ${res.linked} linked`
  );
}

// --- import ------------------------------------------------------------------

/** `bro debt import` repo identity — `--repo` wins, then the origin
 *  remote (no gh needed: host is dropped to match gh's OWNER/REPO), then
 *  `gh repo view`. Failing all three is a loud usage error: identity
 *  must never silently degrade. */
function resolveImportRepo(flag: string | undefined, root: string): string {
  if (flag !== undefined) {
    if (!/^\S+\/\S+$/.test(flag)) {
      console.error(`error: --repo expects OWNER/REPO, got "${flag}"`);
      process.exit(2);
    }
    return flag;
  }
  const remote = remoteUrl(root);
  const normalized = remote === undefined ? '' : normalizeRemote(remote); // host/owner/repo
  const slash = normalized.indexOf('/');
  if (slash > 0 && slash < normalized.length - 1) {
    return normalized.slice(slash + 1);
  }
  try {
    return resolveRepo([], root);
  } catch {
    console.error('error: cannot determine repo from git remote or gh — pass --repo OWNER/REPO');
    process.exit(2);
  }
}

/** Positional must be a readable file — a directory is a usage error
 *  pointing at the dir-scan; an unreadable path is a hard failure.
 *  The canonical path must stay inside the canonical repo root — a
 *  lexical check alone is symlink-blind, and an escaping positional
 *  would import arbitrary file contents into the ledger. */
function assertImportableFile(root: string, f: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(f);
  } catch (err) {
    console.error(`error: cannot read ${f} — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (!st.isFile()) {
    console.error(
      `error: ${f} is not a file — the .sverka dir sweep is \`bro debt collect --source sverka\``
    );
    process.exit(2);
  }
  const rel = relative(realpathSync(root), realpathSync(f));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`error: ${f} resolves outside the repo root`);
    process.exit(2);
  }
}

interface ImportArgs {
  files: string[];
  repo?: string;
  dryRun: boolean;
}

/** Argv → an import plan. Flags dispatch through a table — one row per
 *  flag; the handler returns how many extra argv slots it consumed.
 *  Bare positionals are the SARIF files. */
function parseImportArgs(argv: string[]): ImportArgs {
  const out: ImportArgs = { files: [], dryRun: false };
  const flags = new Map<string, (index: number) => number>([
    [
      '--dry-run',
      () => {
        out.dryRun = true;
        return 0;
      },
    ],
    [
      '--repo',
      index => {
        const v = readOption(argv, index);
        if (v === null) {
          console.error('error: --repo requires a value');
          process.exit(2);
        }
        out.repo = v;
        return 1;
      },
    ],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const handler = flags.get(arg);
    if (handler !== undefined) {
      i += handler(i);
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`error: unknown flag ${arg}`);
      usage();
    }
    out.files.push(arg);
  }
  if (out.files.length === 0) {
    console.error('error: bro debt import needs at least one SARIF file');
    usage();
  }
  return out;
}

/** Parse every artifact before anything writes — one unreadable or
 *  malformed file aborts the whole import, so a partial snapshot can
 *  never reach the resolve sweep looking like "findings fixed". */
function readImportRecords(ctx: CollectCtx, root: string, files: string[]): DebtRecord[] {
  try {
    return importSarifFiles(ctx, root, files);
  } catch (err) {
    console.error(`debt import: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/** The writes of a non-dry import — the harvest file, then the in-scope
 *  resolve overlays. The import IS a complete snapshot of exactly the
 *  artifacts it read: a row scoped to one of them but absent from the
 *  fresh read resolved upstream (spec bro-l8c4f.15). */
function writeImport(ctx: CollectCtx, records: DebtRecord[], gone: string[]): void {
  if (records.length > 0) {
    writeHarvestFile({
      pr: 0,
      source: 'sverka',
      runId: ctx.runId,
      harvestedAt: ctx.harvestedAt,
      records,
    });
    reopenTerminalRows(records);
  }
  if (gone.length === 0) {
    return;
  }
  upsertLedgerOverlays(
    gone.map(thread_id => ({
      thread_id,
      status: 'done' as const,
      fix_pr: null,
      fixed_at: new Date().toISOString(),
      notes: 'resolved upstream — no longer reported',
    }))
  );
  console.error(`debt: sverka — resolved ${gone.length} row(s) no longer reported`);
}

/** Explicit import of a completed sverka/SARIF artifact (spec
 *  bro-l8c4f.15). Parse-all-then-write: one unreadable/malformed file
 *  aborts the whole import — a partial snapshot must never close rows.
 *  The resolve sweep is scoped to exactly the artifacts imported: rows
 *  belonging to other files are out of scope and stay untouched. */
function cmdImport(argv: string[]): void {
  const args = parseImportArgs(argv);
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd();
  const ctx: CollectCtx = {
    repo: resolveImportRepo(args.repo, root),
    runId: `import-${randomUUID().slice(0, 8)}`,
    harvestedAt: new Date().toISOString(),
    dir: root,
  };
  // Positionals resolve against the checkout top once — the spawn cwd
  // may be a repo subdirectory, and validation, reading, and artifact
  // keys must all see the same (root-relative) file.
  const files = args.files.map(f => resolve(root, f));
  for (const f of files) {
    assertImportableFile(root, f);
  }
  const records = readImportRecords(ctx, root, files);
  const artifacts = [...new Set(files.map(f => sarifArtifactPath(root, f)))];
  const gone = resolvedThreadIds(readDebtRecords(), 'sverka', records, sverkaFileScope(artifacts));
  console.error(
    `debt: sverka — ${records.length} finding(s) from ${artifacts.length} artifact(s)` +
      (args.dryRun ? ` — would resolve ${gone.length} row(s)` : '')
  );
  if (args.dryRun) {
    for (const row of records) {
      console.log(JSON.stringify(row));
    }
    for (const id of gone) {
      console.log(id);
    }
    return;
  }
  writeImport(ctx, records, gone);
  refreshDebtLedger();
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

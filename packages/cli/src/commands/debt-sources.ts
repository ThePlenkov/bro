/** `bro debt`'s multi-source collectors and ledger bookkeeping — the
 *  opt-in feeds (sverka/stale-prs/…) landing in the same ledger, the
 *  PR-decorator dedupe overlays, the resolved-upstream sweep, and the
 *  beads projection. Split out of debt.ts — the module was past the
 *  CodeScene file-size bar. */
import { gitTry, isBdCompatError } from '@broject/core';
import {
  ALL_SOURCES,
  buildSummary,
  collectForSource,
  DEBT_SOURCES,
  dedupeForSource,
  readDebtRecords,
  resolvedThreadIds,
  SourceSkipped,
  sverkaScanScope,
  syncDebtToBeads,
  upsertLedgerOverlays,
  writeHarvestFile,
  writeSummary,
  type DebtRecord,
  type DebtSource,
  type LedgerOverlay,
} from '@broject/debt';
import { loadBroConfig } from '../plugins.ts';
import type { CollectArgs } from './debt-args.ts';

/** A configured source nothing implements would silently collect zero
 *  findings — warn so a typo'd name isn't mistaken for a clean sweep. */
export function warnUnknownSources(configured: string[]): void {
  const knownSources = new Set<string>(ALL_SOURCES);
  for (const s of configured.filter(x => !knownSources.has(x))) {
    console.error(`debt collect: unknown source "${s}" — ignored`);
  }
}

/** Multi-source collectors — opt-in feeds landing in the same ledger. */
export function collectDebtSources(
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
    if (err instanceof SourceSkipped) {
      console.error(`debt: ${source} skipped — ${err.message}`);
      return undefined;
    }
    // An unexpected failure means an incomplete sweep — mark the run
    // failed so CI doesn't read a partial collect as clean. Rows stay
    // open either way: the resolve sweep never runs without a snapshot.
    console.error(`debt: source ${source} failed — ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
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

/** Open or done ledger rows now covered by a review thread → `duplicate`. */
function idsToDuplicate(byId: Map<string, DebtRecord>, dupedIds: Set<string>): string[] {
  return [...dupedIds].filter(id => {
    const s = byId.get(id)?.status;
    return s === 'open' || s === 'done';
  });
}

/** Re-emitted findings shadowed by a stale `duplicate`/`done` overlay →
 *  `open`. `wontfix` stays: a live finding IS its steady state, so
 *  reopening would churn the human verdict every collect. */
function idsToReopen(byId: Map<string, DebtRecord>, records: DebtRecord[]): string[] {
  return records
    .map(r => r.thread_id)
    .filter(id => {
      const s = byId.get(id)?.status;
      return s === 'duplicate' || s === 'done';
    });
}

function dupOverlayRows(toDup: string[], coveredBy: Map<string, string>): LedgerOverlay[] {
  return toDup.map(thread_id => ({
    thread_id,
    status: 'duplicate' as const,
    fix_pr: null,
    fixed_at: null,
    notes: `covered by review thread ${coveredBy.get(thread_id) ?? ''}`.trim(),
  }));
}

function reopenOverlayRows(byId: Map<string, DebtRecord>, toReopen: string[]): LedgerOverlay[] {
  return toReopen.map(thread_id => ({
    thread_id,
    status: 'open' as const,
    fix_pr: null,
    fixed_at: null,
    notes:
      byId.get(thread_id)?.status === 'duplicate'
        ? 'reopened — no longer covered by a review thread'
        : 'reopened — still reported upstream',
  }));
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
  const toDup = idsToDuplicate(byId, dupedIds);
  const toReopen = idsToReopen(byId, records);
  if (toDup.length === 0 && toReopen.length === 0) {
    return;
  }
  upsertLedgerOverlays([...dupOverlayRows(toDup, coveredBy), ...reopenOverlayRows(byId, toReopen)]);
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

// --- sync ------------------------------------------------------------------

export function cmdSync(argv: string[]): void {
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
  let res: ReturnType<typeof syncDebtToBeads>;
  try {
    res = syncDebtToBeads(records, { dryRun });
  } catch (err) {
    // Same failure taxonomy as maybeProjectDebtToBeads — but `sync` is
    // the explicit request, so a run that projected nothing exits
    // nonzero rather than degrading to a warn.
    const msg = err instanceof Error ? err.message : String(err);
    if (isBdCompatError(err)) {
      console.error(`debt sync skipped: ${msg}`);
      console.error(
        'beads projection off — ledger stays jsonl-only; upgrade/downgrade bd ' +
          'or set "stores": ["jsonl"] in bro.config.json'
      );
    } else {
      console.error(`debt sync FAILED: ${msg}`);
    }
    process.exit(1);
  }
  const verb = dryRun ? '[dry-run] ' : '';
  console.error(
    `${verb}debt sync: ${records.length} record(s) — ${res.created} created, ` +
      `${res.closed} closed, ${res.reopened} reopened, ${res.updated} updated, ` +
      `${res.unchanged} unchanged, ${res.linked} linked`
  );
}

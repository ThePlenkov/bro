/**
 * The outcome plane (spec bro-0ykhg.4) — how a routed decision
 * actually went, reported back by decision id.
 *
 * Every report lands in `outcome_reports` first — the audit log — then
 * the acceptance rules decide whether it updates `outcomes`, the one
 * resolved row stats/recall/scoring/invalidation read:
 *
 *   - unknown decision id        → throws (fail loud, never guess)
 *   - invalid result/measures    → throws (validated before persist)
 *   - identical event redelivery → no-op
 *   - unverified report          → applies only over pending/absent —
 *                                  it can never replace a verified row
 *   - same source, stale revision→ retained for reconciliation
 *   - verified 'merged'          → supersedes fleet failure/abandon
 *   - verified 'merged' stands   → only a newer verified revision from
 *                                  the same (merge-authority) source
 *                                  may correct it
 *   - verified, unrelated sources, conflicting terminal results
 *                                → retained for reconciliation, never
 *                                  last-write-wins
 *
 * Missing measures are NULL — unknown, never zero. The stats
 * read-model computes P(success | route, features) with the Beta(1,1)
 * prior over verified terminal rows inside the window — zero rows
 * report the prior 0.5 and n=0, never a judge score.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { StoreFace } from './decisions.ts';
import { canonicalJson, getDecision } from './decisions.ts';
import type { DecisionRow } from './decisions.ts';
import { outcomes, outcomeReports } from './schema.ts';
import { readReporterToken, redactSecrets, tightenStoreFiles } from './privacy.ts';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';

/** The terminal results an outcome may carry — all of them terminal. */
export const OUTCOME_RESULTS = ['merged', 'failed', 'abandoned', 'parked'] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

/** The success predicates the shared evaluator knows — the formula's
 *  `success` key and the stats surface both read this one definition. */
export const SUCCESS_PREDICATES = ['merged', 'merged_first_round'] as const;
export type SuccessPredicate = (typeof SUCCESS_PREDICATES)[number];
export const DEFAULT_SUCCESS_PREDICATE: SuccessPredicate = 'merged_first_round';

/** One outcome report — the reporter's claim plus its provenance. */
export interface OutcomeReport {
  /** the decision this outcome answers — REQUIRED, unknown ids fail */
  decisionId: string;
  result: OutcomeResult;
  rounds?: number;
  threads?: number;
  cost?: number;
  tokens?: number;
  wallMs?: number;
  /** who reported — the reporter identity, never a credential */
  reporter: string;
  /** the delivery's event id — redelivery keys on it */
  eventId: string;
  /** the authoritative source the report came from */
  sourceId: string;
  /** the authority's monotonic revision — numeric, never a timestamp */
  sourceRevision: number;
}

/** Why an accepted/rejected report did what it did — the explanation's
 *  provenance and the CLI's --json answer. */
export type OutcomeApply =
  | 'inserted'
  | 'updated'
  | 'pending'
  | 'duplicate-event'
  | 'stale-revision'
  | 'unverified-vs-verified'
  | 'merged-stands'
  | 'conflict-retained';

export interface RecordOutcomeResult {
  applied: OutcomeApply;
  verified: boolean;
  outcome?: OutcomeRow;
}

/** The stored outcome row. */
export interface OutcomeRow {
  decisionId: string;
  contextId: string;
  tableHash: string | null;
  formulaHash: string | null;
  route: string | null;
  provider: string | null;
  model: string | null;
  taskText: string | null;
  featuresJson: string | null;
  result: string;
  rounds: number | null;
  threads: number | null;
  cost: number | null;
  tokens: number | null;
  wallMs: number | null;
  reporter: string | null;
  eventId: string | null;
  sourceId: string | null;
  sourceRevision: number | null;
  verified: number;
  at: number;
}

/** Options for recordOutcome — the verification seam and clock. */
export interface RecordOutcomeOptions {
  /** the reporter credential presented — verified when it matches the
   *  store's reporter token (the generic reporter seam; workers never
   *  hold it). Ignored when `verify` supplies the verdict instead. */
  credential?: string;
  /** a caller-supplied verifier for standalone operators — returns
   *  true when the report carries authoritative evidence. The trusted
   *  in-process reporter (act's merge authority) uses this after it
   *  has itself verified the PR/act verdict. */
  verify?: (report: OutcomeReport) => boolean | Promise<boolean>;
  /** false stores no task text/features even when the decision has
   *  them (retention 0) */
  persistText?: boolean;
  /** epoch ms — defaults to now */
  now?: number;
}

const isInt = (v: number): boolean => Number.isInteger(v);

/** Validate a report BEFORE anything persists — unknown decision ids
 *  and invalid measures fail loud; the row never lands half-written. */
function validateReport(report: OutcomeReport): void {
  if (typeof report.decisionId !== 'string' || report.decisionId === '') {
    throw new Error('outcome report requires a decisionId');
  }
  if (!OUTCOME_RESULTS.includes(report.result)) {
    throw new Error(
      `outcome result must be one of ${OUTCOME_RESULTS.join('|')} — got ${JSON.stringify(report.result)}`
    );
  }
  if (typeof report.reporter !== 'string' || report.reporter === '') {
    throw new Error('outcome report requires a reporter identity');
  }
  if (typeof report.eventId !== 'string' || report.eventId === '') {
    throw new Error('outcome report requires an eventId');
  }
  if (typeof report.sourceId !== 'string' || report.sourceId === '') {
    throw new Error('outcome report requires a sourceId');
  }
  if (!isInt(report.sourceRevision) || report.sourceRevision < 0) {
    throw new Error('outcome report requires a non-negative integer sourceRevision');
  }
  const measures: Array<[string, number | undefined, boolean]> = [
    ['rounds', report.rounds, true],
    ['threads', report.threads, true],
    ['tokens', report.tokens, true],
    ['cost', report.cost, false],
    ['wallMs', report.wallMs, true],
  ];
  for (const [name, value, intOnly] of measures) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `outcome ${name} must be a finite non-negative number — got ${JSON.stringify(value)}`
      );
    }
    if (intOnly && !isInt(value)) {
      throw new Error(
        `outcome ${name} must be a non-negative integer — got ${JSON.stringify(value)}`
      );
    }
  }
}

/** The credential check — timing-safe compare against the store's
 *  reporter token. No token on disk (or none presented) → unverified. */
function credentialVerified(store: StoreFace, credential: string | undefined): boolean {
  if (credential === undefined) return false;
  const expected = readReporterToken(store.path);
  if (expected === undefined) return false;
  const a = Buffer.from(credential, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ExistingOutcome {
  eventId: string | null;
  result: string;
  verified: number;
  sourceId: string | null;
  sourceRevision: number | null;
}

async function readExisting(
  db: StoreFace['db'],
  decisionId: string
): Promise<ExistingOutcome | undefined> {
  const rows = await db.select().from(outcomes).where(eq(outcomes.decisionId, decisionId));
  const row = rows[0] as OutcomeRow | undefined;
  if (row === undefined) return undefined;
  return {
    eventId: row.eventId,
    result: row.result,
    verified: row.verified,
    sourceId: row.sourceId,
    sourceRevision: row.sourceRevision,
  };
}

/** Record one outcome report — the single write path every reporter
 *  (act's merge authority, the fleet terminal exits, the operator CLI)
 *  goes through. Throws on unknown decision ids and invalid reports;
 *  returns the apply verdict for accepted, pending, retained and
 *  no-op cases alike. */
export async function recordOutcome(
  store: StoreFace,
  report: OutcomeReport,
  options: RecordOutcomeOptions = {}
): Promise<RecordOutcomeResult> {
  validateReport(report);
  const decision = await getDecision(store.db, report.decisionId);
  if (decision === undefined) {
    throw new Error(
      `unknown decision id ${report.decisionId} — the decision was never journaled; ` +
        'outcomes join decisions by id, never by guessing from task text'
    );
  }
  const now = options.now ?? Date.now();
  const verified =
    credentialVerified(store, options.credential) ||
    (options.verify !== undefined ? (await options.verify(report)) === true : false);
  const verifiedFlag = verified ? 1 : 0;

  const existing = await readExisting(store.db, report.decisionId);

  // identical event redelivery — a no-op, not even a second report row
  if (existing !== undefined && existing.eventId === report.eventId) {
    return {
      applied: 'duplicate-event',
      verified: verifiedFlag === 1,
      outcome: await readOutcome(store.db, report.decisionId),
    };
  }

  let applied: OutcomeApply;
  let writeRow = true;
  if (existing === undefined) {
    applied = verified ? 'inserted' : 'pending';
  } else if (verifiedFlag === 0 && existing.verified === 1) {
    // unverified submissions sit pending — they can never replace a
    // verified row; the report is still logged for reconciliation
    applied = 'unverified-vs-verified';
    writeRow = false;
  } else if (
    existing.sourceId === report.sourceId &&
    existing.sourceRevision !== null &&
    report.sourceRevision <= existing.sourceRevision &&
    existing.verified === 1
  ) {
    // the authority already spoke at this or a newer revision — an
    // older redelivery is retained, never applied
    applied = 'stale-revision';
    writeRow = false;
  } else if (
    existing.result === 'merged' &&
    existing.verified === 1 &&
    report.result !== 'merged' &&
    report.sourceId !== existing.sourceId
  ) {
    // a verified merge stands — only the merge authority's own newer
    // revision (same sourceId, already past the staleness check) may
    // correct it; unrelated signals are retained
    applied = 'merged-stands';
    writeRow = false;
  } else if (verifiedFlag === 1 && report.result === 'merged' && existing.result !== 'merged') {
    // a verified merge supersedes fleet failure/abandon/parked signals
    // for the same decision — the merge authority's word is the
    // strongest terminal fact there is (spec bro-0ykhg.4)
    applied = 'updated';
  } else if (
    existing.verified === 1 &&
    verifiedFlag === 1 &&
    existing.sourceId !== report.sourceId &&
    existing.result !== report.result
  ) {
    // conflicting terminal reports from unrelated verified sources —
    // retained for reconciliation, never last-write-wins
    applied = 'conflict-retained';
    writeRow = false;
  } else {
    // verified updates land; unverified reports only move pending rows
    applied = verifiedFlag === 1 ? 'updated' : 'pending';
  }

  // every report lands in the audit log — accepted or retained
  await store.db.insert(outcomeReports).values({
    id: randomUUID(),
    decisionId: report.decisionId,
    eventId: report.eventId,
    reporter: redactSecrets(report.reporter),
    sourceId: report.sourceId,
    sourceRevision: report.sourceRevision,
    result: report.result,
    measures: JSON.stringify({
      rounds: report.rounds ?? null,
      threads: report.threads ?? null,
      cost: report.cost ?? null,
      tokens: report.tokens ?? null,
      wallMs: report.wallMs ?? null,
    }),
    verified: verifiedFlag,
    accepted: writeRow ? 1 : 0,
    reason: writeRow ? null : applied,
    at: now,
  });

  let outcome: OutcomeRow | undefined;
  if (writeRow) {
    outcome = await upsertOutcome(
      store,
      decision,
      report,
      verifiedFlag,
      now,
      options.persistText !== false
    );
  } else {
    outcome = await readOutcome(store.db, report.decisionId);
  }
  tightenStoreFiles(store.path);
  return { applied, verified: verifiedFlag === 1, outcome };
}

async function readOutcome(
  db: StoreFace['db'],
  decisionId: string
): Promise<OutcomeRow | undefined> {
  const rows = await db.select().from(outcomes).where(eq(outcomes.decisionId, decisionId));
  return rows[0] as OutcomeRow | undefined;
}

/** Land the accepted report on the outcomes row — the decision supplies
 *  the grouping columns (context, hashes, route, features, text); the
 *  report supplies the verdict and measures. */
async function upsertOutcome(
  store: StoreFace,
  decision: DecisionRow,
  report: OutcomeReport,
  verified: number,
  now: number,
  persistText: boolean
): Promise<OutcomeRow> {
  const values = {
    decisionId: decision.decisionId,
    contextId: decision.contextId,
    tableHash: decision.tableHash,
    formulaHash: decision.formulaHash,
    route: decision.route,
    provider: decision.provider,
    model: decision.model,
    taskText: persistText ? decision.taskText : null,
    featuresJson: persistText ? decision.featuresJson : null,
    result: report.result,
    rounds: report.rounds ?? null,
    threads: report.threads ?? null,
    cost: report.cost ?? null,
    tokens: report.tokens ?? null,
    wallMs: report.wallMs ?? null,
    reporter: redactSecrets(report.reporter),
    eventId: report.eventId,
    sourceId: report.sourceId,
    sourceRevision: report.sourceRevision,
    verified,
    at: now,
  };
  await store.db
    .insert(outcomes)
    .values(values)
    .onConflictDoUpdate({
      target: outcomes.decisionId,
      set: {
        result: values.result,
        rounds: values.rounds,
        threads: values.threads,
        cost: values.cost,
        tokens: values.tokens,
        wallMs: values.wallMs,
        // the text-bearing columns move with the report too — leaving
        // them out let the stored row, the FTS index (synced from
        // values.taskText) and the returned row disagree whenever
        // persistText differed between writes to the same decision
        taskText: values.taskText,
        featuresJson: values.featuresJson,
        reporter: values.reporter,
        eventId: values.eventId,
        sourceId: values.sourceId,
        sourceRevision: values.sourceRevision,
        verified: values.verified,
        at: values.at,
      },
    });
  await syncOutcomeFts(store, decision.decisionId, values.taskText);
  return values as OutcomeRow;
}

/** Keep the FTS index in step with the outcome row's task text —
 *  delete-then-insert so a changed text never double-indexes. */
async function syncOutcomeFts(
  store: StoreFace,
  decisionId: string,
  taskText: string | null
): Promise<void> {
  const client = store.db.$client;
  client.prepare('delete from outcomes_fts where decision_id = ?').run(decisionId);
  if (taskText !== null && taskText !== '') {
    client
      .prepare('insert into outcomes_fts (decision_id, task_text) values (?, ?)')
      .run(decisionId, taskText);
  }
}

/** The authority's next monotonic revision for `sourceId` — strictly
 *  above every revision the source already recorded (the audit log is
 *  the counter's memory, so a restart never reuses one) and never below
 *  the wall clock, so revisions minted by unrelated sources still order
 *  by time. Synchronous: the caller already holds the store open. Two
 *  reporters racing the same read can still mint the same revision —
 *  the stale-revision verdict is the detection, the reporter retries
 *  under a fresh one. */
export function nextSourceRevision(db: StoreFace['db'], sourceId: string): number {
  const rows = db.$client
    .prepare(
      'select coalesce(max(source_revision), 0) as m from outcome_reports where source_id = ?'
    )
    .all(sourceId) as Array<{ m: number }>;
  return Math.max(Date.now(), Number(rows[0]?.m ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// The stats read-model — P(success | route, features)
// ---------------------------------------------------------------------------

/** One labelled-or-not verified outcome row, as the stats read. */
export interface StatsRow {
  decisionId: string;
  route: string | null;
  result: string;
  rounds: number | null;
  cost: number | null;
  wallMs: number | null;
  featuresJson: string | null;
  at: number;
}

/** The stats read-model's answer for one scope — the fields the formula
 *  scorer (PR #1008's OutcomeStatsSource seam) and `brouter stats
 *  outcomes` both consume. `p` is the Beta(1,1)-smoothed probability;
 *  zero rows report p=0.5, n=0 — the prior, never a judge score. */
export interface OutcomeStats {
  /** P(success | route, features) — (successes + 1) / (n + 2) */
  p: number;
  /** labelled rows — successes + failures */
  n: number;
  successes: number;
  failures: number;
  /** verified rows excluded as unlabelled (merged without rounds
   *  under merged_first_round) */
  excluded: number;
  /** mean task cost USD over verified rows carrying a cost — NULL when
   *  no row measured one (unknown is not zero) */
  costUsd: number | null;
  /** mean task wall seconds — NULL when unmeasured */
  wallSec: number | null;
}

/** The stats query — the grouping keys the read-model conditions on. */
export interface OutcomeStatsQuery {
  /** the project namespace — required */
  contextId: string;
  /** restrict to one route — undefined means every route in scope */
  route?: string;
  tableHash?: string;
  formulaHash?: string;
  /** the feature map to bucket by — undefined = no bucket filter;
   *  `{}` = the empty bucket */
  features?: Record<string, string | number | boolean>;
  /** the bucket's key set — defaults to the feature map's own keys;
   *  the .7 adapter passes the formula's declared question keys */
  featureKeys?: readonly string[];
  /** the success predicate — default merged_first_round */
  success?: SuccessPredicate;
  /** epoch ms — rows at/after this count; default now - 30d */
  since?: number;
  now?: number;
}

/** The default stats window — verified terminal rows from the last
 *  30 days (spec bro-0ykhg.4). */
export const OUTCOME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Canonical feature bucket — pick the bucket keys in sorted order so
 *  equal feature sets compare equal regardless of writer order. */
function featureBucket(featuresJson: string | null, keys: readonly string[]): string {
  if (featuresJson === null) return '{}';
  let features: Record<string, unknown>;
  try {
    features = JSON.parse(featuresJson) as Record<string, unknown>;
  } catch {
    return '{}';
  }
  const picked: Record<string, unknown> = {};
  for (const key of [...keys].sort()) {
    if (key in features) picked[key] = features[key];
  }
  return canonicalJson(picked);
}

/** The shared success evaluator — the ONE definition of what counts as
 *  success under each predicate. `merged` counts every merged row;
 *  `merged_first_round` requires merged with rounds===1, and a merged
 *  row with UNKNOWN rounds is unlabelled — excluded from n, never
 *  assumed one. Failed/abandoned/parked always count as failures. */
export type Label = 'success' | 'failure' | 'unlabelled';

export function labelOutcome(
  row: { result: string; rounds: number | null },
  predicate: SuccessPredicate
): Label {
  if (row.result !== 'merged') return 'failure';
  if (predicate === 'merged') return 'success';
  // merged_first_round
  if (row.rounds === null || row.rounds === undefined) return 'unlabelled';
  return row.rounds === 1 ? 'success' : 'failure';
}

/** Read verified terminal outcomes inside the window and reduce them
 *  to P(success | route, features). Sync over an already-open db —
 *  the seam .7 binds as OutcomeStatsSource. */
export async function outcomeStats(
  db: StoreFace['db'],
  query: OutcomeStatsQuery
): Promise<OutcomeStats> {
  const now = query.now ?? Date.now();
  const since = query.since ?? now - OUTCOME_WINDOW_MS;
  const predicate = query.success ?? DEFAULT_SUCCESS_PREDICATE;
  const clauses = [
    eq(outcomes.contextId, query.contextId),
    eq(outcomes.verified, 1),
    gte(outcomes.at, since),
  ];
  if (query.route !== undefined) clauses.push(eq(outcomes.route, query.route));
  if (query.tableHash !== undefined) clauses.push(eq(outcomes.tableHash, query.tableHash));
  if (query.formulaHash !== undefined) clauses.push(eq(outcomes.formulaHash, query.formulaHash));

  const rows = (await db
    .select({
      decisionId: outcomes.decisionId,
      route: outcomes.route,
      result: outcomes.result,
      rounds: outcomes.rounds,
      cost: outcomes.cost,
      wallMs: outcomes.wallMs,
      featuresJson: outcomes.featuresJson,
      at: outcomes.at,
    })
    .from(outcomes)
    .where(and(...clauses))) as StatsRow[];

  const keys =
    query.featureKeys !== undefined
      ? query.featureKeys
      : query.features !== undefined
        ? Object.keys(query.features)
        : undefined;
  const wantedBucket =
    keys === undefined ? undefined : featureBucket(canonicalJson(query.features ?? {}), keys);

  let successes = 0;
  let failures = 0;
  let excluded = 0;
  let costSum = 0;
  let costN = 0;
  let wallSum = 0;
  let wallN = 0;

  for (const row of rows) {
    // bucket filter — only when the caller conditioned on features
    if (wantedBucket !== undefined) {
      if (featureBucket(row.featuresJson, keys!) !== wantedBucket) continue;
    }
    const label = labelOutcome(row, predicate);
    if (label === 'success') successes += 1;
    else if (label === 'failure') failures += 1;
    else excluded += 1;
    // means run over every verified in-scope row carrying the measure —
    // an unlabelled row's cost is still a real measurement
    if (row.cost !== null) {
      costSum += row.cost;
      costN += 1;
    }
    if (row.wallMs !== null) {
      wallSum += row.wallMs;
      wallN += 1;
    }
  }

  const n = successes + failures;
  return {
    p: (successes + 1) / (n + 2),
    n,
    successes,
    failures,
    excluded,
    costUsd: costN === 0 ? null : costSum / costN,
    wallSec: wallN === 0 ? null : wallSum / wallN / 1000,
  };
}

/** Per-route stats — the `brouter stats outcomes` breakdown: one
 *  OutcomeStats per route plus the all-routes total. */
export async function outcomeStatsByRoute(
  db: StoreFace['db'],
  query: OutcomeStatsQuery
): Promise<{ total: OutcomeStats; routes: Array<{ route: string; stats: OutcomeStats }> }> {
  const routes = await db
    .selectDistinct({ route: outcomes.route })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.contextId, query.contextId),
        eq(outcomes.verified, 1),
        gte(outcomes.at, query.since ?? (query.now ?? Date.now()) - OUTCOME_WINDOW_MS)
      )
    );
  const routeNames = routes
    .map(r => (r as { route: string | null }).route)
    .filter((r): r is string => r !== null)
    .sort();
  const perRoute = [];
  for (const route of routeNames) {
    perRoute.push({ route, stats: await outcomeStats(db, { ...query, route }) });
  }
  return { total: await outcomeStats(db, query), routes: perRoute };
}

// ---------------------------------------------------------------------------
// Retention — taskTextRetentionDays
// ---------------------------------------------------------------------------

/** The text-bearing columns expiry clears — free text, carried inputs,
 *  replay snapshots and the feature bucket all go; hashes, links,
 *  measures and the verdict stay (the numeric aggregates). */
const DECISION_TEXT_COLS = [
  'task_text',
  'task_json',
  'candidates_json',
  'table_json',
  'formula_text',
  'stage_answers',
] as const;
const OUTCOME_TEXT_COLS = ['task_text', 'features_json'] as const;

export interface ExpireResult {
  decisions: number;
  outcomes: number;
  fts: number;
}

/** Expire task text older than the retention window — atomically:
 *  decisions and outcomes lose their text-bearing fields, the FTS
 *  entries go, and numeric aggregates (hashes, measures, verdicts,
 *  links) stay. `retentionDays` 0 means the operator disabled text
 *  persistence entirely — the same clear runs against everything. */
export async function expireTaskText(
  store: StoreFace,
  options: { retentionDays: number; now?: number }
): Promise<ExpireResult> {
  const now = options.now ?? Date.now();
  const cutoff =
    options.retentionDays <= 0
      ? Number.MAX_SAFE_INTEGER
      : now - options.retentionDays * 24 * 60 * 60 * 1000;
  const client = store.db.$client;
  const result: ExpireResult = { decisions: 0, outcomes: 0, fts: 0 };
  try {
    client.exec('begin');
    // which decision ids still carry text — their FTS rows go too
    const staleDecisions = client
      .prepare(
        `select decision_id from decisions where created_at < ? and (${DECISION_TEXT_COLS.map(c => `${c} is not null`).join(' or ')})`
      )
      .all(cutoff) as Array<{ decision_id: string }>;
    const staleOutcomes = client
      .prepare(
        `select decision_id from outcomes where at < ? and (${OUTCOME_TEXT_COLS.map(c => `${c} is not null`).join(' or ')})`
      )
      .all(cutoff) as Array<{ decision_id: string }>;
    const ftsIds = [...new Set([...staleDecisions, ...staleOutcomes].map(r => r.decision_id))];
    for (const id of ftsIds) {
      client.prepare('delete from outcomes_fts where decision_id = ?').run(id);
    }
    result.fts = ftsIds.length;
    if (DECISION_TEXT_COLS.length > 0) {
      const setClause = DECISION_TEXT_COLS.map(c => `${c} = null`).join(', ');
      const info = client
        .prepare(`update decisions set ${setClause} where created_at < ?`)
        .run(cutoff);
      result.decisions = Number(info.changes);
    }
    if (OUTCOME_TEXT_COLS.length > 0) {
      const setClause = OUTCOME_TEXT_COLS.map(c => `${c} = null`).join(', ');
      const info = client.prepare(`update outcomes set ${setClause} where at < ?`).run(cutoff);
      result.outcomes = Number(info.changes);
    }
    client.exec('commit');
    tightenStoreFiles(store.path);
    return result;
  } catch (err) {
    try {
      client.exec('rollback');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/** The T1-recall read — FTS5 over outcome task text inside a context.
 *  Returns decision ids whose stored task text matches the query;
 *  the caller re-reads the rows for the full record. Only VERIFIED
 *  outcomes recall — pending assertions never vote. */
export async function recallDecisions(
  db: StoreFace['db'],
  query: { contextId: string; text: string; limit?: number }
): Promise<string[]> {
  if (query.text.trim() === '') return [];
  try {
    const rows = db.$client
      .prepare(
        `select o.decision_id from outcomes_fts f
         join outcomes o on o.decision_id = f.decision_id
         where outcomes_fts match ? and o.context_id = ? and o.verified = 1
         limit ?`
      )
      .all(query.text, query.contextId, query.limit ?? 20) as Array<{ decision_id: string }>;
    return rows.map(r => r.decision_id);
  } catch {
    return [];
  }
}

/** Count of outcome rows excluded from every consumer because they sit
 *  pending (unverified) — the explanation surface reports it so a
 *  forged or unfinished report is visible, never silently dropped. */
export async function pendingOutcomeCount(
  db: StoreFace['db'],
  contextId?: string
): Promise<number> {
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(outcomes)
      .where(
        contextId === undefined
          ? eq(outcomes.verified, 0)
          : and(eq(outcomes.verified, 0), eq(outcomes.contextId, contextId))
      );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** The non-joinable count — decisions journaled before decision ids
 *  existed cannot receive outcomes; surfaces report them rather than
 *  guess. (All current rows carry ids; this counts rows whose outcome
 *  join would be ambiguous — kept for the explanation contract.) */
export async function outcomeReportLog(
  db: StoreFace['db'],
  decisionId: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await db
      .select()
      .from(outcomeReports)
      .where(eq(outcomeReports.decisionId, decisionId));
    return rows as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

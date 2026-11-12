/**
 * The ledger's tables — the facts the router records.
 *
 * The schema is the drizzle one (typed queries); the SQL that creates it
 * lives in migrations.ts and a drift test proves the two agree — the
 * schema is the source of truth, the SQL is what the database runs.
 */
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The counters — the router's own traffic, per model and window. */
export const usage = sqliteTable(
  'usage',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    windowStart: integer('window_start').notNull(),
    requests: integer('requests').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
  },
  t => [primaryKey({ columns: [t.provider, t.model, t.windowStart] })]
);

/** The walls — the rate limit the router SAW (429 + resetAt). */
export const limits = sqliteTable(
  'limits',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    resetAt: integer('reset_at').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull(),
    seenAt: integer('seen_at').notNull(),
  },
  t => [primaryKey({ columns: [t.provider, t.model] })]
);

/** The sessions the router holds open — id, lane, model, the tags. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  meta: text('meta'),
});

/** The decision journal — one row per route/ask/spawn decision, written
 *  BEFORE the work it routes starts (spec bro-0ykhg.4). The row carries
 *  the replayable inputs: task text and carried fields, the surviving
 *  candidates, the table/formula snapshots and their hashes, the judge
 *  configuration identity and the stage answers — everything .2's
 *  cascade, .3's cache and .5's replay need to re-ask the question.
 *
 *  `context_id` namespaces the project: the canonical repository id
 *  when one exists, else the caller's configured namespace, else the
 *  canonical table location — outcomes group by it, never by a route
 *  name across projects. */
export const decisions = sqliteTable('decisions', {
  /** the decision's UUID — generated once, never derived from text */
  decisionId: text('decision_id').primaryKey(),
  /** the stable project namespace outcomes group under */
  contextId: text('context_id').notNull(),
  /** epoch ms the decision was journaled */
  createdAt: integer('created_at').notNull(),
  /** the task text the decision read — NULL once retention expires it
   *  or when the operator disabled text persistence (retention 0) */
  taskText: text('task_text'),
  /** the carried inputs as JSON — type/complexity/priority/features/
   *  labels/paths/repo, whatever the caller supplied */
  taskJson: text('task_json'),
  /** the canonical feature map as JSON — the bucket P(success|route,
   *  features) groups by; outcomes copy it at report time */
  featuresJson: text('features_json'),
  /** the surviving candidates at decision time, as JSON */
  candidatesJson: text('candidates_json'),
  /** the route table snapshot, as JSON — replay re-resolves against it */
  tableJson: text('table_json'),
  /** sha256 over the canonical table JSON */
  tableHash: text('table_hash'),
  /** the formula file's raw text — NULL when no formula drove the pick */
  formulaText: text('formula_text'),
  /** sha256 over the formula bytes */
  formulaHash: text('formula_hash'),
  /** the formula's path, when one was declared */
  formulaPath: text('formula_path'),
  /** the judge configuration identity as JSON — provider, model, mode;
   *  never credential material */
  judgeConfig: text('judge_config'),
  /** the stage answers as JSON — T0/T1/T2 verdicts for replay */
  stageAnswers: text('stage_answers'),
  /** the route the decision landed on — NULL when none fit */
  route: text('route'),
  /** the chain head's provider/model the route resolved to */
  provider: text('provider'),
  model: text('model'),
  /** who picked — 'table' order, the 'model', the 'formula', a 'cache' hit */
  picked: text('picked'),
  /** the run links — written at journal time when known, repaired by
   *  pin reconciliation when a crash lands between the two */
  beadId: text('bead_id'),
  worker: text('worker'),
  runId: text('run_id'),
  pr: text('pr'),
});

/** The outcomes — how a routed decision actually went (spec bro-0ykhg.4).
 *  One row per decision: the resolved, accepted state. Every report
 *  lands in `outcome_reports` first; this row is what stats, recall,
 *  scoring and invalidation read.
 *
 *  `verified` splits evidence from assertion: unverified CLI
 *  submissions sit pending (0), excluded from every consumer, and can
 *  never replace a verified row. Missing measures are NULL — unknown,
 *  never zero. */
export const outcomes = sqliteTable('outcomes', {
  /** the decision this outcome answers — joins the journal */
  decisionId: text('decision_id').primaryKey(),
  /** copied from the decision — the grouping namespace */
  contextId: text('context_id').notNull(),
  tableHash: text('table_hash'),
  formulaHash: text('formula_hash'),
  route: text('route'),
  provider: text('provider'),
  model: text('model'),
  /** the task text at report time — NULL after retention expires it */
  taskText: text('task_text'),
  /** the canonical feature bucket as JSON — NULL after retention */
  featuresJson: text('features_json'),
  /** merged | failed | abandoned | parked — all terminal */
  result: text('result').notNull(),
  rounds: integer('rounds'),
  threads: integer('threads'),
  /** mean-able cost in USD — real: a task's cost is not an integer */
  cost: real('cost'),
  tokens: integer('tokens'),
  wallMs: integer('wall_ms'),
  /** who reported — the reporter identity, never a credential */
  reporter: text('reporter'),
  /** the accepted event's id — idempotent redelivery keys on it */
  eventId: text('event_id'),
  /** the authoritative source the report came from */
  sourceId: text('source_id'),
  /** the authority's monotonic revision — numeric, never a timestamp string */
  sourceRevision: integer('source_revision'),
  /** 1 = verified evidence, 0 = pending assertion */
  verified: integer('verified').notNull().default(0),
  /** epoch ms the outcome was accepted */
  at: integer('at').notNull(),
});

/** The report log — every outcome report the store ever saw, accepted
 *  or retained. Conflicting terminal reports from unrelated sources
 *  are kept here for reconciliation, never silently last-write-wins;
 *  `accepted`/`reason` record why each update landed or didn't. */
export const outcomeReports = sqliteTable('outcome_reports', {
  /** the report row's own id */
  id: text('id').primaryKey(),
  decisionId: text('decision_id').notNull(),
  eventId: text('event_id').notNull(),
  reporter: text('reporter').notNull(),
  sourceId: text('source_id').notNull(),
  sourceRevision: integer('source_revision').notNull(),
  result: text('result').notNull(),
  /** the measures as JSON — rounds/threads/cost/tokens/wallMs */
  measures: text('measures'),
  verified: integer('verified').notNull(),
  /** 1 = applied to `outcomes`, 0 = retained for reconciliation */
  accepted: integer('accepted').notNull(),
  /** why the update was rejected — the explanation's provenance */
  reason: text('reason'),
  at: integer('at').notNull(),
});

/** The bookkeeping table — which migrations ran, and when. */
export const migrations = sqliteTable('migrations', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
});

/** The schema as one object — drizzle's `schema` option. */
export const schema = {
  usage,
  limits,
  sessions,
  decisions,
  outcomes,
  outcomeReports,
  migrations,
};

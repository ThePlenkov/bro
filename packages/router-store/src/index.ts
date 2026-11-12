/**
 * @broject/router-store — the router's own ledger.
 *
 * The router serves the models, so the router keeps the ledger: the
 * traffic it served, the rate limit it saw, the sessions it holds. The
 * health read-model over that ledger is what a route decision reads.
 *
 * One SQLite database through drizzle over Node's built-in SQLite — no
 * native module, no server. Every write is best-effort: the ledger is a
 * record, not a gate.
 */
export {
  canonicalJson,
  contentHash,
  findDecisions,
  getDecision,
  linkDecision,
  newDecisionId,
  recordDecision,
  textHash,
  type DecisionInput,
  type DecisionKind,
  type DecisionRow,
  type StoreFace,
} from './decisions.ts';
export { healthSnapshot } from './health.ts';
export { migrateStore, migrationIds } from './migrations.ts';
export {
  DEFAULT_SUCCESS_PREDICATE,
  expireTaskText,
  labelOutcome,
  nextSourceRevision,
  outcomeReportLog,
  outcomeStats,
  outcomeStatsByRoute,
  OUTCOME_RESULTS,
  OUTCOME_WINDOW_MS,
  pendingOutcomeCount,
  recallDecisions,
  recordOutcome,
  SUCCESS_PREDICATES,
  type ExpireResult,
  type OutcomeApply,
  type OutcomeReport,
  type OutcomeResult,
  type OutcomeRow,
  type OutcomeStats,
  type OutcomeStatsQuery,
  type RecordOutcomeOptions,
  type RecordOutcomeResult,
  type StatsRow,
  type SuccessPredicate,
} from './outcomes.ts';
export {
  ensureReporterToken,
  ensureStorePrivacy,
  readReporterToken,
  redactSecrets,
  reporterTokenPath,
} from './privacy.ts';
export { routerStorePath } from './path.ts';
export {
  decisions,
  limits,
  migrations,
  outcomeReports,
  outcomes,
  schema,
  sessions,
  usage,
} from './schema.ts';
export {
  activeLimits,
  clearLimit,
  closeSession,
  openSession,
  openSessions,
  openStore,
  recordLimit,
  recordUsage,
  storeStats,
  usageInWindow,
  type LimitRow,
  type RouterDb,
  type SessionRow,
  type StoreHandle,
} from './store.ts';

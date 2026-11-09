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
export { healthSnapshot } from './health.ts';
export { migrateStore, migrationIds } from './migrations.ts';
export { routerStorePath } from './path.ts';
export { limits, migrations, schema, sessions, usage } from './schema.ts';
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

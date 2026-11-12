/**
 * The ledger's migrations — the SQL the database runs.
 *
 * Hand-written, and a drift test proves it agrees with the drizzle
 * schema (migrations.test.ts compares every table's columns against
 * `PRAGMA table_info`). No generator, no codegen step, no folder to ship:
 * the migration list IS the package's data, and the schema stays the
 * source of truth for the queries.
 */
import type { RouterDb } from './store.ts';
import { migrations } from './schema.ts';

/** The ledger's tables, in the order they are created. */
const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '0001_ledger',
    sql: `
create table if not exists usage (
  provider text not null,
  model text not null,
  window_start integer not null,
  requests integer not null default 0,
  tokens integer not null default 0,
  primary key (provider, model, window_start)
);
create table if not exists limits (
  provider text not null,
  model text not null,
  reset_at integer not null,
  reason text not null,
  source text not null,
  seen_at integer not null,
  primary key (provider, model)
);
create table if not exists sessions (
  id text primary key,
  provider text not null,
  model text not null,
  started_at integer not null,
  ended_at integer,
  meta text
);
create index if not exists sessions_lane on sessions (provider, model);
`,
  },
  {
    id: '0002_decisions_outcomes',
    sql: `
create table if not exists decisions (
  decision_id text primary key,
  context_id text not null,
  created_at integer not null,
  task_text text,
  task_json text,
  features_json text,
  candidates_json text,
  table_json text,
  table_hash text,
  formula_text text,
  formula_hash text,
  formula_path text,
  judge_config text,
  stage_answers text,
  route text,
  provider text,
  model text,
  picked text,
  bead_id text,
  worker text,
  run_id text,
  pr text
);
create index if not exists decisions_context on decisions (context_id, created_at);
create index if not exists decisions_bead on decisions (bead_id);
create index if not exists decisions_run on decisions (run_id);
create table if not exists outcomes (
  decision_id text primary key,
  context_id text not null,
  table_hash text,
  formula_hash text,
  route text,
  provider text,
  model text,
  task_text text,
  features_json text,
  result text not null,
  rounds integer,
  threads integer,
  cost real,
  tokens integer,
  wall_ms integer,
  reporter text,
  event_id text,
  source_id text,
  source_revision integer,
  verified integer not null default 0,
  at integer not null
);
create index if not exists outcomes_context on outcomes (context_id, route, at);
create index if not exists outcomes_event on outcomes (event_id);
create table if not exists outcome_reports (
  id text primary key,
  decision_id text not null,
  event_id text not null,
  reporter text not null,
  source_id text not null,
  source_revision integer not null,
  result text not null,
  measures text,
  verified integer not null,
  accepted integer not null,
  reason text,
  at integer not null
);
create index if not exists outcome_reports_decision on outcome_reports (decision_id, at);
create virtual table if not exists outcomes_fts using fts5(decision_id unindexed, task_text);
`,
  },
];

/** The bookkeeping table — which migrations ran. */
const BOOKKEEPING = `
create table if not exists migrations (
  id text primary key,
  applied_at integer not null
);
`;

/** The migration ids already applied. */
function appliedIds(db: RouterDb): Set<string> {
  const rows = db.select({ id: migrations.id }).from(migrations).all();
  return new Set(rows.map(r => r.id));
}

/** Record that a migration ran. A duplicate is ignored, not an error: two
 *  callers may reach the same migration, and the second one must not fail
 *  the run. */
function recordApplied(db: RouterDb, id: string): void {
  db.insert(migrations)
    .values({ id, appliedAt: Date.now() })
    .onConflictDoNothing({ target: migrations.id })
    .run();
}

/** Apply the migrations this database has not seen yet; return their ids.
 *  A second run is a no-op — the store is opened by every command.
 *
 *  The run is synchronous on purpose. The client is node:sqlite's
 *  `DatabaseSync`, and an `await` inside the transaction would hand the
 *  event loop to a second caller, which would then `BEGIN` inside ours —
 *  "cannot start a transaction within a transaction". Without an await
 *  between `BEGIN` and `COMMIT` nothing can interleave. */
export function migrateStore(db: RouterDb): string[] {
  db.$client.exec(BOOKKEEPING);
  const applied = appliedIds(db);
  const fresh: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.$client.exec('BEGIN');
    try {
      db.$client.exec(migration.sql);
      recordApplied(db, migration.id);
      db.$client.exec('COMMIT');
    } catch (err) {
      db.$client.exec('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`router store: migration ${migration.id} failed — ${msg}`);
    }
    fresh.push(migration.id);
  }
  return fresh;
}

/** The SQL of every migration — the drift test reads it. */
export function migrationSql(): string {
  return MIGRATIONS.map(m => m.sql).join('\n');
}

/** The migration ids, in order. */
export function migrationIds(): string[] {
  return MIGRATIONS.map(m => m.id);
}

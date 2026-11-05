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
];

/** The bookkeeping table — which migrations ran. */
const BOOKKEEPING = `
create table if not exists migrations (
  id text primary key,
  applied_at integer not null
);
`;

/** The migration ids already applied. */
async function appliedIds(db: RouterDb): Promise<Set<string>> {
  const rows = await db.select({ id: migrations.id }).from(migrations);
  return new Set(rows.map(r => r.id));
}

/** Apply the migrations this database has not seen yet; return their ids.
 *  A second run is a no-op — the store is opened by every command. */
export async function migrateStore(db: RouterDb): Promise<string[]> {
  db.$client.exec(BOOKKEEPING);
  const applied = await appliedIds(db);
  const fresh: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.$client.exec('BEGIN');
    try {
      db.$client.exec(migration.sql);
      await db.insert(migrations).values({ id: migration.id, appliedAt: Date.now() });
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

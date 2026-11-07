/**
 * The ledger's tables — the three facts the router records.
 *
 * The schema is the drizzle one (typed queries); the SQL that creates it
 * lives in migrations.ts and a drift test proves the two agree — the
 * schema is the source of truth, the SQL is what the database runs.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/** The bookkeeping table — which migrations ran, and when. */
export const migrations = sqliteTable('migrations', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
});

/** The schema as one object — drizzle's `schema` option. */
export const schema = { usage, limits, sessions, migrations };

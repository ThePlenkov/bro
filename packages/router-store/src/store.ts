/**
 * The store API — the router's writes and reads over the ledger.
 *
 * Every write is BEST-EFFORT: the ledger is a record, not a gate. A
 * missing, locked or broken store costs the numbers, never the run — so
 * the writes return a boolean ("recorded") instead of throwing, and the
 * reads answer with an empty result instead of failing the caller.
 *
 * The decision about whether a model may serve belongs to the serving
 * path (it knows the caps); this layer only records what happened.
 */
import { and, eq, gt, gte, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { limits, sessions, usage } from './schema.ts';

/** The typed database — drizzle over Node's built-in SQLite. The raw
 *  client rides along: the migrations run statements SQLite itself owns. */
export type RouterDb = NodeSQLiteDatabase & { $client: DatabaseSync };

/** The store handle — the database, or the reason there is none. */
export type StoreHandle =
  | { ok: true; db: RouterDb; path: string; close: () => void }
  | { ok: false; path: string; reason: string };

/** One wall — the rate limit the router saw. */
export interface LimitRow {
  provider: string;
  model: string;
  resetAt: number;
  reason: string;
  source: string;
  seenAt: number;
}

/** One session the router holds open. */
export interface SessionRow {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  meta?: string;
}

/** Open (or create) the ledger at `path`. Never throws — the caller
 *  gets the reason instead. */
export function openStore(path: string): StoreHandle {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const client = new DatabaseSync(path);
    client.exec('PRAGMA journal_mode = WAL');
    client.exec('PRAGMA foreign_keys = ON');
    const db = drizzle({ client });
    return { ok: true, db, path, close: () => client.close() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path, reason: msg };
  }
}

/** Run a write that must never take the caller down. */
async function bestEffort(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch {
    return false;
  }
}

/** Count the requests (and tokens) the router served for one model
 *  inside a window. */
export async function usageInWindow(
  db: RouterDb,
  window: { provider: string; model: string; since: number; until: number }
): Promise<{ requests: number; tokens: number }> {
  try {
    const rows = await db
      .select({
        requests: sql<number>`coalesce(sum(${usage.requests}), 0)`,
        tokens: sql<number>`coalesce(sum(${usage.tokens}), 0)`,
      })
      .from(usage)
      .where(
        and(
          eq(usage.provider, window.provider),
          eq(usage.model, window.model),
          gte(usage.windowStart, window.since),
          lte(usage.windowStart, window.until)
        )
      );
    const row = rows[0];
    return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
  } catch {
    return { requests: 0, tokens: 0 };
  }
}

/** Record the traffic the router served. Returns false when the ledger
 *  could not take it — the run continues either way. */
export function recordUsage(
  db: RouterDb,
  row: { provider: string; model: string; windowStart: number; requests: number; tokens: number }
): Promise<boolean> {
  return bestEffort(async () => {
    await db
      .insert(usage)
      .values(row)
      .onConflictDoUpdate({
        target: [usage.provider, usage.model, usage.windowStart],
        set: {
          requests: sql`${usage.requests} + ${row.requests}`,
          tokens: sql`${usage.tokens} + ${row.tokens}`,
        },
      });
  });
}

/** Record a wall — the rate limit the router saw. */
export function recordLimit(
  db: RouterDb,
  row: {
    provider: string;
    model: string;
    resetAt: number;
    reason: string;
    source: string;
    seenAt: number;
  }
): Promise<boolean> {
  return bestEffort(async () => {
    await db
      .insert(limits)
      .values(row)
      .onConflictDoUpdate({
        target: [limits.provider, limits.model],
        set: { resetAt: row.resetAt, reason: row.reason, source: row.source, seenAt: row.seenAt },
      });
  });
}

/** Lift a wall — the rate limit reset, or the operator cleared it. */
export function clearLimit(db: RouterDb, provider: string, model: string): Promise<boolean> {
  return bestEffort(async () => {
    await db.delete(limits).where(and(eq(limits.provider, provider), eq(limits.model, model)));
  });
}

/** The walls that still hold — a limit whose reset has not come. The reset
 *  IS the end of the wall: at `resetAt` the limit is over, not one tick
 *  more. */
export async function activeLimits(db: RouterDb, now: number): Promise<LimitRow[]> {
  try {
    const rows = await db.select().from(limits).where(gt(limits.resetAt, now));
    return rows.map(r => ({
      provider: r.provider,
      model: r.model,
      resetAt: r.resetAt,
      reason: r.reason,
      source: r.source,
      seenAt: r.seenAt,
    }));
  } catch {
    return [];
  }
}

/** Open a session the router holds. */
export function openSession(
  db: RouterDb,
  row: { id: string; provider: string; model: string; startedAt: number; meta?: string }
): Promise<boolean> {
  return bestEffort(async () => {
    await db
      .insert(sessions)
      .values({ ...row, endedAt: null })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          provider: row.provider,
          model: row.model,
          startedAt: row.startedAt,
          endedAt: null,
          meta: row.meta ?? null,
        },
      });
  });
}

/** Close a session — it is no longer holding the lane. */
export function closeSession(db: RouterDb, id: string, endedAt: number): Promise<boolean> {
  return bestEffort(async () => {
    await db
      .update(sessions)
      .set({ endedAt })
      .where(and(eq(sessions.id, id), sql`${sessions.endedAt} is null`));
  });
}

/** The sessions still open. */
export async function openSessions(db: RouterDb): Promise<SessionRow[]> {
  try {
    const rows = await db.select().from(sessions).where(sql`${sessions.endedAt} is null`);
    return rows.map(r => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      startedAt: r.startedAt,
      meta: r.meta ?? undefined,
    }));
  } catch {
    return [];
  }
}

/** The ledger's size — how much it holds, for `store stats`. */
export async function storeStats(
  db: RouterDb
): Promise<{ usage: number; limits: number; sessions: number }> {
  const count = async (table: typeof usage | typeof limits | typeof sessions): Promise<number> => {
    try {
      const rows = await db.select({ n: sql<number>`count(*)` }).from(table);
      return rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    usage: await count(usage),
    limits: await count(limits),
    sessions: await count(sessions),
  };
}

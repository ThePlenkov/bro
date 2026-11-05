/**
 * The ledger, from the router's surfaces — the health a decision reads, the
 * turn the router served, and the window's counters.
 *
 * The ledger is the router's own record, and it is NOT a gate: a missing,
 * locked or broken store costs the numbers, never the run. Every read here
 * answers with what it knows (and says when it knows nothing); every write
 * is best-effort.
 *
 * The window is the hour — the bucket the ledger's `usage` table is keyed
 * by. A window is not a session: the session's own cost is the turn's, and
 * the window's counters are the scale around it.
 */
import { randomUUID } from 'node:crypto';
import type { HealthSnapshot } from '@broject/core';
import {
  closeSession,
  healthSnapshot,
  migrateStore,
  openSession,
  openStore,
  recordUsage,
  routerStorePath,
  usageInWindow,
} from '@broject/router-store';

/** The window's width — the hour. */
export const WINDOW_MS = 3_600_000;

/** The bucket a moment falls into — the ledger's own window key. */
export function windowStart(now: number = Date.now()): number {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

/** The health — the walls and the sessions, and whether the ledger could
 *  answer at all. An unreadable ledger is no wall: the decision degrades,
 *  the run continues. */
export async function ledgerHealth(
  now: number = Date.now()
): Promise<{ snapshot: HealthSnapshot; known: boolean }> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return { snapshot: {}, known: false };
  }
  try {
    await migrateStore(handle.db);
    return { snapshot: await healthSnapshot(handle.db, now), known: true };
  } catch {
    return { snapshot: {}, known: false };
  } finally {
    handle.close();
  }
}

/** The turn the router served — the traffic counters and the session it
 *  ran in. Best-effort: a ledger that cannot take it costs the numbers,
 *  never the run. Returns whether it was recorded. */
export async function recordTurn(turn: {
  provider: string;
  model: string;
  /** the tokens the turn carried — reported or estimated */
  tokens: number;
  /** a tag for the session — what the turn was */
  tag?: string;
  now?: number;
}): Promise<boolean> {
  const now = turn.now ?? Date.now();
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return false;
  }
  // the id must be unique: two turns in the same millisecond would collide,
  // and the collision resets the first session's endedAt — a ghost open
  // session that skews the health counts
  const session = `ask-${now}-${turn.provider}-${randomUUID()}`;
  try {
    await migrateStore(handle.db);
    await recordUsage(handle.db, {
      provider: turn.provider,
      model: turn.model,
      windowStart: windowStart(now),
      requests: 1,
      tokens: turn.tokens,
    });
    await openSession(handle.db, {
      id: session,
      provider: turn.provider,
      model: turn.model,
      startedAt: now,
      ...(turn.tag === undefined ? {} : { meta: JSON.stringify({ tag: turn.tag }) }),
    });
    await closeSession(handle.db, session, now);
    return true;
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

/** The window's counters for one model — undefined when the ledger could
 *  not be read (an unknown is not a zero). */
export async function windowCounters(
  model: { provider: string; model: string },
  now: number = Date.now()
): Promise<{ requests: number; tokens: number } | undefined> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return undefined;
  }
  try {
    await migrateStore(handle.db);
    return await usageInWindow(handle.db, {
      provider: model.provider,
      model: model.model,
      since: now - WINDOW_MS,
      until: now,
    });
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}

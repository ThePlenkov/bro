/**
 * Health — the read-model over the ledger.
 *
 * One verdict per served model: can it serve right now, and if not, why
 * and until when. The ledger holds the FACTS (the wall the router saw,
 * the sessions it holds); the policy about whether those facts block a
 * request belongs to the serving path, which knows the caps.
 *
 * Absent = available: a model the ledger never heard of is not walled.
 */
import {
  healthKey,
  type HealthReason,
  type HealthSnapshot,
  type HealthVerdict,
} from '@broject/core';
import { activeLimits, openSessions, type RouterDb } from './store.ts';

/** The reasons a wall may carry — the shared vocabulary. */
const REASONS: readonly HealthReason[] = ['rate-limited', 'quota', 'session-cap', 'lane-busy'];

/** A reason the ledger does not know still has to mean something — the
 *  wall is real even when the writer spelled it differently. */
function asReason(written: string): HealthReason {
  return REASONS.find(r => r === written) ?? 'rate-limited';
}

/** The snapshot — a map with NO prototype. The key is bro's own
 *  `<provider>/<model>` (a lane without a model keys as the bare
 *  provider), and a provider named `__proto__` must land as an ordinary
 *  own entry — a wall the router knows — instead of a write to
 *  `Object.prototype`. */
function emptySnapshot(): HealthSnapshot {
  return Object.create(null) as HealthSnapshot;
}

/** The walls — a model that cannot serve until the reset comes. */
async function wallVerdicts(db: RouterDb, now: number): Promise<HealthSnapshot> {
  const snapshot = emptySnapshot();
  for (const limit of await activeLimits(db, now)) {
    const key = healthKey(limit.provider, limit.model);
    snapshot[key] = {
      available: false,
      reason: asReason(limit.reason),
      until: limit.resetAt,
      detail: `${limit.reason} until ${new Date(limit.resetAt).toISOString()} (seen by ${limit.source})`,
    };
  }
  return snapshot;
}

/** The sessions the router holds — a fact the caller weighs against its
 *  own cap, never a verdict on its own. */
async function sessionFacts(db: RouterDb, snapshot: HealthSnapshot): Promise<void> {
  for (const session of await openSessions(db)) {
    const key = healthKey(session.provider, session.model);
    const verdict: HealthVerdict = snapshot[key] ?? { available: true };
    verdict.openSessions = (verdict.openSessions ?? 0) + 1;
    snapshot[key] = verdict;
  }
}

/** The snapshot — what the route resolver reads. */
export async function healthSnapshot(
  db: RouterDb,
  now: number = Date.now()
): Promise<HealthSnapshot> {
  const snapshot = await wallVerdicts(db, now);
  await sessionFacts(db, snapshot);
  return snapshot;
}

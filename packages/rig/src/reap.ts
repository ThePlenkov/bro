/**
 * Registry reap selection — which collected agent entries a prune may
 * remove. Moved from `commands/agents.ts` in the fleet-lifecycle
 * extraction (bro-jamp7): the terminal-state + age + identity-pin
 * verdict is engine; the connector collection and registry removal
 * stay in the command layer.
 */
import type { AgentInfo, AgentState } from '@broject/core';

/** States prune reaps — 'blocked' stays: a wall-parked worker is
 *  respawn-able debt, not litter. */
export const REAP_STATES = new Set<AgentState>(['exited', 'lost', 'stopped']);

/** Which collected entries prune may reap. `expected` pins the observed
 *  identity per molStep — removeAgentRegistryEntries re-checks it under
 *  the lock so a respawn between snapshot and removal can't be reaped
 *  as the terminal agent it replaced. Age counts from spawnedAt — the
 *  registry records no exit timestamp; an entry with none can't
 *  age-verify and stays. */
export function selectReapable(
  backends: Array<{ conn: { name: string }; agents: AgentInfo[]; degraded?: string }>,
  cutoff: number | undefined
): {
  reapable: string[];
  skipped: string[];
  expected: Map<string, { agentId?: string; spawnedAt?: string; pid?: number }>;
} {
  const reapable: string[] = [];
  const skipped: string[] = [];
  const expected = new Map<string, { agentId: string; spawnedAt?: string; pid?: number }>();
  for (const b of backends) {
    // a degraded backend's states are unproven — its entries stay
    if (b.degraded !== undefined) {
      skipped.push(`${b.conn.name}: ${b.degraded}`);
      continue;
    }
    for (const a of b.agents) {
      const t = a.spawnedAt === undefined ? Number.NaN : Date.parse(a.spawnedAt);
      if (!REAP_STATES.has(a.state) || (cutoff !== undefined && (Number.isNaN(t) || t >= cutoff))) {
        continue;
      }
      reapable.push(a.molStep);
      expected.set(a.molStep, { agentId: a.id, spawnedAt: a.spawnedAt, pid: a.pid });
    }
  }
  return { reapable, skipped, expected };
}

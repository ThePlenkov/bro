/**
 * Copilot landed-slot sweep — retire `.slot` reservations whose
 * remote task already landed in the refreshed live set, so a landed
 * spawn is not double-counted (live + reservation) under the
 * admission contract.
 *
 * Leaf module — imports externals only.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readAgentRegistry } from '@broject/core';

/** One landed entry's own reservations — slot names carry
 *  `<agentId>-<stamp>.slot`, so the live task's agent sweeps its own. */
function sweepEntrySlots(slotsDir: string, names: readonly string[], agentId: string): void {
  for (const name of names) {
    const landed = name.startsWith(`${agentId}-`) && name.endsWith('.slot');
    if (landed) {
      try {
        rmSync(join(slotsDir, name), { force: true });
      } catch {
        // a racing reaper already got it
      }
    }
  }
}

/** Retire `.slot` reservations whose remote task already landed in the
 *  refreshed live set — the admission contract a landed spawn must not
 *  double-count (live + reservation) under. The correlation needs the
 *  repo's registry (agentId → taskId), so the sweep rides connector
 *  reads rather than the host-wide plane: each repo sweeps its own
 *  slots, and a cross-repo spawn's reservation gets retired by that
 *  repo's next refresh — the TTL bounds whatever remains. */
export function copilotSweepLandedSlots(dir: string, slotsDir: string, live: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(slotsDir);
  } catch {
    return; // no/unreadable dir — the tally reports its own verdict
  }
  for (const e of Object.values(readAgentRegistry(dir))) {
    const landed = e.backend === 'copilot' && typeof e.taskId === 'string' && live.has(e.taskId);
    if (landed) {
      sweepEntrySlots(slotsDir, names, e.agentId);
    }
  }
}

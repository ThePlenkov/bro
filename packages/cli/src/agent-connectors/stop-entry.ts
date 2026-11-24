/**
 * The connector `.stop` tail — recording `stopped` on a registry row
 * after the backend's kill landed. Every backend's stop ends the same
 * way: under the registry lock (re-entrant — the same lock the spawner
 * holds), re-verify the row still names this run, confirm nothing live
 * remains, patch `stopped: true`, drop the work marker. A respawn
 * during the kill wait re-probes and re-pins the entry under that same
 * lock — skipping the re-check would stamp `stopped` + the marker drop
 * on a live, respawned entry.
 */
import {
  type AgentRegistryEntry,
  patchAgentRegistry,
  readAgentRegistry,
  withAgentRegistryLock,
} from '@broject/core';
import { dropWorkMarker } from './work-markers.ts';

/** A backend liveness probe for the post-kill re-check — 'running'
 *  still owns the entry, 'dead' frees it, 'unknown' is unverifiable. */
export interface StopProbe {
  live: 'running' | 'dead' | 'unknown';
  err?: string;
}

/** 'running' keeps the entry, 'unknown' refuses to mark — an
 *  unverifiable probe must not record 'stopped' on something that may
 *  still be live, so it throws instead of returning a verdict. */
function stopProbeStillLive(
  probe: (() => StopProbe | undefined) | undefined,
  id: string,
  what: string
): boolean {
  const p = probe?.();
  if (p === undefined || p.live === 'dead') {
    return false;
  }
  if (p.live === 'unknown') {
    throw new Error(`cannot verify ${id}'s ${what} stopped — ${p.err ?? 'unverifiable'}`);
  }
  return true;
}

/** The row still names THIS run — a respawn reuses the agentId, so
 *  `agentId`+`spawnedAt` identity is what separates "our row" from
 *  "the run that replaced us". */
function entryStillOurs(cur: AgentRegistryEntry | undefined, entry: AgentRegistryEntry): boolean {
  return cur !== undefined && cur.agentId === entry.agentId && cur.spawnedAt === entry.spawnedAt;
}

/** Record `stopped` on the registry row — but only while the row still
 *  names THIS run and nothing live keeps it: a respawn reuses the
 *  agentId, so `agentId`+`spawnedAt` identity is what separates "our
 *  row" from "the run that replaced us". `stillLive` is the caller's
 *  extra post-kill probe (native's unit liveness); `probe`/`id`/`what`
 *  are the backend's own verify-before-mark (tmux session, docker
 *  container) — 'running' skips, 'unknown' throws. */
export function markStoppedEntry(args: {
  dir: string;
  molStep: string;
  entry: AgentRegistryEntry;
  id: string;
  what?: string;
  stillLive?: () => boolean;
  probe?: () => StopProbe | undefined;
}): void {
  const { dir, molStep, entry, id } = args;
  withAgentRegistryLock(dir, () => {
    if (!entryStillOurs(readAgentRegistry(dir)[molStep], entry)) {
      return; // respawned or gone — the live run owns the entry
    }
    if (args.stillLive?.() === true) {
      return; // the unit (wrapper/descendant) lives — the live run owns the entry
    }
    if (stopProbeStillLive(args.probe, id, args.what ?? 'session')) {
      return; // still alive — the live run owns the entry
    }
    try {
      patchAgentRegistry(dir, molStep, { stopped: true });
    } catch {
      // the marker removal below still records intent
    }
    dropWorkMarker(dir, molStep, entry);
  });
}

/** Bounded kill-wait poll — let a kill land before recording the stop:
 *  `stopped` on a still-live backend would let a respawn run alongside
 *  the dying agent. Returns when `stillLive` first answers false or the
 *  deadline passes; the caller's lock-time re-check is the verdict that
 *  actually decides, so the poll only needs to be honest, not exact. */
export async function pollUntilGone(stillLive: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (stillLive() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25)); // NOSONAR — bounded kill-wait poll
  }
}

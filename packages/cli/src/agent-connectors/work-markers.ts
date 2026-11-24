/**
 * Agent work markers + agents-home paths — the filesystem half of the
 * connector's spawn bookkeeping. `<git-common-dir>/bro/agents/` holds
 * per-agent artifacts (prompt, log, exit status) in the shared dir, not
 * the worktree: a prompt file in the tree would be a dirty file the
 * agent might commit. `<common>/bro/hooks/agent-<id>.work` markers make
 * a live agent visible to session-start parallel detection.
 *
 * Leaf module — imports externals only, so every other
 * agent-connectors module (core included) can sit above it.
 */
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AgentRegistryEntry,
  gitTry,
  procStat,
  readAgentRegistry,
  withAgentRegistryLock,
} from '@broject/core';

/** `<git-common-dir>/bro/agents/` — per-agent artifacts (prompt, log,
 *  exit status) live in the shared dir, not the worktree: a prompt file
 *  in the tree would be a dirty file the agent might commit. */
export function agentsHome(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.code === 0 ? r.out.trim() : '';
  return common === '' ? null : join(common, 'bro', 'agents');
}

/** agentIds become filenames under shared dirs — a tampered registry
 *  entry's `../x` must not escape them. Minted ids are `<backend>-<hex>`;
 *  the pattern starts alnum so `.`/`..` segments can never form. */
export const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `<common>/bro/agents/<agentId>.prompt.md` — the spawn-time rendered
 *  instructions. Respawn of a custom-prompt agent (a fixer round's
 *  thread context, say) reuses it — the agentId survives process death,
 *  so the file does too. Null for an unsafe or unanchorable id. */
export function agentPromptPath(dir: string, agentId: string): string | null {
  const home = agentsHome(dir);
  return home === null || !SAFE_AGENT_ID.test(agentId) ? null : join(home, `${agentId}.prompt.md`);
}

/** `<common>/bro/hooks/agent-<id>.work` — hooks markers are
 *  `<common>/bro/hooks/<session>.<aspect>`; the agent gets a synthetic
 *  session name so `otherLiveWork` (session-start parallel detection)
 *  reports it as live work on the molStep. Null outside a common dir. */
export function workMarkerPath(dir: string, agentId: string): string | null {
  if (!SAFE_AGENT_ID.test(agentId)) {
    return null;
  }
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.code === 0 ? r.out.trim() : '';
  return common === '' ? null : join(common, 'bro', 'hooks', `agent-${agentId}.work`);
}

export function writeWorkMarker(dir: string, agentId: string, molStep: string, pid?: number): void {
  try {
    const marker = workMarkerPath(dir, agentId);
    if (marker === null) {
      return;
    }
    mkdirSync(dirname(marker), { recursive: true });
    // stamp the agent's real pid (+start identity) so a dead agent's
    // marker reads as residue immediately, not after the freshness
    // window — mtime-only markers from a killed session used to occupy
    // a worktree for a day (bro-b87b)
    const start = typeof pid === 'number' && pid > 0 ? procStat(pid)?.start : undefined;
    // no starttime = no reuse identity — better an ownerless marker on
    // the mtime window than a tag a recycled pid can impersonate
    const tag = start ? ` ${pid} ${start}` : '';
    writeFileSync(marker, `${Date.now()}${tag}\n${molStep}\n`);
  } catch {
    // marker is advisory — never break a spawn over detection cosmetics
  }
}

/** Unlink the .work marker — but revalidate the registry first: a
 *  respawn reuses the agentId, so a caller working from a stale snapshot
 *  (nativeState/recordedDeath list entries outside the registry lock)
 *  would unlink the fresh marker the new run just wrote (bro-78qb).
 *  Drop only when the registry no longer points a NEWER same-agentId
 *  spawn at this marker. */
export function dropWorkMarker(dir: string, molStep: string, entry: AgentRegistryEntry): void {
  try {
    // revalidate + unlink must not interleave with a respawn's registry
    // write + marker write — same lock the spawner holds (re-entrant)
    withAgentRegistryLock(dir, () => {
      const cur = readAgentRegistry(dir)[molStep];
      if (cur !== undefined && cur.agentId === entry.agentId && cur.spawnedAt !== entry.spawnedAt) {
        return; // respawned — the live run owns the marker now
      }
      const marker = workMarkerPath(dir, entry.agentId);
      if (marker !== null) {
        rmSync(marker, { force: true });
      }
    });
  } catch {
    // best-effort
  }
}

/** Marker mtime IS the liveness signal detection reads — refresh it
 *  while the agent is verifiably alive or a long-running worker goes
 *  stale (and a dead one's leftover marker stops looking live). */
export function touchWorkMarker(dir: string, agentId: string): void {
  try {
    const marker = workMarkerPath(dir, agentId);
    if (marker !== null && existsSync(marker)) {
      const now = new Date();
      utimesSync(marker, now, now);
    }
  } catch {
    // best-effort
  }
}

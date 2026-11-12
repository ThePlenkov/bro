/**
 * Orchestrator role gate — the `role:orchestrator@<project>` exclusive
 * claim from the fleet spec (specs/sessions/bro-izpyk.md; impl spec
 * specs/bro-izpyk.3.md). `bro mode orchestrate` acquires the claim; the
 * hook-driven supervisor rearm paths ask `orchestratorRoleAllows`
 * before spawning a cadence.
 *
 * Semantics (fail-open, like modes):
 *  - `BRO_AGENT_ID` set → never (the spawned-worker veto — same rule
 *    `isOrchestratorSession` encodes for the CLI guards that stay sync).
 *  - Role unclaimed → allowed. Two sessions can both be de-facto
 *    orchestrators only until one declares `bro mode orchestrate` —
 *    that is today's behavior, preserved.
 *  - Role held by this session → allowed.
 *  - Role held by a different live session → refused/quiet. That is
 *    the exclusivity the spec buys.
 *  - Session unresolvable (library caller, no hook identity) → the
 *    legacy env verdict stands; there is no SessionKey to check.
 */
import {
  facade,
  hookHostOf,
  loadConfig,
  orchestratorRoleUri,
  sessionProject,
  type ClaimFacade,
  type ClaimResult,
  type SessionKey,
} from '@broject/core';
import { agentOwner } from './proc-owner.ts';

export interface RoleSession {
  host: string;
  sid: string;
}

/** Resolve the firing session for a hook/CLI context — explicit
 *  sessionId+host win; host falls back to the env detection the hook
 *  spool uses. null = no session identity (caller keeps legacy rules). */
export function roleSessionOf(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): RoleSession | null {
  const sid = sessionId?.trim();
  if (sid === undefined || sid === '') {
    return null;
  }
  return { host: hookHostOf(env), sid };
}

function claimsFor(dir: string): ClaimFacade {
  // core loadConfig, NOT plugins.ts's loadBroConfig — this module is
  // imported by the pulse leaf connectors, which must stay out of the
  // plugins↔commands import cycle (drive-pulse.ts's module comment).
  const prefer = loadConfig(dir).connectors;
  return facade('claims', { dir }, prefer === undefined ? {} : { prefer });
}

/** May this session act as the project orchestrator? See the module
 *  comment for the verdict table. `session` null → env-only legacy
 *  answer (true when BRO_AGENT_ID is unset). */
export async function orchestratorRoleAllows(
  dir: string,
  session: RoleSession | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const agentId = env.BRO_AGENT_ID;
  if (agentId !== undefined && agentId !== '') {
    return false;
  }
  if (session === null) {
    return true;
  }
  const project = sessionProject(dir);
  if (project === undefined) {
    return true; // no project identity — nothing to be exclusive over
  }
  try {
    const claims = claimsFor(dir);
    const rows = await claims.list({ resource: orchestratorRoleUri(project) });
    return !rows.some(r => !(r.host === session.host && r.sid === session.sid));
  } catch {
    return true; // ledger down → legacy behavior, never a hard gate
  }
}

/** Acquire `role:orchestrator@<project>` for `session` — the
 *  `bro mode orchestrate` write path. The holder pid is this process's
 *  agent root so a dead orchestrator frees the role on the next claim
 *  probe instead of waiting out the TTL. */
export async function acquireOrchestratorRole(
  dir: string,
  session: SessionKey,
  opts: { ttlMs?: number } = {}
): Promise<ClaimResult> {
  const project = sessionProject(dir);
  if (project === undefined) {
    return { ok: false, conflict: null };
  }
  const owner = agentOwner();
  return claimsFor(dir).claim(orchestratorRoleUri(project), session, {
    exclusive: true,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(owner !== null ? { pid: owner.pid, pidStart: owner.start } : {}),
    dir,
  });
}

/** Release the role claim when this session holds it — mode leaves
 *  orchestrate. Best-effort: a missing row is already released. */
export async function releaseOrchestratorRole(dir: string, session: SessionKey): Promise<void> {
  const project = sessionProject(dir);
  if (project === undefined) {
    return;
  }
  try {
    await claimsFor(dir).release(orchestratorRoleUri(project), session);
  } catch {
    // release is best-effort — a stuck row dies with its TTL/pid anyway
  }
}

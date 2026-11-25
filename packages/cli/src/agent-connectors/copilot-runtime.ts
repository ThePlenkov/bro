/** Copilot connector session and task helpers. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  classifyExitCause,
  ghHost,
  rateDeathBackoff,
  sessionPlane,
  sessionQuotaConfig,
  sessionSlotsDir,
  withAgentRegistryLock,
  writeAgentRegistry,
  type AgentCause,
  type AgentInfo,
  type AgentRegistryEntry,
} from '@broject/core';
import {
  COPILOT_COUNT_TTL_MS,
  copilotCountFile,
  readCopilotCount,
  writeCopilotCount,
} from '../session-planes/copilot.ts';
import {
  copilotEntryRepo,
  copilotHasPullArtifact,
  copilotHeadRef,
  copilotRemoteRepo,
} from './copilot-refs.ts';
import {
  type CopilotSession,
  type CopilotTask,
  copilotLatestSession,
  copilotSessionError,
  copilotTaskIdOf,
  copilotTaskState,
} from './copilot-tasks.ts';
import {
  AgentNotFound,
  SpawnError,
  entryRunId,
  infoCause,
  infoLearn,
  infoProvenance,
  patchAgentRegistry,
  probeState,
  readAgentRegistry,
  externalGuardOf,
  type AgentConnectorEnv,
  type ListResult,
  type GhResult,
  type SessionQuotaLane,
  type TmuxLiveness,
} from './spawn-harness.ts';
import { dockerRun } from './docker-basic-harness.ts';
import { copilotSweepLandedSlots } from './copilot-slots.ts';

export function ghRun(args: string[], timeoutMs = 30_000): GhResult {
  const proc = spawnSync('gh', args, {
    // NOSONAR — PATH lookup is the contract (same as docker/git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
    missing: (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  };
}

/** REST task states that still burn budget — everything a live task
 *  can read as on the documented surface (queued → in_progress →
 *  terminal; idle and waiting_for_user are suspended-but-alive). */
export const COPILOT_LIVE_STATES = new Set(['queued', 'in_progress', 'idle', 'waiting_for_user']);

/** The PR the task opened — resolved via the pushes' head_ref, the
 *  same join `gh agent-task view` hydrates internally. Absent until a
 *  pull artifact exists; a failed read stays unpinned rather than
 *  blocking the state read it rode in on. */
export function copilotResolvePr(repo: string, headRef: string): { pr?: number; prUrl?: string } {
  const owner = repo.split('/')[0];
  const r = ghRun([
    'api',
    `repos/${repo}/pulls?head=${owner}:${encodeURIComponent(headRef)}&state=all&per_page=1`,
  ]);
  if (r.code !== 0) {
    return {};
  }
  try {
    const v = JSON.parse(r.out) as unknown;
    const first = Array.isArray(v) ? (v[0] as { number?: unknown; html_url?: unknown }) : undefined;
    return {
      pr: typeof first?.number === 'number' ? first.number : undefined,
      prUrl: typeof first?.html_url === 'string' ? first.html_url : undefined,
    };
  } catch {
    return {};
  }
}

/** The agents-web session URL — the attach/log target. Requires the
 *  pinned PR; a task that never opened one has no per-session page. */
export function copilotSessionUrl(
  repo: string | undefined,
  pr: unknown,
  sessionId: unknown
): string | undefined {
  return repo !== undefined && typeof pr === 'number' && typeof sessionId === 'string'
    ? `https://${ghHost()}/${repo}/pull/${pr}/agent-sessions/${sessionId}`
    : undefined;
}

/** One task's REST read — `{ok:false}` is "the API couldn't say"
 *  (down, unauthorized, preview drift), never a fabricated corpse. */
export function copilotFetchTask(taskId: string): {
  ok: boolean;
  task?: CopilotTask;
  err?: string;
} {
  const r = ghRun(['api', `agents/tasks/${taskId}`]);
  if (r.missing) {
    return { ok: false, err: 'gh not on PATH' };
  }
  if (r.code !== 0) {
    return { ok: false, err: r.err !== '' ? r.err : `gh api exited ${r.code}` };
  }
  try {
    const task = JSON.parse(r.out) as CopilotTask;
    return typeof task === 'object' && task !== null
      ? { ok: true, task }
      : { ok: false, err: 'unparseable task JSON' };
  } catch {
    return { ok: false, err: 'gh api returned unparseable JSON' };
  }
}

/** The account's live task id set — filtered, paginated listings for
 *  the fleet walk and the session-plane count refresh. `undefined` =
 *  the API couldn't answer (fail closed — an unverifiable count
 *  occupies, never frees). An incomplete inventory is marked explicitly
 *  (pagination hit the limit) so callers can fail closed rather than
 *  caching a truncated set as complete. */
export function copilotLiveTaskIds(): { ids: Set<string>; incomplete: boolean } | undefined {
  const ids = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const r = ghRun([
      'api',
      `agents/tasks?state=${[...COPILOT_LIVE_STATES].join(',')}&per_page=100&page=${page}`,
    ]);
    if (r.code !== 0) {
      return undefined;
    }
    try {
      const v = JSON.parse(r.out) as { tasks?: unknown };
      const batch = Array.isArray(v.tasks)
        ? v.tasks
            .map(t => (t as { id?: unknown })?.id)
            .filter((x): x is string => typeof x === 'string')
        : [];
      for (const id of batch) {
        ids.add(id);
      }
      if (batch.length < 100) {
        return { ids, incomplete: false };
      }
      if (page === 10) {
        // full page at the limit — cannot tell complete from truncated
        return { ids, incomplete: true };
      }
    } catch {
      return undefined;
    }
  }
  return { ids, incomplete: false };
}

/** copilot occupancy — the remote probe is the same honesty rule as
 *  docker's: recorded death frees the slot regardless (a stopped/exit
 *  entry holds no live task), a task proven absent from the live set
 *  frees, and an unverifiable read OCCUPIES — a maybe-running remote
 *  worker is a maybe-burning one. An entry with no taskId was never
 *  dispatched; nothing remote can hold its slot. */
export function copilotOccupies(entry: AgentRegistryEntry, live: Set<string> | undefined): boolean {
  if (entry.stopped === true || entry.exitStatus !== undefined) {
    return false;
  }
  const taskId = copilotTaskIdOf(entry);
  return taskId !== undefined && (live === undefined || live.has(taskId));
}

/** Generation-safe merge of remote-learned facts into the registry —
 *  the same bind-to-identity rule ensureExitCause's advisory write
 *  uses: a respawn between our read and this patch owns the entry now,
 *  and the old task's drift must not mislabel it. The entry object is
 *  updated either way so THIS read's verdict is authoritative. */
export function copilotPatch(
  dir: string,
  molStep: string,
  entry: AgentRegistryEntry,
  patch: Record<string, unknown>
): void {
  Object.assign(entry, patch);
  try {
    withAgentRegistryLock(dir, () => {
      const reg = readAgentRegistry(dir);
      const cur = reg[molStep];
      if (
        cur === undefined ||
        cur.agentId !== entry.agentId ||
        cur.spawnedAt !== entry.spawnedAt ||
        cur.runId !== entry.runId
      ) {
        return;
      }
      reg[molStep] = { ...cur, ...patch };
      writeAgentRegistry(dir, reg);
    });
  } catch {
    // advisory — the in-memory entry already carries the verdict
  }
}

/** What one task read teaches the registry — session/pr/run handles
 *  pin as they appear, taskState tracks drift, and a terminal state
 *  harvests the exit record (exitStatus+cause+resetAt, or stopped on
 *  cancelled) so the recorded-death ladder reports it like a local
 *  death. The terminal half lives in copilotTerminalPatch. */
/** The terminal-state half of the absorb patch — cancelled reads
 *  stopped, completed the ok exit record, failed/timed_out the
 *  classified one. The classified death runs the same instant-death
 *  backoff ensureExitCause applies (spec bro-9eeld) — a preclassified
 *  cause bypasses ensureExitCause's escalation, so the streak and the
 *  escalated hold are computed here: the session's updated_at is the
 *  honest remote death stamp, and any outcome that isn't a fast
 *  rate-limit death clears the streak. */
export function copilotTerminalPatch(
  state: string,
  task: CopilotTask,
  entry: AgentRegistryEntry
): Record<string, unknown> {
  if (state === 'cancelled') {
    return { stopped: true, rateStreak: undefined };
  }
  if (state === 'completed') {
    return { exitStatus: 0, cause: 'ok', rateStreak: undefined };
  }
  if (state !== 'failed' && state !== 'timed_out') {
    return {};
  }
  // terminal verdicts are idempotent — a repeated harvest of the same
  // classified death must not stack another backoff streak, or one
  // failure escalates 30s→60s→120s on nothing but status reads
  if (entry.cause !== undefined && entry.cause !== 'ok') {
    return {
      exitStatus: typeof entry.exitStatus === 'number' ? entry.exitStatus : 1,
      cause: entry.cause,
      resetAt: entry.resetAt,
      rateStreak: entry.rateStreak,
    };
  }
  const stamp = Date.parse(String(copilotLatestSession(task)?.updated_at ?? ''));
  const exitAt = Number.isNaN(stamp) ? Date.now() : stamp;
  const c =
    state === 'timed_out'
      ? { cause: 'crash' as AgentCause, resetAt: undefined }
      : classifyExitCause(copilotSessionError(task), 1, exitAt);
  const back = rateDeathBackoff(entry, c.cause, c.resetAt, exitAt);
  return {
    exitStatus: 1,
    cause: c.cause,
    resetAt: back.resetAt,
    rateStreak: back.streak > 0 ? back.streak : undefined,
  };
}

export function copilotAbsorb(
  dir: string,
  molStep: string,
  entry: AgentRegistryEntry,
  task: CopilotTask
): void {
  const patch: Record<string, unknown> = {};
  const state = copilotTaskState(task);
  if (state !== '' && entry.taskState !== state) {
    patch.taskState = state;
  }
  const session = copilotLatestSession(task);
  if (typeof session?.id === 'string' && session.id !== entry.sessionId) {
    patch.sessionId = session.id;
    patch.attach = `gh agent-task view ${session.id} --log --follow`;
  }
  const runId = session?.workflow_run_id;
  if (typeof runId === 'number' && runId !== entry.workflowRun) {
    patch.workflowRun = runId;
  }
  const headRef = copilotHeadRef(task);
  if (headRef !== undefined && headRef !== entry.branch) {
    patch.branch = headRef;
  }
  const repo = copilotEntryRepo(entry);
  if (
    entry.pr === undefined &&
    copilotHasPullArtifact(task) &&
    repo !== undefined &&
    headRef !== undefined
  ) {
    const { pr, prUrl } = copilotResolvePr(repo, headRef);
    if (pr !== undefined) {
      patch.pr = pr;
      patch.prUrl = prUrl ?? `https://${ghHost()}/${repo}/pull/${pr}`;
    }
  }
  const sessionUrl = copilotSessionUrl(
    repo,
    patch.pr ?? entry.pr,
    patch.sessionId ?? entry.sessionId
  );
  if (sessionUrl !== undefined && sessionUrl !== entry.sessionUrl) {
    patch.sessionUrl = sessionUrl;
  }
  Object.assign(patch, copilotTerminalPatch(state, task, entry));
  if (Object.keys(patch).length > 0) {
    copilotPatch(dir, molStep, entry, patch);
  }
}

/** Liveness verdict for one registry entry — the tri-state probeState
 *  consumes, plus the raw remote state: 'queued' is live but not yet
 *  running, and the reported AgentInfo.state should say so. 'unknown'
 *  is every unreadable read (gh missing, auth, 404 on a task the API
 *  rotated out, preview drift) — degraded, never a corpse. An entry
 *  without a taskId was never dispatched: 'dead' is the honest read. */
export function copilotTaskProbe(
  dir: string,
  molStep: string,
  entry: AgentRegistryEntry
): { live: TmuxLiveness; err?: string; state?: string } {
  const taskId = copilotTaskIdOf(entry);
  if (taskId === undefined) {
    return { live: 'dead' };
  }
  const f = copilotFetchTask(taskId);
  if (!f.ok) {
    return { live: 'unknown', err: f.err };
  }
  copilotAbsorb(dir, molStep, entry, f.task!);
  const state = copilotTaskState(f.task!);
  if (COPILOT_LIVE_STATES.has(state)) {
    return { live: 'running', state };
  }
  if (
    state === 'completed' ||
    state === 'failed' ||
    state === 'timed_out' ||
    state === 'cancelled'
  ) {
    return { live: 'dead', state };
  }
  // a state this build doesn't know — preview drift reads 'unknown',
  // not 'lost'
  return { live: 'unknown', err: `unrecognised task state '${state}'`, state };
}

/** One registry entry → AgentInfo — the shared shape toCopilotInfo and
 *  list() build. 'queued' reports 'spawned' rather than 'running': the
 *  task exists remotely but no session burns yet. */
export function copilotInfoFor(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  probe: { live: TmuxLiveness; state?: string }
): AgentInfo {
  const st = probeState(dir, home, molStep, entry, probe.live);
  return {
    id: entry.agentId,
    spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
    runId: entryRunId(entry),
    molStep,
    backend: entry.backend,
    state: st === 'running' && probe.state === 'queued' ? 'spawned' : st,
    ...infoCause(entry),
    ...infoLearn(entry),
    ...infoProvenance(entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    // no local log exists — the session URL is the attach/log pointer
    log: typeof entry.sessionUrl === 'string' ? entry.sessionUrl : undefined,
  };
}

export function toCopilotInfo(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): AgentInfo {
  return copilotInfoFor(dir, home, molStep, entry, copilotTaskProbe(dir, molStep, entry));
}

/** The session quota a copilot spawn rides — a remote kind needs no
 *  cli detection: the plane is 'copilot' unless agents.copilot.
 *  sessionKind names another registered one (the only sensible reroute
 *  is another remote-count plane sharing the cache contract). */
export function copilotSessionQuota(env: AgentConnectorEnv): SessionQuotaLane | undefined {
  const declared = env.agents['copilot']?.['sessionKind'];
  const kind = typeof declared === 'string' && declared !== '' ? declared : 'copilot';
  const quota = sessionQuotaConfig(env.agents, kind);
  if (quota === undefined) {
    return undefined;
  }
  const plane = sessionPlane(kind);
  if (plane === undefined) {
    // a capped kind with no registered plane is a config bug — refuse
    // loudly rather than spawn past a quota the operator armed
    throw new SpawnError(
      `agents.copilot.sessionKind '${kind}' has no registered session plane — ` +
        `cannot enforce agents.${kind}.maxSessions/maxWorkers`,
      'config'
    );
  }
  return { plane, agents: env.agents };
}

/** Refresh the count cache the copilot plane serves — best-effort and
 *  only while the cache has a reader (an unarmed copilot quota AND a
 *  disarmed external guard means none; the extra gh call is pure
 *  waste). A failed refresh just leaves the
 *  cache stale, which countLive already fails closed on. The landed
 *  sweep retires this repo's reservations the remote count now sees.
 *  Readers are the quota lanes AND the external guard's copilot probe —
 *  either one armed keeps the refresh paying. An incomplete inventory is
 *  not cached as complete; when pagination hits the limit we do not write
 *  a complete cache. */
export function copilotRefreshCount(dir: string, env: AgentConnectorEnv): void {
  // an unarmed copilot lane has no reader — unless the external guard
  // is armed: its copilot probe reads the same cache, so a rig that
  // never dispatches copilot work still refreshes it (spec bro-eqi2d)
  if (
    sessionQuotaConfig(env.agents, 'copilot') === undefined &&
    externalGuardOf(env) === undefined
  ) {
    return;
  }
  const resDir = env.agents['copilot']?.['reservationsDir'];
  const observedAt = Date.now();
  const res = copilotLiveTaskIds();
  if (res !== undefined) {
    if (res.incomplete) {
      // Do not cache a truncated/incomplete inventory as complete.
      // Leave existing cache as-is (or absent); probe will treat absent/stale as not active,
      // but better to not write partial complete state - explicitly don't write complete cache.
      return;
    }
    const slots = sessionSlotsDir('copilot', typeof resDir === 'string' ? resDir : undefined);
    writeCopilotCount(typeof resDir === 'string' ? resDir : undefined, [...res.ids], observedAt);
    copilotSweepLandedSlots(dir, slots, res.ids);
  }
}

/** The external guard's remote preflight — refresh the copilot
 *  inventory when it is absent or stale so the guard's copilot plane
 *  sees foreign remote tasks even on a rig that never dispatches
 *  copilot work (the connector's own refreshes only fire on copilot
 *  lanes). Runs OUTSIDE the spawn critical section — the gh call must
 *  not stall the registry lock. Best-effort like every refresh: a
 *  failed fetch leaves the cache absent/stale and the plane reports
 *  quiet rather than inventing remote state. */
export function primeCopilotForExternalGuard(dir: string, env: AgentConnectorEnv): void {
  if (externalGuardOf(env) === undefined) {
    return;
  }
  const resDir = env.agents['copilot']?.['reservationsDir'];
  const cache = readCopilotCount(copilotCountFile(typeof resDir === 'string' ? resDir : undefined));
  if (cache !== undefined) {
    const age = Date.now() - cache.at;
    if (age >= 0 && age < COPILOT_COUNT_TTL_MS) {
      return; // fresh enough — the plane trusts it inside the TTL
    }
  }
  copilotRefreshCount(dir, env);
}

// --- devin (external sessions) ------------------------------------------------------

/** One discovered devin session → an AgentInfo row. The lock-name is
 *  the session's own ref (`devin --resume <name>`); the id prefers the
 *  worker's BRO_AGENT_ID badge — the registry correlation the
 *  discovered-session fold already keys on. `molStep` reads the
 *  worker's BRO_BEAD_ID pin, then the badge, then the session name —
 *  an unbadged interactive session names itself, never a phantom
 *  step. */

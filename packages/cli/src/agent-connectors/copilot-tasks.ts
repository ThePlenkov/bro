/**
 * Copilot task shapes + accessors — the loosely-typed REST task the
 * `gh api` reads return; fields narrow at use, so a preview schema
 * drift degrades a read instead of crashing it.
 *
 * Leaf module — imports externals only; core re-imports every piece.
 */
import type { AgentRegistryEntry } from '@broject/core';

/** Task ids are server-minted UUIDs; the registry pin is trusted only
 *  when it can't smuggle a path/query segment into the REST URL. */
const COPILOT_SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The loosely-typed REST task — fields narrow at use, so a preview
 *  schema drift degrades a read instead of crashing it. */
export interface CopilotTask {
  id?: unknown;
  state?: unknown;
  artifacts?: unknown;
  sessions?: unknown;
}

export interface CopilotSession {
  id?: unknown;
  state?: unknown;
  workflow_run_id?: unknown;
  error?: unknown;
  head_ref?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export function copilotTaskIdOf(entry: AgentRegistryEntry): string | undefined {
  const id = entry.taskId;
  return typeof id === 'string' && COPILOT_SAFE_TASK_ID.test(id) ? id : undefined;
}

export function copilotTaskState(task: CopilotTask): string {
  return typeof task.state === 'string' ? task.state : '';
}

export function copilotTaskSessions(task: CopilotTask): CopilotSession[] {
  return Array.isArray(task.sessions)
    ? task.sessions.filter((s): s is CopilotSession => typeof s === 'object' && s !== null)
    : [];
}

/** The latest session a task reports — sessions accumulate across
 *  retries/steers; the newest carries the live state, the workflow run
 *  and the error the terminal verdict classifies. */
export function copilotLatestSession(task: CopilotTask): CopilotSession | undefined {
  const sessions = copilotTaskSessions(task);
  let latest: CopilotSession | undefined;
  let stamp = '';
  for (const s of sessions) {
    const at =
      typeof s.updated_at === 'string'
        ? s.updated_at
        : typeof s.created_at === 'string'
          ? s.created_at
          : '';
    if (latest === undefined || at >= stamp) {
      latest = s;
      stamp = at;
    }
  }
  return latest;
}

/** Error text a failed session left behind — the terminal verdict's
 *  classifyExitCause input (a rate-limit wall reads 'rate_limited',
 *  not 'crash'). */
export function copilotSessionError(task: CopilotTask): string {
  const err = copilotLatestSession(task)?.error;
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === 'string' ? msg : '';
}

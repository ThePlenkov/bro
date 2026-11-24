/**
 * Copilot remote refs — the 'owner/repo' and head_ref surfaces a task
 * carries: the remote-repo parse, the branch the session pushes, and
 * the pull-artifact probe the PR resolution gates on.
 *
 * Leaf module — imports externals + the task shape.
 */
import { type AgentRegistryEntry, gitTry } from '@broject/core';
import { type CopilotTask, copilotTaskSessions } from './copilot-tasks.ts';

/** `git@host:o/r(.git)`, `https://host/o/r(.git)`, `ssh://…/o/r` →
 *  `o/r` — the last two path segments of any origin form GitHub
 *  accepts. */
export function copilotParseRemote(url: string): string | undefined {
  const m = /([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/.exec(
    url.trim()
  );
  return m === null ? undefined : `${m[1]}/${m[2]}`;
}

export function copilotRemoteRepo(dir: string): string | undefined {
  const url = gitTry(['-C', dir, 'remote', 'get-url', 'origin']);
  return url.code === 0 ? copilotParseRemote(url.out) : undefined;
}

/** The 'owner/repo' a registry entry's task lives on — pinned at
 *  spawn; the worktree's origin is the fallback for entries predating
 *  the pin. */
export function copilotEntryRepo(entry: AgentRegistryEntry): string | undefined {
  if (typeof entry.taskRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entry.taskRepo)) {
    return entry.taskRepo;
  }
  return typeof entry.worktree === 'string' ? copilotRemoteRepo(entry.worktree) : undefined;
}

/** A `branch` artifact's head_ref — artifacts carry
 *  `base_ref`/`head_ref` at creation. */
function copilotArtifactHeadRef(task: CopilotTask): string | undefined {
  if (!Array.isArray(task.artifacts)) {
    return undefined;
  }
  for (const a of task.artifacts) {
    const ref = a as { type?: unknown; data?: { head_ref?: unknown } };
    const head = ref?.type === 'branch' ? ref.data?.head_ref : undefined;
    if (typeof head === 'string') {
      return head;
    }
  }
  return undefined;
}

/** A session object's own head_ref — sessions repeat the refs their
 *  artifact carried. */
function copilotSessionHeadRef(task: CopilotTask): string | undefined {
  for (const s of copilotTaskSessions(task)) {
    if (typeof s.head_ref === 'string' && s.head_ref !== '') {
      return s.head_ref;
    }
  }
  return undefined;
}

/** The remote branch the session pushes — `branch` artifacts carry
 *  `base_ref`/`head_ref` at creation; session objects repeat them. */
export function copilotHeadRef(task: CopilotTask): string | undefined {
  return copilotArtifactHeadRef(task) ?? copilotSessionHeadRef(task);
}

export function copilotHasPullArtifact(task: CopilotTask): boolean {
  return (
    Array.isArray(task.artifacts) &&
    task.artifacts.some(a => (a as { type?: unknown })?.type === 'pull')
  );
}

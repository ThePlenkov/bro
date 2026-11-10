/**
 * Agent → worktree join shared by the arm scan (reconcile.ts). Fleet
 * status classification and `[state·#PR]` labels moved to the daemon
 * projector (spec bro-u19mq) — the plugin only keeps spawn/attach
 * lifecycle, it never writes status tokens.
 */

import type { StatusAgent } from './lib.ts';
import type { Planes } from './planes.ts';

/** The worktree path a fleet agent runs on: the registry's absolute
 *  path when it still resolves, else the status plane's name match —
 *  same join `agentArms` uses. */
export function agentTreePath(a: StatusAgent, p: Planes): string | undefined {
  const reg = p.registry[a.id];
  const byAbs =
    reg?.worktree !== undefined ? p.status.worktrees.find(t => t.path === reg.worktree) : undefined;
  return (byAbs ?? p.status.worktrees.find(t => t.name === a.worktree))?.path;
}

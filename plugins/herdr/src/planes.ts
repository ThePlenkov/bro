/**
 * Planes — the joined read bundle every reconcile pass converges from.
 * How a pass gets TRIGGERED (poll tick vs a live feed later) is the
 * EventSource's business; what it converges FROM is always this shape —
 * bro's planes on the left, herdr's on the right, all reads, no writes.
 */
import {
  agentsJson,
  armedWorkDetails,
  broStatus,
  worktreeList,
  workspaceList,
  type AgentEntry,
  type BroStatus,
  type HerdrWorkspace,
  type HerdrWorktreeList,
} from './lib.ts';

export interface Planes {
  /** The bro repo being reconciled. */
  repo: string;
  /** The repo's primary checkout — `worktree open --cwd` must anchor
   *  here (linked-tree cwd is refused). */
  main: string;
  /** bro: worktrees + claims + beads + fleet.agents + loop.runs. */
  status: BroStatus;
  /** herdr: per-tree open_workspace_id for this repo. */
  worktrees: HerdrWorktreeList;
  /** herdr: live workspaces (labels for drift detection). */
  workspaces: HerdrWorkspace[];
  /** bro: <git-common>/bro/agents.json — attempt log/pid/abs worktree. */
  registry: Record<string, AgentEntry>;
  /** bro: live session `.work` marker details (armed trees). */
  armedDetails: string[];
}

export function readPlanes(repo: string): Planes {
  const status = broStatus(repo);
  const worktrees = worktreeList(repo);
  const main =
    worktrees.source?.source_checkout_path ??
    status.worktrees.find(w => w.main === true)?.path ??
    repo;
  return {
    repo,
    main,
    status,
    worktrees,
    workspaces: workspaceList(),
    registry: agentsJson(main),
    armedDetails: armedWorkDetails(main),
  };
}

/** The subset convergence actually reads — a PollSource diff key that
 *  ignores churn fields (silentMs, watch ages, timestamps) so a tick
 *  only fires a pass when something reconcile cares about moved. */
export function diffKey(p: Planes): string {
  return JSON.stringify({
    armed: p.armedDetails,
    trees: p.status.worktrees.map(w => [w.name, w.path, w.branch, w.claim, w.state]),
    agents: p.status.fleet.agents.map(a => [
      a.id,
      a.state,
      a.cause,
      a.pid,
      a.worktree,
      a.agentId,
      a.log,
    ]),
    loop: p.status.loop.runs.map(r => [r.beadId, r.state, r.worktree, r.log]),
    open: p.worktrees.worktrees.map(w => [w.path, w.open_workspace_id]),
    ws: p.workspaces.map(w => [w.workspace_id, w.label, w.worktree?.checkout_path]),
    titles: p.status.beads.inProgress.map(b => [b.id, b.title]),
    reg: Object.entries(p.registry).map(([k, e]) => [k, e.agentId, e.log, e.worktree, e.pid]),
  });
}

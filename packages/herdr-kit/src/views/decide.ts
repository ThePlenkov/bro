/** The convergence decision layer — pure: state + probe results in,
 *  Action[] out. The caller owns every herdr/fs call: it probes
 *  (paneList/paneExists/paneIdle), hands this module the answers,
 *  then executes the returned actions and keeps its own state map. */

/** One pane as herdr reports it (only the fields decisions read). */
export interface PaneInfo {
  pane_id: string;
  label?: string;
}

/** A recorded session-pane binding — one managed worktree's record.
 *  `agent_id` pins the archive the pane was armed with; a later pass
 *  resolving a DIFFERENT live agent rebinds rather than tailing the
 *  dead journal forever. */
export interface SessionRec {
  workspace: string;
  worktree: string;
  pane_id: string;
  agent_id?: string;
  /** Epoch ms before which a failed rebind is not retried — a `pane
   *  run` that keeps failing must not churn a fresh split+close every
   *  converge pass. */
  retryAt?: number;
  /** A pane a rebind failed to close — retried each pass so a stale
   *  archive does not linger beside its replacement. */
  closePending?: string;
}

/** What one ensure-pass should do — the caller executes and records. */
export type SessionAction =
  | { kind: 'rearm'; paneId: string; adopted: boolean }
  | { kind: 'rebind'; paneId: string }
  | { kind: 'arm'; paneId: string; adopted: boolean }
  | { kind: 'split'; targetId?: string }
  | { kind: 'none' };

/** The pane the session role may take: an unbound orphan carrying our
 *  label first, then any idle pane not bound to another bro role and
 *  not wearing a bro-role label. */
export function pickPane(
  panes: PaneInfo[],
  bound: Set<string>,
  sessionLabel: string,
  broLabels: Set<string>,
  idle: (paneId: string) => boolean
): { id?: string; adopted: boolean } {
  const orphan = panes.find(
    p => p.label === sessionLabel && !bound.has(p.pane_id) && idle(p.pane_id)
  );
  if (orphan !== undefined) return { id: orphan.pane_id, adopted: true };
  const free = panes.find(
    p =>
      !bound.has(p.pane_id) && (p.label === undefined || !broLabels.has(p.label)) && idle(p.pane_id)
  );
  return { ...(free !== undefined ? { id: free.pane_id } : {}), adopted: false };
}

/** One workspace's session-pane decision: record → re-arm/keep →
 *  orphan-label → idle pane → split. */
export function decideSession(input: {
  rec?: SessionRec;
  panes: PaneInfo[];
  bound: Set<string>;
  sessionLabel: string;
  broLabels: Set<string>;
  exists: (paneId: string) => boolean;
  idle: (paneId: string) => boolean;
  /** The live agent the caller resolved for this pass — when the
   *  recorded binding points at a different archive the pane is
   *  closed and re-armed (a running tail never restarts itself). */
  agent?: { id: string };
}): SessionAction {
  const { rec } = input;
  if (rec !== undefined && input.exists(rec.pane_id)) {
    if (rec.agent_id !== input.agent?.id) return { kind: 'rebind', paneId: rec.pane_id };
    if (!input.idle(rec.pane_id)) return { kind: 'none' };
    return { kind: 'rearm', paneId: rec.pane_id, adopted: true };
  }
  const pick = pickPane(input.panes, input.bound, input.sessionLabel, input.broLabels, input.idle);
  if (pick.id === undefined) {
    return { kind: 'split', targetId: input.panes[0]?.pane_id };
  }
  return { kind: 'arm', paneId: pick.id, adopted: pick.adopted };
}

/** Which pane a retire closes — the recorded pane when it still
 *  exists, else the orphan carrying the session label. */
export function decideSessionRetire(input: {
  rec?: SessionRec;
  panes: PaneInfo[];
  sessionLabel: string;
  exists: (paneId: string) => boolean;
}): { closeId?: string } {
  const { rec } = input;
  const recPane = input.panes.find(p => p.pane_id === rec?.pane_id);
  if (rec !== undefined && input.exists(rec.pane_id) && recPane?.label === input.sessionLabel) {
    return { closeId: rec.pane_id };
  }
  return { closeId: input.panes.find(p => p.label === input.sessionLabel)?.pane_id };
}

/** Records whose workspace is gone — the paths the caller deletes. */
export function dropOrphanRecords<T extends { workspace: string }>(
  records: Record<string, T>,
  liveWsIds: Set<string>
): string[] {
  return Object.entries(records)
    .filter(([, rec]) => !liveWsIds.has(rec.workspace))
    .map(([path]) => path);
}

// --- live views ----------------------------------------------------------------

/** One discovered live agent — a registry/handle sighting with a
 *  live pid. */
export interface LiveAgent {
  id: string;
  events: string;
  worktree?: string;
  pid?: number;
}

/** One liveViews record — the workspace+pane a live agent occupies. */
export interface LiveViewRec {
  workspace: string;
  pane_id: string;
  /** true only for workspaces THIS plugin created (`workspace
   *  create`) — closing anything else is never ours to do. */
  owned?: boolean;
}

export type LiveViewAction =
  | { kind: 'retire'; id: string; rec: LiveViewRec; reason: 'dead' | 'covered' }
  | { kind: 'keep'; id: string; rec: LiveViewRec }
  | { kind: 'rearm'; id: string; rec: LiveViewRec }
  | { kind: 'drop'; id: string; rec: LiveViewRec }
  | { kind: 'open'; agent: LiveAgent };

/** Live agents → view panes, the decision half of convergeLiveViews.
 *  Order matters: every retire/drop decision is emitted first so the
 *  caller frees state before opens are attempted; a `rearm` whose
 *  `pane run` fails is the caller's cue to close an owned workspace
 *  and drop the record. */
export function convergeViews(input: {
  live: LiveAgent[];
  existing: Record<string, LiveViewRec>;
  /** Worktrees already carrying a managed session pane — an agent
   *  parked there never gets a second view. */
  covered: Set<string>;
  exists: (paneId: string) => boolean;
  idle: (paneId: string) => boolean;
}): LiveViewAction[] {
  const out: LiveViewAction[] = [];
  /** Ids whose open is suppressed: 'keep' settles, 'rearm' is the
   *  caller's inline branch — a failed `pane run` falls through to
   *  the caller's own drop-then-open path, not a fresh action. */
  const suppressed = new Set<string>();
  const recAction = (id: string, rec: LiveViewRec): LiveViewAction => {
    const agent = input.live.find(a => a.id === id);
    if (agent === undefined) return { kind: 'retire', id, rec, reason: 'dead' };
    if (agent.worktree !== undefined && input.covered.has(agent.worktree)) {
      return { kind: 'retire', id, rec, reason: 'covered' };
    }
    if (!input.exists(rec.pane_id)) return { kind: 'drop', id, rec };
    return input.idle(rec.pane_id) ? { kind: 'rearm', id, rec } : { kind: 'keep', id, rec };
  };
  for (const [id, rec] of Object.entries(input.existing)) {
    const action = recAction(id, rec);
    out.push(action);
    if (action.kind === 'rearm' || action.kind === 'keep') suppressed.add(id);
  }
  for (const a of input.live) {
    if (a.worktree !== undefined && input.covered.has(a.worktree)) continue;
    if (suppressed.has(a.id)) continue;
    out.push({ kind: 'open', agent: a });
  }
  return out;
}

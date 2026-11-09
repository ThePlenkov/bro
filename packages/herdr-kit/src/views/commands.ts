/** Pane-command argv builders — pure: bins + target in, argv out.
 *  The caller joins with its own quoting (the plugin's shq). */

/** What a view pane needs to launch — resolved bins. */
export interface ViewBins {
  /** bun binary when the OpenTUI lane resolves (undefined → line mode). */
  bun?: string;
  /** the OpenTUI entrypoint path when it exists on disk. */
  tui?: string;
  /** the bro binary — the line-mode fallback's argv head. */
  bro: string;
}

/** The managed-workspace session pane — the OpenTUI app bound to the
 *  worktree when tui+bun resolve, `bro herdr session-view` else. */
export function sessionViewArgv(
  worktree: string,
  bins: ViewBins,
  agent?: { id: string; events: string }
): string[] {
  const direct = agent === undefined ? [] : ['--events', agent.events, '--agent', agent.id];
  if (bins.bun !== undefined && bins.tui !== undefined) {
    return [bins.bun, 'run', bins.tui, ...direct, worktree];
  }
  // the line-mode fallback carries the same binding — worktree-only
  // resolution drops native journals the fleet doc never names
  return [bins.bro, 'herdr', 'session-view', worktree, ...direct];
}

/** The per-agent live view — the OpenTUI app bound to the archive
 *  directly (`--events`/`--agent`) when tui+bun resolve, the line-mode
 *  session-view keyed on the agent's worktree otherwise. */
export function liveViewArgv(
  a: { events: string; id: string; worktree?: string },
  bins: ViewBins
): string[] {
  if (bins.bun !== undefined && bins.tui !== undefined) {
    return [bins.bun, 'run', bins.tui, '--events', a.events, '--agent', a.id];
  }
  return [
    bins.bro,
    'herdr',
    'session-view',
    a.worktree ?? '.',
    '--events',
    a.events,
    '--agent',
    a.id,
  ];
}

/** The pane command STRINGS — same argvs rendered with the caller's
 *  quoting convention (verbs bare, values sanitized): `'bun' run
 *  'main.ts' 'wt'` — the shape `pane run` + tests assert. */
export function sessionViewCommand(
  worktree: string,
  bins: ViewBins,
  q: (s: string) => string,
  agent?: { id: string; events: string }
): string {
  const direct = agent === undefined ? '' : ` --events ${q(agent.events)} --agent ${q(agent.id)}`;
  if (bins.bun !== undefined && bins.tui !== undefined) {
    return `${q(bins.bun)} run ${q(bins.tui)}${direct} ${q(worktree)}`;
  }
  return `${q(bins.bro)} herdr session-view ${q(worktree)}${direct}`;
}

export function liveViewCommand(
  a: { events: string; id: string; worktree?: string },
  bins: ViewBins,
  q: (s: string) => string
): string {
  if (bins.bun !== undefined && bins.tui !== undefined) {
    return `${q(bins.bun)} run ${q(bins.tui)} --events ${q(a.events)} --agent ${q(a.id)}`;
  }
  return `${q(bins.bro)} herdr session-view ${q(a.worktree ?? '.')} --events ${q(a.events)} --agent ${q(a.id)}`;
}

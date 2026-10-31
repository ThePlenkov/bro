/**
 * live-views — plugin-owned session views for EVERY live bro agent
 * (spec bro-q2edc addendum 17). sessions.ts covers managed
 * workspaces; this module covers agents with no armed worktree —
 * loop runs, convoy workers, fleet spawns — discovered from the
 * agents registry (`<git-common>/bro/agents.json` +
 * `bro/agents/<id>.events.jsonl`).
 *
 * Each live agent gets a fresh herdr workspace `🤖 view:<id>` whose
 * pane runs `tui/main.ts --events <path> --agent <id>` — the viewer
 * resolves the archive directly, so no fleet-status file is read
 * and nothing lands in daemon-owned dirs (janitor-reaped files were
 * the "waiting for projector" field bug). A dead agent's workspace
 * closes with its panes; state lives only in the plugin's own
 * `state.liveViews` map.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentsJson,
  BRO,
  herdrOk,
  herdrTry,
  PLUGIN_ROOT,
  type PluginState,
  paneExists,
  paneIdle,
  paneList,
  pidAlive,
  shq,
} from './lib.ts';
import { bun } from './sessions.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

const TUI_MAIN = join(PLUGIN_ROOT, 'tui', 'main.ts');
const VIEW_PREFIX = '🤖 view:';

/** One discovered live agent — a registry entry with a live pid. */
interface LiveAgent {
  id: string;
  events: string;
  worktree?: string;
  pid?: number;
}

/** Registry + handle-file scan — a live pid is the truth either
 *  way: `agents.json` first, then `<id>.<run>.go` handles without a
 *  sibling `.exit` (the janitor reaps registry entries; the attempt
 *  pins outlive them — field bug B). The events path is named even
 *  when the file does not exist yet — the viewer's live-tail retry
 *  starts rendering when it lands. */
export function liveAgents(base: string): LiveAgent[] {
  const dir = join(base, 'bro', 'agents');
  const out = new Map<string, LiveAgent>();
  for (const [id, e] of Object.entries(agentsJson(base))) {
    if (e.pid === undefined || !pidAlive(e.pid)) continue;
    out.set(id, { id, events: join(dir, `${id}.events.jsonl`), worktree: e.worktree, pid: e.pid });
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [...out.values()];
  }
  for (const f of names) {
    if (!f.endsWith('.go')) continue;
    const stem = f.slice(0, -3);
    if (names.includes(`${stem}.exit`)) continue;
    const id = stem.split('.')[0] ?? '';
    if (id === '' || out.has(id)) continue;
    let pid: number | undefined;
    let start: string | undefined;
    try {
      const [p, s] = readFileSync(join(dir, `${stem}.handle`), 'utf8').split(' ');
      pid = Number(p);
      start = s;
    } catch {
      continue;
    }
    if (!pidAlive(pid, start)) continue;
    out.set(id, { id, events: join(dir, `${id}.events.jsonl`), pid });
  }
  return [...out.values()];
}

/** The pane command — the OpenTUI viewer bound to the archive
 *  directly; the line-mode session-view stays the bun-less fallback
 *  keyed on the agent's worktree. */
function viewCommand(a: LiveAgent): string {
  const b = existsSync(TUI_MAIN) ? bun() : undefined;
  if (b !== undefined) {
    return `${shq(b)} run ${shq(TUI_MAIN)} --events ${shq(a.events)} --agent ${shq(a.id)}`;
  }
  return `${shq(BRO)} herdr session-view ${shq(a.worktree ?? '.')}`;
}

/** A FRESH workspace for one agent — `🤖 view:<id>`. `workspace
 *  create`, never `worktree open`: the open verb resolves to an
 *  already-open workspace and its first pane is someone's shell —
 *  the view must never hijack it. A fresh pane also has no
 *  scrollback: THE clean-start the terminal-side \e[3J cannot
 *  promise under herdr. */
function openViewWorkspace(a: LiveAgent, main: string): string | undefined {
  const res = herdrTry<{
    workspace_id?: string;
    workspace?: { workspace_id?: string };
  }>(['workspace', 'create', '--cwd', a.worktree ?? main, '--label', `${VIEW_PREFIX} ${a.id}`]);
  return res?.workspace_id ?? res?.workspace?.workspace_id;
}

/** Converge live agents → view panes. `state.liveViews` maps agentId
 *  → {workspace, pane_id}; agents whose worktree already carries a
 *  managed session pane are skipped — one view per agent, never two. */
export function convergeLiveViews(
  base: string,
  main: string,
  state: PluginState,
  coveredWorktrees: Set<string>
): void {
  const agents = liveAgents(base);
  // no agents and nothing recorded — the pass must leave the state
  // byte-identical (converge tests assert the whole doc)
  if (agents.length === 0 && Object.keys(state.liveViews ?? {}).length === 0) return;
  state.liveViews ??= {};

  // retire: dead agent or its worktree picked up a managed session —
  // the whole workspace closes, panes with it — but only a workspace
  // the rec OWNS (workspace create). A foreign or pre-flagless rec
  // just drops; closing someone else's workspace is never ours to do
  for (const [id, rec] of Object.entries(state.liveViews)) {
    const agent = agents.find(a => a.id === id);
    const covered = agent?.worktree !== undefined && coveredWorktrees.has(agent.worktree);
    if (agent === undefined || covered) {
      if (rec.owned === true) herdrTry(['workspace', 'close', rec.workspace]);
      delete state.liveViews[id];
      log(
        `view ${id}: workspace ${rec.workspace} closed (${agent === undefined ? 'agent dead' : 'covered by managed session'})`
      );
    }
  }

  for (const a of agents) {
    if (a.worktree !== undefined && coveredWorktrees.has(a.worktree)) continue;
    const rec = state.liveViews[a.id];
    if (rec !== undefined) {
      // a live pane that idles means the viewer died — re-arm it
      if (paneExists(rec.pane_id)) {
        if (!paneIdle(rec.pane_id)) continue;
        if (herdrOk(['pane', 'run', rec.pane_id, viewCommand(a)])) continue;
      }
      if (rec.owned === true) herdrTry(['workspace', 'close', rec.workspace]);
      delete state.liveViews[a.id];
    }
    const ws = openViewWorkspace(a, main);
    if (ws === undefined) {
      log(`view ${a.id}: workspace open failed`);
      continue;
    }
    const paneId = paneList(ws)[0]?.pane_id;
    if (paneId === undefined || !herdrOk(['pane', 'run', paneId, viewCommand(a)])) {
      log(`view ${a.id}: pane run failed in ${ws}`);
      continue;
    }
    state.liveViews[a.id] = { workspace: ws, pane_id: paneId, owned: true };
    log(`view ${a.id} → ${ws}: ${a.events}`);
  }
  // the last record retired — drop the empty bucket so the state doc
  // carries no liveViews key at all
  if (Object.keys(state.liveViews).length === 0) delete state.liveViews;
}

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
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convergeViews, liveViewCommand } from '../../../packages/herdr-kit/src/index.ts';
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
  STATE_DIR,
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
  for (const [key, e] of Object.entries(agentsJson(base))) {
    if (e.pid === undefined || !pidAlive(e.pid)) continue;
    // the archive stem is the agent id (native-<hash>), not the run
    // key — the entry's log path carries it: native-x.events.jsonl
    // sits beside native-x.log. Keying on it also dedupes a run key
    // and its handle-file sighting of the same agent.
    const stem = e.log?.replace(/\.log$/, '') ?? join(dir, `${key}.events`);
    const id = stem.split('/').pop() ?? key;
    out.set(id, { id, events: `${stem}.events.jsonl`, worktree: e.worktree, pid: e.pid });
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
 *  keyed on the agent's worktree. argv building is the kit's. */
function viewCommand(a: LiveAgent): string {
  const b = existsSync(TUI_MAIN) ? bun() : undefined;
  return liveViewCommand(
    a,
    { ...(b !== undefined ? { bun: b, tui: TUI_MAIN } : {}), bro: BRO },
    shq
  );
}

/** A FRESH workspace for one agent — `🤖 view:<id>`. `workspace
 *  create`, never `worktree open`: the open verb resolves to an
 *  already-open workspace and its first pane is someone's shell —
 *  the view must never hijack it. A fresh pane also has no
 *  scrollback: THE clean-start the terminal-side \e[3J cannot
 *  promise under herdr.
 *
 *  The cwd is a per-agent scratch dir, NEVER the agent's worktree
 *  or the repo root: `workspace create` dedupes by cwd — a real
 *  path that already carries a user workspace gets ADOPTED and
 *  relabeled (field-found: w0 'bro' became a view label). A scratch
 *  path collides with nothing, so create always yields a workspace
 *  the plugin owns. */
function openViewWorkspace(a: LiveAgent): string | undefined {
  const cwd = join(STATE_DIR, 'view-cwd', a.id);
  mkdirSync(cwd, { recursive: true });
  const res = herdrTry<{
    workspace_id?: string;
    workspace?: { workspace_id?: string };
  }>(['workspace', 'create', '--cwd', cwd, '--label', `${VIEW_PREFIX} ${a.id}`]);
  return res?.workspace_id ?? res?.workspace?.workspace_id;
}

/** Converge live agents → view panes. `state.liveViews` maps agentId
 *  → {workspace, pane_id}; agents whose worktree already carries a
 *  managed session pane are skipped — one view per agent, never two. */
export function convergeLiveViews(
  base: string,
  _main: string,
  state: PluginState,
  coveredWorktrees: Set<string>
): void {
  const agents = liveAgents(base);
  // no agents and nothing recorded — the pass must leave the state
  // byte-identical (converge tests assert the whole doc)
  if (agents.length === 0 && Object.keys(state.liveViews ?? {}).length === 0) return;
  state.liveViews ??= {};

  // the decision layer is the kit's — retire/drop/rearm/keep/open;
  // this is the exec half: probes in, herdr calls + state out.
  /** One open — fresh workspace → first pane → run → record. */
  const openView = (a: LiveAgent): void => {
    const ws = openViewWorkspace(a);
    if (ws === undefined) {
      log(`view ${a.id}: workspace open failed`);
      return;
    }
    const paneId = paneList(ws)[0]?.pane_id;
    if (paneId === undefined || !herdrOk(['pane', 'run', paneId, viewCommand(a)])) {
      log(`view ${a.id}: pane run failed in ${ws}`);
      return;
    }
    state.liveViews ??= {};
    state.liveViews[a.id] = { workspace: ws, pane_id: paneId, owned: true };
    log(`view ${a.id} → ${ws}: ${a.events}`);
  };
  for (const act of convergeViews({
    live: agents,
    existing: state.liveViews,
    covered: coveredWorktrees,
    exists: paneExists,
    idle: paneIdle,
  })) {
    switch (act.kind) {
      case 'retire':
        if (act.rec.owned === true) herdrTry(['workspace', 'close', act.rec.workspace]);
        delete state.liveViews[act.id];
        log(
          `view ${act.id}: workspace ${act.rec.workspace} closed (${act.reason === 'dead' ? 'agent dead' : 'covered by managed session'})`
        );
        break;
      case 'drop':
        if (act.rec.owned === true) herdrTry(['workspace', 'close', act.rec.workspace]);
        delete state.liveViews[act.id];
        break;
      case 'rearm': {
        const a = agents.find(x => x.id === act.id);
        if (a !== undefined && herdrOk(['pane', 'run', act.rec.pane_id, viewCommand(a)])) {
          break;
        }
        // a failed re-arm drops the record and falls through to the
        // open path — same pass, same agent
        if (act.rec.owned === true) herdrTry(['workspace', 'close', act.rec.workspace]);
        delete state.liveViews[act.id];
        if (a !== undefined) openView(a);
        break;
      }
      case 'keep':
        break;
      case 'open':
        openView(act.agent);
        break;
    }
  }
  // the last record retired — drop the empty bucket so the state doc
  // carries no liveViews key at all
  if (Object.keys(state.liveViews).length === 0) delete state.liveViews;
}

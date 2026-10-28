/**
 * Board pane — the joined read view: bro fleet status --json × herdr
 * worktree list × workspace list (+ bro fleet --json for PR columns).
 * Renders every BRO_BOARD_EVERY_S (15s default); pure read plane, the
 * watch -n shape the spec allows for v1.
 *
 * Columns: worktree · bead/title · agent (step/state/cause) ·
 * workspace(id,label) · mirror pane · PR.
 */
import { resolve } from 'node:path';
import {
  broFleet,
  type FleetRow,
  type HerdrWorkspace,
  loadState,
  type MirrorRec,
  repoDir,
  type StatusAgent,
  type StatusWorktree,
  stateScope,
} from './lib.ts';
import { type Planes, readPlanes } from './planes.ts';

const requested = Number(process.env.BRO_BOARD_EVERY_S ?? 15);
const EVERY_MS = Math.max(3, Number.isFinite(requested) ? requested : 15) * 1000;

interface Row {
  worktree: string;
  bead: string;
  agent: string;
  state: string;
  ws: string;
  mirror: string;
  pr: string;
}

/** Everything collect() needs joined once — the per-tree row then
 *  reads lookups only. */
interface BoardJoins {
  wsById: Map<string, HerdrWorkspace>;
  openByPath: Map<string, string>;
  titles: Map<string, string>;
  fleetByStep: Map<string, FleetRow>;
  agentByWt: Map<string, StatusAgent>;
  armedDetails: Set<string>;
  mirrors: MirrorRec[];
  mirrorPanes: Record<string, boolean>;
  main: string;
  repo: string;
}

function boardJoins(p: Planes): BoardJoins {
  let fleetRows: FleetRow[] = [];
  try {
    fleetRows = broFleet(p.repo).rows;
  } catch {
    // fleet rows are the PR column only — absent renders '—'
  }
  const agentByWt = new Map<string, StatusAgent>();
  for (const a of p.status.fleet.agents) {
    if (a.worktree !== undefined) {
      const reg = p.registry[a.id];
      agentByWt.set(a.worktree, { ...a, agentId: a.agentId ?? reg?.agentId });
    }
  }
  return {
    wsById: new Map(p.workspaces.map(w => [w.workspace_id, w])),
    openByPath: new Map(
      p.worktrees.worktrees
        .filter(w => w.open_workspace_id !== undefined)
        .map(w => [w.path, w.open_workspace_id!])
    ),
    titles: new Map(p.status.beads.inProgress.map(b => [b.id, b.title] as const)),
    fleetByStep: new Map(fleetRows.map(r => [r.step, r])),
    agentByWt,
    armedDetails: new Set(p.armedDetails),
    mirrors: Object.values(loadState(stateScope(p.main)).mirrors),
    mirrorPanes: p.mirrorPanes,
    main: p.main,
    repo: p.repo,
  };
}

/** Claimed, hosting a live agent, or named by a session marker — the
 *  board's "has live work" predicate. */
function isArmed(
  w: StatusWorktree,
  agent: StatusAgent | undefined,
  armedDetails: Set<string>,
  main: string
): boolean {
  if (w.claim !== undefined || agent?.state === 'running') return true;
  return [...armedDetails].some(d =>
    d.includes('/')
      ? resolve(main, d) === w.path
      : w.name === `bro--${d}` || w.name === d || w.claim === d
  );
}

/** Per-cell projections — each reads one join and returns display text. */
function beadCell(
  w: StatusWorktree,
  agent: StatusAgent | undefined,
  titles: Map<string, string>
): string {
  const slug = w.claim ?? agent?.id;
  const bead = slug !== undefined ? (titles.get(slug) ?? slug) : '';
  return bead.length > 46 ? `${bead.slice(0, 45)}…` : bead;
}

function stateCell(agent: StatusAgent | undefined, w: StatusWorktree): string {
  if (agent === undefined) return w.state ?? '';
  return `${agent.state}${agent.cause !== undefined ? `/${agent.cause}` : ''}`;
}

function wsCell(ws: HerdrWorkspace | undefined): string {
  if (ws === undefined) return '—';
  return `${ws.workspace_id}${ws.label !== undefined ? ` "${ws.label}"` : ''}`;
}

/** A record whose pane was closed shows as stale, not live — the rec
 *  prunes on the next pass; the board reports what IS. */
function mirrorCell(mirror: MirrorRec | undefined, panes: Record<string, boolean>): string {
  if (mirror === undefined) return '';
  const live = panes[mirror.step] === true;
  return `${mirror.pane_id}${mirror.marked === true ? ' ✖' : ''}${live ? '' : ' (gone)'}`;
}

function prCell(agent: StatusAgent | undefined, fleetByStep: Map<string, FleetRow>): string {
  const pr = agent !== undefined ? fleetByStep.get(agent.id)?.prNum : undefined;
  return pr !== undefined ? `#${pr}` : '';
}

function rowFor(w: StatusWorktree, j: BoardJoins): Row | undefined {
  const agent = j.agentByWt.get(w.name);
  const wsId = j.openByPath.get(w.path);
  const ws = wsId !== undefined ? j.wsById.get(wsId) : undefined;
  // the board shows live work plus opened workspaces — parked litter
  // is noise the fleet table already carries
  if (!isArmed(w, agent, j.armedDetails, j.main) && ws === undefined) return undefined;

  return {
    worktree: w.name,
    bead: beadCell(w, agent, j.titles),
    agent: agent?.agentId ?? '',
    state: stateCell(agent, w),
    ws: wsCell(ws),
    mirror: mirrorCell(
      j.mirrors.find(m => m.worktree === w.path),
      j.mirrorPanes
    ),
    pr: prCell(agent, j.fleetByStep),
  };
}

function collect(): Row[] {
  const p = readPlanes(repoDir());
  const j = boardJoins(p);
  const rows: Row[] = [];
  for (const w of p.status.worktrees) {
    if (w.main === true) continue;
    const r = rowFor(w, j);
    if (r !== undefined) rows.push(r);
  }
  return rows;
}

function render(rows: Row[], err?: string): string {
  const cols: [keyof Row, string][] = [
    ['worktree', 'worktree'],
    ['bead', 'bead / title'],
    ['agent', 'agent'],
    ['state', 'state'],
    ['ws', 'workspace'],
    ['mirror', 'mirror'],
    ['pr', 'pr'],
  ];
  const cells = rows.map(r => cols.map(([k]) => (r[k] === '' ? '—' : r[k])));
  const widths = cols.map(([, h], i) =>
    Math.max(h.length, ...cells.map(c => (c[i] ?? '').length), 1)
  );
  const line = (vals: string[]): string =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const out = [
    `bro board — ${new Date().toLocaleTimeString()}  (worktree ↔ bead ↔ agent ↔ workspace ↔ PR)`,
    '',
    line(cols.map(([, h]) => h)),
    ...cells.map(line),
  ];
  if (rows.length === 0) out.push('  no armed worktrees or opened workspaces');
  if (err !== undefined) out.push('', `  warning: ${err}`);
  return out.join('\n');
}

const tick = (): void => {
  let err: string | undefined;
  let rows: Row[] = [];
  try {
    rows = collect();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  process.stdout.write(`\x1b[2J\x1b[H${render(rows, err)}\n`);
};

tick();
setInterval(tick, EVERY_MS);

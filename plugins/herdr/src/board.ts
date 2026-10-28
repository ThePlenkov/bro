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
import { broFleet, loadState, repoDir, type BroStatus, type FleetRow } from './lib.ts';
import { readPlanes } from './planes.ts';

const EVERY_MS = Math.max(3, Number(process.env.BRO_BOARD_EVERY_S ?? 15)) * 1000;

interface Row {
  worktree: string;
  bead: string;
  agent: string;
  state: string;
  ws: string;
  mirror: string;
  pr: string;
}

function collect(): Row[] {
  const p = readPlanes(repoDir());
  const status = p.status;
  const wsById = new Map(p.workspaces.map(w => [w.workspace_id, w]));
  const openByPath = new Map(
    p.worktrees.worktrees
      .filter(w => w.open_workspace_id !== undefined)
      .map(w => [w.path, w.open_workspace_id!])
  );

  let fleetRows: FleetRow[] = [];
  try {
    fleetRows = broFleet(p.repo).rows;
  } catch {
    // fleet rows are the PR column only — absent renders '—'
  }
  const fleetByStep = new Map(fleetRows.map(r => [r.step, r]));

  const titles = new Map(status.beads.inProgress.map(b => [b.id, b.title] as const));
  const state = loadState();
  const agentByWt = new Map<string, BroStatus['fleet']['agents'][number]>();
  for (const a of status.fleet.agents) {
    if (a.worktree !== undefined) {
      const reg = p.registry[a.id];
      agentByWt.set(a.worktree, { ...a, agentId: a.agentId ?? reg?.agentId });
    }
  }

  const armedDetails = new Set(p.armedDetails);

  const rows: Row[] = [];
  for (const w of status.worktrees) {
    if (w.main === true) continue;
    const agent = agentByWt.get(w.name);
    const wsId = openByPath.get(w.path);
    const ws = wsId !== undefined ? wsById.get(wsId) : undefined;
    const armed =
      w.claim !== undefined ||
      agent?.state === 'running' ||
      [...armedDetails].some(d =>
        d.includes('/')
          ? resolve(p.main, d) === w.path
          : w.name === `bro--${d}` || w.name === d || w.claim === d
      );
    // the board shows live work plus opened workspaces — parked litter
    // is noise the fleet table already carries
    if (!armed && ws === undefined) continue;

    const slug = w.claim ?? agent?.id;
    const bead = slug !== undefined ? (titles.get(slug) ?? slug) : '';
    const mirror = Object.values(state.mirrors).find(m => m.worktree === w.path);
    const pr = agent !== undefined ? fleetByStep.get(agent.id)?.prNum : undefined;
    rows.push({
      worktree: w.name,
      bead: bead.length > 46 ? `${bead.slice(0, 45)}…` : bead,
      agent: agent?.agentId ?? '',
      state:
        agent !== undefined
          ? `${agent.state}${agent.cause !== undefined ? `/${agent.cause}` : ''}`
          : (w.state ?? ''),
      ws:
        ws !== undefined
          ? `${ws.workspace_id}${ws.label !== undefined ? ` "${ws.label}"` : ''}`
          : '—',
      mirror: mirror !== undefined ? `${mirror.pane_id}${mirror.marked === true ? ' ✖' : ''}` : '',
      pr: pr !== undefined ? `#${pr}` : '',
    });
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

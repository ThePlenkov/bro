import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import css from '../styles.css?url';

export const Route = createFileRoute('/backlog')({
  head: () => ({ links: [{ rel: 'stylesheet', href: css }] }),
  component: BacklogPage,
});

const GITHUB = 'https://github.com/ThePlenkov/bro';
const BASE_URL = import.meta.env.BASE_URL;
const DOCS = `${BASE_URL}docs`;

// Same channel as /debt: beads has no HTTP surface (its store is dolt
// chunks on refs/dolt/data), so a cron workflow exports a compact
// backlog.json onto the data ref and the page reads it by sha off
// raw.githubusercontent. GitHub issues and open PRs come live from the
// REST API in the same request wave.
const REF_API = 'https://api.github.com/repos/ThePlenkov/bro/git/ref/bro/data';
const RAW = 'https://raw.githubusercontent.com/ThePlenkov/bro';
const ISSUES_API = 'https://api.github.com/repos/ThePlenkov/bro/issues?state=open&per_page=100';
const SNAPSHOT_KEY = 'bro:backlog:snapshot:v1';
const BACKLOG_PATH = '.agents/backlog.json';

interface Bead {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  created_at: string;
  parent?: string;
  labels: string[];
  blocks: string[];
  blocked_by: string[];
  closed_children: number;
  open_children: number;
}

interface Snapshot {
  generated_at: string;
  total_open: number;
  issues: Bead[];
}

interface GhItem {
  id: string;
  title: string;
  kind: 'issue' | 'pr';
  created_at: string;
  url: string;
  labels: string[];
}

interface Data {
  snapshot: Snapshot;
  gh: GhItem[];
  sha: string;
  fetchedAt: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: Data; cached: boolean };

interface Filters {
  q: string;
  status: Set<string>;
  type: Set<string>;
  priority: Set<number>;
  source: 'all' | 'beads' | 'github';
  orphansOnly: boolean;
}

const ALL_STATUS = ['open', 'in-progress', 'blocked'];
const ALL_TYPE = ['bug', 'task', 'feature', 'epic', 'agent', 'molecule', 'chore'];
const ALL_PRIORITY = [1, 2, 3, 4];

function readCache(): { snapshot: Snapshot; gh: GhItem[]; sha: string; fetchedAt: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function resolveSha(): Promise<string> {
  const refRes = await fetch(REF_API);
  if (!refRes.ok) throw new Error(`could not resolve refs/bro/data (${refRes.status})`);
  const { object } = (await refRes.json()) as { object: { sha: string } };
  return object.sha;
}

interface GhRaw {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
}

const toGh = (i: GhRaw): GhItem => ({
  id: `${i.pull_request ? 'pr' : 'gh'}-${i.number}`,
  title: i.title,
  kind: i.pull_request ? 'pr' : 'issue',
  created_at: i.created_at,
  url: i.html_url,
  labels: (i.labels ?? []).map(l => (typeof l === 'string' ? l : (l.name ?? ''))),
});

async function fetchGh(): Promise<GhItem[]> {
  const res = await fetch(ISSUES_API);
  return res.ok ? ((await res.json()) as GhRaw[]).map(toGh) : [];
}

async function load(): Promise<Data> {
  let sha: string;
  try {
    sha = await resolveSha();
  } catch {
    const cached = readCache();
    if (cached) return { ...cached, fetchedAt: cached.fetchedAt };
    throw new Error('could not resolve refs/bro/data');
  }

  const [backlogRes, gh] = await Promise.all([fetch(`${RAW}/${sha}/${BACKLOG_PATH}`), fetchGh()]);
  if (!backlogRes.ok) throw new Error(`backlog.json not on refs/bro/data (${backlogRes.status})`);
  const snapshot = (await backlogRes.json()) as Snapshot;

  const data = { snapshot, gh, sha, fetchedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(data));
  } catch {
    /* quota — live next load instead */
  }
  return data;
}

function ageDays(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / 86400000);
}

const TYPE_COLOR: Record<string, string> = {
  bug: '#e0705a',
  epic: '#b58ae0',
  feature: '#6fbf8a',
  task: '#6a9fd8',
  agent: '#d8b56a',
  molecule: '#8ad0d0',
  chore: '#9a9a9a',
};

function normalizeGh(g: GhItem): Bead {
  return {
    id: g.id,
    title: g.title,
    status: 'open',
    priority: 0,
    type: g.kind,
    created_at: g.created_at,
    labels: g.labels,
    blocks: [],
    blocked_by: [],
    closed_children: 0,
    open_children: 0,
  };
}

// --- graph layout -------------------------------------------------------
// Deterministic forest: epic roots on top, children stacked beneath their
// parent (open children of open nodes only). Orphans and edge-less beads
// are filtered out — the honest shape of this backlog is a swamp, so the
// graph shows the structured part.
interface GNode {
  bead: Bead;
  x: number;
  y: number;
  depth: number;
}
interface GEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'parent' | 'blocks';
}

const ROW_H = 56;
const COL_W = 220;
const W_COLS = 5;

function forestRoots(issues: Bead[], includeFlat: boolean): { starts: Bead[]; children: Map<string, Bead[]> } {
  const byId = new Map(issues.map(i => [i.id, i]));
  const children = new Map<string, Bead[]>();
  const roots: Bead[] = [];
  for (const i of issues) {
    const p = i.parent && byId.has(i.parent) ? i.parent : null;
    if (p) (children.get(p) ?? children.set(p, []).get(p)!).push(i);
    else roots.push(i);
  }
  const epics = roots
    .filter(r => r.type === 'epic' || children.has(r.id))
    .sort((a, b) => a.priority - b.priority || b.open_children - a.open_children);
  const flat = roots.filter(r => !epics.includes(r));
  return { starts: includeFlat ? [...epics, ...flat] : epics, children };
}

// One vertical band per root; each subtree is BFS'd level by level,
// every level wrapped across W_COLS columns so the whole forest fits a
// fixed-width strip the page scrolls through.
function layoutBand(root: Bead, bandY: number, children: Map<string, Bead[]>, pos: Map<string, GNode>): number {
  let frontier: Bead[] = [root];
  let levelY = bandY + 24;
  let depth = 0;
  while (frontier.length > 0) {
    const next: Bead[] = [];
    frontier.forEach((n, idx) => {
      pos.set(n.id, {
        bead: n,
        x: (idx % W_COLS) * COL_W + COL_W / 2,
        y: levelY + Math.floor(idx / W_COLS) * ROW_H,
        depth,
      });
      for (const k of children.get(n.id) ?? []) next.push(k);
    });
    levelY += Math.ceil(frontier.length / W_COLS) * ROW_H;
    frontier = next;
    depth += 1;
  }
  return levelY + 8;
}

function layout(issues: Bead[], includeFlat: boolean): { nodes: GNode[]; edges: GEdge[]; w: number; h: number } {
  const { starts, children } = forestRoots(issues, includeFlat);
  const pos = new Map<string, GNode>();
  let bandY = 0;
  for (const root of starts) bandY = layoutBand(root, bandY, children, pos);

  const edges: GEdge[] = [];
  for (const n of pos.values()) {
    for (const k of children.get(n.bead.id) ?? []) {
      const t = pos.get(k.id);
      if (t) edges.push({ x1: n.x, y1: n.y + 12, x2: t.x, y2: t.y - 12, kind: 'parent' });
    }
    for (const t of n.bead.blocks) {
      const other = pos.get(t);
      if (other) edges.push({ x1: n.x, y1: n.y, x2: other.x, y2: other.y, kind: 'blocks' });
    }
  }
  return { nodes: [...pos.values()], edges, w: W_COLS * COL_W, h: bandY + 20 };
}

// --- components ---------------------------------------------------------

function Chip({ active, label, onClick }: Readonly<{ active: boolean; label: string; onClick: () => void }>) {
  return (
    <button type="button" onClick={onClick} className={`bl-chip${active ? ' on' : ''}`}>
      {label}
    </button>
  );
}

// Chip rows are data, not JSX: every filter group is one entry and the
// controls render it generically — adding a facet is a one-line change.
interface ChipItem { v: string; label: string; active: boolean; onClick: () => void }

function ChipRow({ groups }: Readonly<{ groups: ChipItem[][] }>) {
  return (
    <div className="bl-chiprow">
      {groups.map((g, gi) => (
        <span key={g.map(c => c.v).join('|')} style={{ display: 'contents' }}>
          {gi > 0 && <span className="bl-sep" />}
          {g.map(c => <Chip key={c.v} active={c.active} label={c.label} onClick={c.onClick} />)}
        </span>
      ))}
    </div>
  );
}

function nodeStroke(b: Bead): string {
  if (b.status === 'in-progress') return '#d8b56a';
  if (b.status === 'blocked') return '#e0705a';
  return TYPE_COLOR[b.type] ?? '#3f5147';
}

function EdgeLine({ e }: Readonly<{ e: GEdge }>) {
  return e.kind === 'parent' ? (
    <line x1={e.x1} y1={e.y1 + 12} x2={e.x2} y2={e.y2 - 12} stroke="#3f5147" strokeWidth={1} />
  ) : (
    <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#e0705a" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />
  );
}

function GraphNode({ n, onPick }: Readonly<{ n: GNode; onPick: (b: Bead | null) => void }>) {
  return (
    <g transform={`translate(${n.x},${n.y})`} onClick={() => onPick(n.bead)} className="bl-node">
      <rect x={-98} y={-14} width={196} height={28} rx={6}
        fill={n.bead.status === 'blocked' ? '#3a2430' : '#172018'}
        stroke={nodeStroke(n.bead)}
        strokeWidth={n.bead.type === 'epic' ? 2 : 1}
      />
      <text x={-90} y={4} fontSize={10} fill="#c8d4cc" fontFamily="var(--mono)">
        {n.bead.id} · {n.bead.title.slice(0, 26)}
      </text>
    </g>
  );
}

function Graph({ items, onPick }: Readonly<{ items: Bead[]; onPick: (b: Bead | null) => void }>) {
  const [flat, setFlat] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const g = useMemo(() => layout(items, flat), [items, flat]);

  const tools: ChipItem[] = [
    { v: 'flat', label: 'include flat roots', active: flat, onClick: () => setFlat(f => !f) },
    { v: 'zout', label: 'zoom −', active: false, onClick: () => setZoom(z => Math.max(0.15, z / 1.25)) },
    { v: 'zin', label: 'zoom +', active: false, onClick: () => setZoom(z => Math.min(4, z * 1.25)) },
    { v: 'reset', label: 'reset', active: false, onClick: () => { setZoom(1); setPan({ x: 0, y: 0 }); } },
  ];

  const onDrag = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const k = g.w / e.currentTarget.getBoundingClientRect().width / zoom;
    setPan(p => ({ x: p.x + (e.clientX - drag.current!.x) * k, y: p.y + (e.clientY - drag.current!.y) * k }));
    drag.current = { x: e.clientX, y: e.clientY };
  };

  return (
    <div className="bl-graphwrap">
      <div className="bl-graphtools">
        <ChipRow groups={[tools]} />
        <span className="bl-graphhint">drag to pan · click node for details · red edge = blocks</span>
      </div>
      <svg
        role="img"
        viewBox={`0 0 ${g.w} ${g.h}`}
        style={{ width: '100%', height: 'auto', display: 'block', background: '#0e1410', cursor: 'grab' }}
        onMouseDown={e => (drag.current = { x: e.clientX, y: e.clientY })}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onMouseMove={onDrag}
      >
        <title>backlog dependency graph</title>
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {g.edges.map(e => <EdgeLine key={`${e.kind}${e.x1},${e.y1},${e.x2},${e.y2}`} e={e} />)}
          {g.nodes.map(n => <GraphNode key={n.bead.id} n={n} onPick={onPick} />)}
        </g>
      </svg>
    </div>
  );
}

function RelRow({ label, ids, onJump }: Readonly<{ label: string; ids: string[]; onJump: (id: string) => void }>) {
  if (ids.length === 0) return null;
  return (
    <p className="bl-detail-meta">
      {label}: {ids.map(id => <button key={id} type="button" onClick={() => onJump(id)} className="bl-jump">{id} </button>)}
    </p>
  );
}

// Detail meta lines are data too — each row is {when, text|element}.
function Detail({ b, onClose, onJump }: Readonly<{ b: Bead; onClose: () => void; onJump: (id: string) => void }>) {
  const isGh = b.id.startsWith('gh-') || b.id.startsWith('pr-');
  const parent = b.parent ? ` · parent ${b.parent}` : '';
  const meta: string[] = [
    `${b.type} · P${b.priority || '—'} · ${b.status}${parent}`,
    ...(b.labels.length ? [`labels: ${b.labels.join(', ')}`] : []),
    ...(b.open_children + b.closed_children ? [`children: ${b.open_children} open / ${b.closed_children} closed`] : []),
  ];
  return (
    <aside className="bl-detail">
      <div className="bl-detail-head">
        <code>{b.id}</code>
        <button type="button" onClick={onClose}>✕</button>
      </div>
      <p className="bl-detail-title">{b.title}</p>
      {meta.map(m => <p key={m} className="bl-detail-meta">{m}</p>)}
      {isGh && <p><a href={`${GITHUB}/issues/${b.id.split('-')[1]}`}>open on github ↗</a></p>}
      <RelRow label="blocks" ids={b.blocks} onJump={onJump} />
      <RelRow label="blocked by" ids={b.blocked_by} onJump={onJump} />
    </aside>
  );
}

// --- filtering ------------------------------------------------------------

type Row = { b: Bead; src: 'beads' | 'github' };

const beadPredicates = [
  (b: Bead, f: Filters) => f.status.has(b.status) && f.type.has(b.type) && f.priority.has(b.priority),
  (b: Bead, f: Filters) => !f.orphansOnly || !b.parent,
];

function haystack(b: Bead): string {
  return `${b.id} ${b.title} ${b.labels.join(' ')}`.toLowerCase();
}

const ghRows = (gh: GhItem[], q: string): Row[] =>
  gh.map(normalizeGh)
    .filter(b => !q || haystack(b).includes(q))
    .map(b => ({ b, src: 'github' as const }));

const beadRows = (beads: Bead[], f: Filters, q: string): Row[] =>
  beads.filter(b => beadPredicates.every(p => p(b, f)) && (!q || haystack(b).includes(q)))
    .map(b => ({ b, src: 'beads' as const }));

function applyFilters(beads: Bead[], gh: GhItem[], f: Filters): Row[] {
  const q = f.q.trim().toLowerCase();
  return [
    ...(f.source === 'github' ? [] : beadRows(beads, f, q)),
    ...(f.source !== 'beads' && !f.orphansOnly ? ghRows(gh, q) : []),
  ];
}

// --- page -----------------------------------------------------------------

function useBacklog(): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    load()
      .then(data => alive && setState({ kind: 'ready', data, cached: false }))
      .catch(err => {
        const cached = readCache();
        if (alive) {
          setState(cached
            ? { kind: 'ready', data: cached as Data, cached: true }
            : { kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => { alive = false; };
  }, []);
  return state;
}

function toggleSet<T>(s: Set<T>, v: T): Set<T> {
  const next = new Set(s);
  if (next.has(v)) next.delete(v); else next.add(v);
  return next;
}

function Stats({ data, gh, inView }: Readonly<{ data: Data; gh: GhItem[]; inView: number }>) {
  const cells: Array<[number, string]> = [
    [data.snapshot.total_open, 'open beads'],
    [gh.filter(g => g.kind === 'issue').length, 'github issues'],
    [gh.filter(g => g.kind === 'pr').length, 'open PRs'],
    [inView, 'in view'],
  ];
  return (
    <section className="debt-grid">
      {cells.map(([n, l]) => (
        <div key={l} className="stat"><span className="stat-n">{n}</span><span className="stat-l">{l}</span></div>
      ))}
    </section>
  );
}

function ListView({ rows, now, onPick }: Readonly<{ rows: Row[]; now: number; onPick: (b: Bead) => void }>) {
  const CAP = 400;
  return (
    <section className="bl-listwrap">
      <table className="debt-table">
        <thead>
          <tr><th>id</th><th>type</th><th>P</th><th>age</th><th>title</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, CAP).map(({ b, src }) => (
            <tr key={b.id} onClick={() => onPick(b)} className="bl-row">
              <td>{b.id}</td>
              <td>{src === 'github' ? `gh·${b.type}` : b.type}{b.status !== 'open' ? ` (${b.status})` : ''}</td>
              <td className="num">{b.priority || '—'}</td>
              <td className="num">{ageDays(b.created_at, now)}d</td>
              <td>{b.title}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > CAP && <p className="debt-note">showing first {CAP} of {rows.length} — narrow the filters</p>}
      {rows.length === 0 && <p className="debt-note">nothing matches — loosen a filter</p>}
    </section>
  );
}

function FilterControls({ f, setF, view, setView }: Readonly<{
  f: Filters;
  setF: React.Dispatch<React.SetStateAction<Filters>>;
  view: 'list' | 'graph';
  setView: (v: 'list' | 'graph') => void;
}>) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF(p => ({ ...p, [k]: v }));
  const toggle = (k: 'status' | 'type' | 'priority', v: string | number) =>
    setF(p => ({ ...p, [k]: toggleSet(p[k] as Set<string | number>, v) }));
  const groups: ChipItem[][] = [
    (['all', 'beads', 'github'] as const).map(s => ({ v: s, label: s, active: f.source === s, onClick: () => set('source', s) })),
    ALL_STATUS.map(s => ({ v: s, label: s, active: f.status.has(s), onClick: () => toggle('status', s) })),
    ALL_TYPE.map(t => ({ v: t, label: t, active: f.type.has(t), onClick: () => toggle('type', t) })),
    ALL_PRIORITY.map(p => ({ v: `p${p}`, label: `P${p}`, active: f.priority.has(p), onClick: () => toggle('priority', p) })),
    [{ v: 'orphans', label: 'orphans only', active: f.orphansOnly, onClick: () => set('orphansOnly', !f.orphansOnly) }],
    (['list', 'graph'] as const).map(v => ({ v, label: v, active: view === v, onClick: () => setView(v) })),
  ];

  return (
    <section className="bl-controls">
      <input
        type="search"
        placeholder="filter by id / title / label…"
        value={f.q}
        onChange={e => set('q', e.target.value)}
        className="bl-search"
      />
      <ChipRow groups={groups} />
    </section>
  );
}

function Ready({ data, cached }: Readonly<{ data: Data; cached: boolean }>) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [picked, setPicked] = useState<Bead | null>(null);
  const [f, setF] = useState<Filters>({
    q: '', status: new Set(ALL_STATUS), type: new Set(ALL_TYPE),
    priority: new Set(ALL_PRIORITY), source: 'all', orphansOnly: false,
  });

  const beads = data.snapshot.issues;
  const filtered = useMemo(() => applyFilters(beads, data.gh, f), [beads, data.gh, f]);
  const byId = useMemo(() => new Map(beads.map(b => [b.id, b])), [beads]);
  const pick = (id: string) => { const t = byId.get(id); if (t) setPicked(t); };

  return (
    <>
      {cached && (
        <section className="debt-empty"><p>showing the last cached snapshot — GitHub API unreachable right now</p></section>
      )}
      <Stats data={data} gh={data.gh} inView={filtered.length} />
      <FilterControls f={f} setF={setF} view={view} setView={setView} />

      {view === 'list' && <ListView rows={filtered} now={Date.now()} onPick={setPicked} />}
      {view === 'graph' && (
        <section>
          <Graph items={filtered.filter(x => x.src === 'beads').map(x => x.b)} onPick={setPicked} />
        </section>
      )}
      {picked && <Detail b={picked} onClose={() => setPicked(null)} onJump={pick} />}
    </>
  );
}

function Gate({ state }: Readonly<{ state: LoadState }>) {
  if (state.kind === 'loading') return <section className="debt-empty"><p>loading…</p></section>;
  if (state.kind === 'error') {
    return (
      <section className="debt-empty">
        <p>⚠ {state.message} — <a href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api">GitHub rate limits</a> apply to unauthenticated views.</p>
      </section>
    );
  }
  return <Ready data={state.data} cached={state.cached} />;
}

function BacklogPage() {
  const state = useBacklog();
  return (
    <>
      <main className="bl-main">
        <section className="hero">
          <p className="kicker">the swamp, mapped</p>
          <h1>bro backlog, <em>live</em>.</h1>
          <p className="lede">
            Every open bead plus the GitHub queue, read straight off{' '}
            <code>refs/bro/data</code> and the REST API at page load. A publish job refreshes the
            snapshot on every merge to main — what you see is what the store holds now.
          </p>
        </section>
        <Gate state={state} />
      </main>
      <footer className="foot">
        <p className="links">
          <a href={BASE_URL}>bro</a> · <a href={DOCS}>docs</a> · <a href={`${GITHUB}`}>github ↗</a>
          {state.kind === 'ready' && (
            <span className="debt-note"> · snapshot {state.data.sha.slice(0, 8)} · {state.data.snapshot.generated_at.slice(0, 16).replace('T', ' ')}Z</span>
          )}
        </p>
      </footer>
    </>
  );
}

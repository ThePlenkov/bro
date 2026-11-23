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

// Beads have no HTTP surface (the store is dolt chunks on refs/dolt/data),
// so `bro sync` and the merge-to-main workflow export a compact
// backlog.json onto refs/bro/data — and mirror the same commit onto the
// heads twin `bro-data`, which raw.githubusercontent serves without the
// API quota the ref-resolution call costs. GitHub issues and open PRs
// come live from the REST API in the same request wave.
const BRANCH = 'bro-data';
const REF_API = 'https://api.github.com/repos/ThePlenkov/bro/git/ref/bro/data';
const RAW = 'https://raw.githubusercontent.com/ThePlenkov/bro';
const ISSUES_API = 'https://api.github.com/repos/ThePlenkov/bro/issues?state=open&per_page=100';
const SNAPSHOT_KEY = 'bro:backlog:snapshot:v2';
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
  description?: string;
  assignee?: string;
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
  body?: string;
  labels: string[];
}

interface Data {
  snapshot: Snapshot;
  gh: GhItem[];
  sha: string;
  fetchedAt: string;
  ghUnavailable?: boolean;
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

// Facet chips derive from the data itself — a hard-coded list would
// silently hide any bead whose status/type/priority is missing from it
// (P0 beads, `human`/`gate` types, `deferred` status).
const STATUS_ORDER = ['open', 'in-progress', 'blocked', 'deferred'];
const TYPE_ORDER = ['epic', 'feature', 'task', 'bug', 'chore', 'agent', 'molecule', 'issue', 'pr'];

function ordered<T extends string | number>(vals: Iterable<T>, preferred: readonly T[]): T[] {
  const rank = (v: T) => {
    const i = preferred.indexOf(v);
    return i === -1 ? preferred.length : i;
  };
  return [...vals].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function universes(rows: Bead[]): { status: string[]; type: string[]; priority: number[] } {
  return {
    status: ordered(new Set(rows.map(b => b.status)), STATUS_ORDER),
    type: ordered(new Set(rows.map(b => b.type)), TYPE_ORDER),
    priority: [...new Set(rows.map(b => b.priority))].sort((a, b) => a - b),
  };
}

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
  body?: string | null;
  labels?: Array<{ name?: string } | string>;
}

const toGh = (i: GhRaw): GhItem => ({
  id: `${i.pull_request ? 'pr' : 'gh'}-${i.number}`,
  title: i.title,
  kind: i.pull_request ? 'pr' : 'issue',
  created_at: i.created_at,
  url: i.html_url,
  body: i.body ?? undefined,
  labels: (i.labels ?? []).map(l => (typeof l === 'string' ? l : (l.name ?? ''))),
});

// Pages until a short one — the queue outgrew a single page long ago;
// a non-ok response throws so a failed feed can't masquerade as an
// empty queue and overwrite the cached one
async function fetchGh(): Promise<GhItem[]> {
  const out: GhItem[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${ISSUES_API}&page=${page}`);
    if (!res.ok) throw new Error(`github api ${res.status}`);
    const items = (await res.json()) as GhRaw[];
    out.push(...items.map(toGh));
    if (items.length < 100) break;
  }
  return out;
}

// The heads twin costs no API quota — the ref-resolution path stays as
// the fallback until the branch exists (pre-migration snapshots).
async function fetchSnapshot(): Promise<{ snapshot: Snapshot; sha: string }> {
  const branch = await fetch(`${RAW}/${BRANCH}/${BACKLOG_PATH}`);
  if (branch.ok) {
    return { snapshot: (await branch.json()) as Snapshot, sha: BRANCH };
  }
  const sha = await resolveSha();
  const res = await fetch(`${RAW}/${sha}/${BACKLOG_PATH}`);
  if (!res.ok) throw new Error(`backlog.json not on refs/bro/data (${res.status})`);
  return { snapshot: (await res.json()) as Snapshot, sha };
}

// Beads are required (the whole point of the page) — the snapshot
// paints alone, the github queue streams in after. A slow or
// rate-limited api must never gate the beads: cached gh rows show in
// the meantime, the verdict arrives as ghUnavailable.
async function load(): Promise<Data> {
  const { snapshot, sha } = await fetchSnapshot();
  return {
    snapshot,
    gh: readCache()?.gh ?? [],
    sha,
    fetchedAt: new Date().toISOString(),
  };
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
    description: g.body?.slice(0, 4000),
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

function forestRoots(
  issues: Bead[],
  includeFlat: boolean
): { starts: Bead[]; children: Map<string, Bead[]> } {
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
  const epicSet = new Set(epics);
  const flat = roots.filter(r => !epicSet.has(r));
  return { starts: includeFlat ? [...epics, ...flat] : epics, children };
}

// One vertical band per root; each subtree is BFS'd level by level,
// every level wrapped across W_COLS columns so the whole forest fits a
// fixed-width strip the page scrolls through.
function layoutBand(
  root: Bead,
  bandY: number,
  children: Map<string, Bead[]>,
  pos: Map<string, GNode>
): number {
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

// One edge kind per relation source — the table drives both loops.
const EDGE_SOURCES: Array<{
  kind: GEdge['kind'];
  targets: (n: GNode, children: Map<string, Bead[]>) => string[];
  yOff: [number, number];
}> = [
  {
    kind: 'parent',
    targets: (n, children) => (children.get(n.bead.id) ?? []).map(k => k.id),
    yOff: [12, -12],
  },
  { kind: 'blocks', targets: n => n.bead.blocks, yOff: [0, 0] },
];

function collectLayoutEdges(pos: Map<string, GNode>, children: Map<string, Bead[]>): GEdge[] {
  return [...pos.values()].flatMap(n =>
    EDGE_SOURCES.flatMap(src =>
      src.targets(n, children).flatMap(id => {
        const t = pos.get(id);
        return t
          ? [{ x1: n.x, y1: n.y + src.yOff[0], x2: t.x, y2: t.y + src.yOff[1], kind: src.kind }]
          : [];
      })
    )
  );
}

function layout(
  issues: Bead[],
  includeFlat: boolean
): { nodes: GNode[]; edges: GEdge[]; w: number; h: number } {
  const { starts, children } = forestRoots(issues, includeFlat);
  const pos = new Map<string, GNode>();
  let bandY = 0;
  for (const root of starts) bandY = layoutBand(root, bandY, children, pos);
  return {
    nodes: [...pos.values()],
    edges: collectLayoutEdges(pos, children),
    w: W_COLS * COL_W,
    h: bandY + 20,
  };
}

// --- components ---------------------------------------------------------

function Chip({
  active,
  label,
  onClick,
}: Readonly<{ active: boolean; label: string; onClick: () => void }>) {
  return (
    <button type="button" onClick={onClick} className={`bl-chip${active ? ' on' : ''}`}>
      {label}
    </button>
  );
}

// Chip rows are data, not JSX: every filter group is one entry and the
// controls render it generically — adding a facet is a one-line change.
interface ChipItem {
  v: string;
  label: string;
  active: boolean;
  onClick: () => void;
}

function ChipRow({ groups }: Readonly<{ groups: ChipItem[][] }>) {
  return (
    <div className="bl-chiprow">
      {groups.map((g, gi) => (
        <span key={g.map(c => c.v).join('|')} style={{ display: 'contents' }}>
          {gi > 0 && <span className="bl-sep" />}
          {g.map(c => (
            <Chip key={c.v} active={c.active} label={c.label} onClick={c.onClick} />
          ))}
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
    <line
      x1={e.x1}
      y1={e.y1}
      x2={e.x2}
      y2={e.y2}
      stroke="#e0705a"
      strokeWidth={1.5}
      strokeDasharray="4 3"
      opacity={0.8}
    />
  );
}

function GraphNode({ n, onPick }: Readonly<{ n: GNode; onPick: (b: Bead | null) => void }>) {
  return (
    <g transform={`translate(${n.x},${n.y})`} onClick={() => onPick(n.bead)} className="bl-node">
      <rect
        x={-98}
        y={-14}
        width={196}
        height={28}
        rx={6}
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

// zoom/pan/drag is interaction state — it lives in a hook, not inside
// the component that renders the toolbar
function useViewport() {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  return {
    zoom,
    pan,
    drag,
    setPan,
    zoomIn: () => setZoom(z => Math.min(4, z * 1.25)),
    zoomOut: () => setZoom(z => Math.max(0.15, z / 1.25)),
    reset: () => {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    },
  };
}

type Viewport = ReturnType<typeof useViewport>;

function GraphSvg({
  g,
  view,
  onPick,
}: Readonly<{ g: ReturnType<typeof layout>; view: Viewport; onPick: (b: Bead | null) => void }>) {
  const onDrag = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!view.drag.current) return;
    const k = g.w / e.currentTarget.getBoundingClientRect().width / view.zoom;
    view.setPan(p => ({
      x: p.x + (e.clientX - view.drag.current!.x) * k,
      y: p.y + (e.clientY - view.drag.current!.y) * k,
    }));
    view.drag.current = { x: e.clientX, y: e.clientY };
  };
  return (
    <svg
      role="img"
      viewBox={`0 0 ${g.w} ${g.h}`}
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        background: '#0e1410',
        cursor: 'grab',
      }}
      onMouseDown={e => (view.drag.current = { x: e.clientX, y: e.clientY })}
      onMouseUp={() => (view.drag.current = null)}
      onMouseLeave={() => (view.drag.current = null)}
      onMouseMove={onDrag}
    >
      <title>backlog dependency graph</title>
      <g transform={`translate(${view.pan.x},${view.pan.y}) scale(${view.zoom})`}>
        {g.edges.map(e => (
          <EdgeLine key={`${e.kind}${e.x1},${e.y1},${e.x2},${e.y2}`} e={e} />
        ))}
        {g.nodes.map(n => (
          <GraphNode key={n.bead.id} n={n} onPick={onPick} />
        ))}
      </g>
    </svg>
  );
}

function Graph({ items, onPick }: Readonly<{ items: Bead[]; onPick: (b: Bead | null) => void }>) {
  const [flat, setFlat] = useState(false);
  const view = useViewport();
  const g = useMemo(() => layout(items, flat), [items, flat]);

  const tools: ChipItem[] = [
    { v: 'flat', label: 'include flat roots', active: flat, onClick: () => setFlat(f => !f) },
    { v: 'zout', label: 'zoom −', active: false, onClick: view.zoomOut },
    { v: 'zin', label: 'zoom +', active: false, onClick: view.zoomIn },
    { v: 'reset', label: 'reset', active: false, onClick: view.reset },
  ];

  return (
    <div className="bl-graphwrap">
      <div className="bl-graphtools">
        <ChipRow groups={[tools]} />
        <span className="bl-graphhint">
          drag to pan · click node for details · red edge = blocks
        </span>
      </div>
      <GraphSvg g={g} view={view} onPick={onPick} />
    </div>
  );
}

function RelRow({
  label,
  ids,
  onJump,
}: Readonly<{ label: string; ids: string[]; onJump: (id: string) => void }>) {
  if (ids.length === 0) return null;
  return (
    <p className="bl-detail-meta">
      {label}:{' '}
      {ids.map(id => (
        <button key={id} type="button" onClick={() => onJump(id)} className="bl-jump">
          {id}{' '}
        </button>
      ))}
    </p>
  );
}

// The detail panel is where a bead becomes readable: badges for what it
// is, the description for what it says, and every relation a jump away
function Detail({
  b,
  kids,
  onClose,
  onJump,
}: Readonly<{ b: Bead; kids: string[]; onClose: () => void; onJump: (id: string) => void }>) {
  const isGh = b.id.startsWith('gh-') || b.id.startsWith('pr-');
  const badges: Array<[id: string, label: string, color: string | undefined]> = [
    ['type', b.type, TYPE_COLOR[b.type]],
    ['status', b.status, b.status === 'open' ? undefined : '#d8b56a'],
    ['priority', `P${b.priority || '—'}`, undefined],
    ...(isGh ? [['source', 'github', undefined] as [string, string, undefined]] : []),
  ];
  return (
    <aside className="bl-detail">
      <div className="bl-detail-head">
        <code>{b.id}</code>
        <button type="button" onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>
      <p className="bl-detail-badges">
        {badges.map(([id, label, color]) => (
          <span key={id} className="bl-badge" style={color ? { borderColor: color } : undefined}>
            {label}
          </span>
        ))}
      </p>
      <p className="bl-detail-title">{b.title}</p>
      <p className="bl-detail-meta">
        opened {b.created_at.slice(0, 10)}
        {b.assignee ? ` · ${b.assignee}` : ''}
      </p>
      {b.labels.length > 0 && (
        <p className="bl-detail-badges">
          {b.labels.map(l => (
            <span key={l} className="bl-badge dim">
              {l}
            </span>
          ))}
        </p>
      )}
      {/* untrusted plain text — never switch this to dangerouslySetInnerHTML */}
      {b.description && <div className="bl-detail-desc">{b.description}</div>}
      {b.open_children + b.closed_children > 0 && (
        <p className="bl-detail-meta">
          children: {b.open_children} open / {b.closed_children} closed
        </p>
      )}
      {isGh && (
        <p>
          <a href={`${GITHUB}/${b.id.startsWith('pr-') ? 'pull' : 'issues'}/${b.id.split('-')[1]}`}>
            open on github ↗
          </a>
        </p>
      )}
      {b.parent && <RelRow label="parent" ids={[b.parent]} onJump={onJump} />}
      <RelRow label="children" ids={kids} onJump={onJump} />
      <RelRow label="blocks" ids={b.blocks} onJump={onJump} />
      <RelRow label="blocked by" ids={b.blocked_by} onJump={onJump} />
    </aside>
  );
}

// --- filtering ------------------------------------------------------------

interface Row {
  b: Bead;
  src: 'beads' | 'github';
  age: number;
  hay: string;
}

function haystack(b: Bead): string {
  return `${b.id} ${b.title} ${b.labels.join(' ')}`.toLowerCase();
}

const toRow = (b: Bead, src: Row['src'], now: number): Row => ({
  b,
  src,
  age: ageDays(b.created_at, now),
  hay: haystack(b),
});

// same facet semantics for both sources — github rows carry `open`/`issue`|
// `pr`/P0, so the chips filter them the same way beads get filtered
const rowPredicates: Array<(r: Row, f: Filters) => boolean> = [
  (r, f) => f.source === 'all' || r.src === f.source,
  (r, f) => f.status.has(r.b.status) && f.type.has(r.b.type) && f.priority.has(r.b.priority),
  (r, f) => !f.orphansOnly || (r.src === 'beads' && !r.b.parent),
];

function applyFilters(beads: Bead[], gh: GhItem[], f: Filters, now: number): Row[] {
  const q = f.q.trim().toLowerCase();
  const rows = [
    ...beads.map(b => toRow(b, 'beads', now)),
    ...gh.map(g => toRow(normalizeGh(g), 'github', now)),
  ];
  return rows.filter(r => rowPredicates.every(p => p(r, f)) && (q === '' || r.hay.includes(q)));
}

// --- page -----------------------------------------------------------------

function useBacklog(): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    load()
      .then(data => {
        if (!alive) return;
        setState({ kind: 'ready', data, cached: false });
        fetchGh()
          .then(items => {
            if (!alive) return;
            try {
              window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...data, gh: items }));
            } catch {
              /* quota — live next load instead */
            }
            setState(s =>
              s.kind === 'ready'
                ? { ...s, data: { ...s.data, gh: items, ghUnavailable: false } }
                : s
            );
          })
          .catch(() => {
            if (!alive) return;
            setState(s =>
              s.kind === 'ready' ? { ...s, data: { ...s.data, ghUnavailable: true } } : s
            );
          });
      })
      .catch(err => {
        const cached = readCache();
        if (alive) {
          setState(
            cached
              ? { kind: 'ready', data: cached as Data, cached: true }
              : { kind: 'error', message: err instanceof Error ? err.message : String(err) }
          );
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function toggleSet<T>(s: Set<T>, v: T): Set<T> {
  const next = new Set(s);
  if (next.has(v)) next.delete(v);
  else next.add(v);
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
        <div key={l} className="stat">
          <span className="stat-n">{n}</span>
          <span className="stat-l">{l}</span>
        </div>
      ))}
    </section>
  );
}

// comparators are data — adding a sortable column is a table entry, and
// the header renders it generically
const SORTS: Record<string, (a: Row, b: Row) => number> = {
  id: (a, b) => a.b.id.localeCompare(b.b.id),
  type: (a, b) => a.b.type.localeCompare(b.b.type),
  priority: (a, b) => a.b.priority - b.b.priority,
  age: (a, b) => b.age - a.age,
  title: (a, b) => a.b.title.localeCompare(b.b.title),
};
const HEADERS: Array<[keyof typeof SORTS, string]> = [
  ['id', 'id'],
  ['type', 'type'],
  ['priority', 'P'],
  ['age', 'age'],
  ['title', 'title'],
];

interface Sort {
  k: string;
  dir: 1 | -1;
}
const toggleSort = (s: Sort, k: string): Sort => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : 1 });
// descriptor read — a computed key must never reach a plain obj[k] call
const sortCmp = (k: string) => Object.getOwnPropertyDescriptor(SORTS, k)?.value ?? SORTS.title;

function SortTh({
  k,
  label,
  sort,
  onSort,
}: Readonly<{ k: string; label: string; sort: Sort; onSort: (k: string) => void }>) {
  return (
    <th onClick={() => onSort(k)}>
      {label}
      {sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
}

function ListRow({ r, onPick }: Readonly<{ r: Row; onPick: (b: Bead) => void }>) {
  return (
    <tr onClick={() => onPick(r.b)} className="bl-row">
      <td>{r.b.id}</td>
      <td>
        {r.src === 'github' ? `gh·${r.b.type}` : r.b.type}
        {r.b.status !== 'open' ? ` (${r.b.status})` : ''}
      </td>
      <td className="num">{r.b.priority || '—'}</td>
      <td className="num">{r.age}d</td>
      <td>{r.b.title}</td>
    </tr>
  );
}

function ListView({ rows, onPick }: Readonly<{ rows: Row[]; onPick: (b: Bead) => void }>) {
  const CAP = 400;
  const [sort, setSort] = useState<Sort>({ k: 'age', dir: 1 });
  const sorted = useMemo(
    () => [...rows].sort((a, b) => sortCmp(sort.k)(a, b) * sort.dir),
    [rows, sort]
  );
  return (
    <section className="bl-listwrap">
      <table className="debt-table">
        <thead>
          <tr>
            {HEADERS.map(([k, label]) => (
              <SortTh
                key={k}
                k={k}
                label={label}
                sort={sort}
                onSort={k2 => setSort(s => toggleSort(s, k2))}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, CAP).map(r => (
            <ListRow key={r.b.id} r={r} onPick={onPick} />
          ))}
        </tbody>
      </table>
      {rows.length > CAP && (
        <p className="debt-note">
          showing first {CAP} of {rows.length} — narrow the filters
        </p>
      )}
      {rows.length === 0 && <p className="debt-note">nothing matches — loosen a filter</p>}
    </section>
  );
}

// A chip without a group name is a guess; a value without a count hides
// the shape of the backlog — facets render as labeled fieldsets, each
// option carrying its row count
function FacetGroup({ legend, chips }: Readonly<{ legend: string; chips: ChipItem[] }>) {
  return (
    <fieldset className="bl-facet">
      <legend>{legend}</legend>
      {chips.map(c => (
        <Chip key={c.v} active={c.active} label={c.label} onClick={c.onClick} />
      ))}
    </fieldset>
  );
}

// per-facet counts over the source-filtered rows — "how many of each
// kind exist here", independent of the other facets' selection
function facetCounts(rows: Row[]) {
  const c = {
    status: new Map<string, number>(),
    type: new Map<string, number>(),
    priority: new Map<number, number>(),
  };
  for (const r of rows) {
    c.status.set(r.b.status, (c.status.get(r.b.status) ?? 0) + 1);
    c.type.set(r.b.type, (c.type.get(r.b.type) ?? 0) + 1);
    c.priority.set(r.b.priority, (c.priority.get(r.b.priority) ?? 0) + 1);
  }
  return c;
}

function facetCount<T>(m: Map<T, number>, k: T): string {
  return ` · ${m.get(k) ?? 0}`;
}

function FilterControls({
  f,
  setF,
  view,
  setView,
  uni,
  srcRows,
  nBeads,
  nGh,
}: Readonly<{
  f: Filters;
  setF: React.Dispatch<React.SetStateAction<Filters>>;
  view: 'list' | 'graph';
  setView: (v: 'list' | 'graph') => void;
  uni: { status: string[]; type: string[]; priority: number[] };
  srcRows: Row[];
  nBeads: number;
  nGh: number;
}>) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF(p => ({ ...p, [k]: v }));
  const toggle = (k: 'status' | 'type' | 'priority', v: string | number) =>
    setF(p => ({ ...p, [k]: toggleSet(p[k] as Set<string | number>, v) }));
  const clear = () =>
    setF({
      q: '',
      status: new Set(uni.status),
      type: new Set(uni.type),
      priority: new Set(uni.priority),
      source: 'all',
      orphansOnly: false,
    });
  const counts = facetCounts(srcRows);
  const narrowed =
    f.q !== '' ||
    f.source !== 'all' ||
    f.orphansOnly ||
    f.status.size !== uni.status.length ||
    f.type.size !== uni.type.length ||
    f.priority.size !== uni.priority.length;

  const facets: Array<[string, ChipItem[]]> = [
    [
      'source',
      [
        {
          v: 'all',
          label: `all · ${nBeads + nGh}`,
          active: f.source === 'all',
          onClick: () => set('source', 'all'),
        },
        {
          v: 'beads',
          label: `beads · ${nBeads}`,
          active: f.source === 'beads',
          onClick: () => set('source', 'beads'),
        },
        {
          v: 'github',
          label: `github · ${nGh}`,
          active: f.source === 'github',
          onClick: () => set('source', 'github'),
        },
      ],
    ],
    [
      'status',
      uni.status.map(s => ({
        v: s,
        label: `${s}${facetCount(counts.status, s)}`,
        active: f.status.has(s),
        onClick: () => toggle('status', s),
      })),
    ],
    [
      'type',
      uni.type.map(t => ({
        v: t,
        label: `${t}${facetCount(counts.type, t)}`,
        active: f.type.has(t),
        onClick: () => toggle('type', t),
      })),
    ],
    [
      'priority',
      uni.priority.map(p => ({
        v: `p${p}`,
        label: `P${p}${facetCount(counts.priority, p)}`,
        active: f.priority.has(p),
        onClick: () => toggle('priority', p),
      })),
    ],
    [
      'scope',
      [
        {
          v: 'orphans',
          label: 'orphans only',
          active: f.orphansOnly,
          onClick: () => set('orphansOnly', !f.orphansOnly),
        },
      ],
    ],
    [
      'view',
      (['list', 'graph'] as const).map(v => ({
        v,
        label: v,
        active: view === v,
        onClick: () => setView(v),
      })),
    ],
  ];

  return (
    <section className="bl-controls">
      <div className="bl-controls-top">
        <input
          type="search"
          placeholder="filter by id / title / label…"
          value={f.q}
          onChange={e => set('q', e.target.value)}
          className="bl-search"
        />
        <button
          type="button"
          className="bl-chip"
          onClick={clear}
          disabled={!narrowed}
          title="reset every filter"
        >
          clear filters
        </button>
      </div>
      <div className="bl-facets">
        {facets.map(([legend, chips]) => (
          <FacetGroup key={legend} legend={legend} chips={chips} />
        ))}
      </div>
    </section>
  );
}

function Ready({ data, cached }: Readonly<{ data: Data; cached: boolean }>) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [picked, setPicked] = useState<Bead | null>(null);

  const beads = data.snapshot.issues;
  const [now] = useState(() => Date.now());
  const uni = useMemo(() => universes([...beads, ...data.gh.map(normalizeGh)]), [beads, data.gh]);
  const [f, setF] = useState<Filters>({
    q: '',
    status: new Set(uni.status),
    type: new Set(uni.type),
    priority: new Set(uni.priority),
    source: 'all',
    orphansOnly: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // rows after the source facet — the population the facet counts describe
  const srcRows = useMemo(() => {
    const rows = [
      ...beads.map(b => toRow(b, 'beads' as const, now)),
      ...data.gh.map(g => toRow(normalizeGh(g), 'github' as const, now)),
    ];
    return f.source === 'all' ? rows : rows.filter(r => r.src === f.source);
  }, [beads, data.gh, f.source, now]);

  const filtered = useMemo(() => applyFilters(beads, data.gh, f, now), [beads, data.gh, f, now]);
  const byId = useMemo(() => new Map(beads.map(b => [b.id, b])), [beads]);
  // children are derivable from the parent column — no extra export field
  const childIds = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of beads) {
      if (b.parent) (m.get(b.parent) ?? m.set(b.parent, []).get(b.parent)!).push(b.id);
    }
    return m;
  }, [beads]);
  const pick = (id: string) => {
    const t = byId.get(id);
    if (t) setPicked(t);
  };

  return (
    <>
      {cached && (
        <section className="debt-empty">
          <p>showing the last cached snapshot — GitHub API unreachable right now</p>
        </section>
      )}
      {data.ghUnavailable && !cached && (
        <section className="debt-empty">
          <p>github live feed unreachable — beads are live, the gh queue is the last cached one</p>
        </section>
      )}
      <Stats data={data} gh={data.gh} inView={filtered.length} />
      <FilterControls
        f={f}
        setF={setF}
        view={view}
        setView={setView}
        uni={uni}
        srcRows={srcRows}
        nBeads={beads.length}
        nGh={data.gh.length}
      />

      {view === 'list' && <ListView rows={filtered} onPick={setPicked} />}
      {view === 'graph' && (
        <section>
          <Graph items={filtered.filter(x => x.src === 'beads').map(x => x.b)} onPick={setPicked} />
        </section>
      )}
      {picked && (
        <Detail
          b={picked}
          kids={childIds.get(picked.id) ?? []}
          onClose={() => setPicked(null)}
          onJump={pick}
        />
      )}
    </>
  );
}

function Gate({ state }: Readonly<{ state: LoadState }>) {
  if (state.kind === 'loading')
    return (
      <section className="debt-empty">
        <p>loading…</p>
      </section>
    );
  if (state.kind === 'error') {
    return (
      <section className="debt-empty">
        <p>
          ⚠ {state.message} —{' '}
          <a href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api">
            GitHub rate limits
          </a>{' '}
          apply to unauthenticated views.
        </p>
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
          <h1>
            bro backlog, <em>live</em>.
          </h1>
          <p className="lede">
            Every open bead plus the GitHub queue, read straight off <code>refs/bro/data</code> and
            the REST API at page load. A publish job refreshes the snapshot on every merge to main —
            what you see is what the store holds now.
          </p>
        </section>
        <Gate state={state} />
      </main>
      <footer className="foot">
        <p className="links">
          <a href={BASE_URL}>bro</a> · <a href={DOCS}>docs</a> · <a href={`${GITHUB}`}>github ↗</a>
          {state.kind === 'ready' && (
            <span className="debt-note">
              {' '}
              · snapshot {state.data.sha.slice(0, 8)} ·{' '}
              {state.data.snapshot.generated_at.slice(0, 16).replace('T', ' ')}Z
            </span>
          )}
        </p>
      </footer>
    </>
  );
}

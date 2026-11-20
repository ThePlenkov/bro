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
const BACKLOG_PATH = 'backlog.json';

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

async function load(): Promise<Data> {
  const refRes = await fetch(REF_API);
  if (!refRes.ok) {
    const cached = readCache();
    if (cached) return { ...cached, fetchedAt: cached.fetchedAt };
    throw new Error(`could not resolve refs/bro/data (${refRes.status})`);
  }
  const { object } = (await refRes.json()) as { object: { sha: string } };
  const sha = object.sha;

  const [backlogRes, issuesRes] = await Promise.all([
    fetch(`${RAW}/${sha}/${BACKLOG_PATH}`),
    fetch(ISSUES_API),
  ]);
  if (!backlogRes.ok) {
    throw new Error(`backlog.json not on refs/bro/data (${backlogRes.status})`);
  }
  const snapshot = (await backlogRes.json()) as Snapshot;

  let gh: GhItem[] = [];
  if (issuesRes.ok) {
    const items = (await issuesRes.json()) as Array<{
      number: number;
      title: string;
      html_url: string;
      created_at: string;
      pull_request?: unknown;
      labels?: Array<{ name?: string } | string>;
    }>;
    gh = items.map(i => ({
      id: `${i.pull_request ? 'pr' : 'gh'}-${i.number}`,
      title: i.title,
      kind: i.pull_request ? 'pr' : 'issue',
      created_at: i.created_at,
      url: i.html_url,
      labels: (i.labels ?? []).map(l => (typeof l === 'string' ? l : (l.name ?? ''))),
    }));
  }

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

function layout(issues: Bead[], includeFlat: boolean): { nodes: GNode[]; edges: GEdge[]; w: number; h: number } {
  const byId = new Map(issues.map(i => [i.id, i]));
  const children = new Map<string, Bead[]>();
  const roots: Bead[] = [];
  for (const i of issues) {
    const p = i.parent && byId.has(i.parent) ? i.parent : null;
    if (p) {
      (children.get(p) ?? children.set(p, []).get(p)!).push(i);
    } else {
      roots.push(i);
    }
  }
  const epics = roots
    .filter(r => r.type === 'epic' || children.has(r.id))
    .sort((a, b) => a.priority - b.priority || b.open_children - a.open_children);
  const flat = roots.filter(r => !epics.includes(r));
  const starts = includeFlat ? [...epics, ...flat] : epics;

  // Vertical bands — one per root; each subtree is BFS'd level by level,
  // every level wrapped across W_COLS columns so the whole forest fits a
  // fixed-width strip the page scrolls through.
  const ROW_H = 56;
  const COL_W = 220;
  const W_COLS = 5;
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const pos = new Map<string, GNode>();
  let bandY = 0;

  for (const root of starts) {
    let frontier: Bead[] = [root];
    let levelY = bandY + 24;
    let depth = 0;
    while (frontier.length > 0) {
      const next: Bead[] = [];
      frontier.forEach((n, idx) => {
        const gn: GNode = {
          bead: n,
          x: (idx % W_COLS) * COL_W + COL_W / 2,
          y: levelY + Math.floor(idx / W_COLS) * ROW_H,
          depth,
        };
        nodes.push(gn);
        pos.set(n.id, gn);
        for (const k of children.get(n.id) ?? []) next.push(k);
      });
      levelY += Math.ceil(frontier.length / W_COLS) * ROW_H;
      frontier = next;
      depth += 1;
    }
    bandY = levelY + 8;
  }

  for (const n of nodes) {
    for (const k of children.get(n.bead.id) ?? []) {
      const t = pos.get(k.id);
      if (t) edges.push({ x1: n.x, y1: n.y + 12, x2: t.x, y2: t.y - 12, kind: 'parent' });
    }
    for (const t of n.bead.blocks) {
      const other = pos.get(t);
      if (other) edges.push({ x1: n.x, y1: n.y, x2: other.x, y2: other.y, kind: 'blocks' });
    }
  }
  return { nodes, edges, w: W_COLS * COL_W, h: bandY + 20 };
}

// --- components ---------------------------------------------------------

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`bl-chip${active ? ' on' : ''}`}
    >
      {label}
    </button>
  );
}

function Graph({ items, onPick }: { items: Bead[]; onPick: (b: Bead | null) => void }) {
  const [flat, setFlat] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const g = useMemo(() => layout(items, flat), [items, flat]);
  return (
    <div className="bl-graphwrap">
      <div className="bl-graphtools">
        <Chip active={flat} label="include flat roots" onClick={() => setFlat(f => !f)} />
        <Chip active={false} label="zoom −" onClick={() => setZoom(z => Math.max(0.15, z / 1.25))} />
        <Chip active={false} label="zoom +" onClick={() => setZoom(z => Math.min(4, z * 1.25))} />
        <Chip active={false} label="reset" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} />
        <span className="bl-graphhint">drag to pan · click node for details · red edge = blocks</span>
      </div>
      <svg
        viewBox={`0 0 ${g.w} ${g.h}`}
        style={{width:"100%",height:"auto",display:"block",background:"#0e1410",cursor:"grab"}}
        onMouseDown={e => (drag.current = { x: e.clientX, y: e.clientY })}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onMouseMove={e => {
          if (!drag.current) return;
          const svg = e.currentTarget.getBoundingClientRect();
          const k = g.w / svg.width / zoom;
          setPan(p => ({ x: p.x + (e.clientX - drag.current!.x) * k, y: p.y + (e.clientY - drag.current!.y) * k }));
          drag.current = { x: e.clientX, y: e.clientY };
        }}
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {g.edges.map((e, i) =>
            e.kind === 'parent' ? (
              <line key={i} x1={e.x1} y1={e.y1 + 12} x2={e.x2} y2={e.y2 - 12} stroke="#3f5147" strokeWidth={1} />
            ) : (
              <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#e0705a" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />
            ),
          )}
          {g.nodes.map(n => (
            <g key={n.bead.id} transform={`translate(${n.x},${n.y})`} onClick={() => onPick(n.bead)} className="bl-node">
              <rect x={-98} y={-14} width={196} height={28} rx={6}
                fill={n.bead.status === 'blocked' ? '#3a2430' : '#172018'}
                stroke={n.bead.status === 'in-progress' ? '#d8b56a' : n.bead.status === 'blocked' ? '#e0705a' : TYPE_COLOR[n.bead.type] ?? '#3f5147'}
                strokeWidth={n.bead.type === 'epic' ? 2 : 1}
              />
              <text x={-90} y={4} fontSize={10} fill="#c8d4cc" fontFamily="var(--mono)">
                {n.bead.id} · {n.bead.title.slice(0, 26)}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function Detail({ b, onClose, onJump }: { b: Bead; onClose: () => void; onJump: (id: string) => void }) {
  const isGh = b.id.startsWith('gh-') || b.id.startsWith('pr-');
  return (
    <aside className="bl-detail">
      <div className="bl-detail-head">
        <code>{b.id}</code>
        <button type="button" onClick={onClose}>✕</button>
      </div>
      <p className="bl-detail-title">{b.title}</p>
      <p className="bl-detail-meta">
        {b.type} · P{b.priority || '—'} · {b.status}
        {b.parent ? ` · parent ${b.parent}` : ''}
      </p>
      {isGh && (
        <p><a href={`${GITHUB}/issues/${b.id.split('-')[1]}`}>open on github ↗</a></p>
      )}
      {b.labels.length > 0 && <p className="bl-detail-meta">labels: {b.labels.join(', ')}</p>}
      {b.open_children + b.closed_children > 0 && (
        <p className="bl-detail-meta">children: {b.open_children} open / {b.closed_children} closed</p>
      )}
      {b.blocks.length > 0 && (
        <p className="bl-detail-meta">
          blocks: {b.blocks.map(id => <a key={id} onClick={() => onJump(id)} className="bl-jump">{id} </a>)}
        </p>
      )}
      {b.blocked_by.length > 0 && (
        <p className="bl-detail-meta">
          blocked by: {b.blocked_by.map(id => <a key={id} onClick={() => onJump(id)} className="bl-jump">{id} </a>)}
        </p>
      )}
    </aside>
  );
}

function BacklogPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [picked, setPicked] = useState<Bead | null>(null);
  const [f, setF] = useState<Filters>({
    q: '', status: new Set(ALL_STATUS), type: new Set(ALL_TYPE),
    priority: new Set(ALL_PRIORITY), source: 'all', orphansOnly: false,
  });

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

  const beads = state.kind === 'ready' ? state.data.snapshot.issues : [];
  const gh = state.kind === 'ready' ? state.data.gh : [];

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const list: Array<{ b: Bead; src: 'beads' | 'github' }> = [];
    if (f.source !== 'github') {
      for (const b of beads) {
        if (!f.status.has(b.status) || !f.type.has(b.type) || !f.priority.has(Number(b.priority))) continue;
        if (f.orphansOnly && b.parent) continue;
        if (q && !(`${b.id} ${b.title} ${b.labels.join(' ')}`.toLowerCase().includes(q))) continue;
        list.push({ b, src: 'beads' });
      }
    }
    if (f.source !== 'beads') {
      for (const g of gh) {
        const b = normalizeGh(g);
        if (q && !(`${b.id} ${b.title}`.toLowerCase().includes(q))) continue;
        if (f.orphansOnly) continue;
        list.push({ b, src: 'github' });
      }
    }
    return list;
  }, [beads, gh, f]);

  const byId = useMemo(() => new Map(beads.map(b => [b.id, b])), [beads]);
  const now = Date.now();
  const toggle = <K extends 'status' | 'type' | 'priority'>(k: K, v: Filters[K] extends Set<infer T> ? T : never) =>
    setF(prev => {
      const s = new Set(prev[k] as Set<never>);
      (s.has(v as never) ? s.delete(v as never) : s.add(v as never));
      return { ...prev, [k]: s };
    });

  return (
    <>
      <main className="bl-main">
        <section className="hero">
          <p className="kicker">the swamp, mapped</p>
          <h1>
            bro backlog, <em>live</em>.
          </h1>
          <p className="lede">
            Every open bead plus the GitHub queue, read straight off{' '}
            <code>refs/bro/data</code> and the REST API at page load. A publish job refreshes the
            snapshot on every merge to main — what you see is what the store holds now.
          </p>
        </section>

        {state.kind === 'loading' && <section className="debt-empty"><p>loading…</p></section>}
        {state.kind === 'error' && (
          <section className="debt-empty">
            <p>⚠ {state.message} — <a href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api">GitHub rate limits</a> apply to unauthenticated views.</p>
          </section>
        )}
        {state.kind === 'ready' && (
          <>
            {state.cached && (
              <section className="debt-empty"><p>showing the last cached snapshot — GitHub API unreachable right now</p></section>
            )}
            <section className="debt-grid">
              <div className="stat"><span className="stat-n">{state.data.snapshot.total_open}</span><span className="stat-l">open beads</span></div>
              <div className="stat"><span className="stat-n">{gh.filter(g => g.kind === 'issue').length}</span><span className="stat-l">github issues</span></div>
              <div className="stat"><span className="stat-n">{gh.filter(g => g.kind === 'pr').length}</span><span className="stat-l">open PRs</span></div>
              <div className="stat"><span className="stat-n">{filtered.length}</span><span className="stat-l">in view</span></div>
            </section>

            <section className="bl-controls">
              <input
                type="search"
                placeholder="filter by id / title / label…"
                value={f.q}
                onChange={e => setF(p => ({ ...p, q: e.target.value }))}
                className="bl-search"
              />
              <div className="bl-chiprow">
                {(['all', 'beads', 'github'] as const).map(s => (
                  <Chip key={s} active={f.source === s} label={s} onClick={() => setF(p => ({ ...p, source: s }))} />
                ))}
                <span className="bl-sep" />
                {ALL_STATUS.map(s => <Chip key={s} active={f.status.has(s)} label={s} onClick={() => toggle('status', s)} />)}
                <span className="bl-sep" />
                {ALL_TYPE.map(t => <Chip key={t} active={f.type.has(t)} label={t} onClick={() => toggle('type', t)} />)}
                <span className="bl-sep" />
                {ALL_PRIORITY.map(p => <Chip key={p} active={f.priority.has(p)} label={`P${p}`} onClick={() => toggle('priority', p)} />)}
                <span className="bl-sep" />
                <Chip active={f.orphansOnly} label="orphans only" onClick={() => setF(p => ({ ...p, orphansOnly: !p.orphansOnly }))} />
                <span className="bl-sep" />
                <Chip active={view === 'list'} label="list" onClick={() => setView('list')} />
                <Chip active={view === 'graph'} label="graph" onClick={() => setView('graph')} />
              </div>
            </section>

            {view === 'list' && (
              <section className="bl-listwrap">
                <table className="debt-table">
                  <thead>
                    <tr><th>id</th><th>type</th><th>P</th><th>age</th><th>title</th></tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 400).map(({ b, src }) => (
                      <tr key={b.id} onClick={() => setPicked(b)} className="bl-row">
                        <td>{b.id}</td>
                        <td>{src === 'github' ? `gh·${b.type}` : b.type}{b.status !== 'open' ? ` (${b.status})` : ''}</td>
                        <td className="num">{b.priority || '—'}</td>
                        <td className="num">{ageDays(b.created_at, now)}d</td>
                        <td>{b.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length > 400 && (
                  <p className="debt-note">showing first 400 of {filtered.length} — narrow the filters</p>
                )}
                {filtered.length === 0 && <p className="debt-note">nothing matches — loosen a filter</p>}
              </section>
            )}
            {view === 'graph' && (
              <section>
                <Graph items={filtered.filter(x => x.src === 'beads').map(x => x.b)} onPick={setPicked} />
              </section>
            )}

            {picked && (
              <Detail
                b={picked}
                onClose={() => setPicked(null)}
                onJump={id => { const t = byId.get(id); if (t) setPicked(t); }}
              />
            )}
          </>
        )}
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

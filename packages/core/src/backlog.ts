/**
 * Backlog snapshot — the compact JSON the site `/backlog` page reads off
 * refs/bro/data. Rows come either from `bd export` jsonl (the `bro sync`
 * path, local dolt) or straight from `dolt sql` (the CI publish script).
 * Only open-state issues ship; closed work contributes child counters so
 * the page can show epic progress without the full history.
 */

export interface BeadRow {
  id: string;
  title: string;
  status: string;
  priority: number | string;
  issue_type: string;
  created_at: string;
  closed_at?: string | null;
  assignee?: string | null;
  labels?: Array<string | { label?: string; name?: string }>;
  dependencies?: Array<{ type: string; depends_on_id?: string; depends_on_issue_id?: string }>;
}

export interface BacklogIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  created_at: string;
  parent?: string;
  assignee?: string;
  labels: string[];
  blocks: string[];
  blocked_by: string[];
  closed_children: number;
  open_children: number;
}

export interface BacklogSnapshot {
  generated_at: string;
  total_open: number;
  issues: BacklogIssue[];
}

const OPEN_STATUSES = new Set(['open', 'in_progress', 'in-progress', 'blocked', 'deferred']);

interface Edges {
  parentOf: Map<string, string>;
  closedChildren: Map<string, number>;
  blocks: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
}

function push(m: Map<string, string[]>, k: string, v: string) {
  (m.get(k) ?? m.set(k, []).get(k)!).push(v);
}

type Dep = NonNullable<BeadRow['dependencies']>[number];

interface EdgeCtx {
  open: Set<string>;
  e: Edges;
}

// Dependency kinds are data: each type maps to its edge effect, so a new
// kind is a table entry, not another branch.
const DEP_HANDLERS: Record<string, (src: string, tgt: string, ctx: EdgeCtx) => void> = {
  'parent-child': (src, tgt, { open, e }) => {
    e.parentOf.set(src, tgt);
    if (!open.has(src)) e.closedChildren.set(tgt, (e.closedChildren.get(tgt) ?? 0) + 1);
  },
  // a dep row reads "src depends on tgt" — type `blocks` means src is
  // blocked BY tgt, so the `blocks` edge lands on the target
  blocks: (src, tgt, { open, e }) => {
    if (open.has(src) && open.has(tgt)) {
      push(e.blockedBy, src, tgt);
      push(e.blocks, tgt, src);
    }
  },
};

/** bd export and the dolt join emit the same facts under slightly
 *  different keys — accept both. */
function collectEdges(rows: BeadRow[], open: Set<string>): Edges {
  const ctx: EdgeCtx = {
    open,
    e: { parentOf: new Map(), closedChildren: new Map(), blocks: new Map(), blockedBy: new Map() },
  };
  for (const r of rows) {
    for (const d of r.dependencies ?? []) {
      const tgt = d.depends_on_id ?? d.depends_on_issue_id;
      // hasOwn — a prototype key like `__proto__` must not reach the map
      if (tgt && Object.hasOwn(DEP_HANDLERS, d.type)) DEP_HANDLERS[d.type](r.id, tgt, ctx);
    }
  }
  return ctx.e;
}

function labelName(l: string | { label?: string; name?: string }): string {
  return typeof l === 'string' ? l : (l.label ?? l.name ?? '');
}

function toIssue(r: BeadRow, e: Edges): BacklogIssue {
  return {
    id: r.id,
    title: r.title,
    status: r.status.replaceAll('_', '-'),
    // reject non-integer input instead of letting NaN slip into the page
    priority: Number.isInteger(Number(r.priority)) ? Number(r.priority) : 4,
    type: r.issue_type,
    created_at: r.created_at,
    parent: e.parentOf.get(r.id),
    assignee: r.assignee ?? undefined,
    labels: (r.labels ?? []).map(labelName),
    blocks: e.blocks.get(r.id) ?? [],
    blocked_by: e.blockedBy.get(r.id) ?? [],
    closed_children: e.closedChildren.get(r.id) ?? 0,
    open_children: 0,
  };
}

export function compactBacklog(rows: BeadRow[], now = new Date()): BacklogSnapshot {
  const open = new Set(rows.filter(r => OPEN_STATUSES.has(r.status)).map(r => r.id));
  const edges = collectEdges(rows, open);
  const issues = rows.filter(r => open.has(r.id)).map(r => toIssue(r, edges));
  const byId = new Map(issues.map(i => [i.id, i]));
  for (const i of issues) {
    if (i.parent && byId.has(i.parent)) byId.get(i.parent)!.open_children += 1;
  }
  return { generated_at: now.toISOString(), total_open: issues.length, issues };
}

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

const OPEN_STATUSES = new Set(['open', 'in_progress', 'in-progress', 'blocked']);

interface Edges {
  parentOf: Map<string, string>;
  closedChildren: Map<string, number>;
  blocks: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
}

function push(m: Map<string, string[]>, k: string, v: string) {
  (m.get(k) ?? m.set(k, []).get(k)!).push(v);
}

/** bd export and the dolt join emit the same facts under slightly
 *  different keys — accept both. */
function collectEdges(rows: BeadRow[], open: Set<string>): Edges {
  const e: Edges = {
    parentOf: new Map(),
    closedChildren: new Map(),
    blocks: new Map(),
    blockedBy: new Map(),
  };
  for (const r of rows) {
    for (const d of r.dependencies ?? []) {
      const tgt = d.depends_on_id ?? d.depends_on_issue_id;
      if (!tgt) continue;
      if (d.type === 'parent-child') {
        e.parentOf.set(r.id, tgt);
        if (!open.has(r.id)) e.closedChildren.set(tgt, (e.closedChildren.get(tgt) ?? 0) + 1);
      } else if (d.type === 'blocks' && open.has(r.id) && open.has(tgt)) {
        push(e.blocks, r.id, tgt);
        push(e.blockedBy, tgt, r.id);
      }
    }
  }
  return e;
}

function labelName(l: string | { label?: string; name?: string }): string {
  return typeof l === 'string' ? l : (l.label ?? l.name ?? '');
}

function toIssue(r: BeadRow, e: Edges): BacklogIssue {
  return {
    id: r.id,
    title: r.title,
    status: r.status.replace(/_/g, '-'),
    priority: Number(r.priority),
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

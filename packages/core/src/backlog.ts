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

/** bd export and the dolt join emit the same facts under slightly
 *  different keys — accept both. */
export function compactBacklog(rows: BeadRow[], now = new Date()): BacklogSnapshot {
  const open = new Set(rows.filter(r => OPEN_STATUSES.has(r.status)).map(r => r.id));
  const closedChildren = new Map<string, number>();
  const parentOf = new Map<string, string>();
  const blocks = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k) ?? m.set(k, []).get(k)!;
    arr.push(v);
  };
  for (const r of rows) {
    for (const d of r.dependencies ?? []) {
      const tgt = d.depends_on_id ?? d.depends_on_issue_id;
      if (!tgt) continue;
      if (d.type === 'parent-child') {
        parentOf.set(r.id, tgt);
        if (!open.has(r.id)) closedChildren.set(tgt, (closedChildren.get(tgt) ?? 0) + 1);
      } else if (d.type === 'blocks' && open.has(r.id) && open.has(tgt)) {
        push(blocks, r.id, tgt);
        push(blockedBy, tgt, r.id);
      }
    }
  }
  const issues: BacklogIssue[] = rows
    .filter(r => open.has(r.id))
    .map(r => ({
      id: r.id,
      title: r.title,
      status: r.status.replace(/_/g, '-'),
      priority: Number(r.priority),
      type: r.issue_type,
      created_at: r.created_at,
      parent: parentOf.get(r.id),
      assignee: r.assignee ?? undefined,
      labels: (r.labels ?? []).map(l => (typeof l === 'string' ? l : (l.label ?? l.name ?? ''))),
      blocks: blocks.get(r.id) ?? [],
      blocked_by: blockedBy.get(r.id) ?? [],
      closed_children: closedChildren.get(r.id) ?? 0,
      open_children: 0,
    }));
  const byId = new Map(issues.map(i => [i.id, i]));
  for (const i of issues) {
    if (i.parent && byId.has(i.parent)) byId.get(i.parent)!.open_children += 1;
  }
  return { generated_at: now.toISOString(), total_open: issues.length, issues };
}

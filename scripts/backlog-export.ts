/**
 * backlog-export.ts — dump the beads backlog of a dolt clone into the
 * compact JSON the site `/backlog` page reads off refs/bro/data.
 *
 * usage: node scripts/backlog-export.ts <dolt-repo-dir> <out-file>
 *
 * The dolt repo dir is a `dolt clone` of the repo (beads issues live in
 * the `issues` table). Only open-state rows are exported — closed work
 * contributes child counters so the page can show epic progress without
 * shipping the full history.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , doltDir, outFile] = process.argv;
if (!doltDir || !outFile) {
  console.error('usage: node scripts/backlog-export.ts <dolt-repo-dir> <out-file>');
  process.exit(1);
}

function sql<T>(query: string): T[] {
  const out = execFileSync('dolt', ['sql', '-q', query, '-r', 'json'], {
    cwd: doltDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // dolt wraps rows as {rows: [...]}; NULL columns are omitted per row
  return (JSON.parse(out) as { rows: T[] }).rows;
}

interface Row {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  closed_at?: string;
  assignee?: string;
}
interface Dep {
  issue_id: string;
  depends_on_issue_id?: string;
  type: string;
}
interface Label {
  issue_id: string;
  label: string;
}

const OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked']);
const rows = sql<Row>(
  'SELECT id,title,status,priority,issue_type,created_at,closed_at,assignee FROM issues'
);
const deps = sql<Dep>(
  "SELECT issue_id,depends_on_issue_id,type FROM dependencies WHERE type IN ('parent-child','blocks','related')"
);
const labelRows = sql<Label>('SELECT issue_id,label FROM labels');

const open = new Set(rows.filter(r => OPEN_STATUSES.has(r.status)).map(r => r.id));
const closedChildren = new Map<string, number>();
const parentOf = new Map<string, string>();
const blocks = new Map<string, string[]>();
const blockedBy = new Map<string, string[]>();
for (const d of deps) {
  if (!d.depends_on_issue_id) continue;
  const tgt = d.depends_on_issue_id;
  if (d.type === 'parent-child') {
    parentOf.set(d.issue_id, tgt);
    if (!open.has(d.issue_id)) {
      closedChildren.set(tgt, (closedChildren.get(tgt) ?? 0) + 1);
    }
  } else if (d.type === 'blocks' && open.has(d.issue_id) && open.has(tgt)) {
    (blocks.get(d.issue_id) ?? blocks.set(d.issue_id, []).get(d.issue_id)!).push(tgt);
    (blockedBy.get(tgt) ?? blockedBy.set(tgt, []).get(tgt)!).push(d.issue_id);
  }
}
const labelsOf = new Map<string, string[]>();
for (const l of labelRows) {
  (labelsOf.get(l.issue_id) ?? labelsOf.set(l.issue_id, []).get(l.issue_id)!).push(l.label);
}

const issues = rows
  .filter(r => open.has(r.id))
  .map(r => ({
    id: r.id,
    title: r.title,
    status: r.status.replace('_', '-'),
    priority: Number(r.priority),
    type: r.issue_type,
    created_at: r.created_at,
    parent: parentOf.get(r.id),
    assignee: r.assignee,
    labels: labelsOf.get(r.id) ?? [],
    blocks: blocks.get(r.id) ?? [],
    blocked_by: blockedBy.get(r.id) ?? [],
    closed_children: closedChildren.get(r.id) ?? 0,
    open_children: 0,
  }));
const byId = new Map(issues.map(i => [i.id, i]));
for (const i of issues) {
  if (i.parent && byId.has(i.parent)) {
    byId.get(i.parent)!.open_children += 1;
  }
}

writeFileSync(
  outFile,
  JSON.stringify({
    generated_at: new Date().toISOString(),
    total_open: issues.length,
    issues,
  })
);
console.log(`backlog-export: ${issues.length} open issues → ${outFile}`);

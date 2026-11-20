/**
 * backlog-export.ts — dump the beads backlog of a dolt clone into the
 * compact snapshot the site `/backlog` page reads off refs/bro/data.
 *
 * usage: node scripts/backlog-export.ts <dolt-repo-dir> <out-file>
 *
 * The dolt repo dir is a `dolt clone` of the repo (beads issues live in
 * the `issues` table). Row shape is mapped onto `BeadRow` and handed to
 * the shared `compactBacklog` — the same transform `bro sync` runs on
 * `bd export` output, so both publish paths produce identical files.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { compactBacklog, type BeadRow } from '../packages/core/src/backlog.ts';

const [, , doltDir, outFile] = process.argv;
if (!doltDir || !outFile) {
  console.error('usage: node scripts/backlog-export.ts <dolt-repo-dir> <out-file>');
  process.exit(1);
}

function sql<T>(query: string): T[] {
  // NOSONAR S8707 — argv paths are this script's documented API
  const out = execFileSync('dolt', ['sql', '-q', query, '-r', 'json'], {
    cwd: doltDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // dolt wraps rows as {rows: [...]}; NULL columns are omitted per row
  return (JSON.parse(out) as { rows: T[] }).rows;
}

interface IssueRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  closed_at?: string;
  assignee?: string;
}
interface DepRow {
  issue_id: string;
  depends_on_issue_id?: string;
  type: string;
}
interface LabelRow {
  issue_id: string;
  label: string;
}

const issues = sql<IssueRow>(
  'SELECT id,title,status,priority,issue_type,created_at,closed_at,assignee FROM issues'
);
const deps = sql<DepRow>(
  "SELECT issue_id,depends_on_issue_id,type FROM dependencies WHERE type IN ('parent-child','blocks','related')"
);
const labelRows = sql<LabelRow>('SELECT issue_id,label FROM labels');

const depBy = new Map<string, DepRow[]>();
for (const d of deps) (depBy.get(d.issue_id) ?? depBy.set(d.issue_id, []).get(d.issue_id)!).push(d);
const labelBy = new Map<string, string[]>();
for (const l of labelRows)
  (labelBy.get(l.issue_id) ?? labelBy.set(l.issue_id, []).get(l.issue_id)!).push(l.label);

const rows: BeadRow[] = issues.map(r => ({
  ...r,
  labels: labelBy.get(r.id) ?? [],
  dependencies: depBy.get(r.id) ?? [],
}));

const snap = compactBacklog(rows);
writeFileSync(outFile, JSON.stringify(snap)); // NOSONAR S8707 — argv out path is the API
console.log(`backlog-export: ${snap.total_open} open issues → ${outFile}`);

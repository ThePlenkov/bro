/**
 * Issue node → TaskRow derivation and the list/ready filtering (moved
 * from tasks.ts). The store vocabulary lives here: the claim/blocked
 * labels, the default priority, and the fetch cap.
 *
 *   status    — closed | in_progress (bro:claimed label or assignee) |
 *               blocked (open blocker) | open
 *   blocked   — open `blockedBy` dependency, open sub-issue (decomposed
 *               work is not itself ready), or a manual 'blocked' label
 *   type/prio — native issueType wins, then type:/kind:/epic labels,
 *               then the `<!-- bro: {...} -->` body trailer; p<N> and
 *               priority:<N> labels, then the trailer, default 2
 */
import { bodyMeta, stripMeta } from '@broject/core';
import type { TaskFilter, TaskRow } from '@broject/core';
import type { IssueNode, Ref } from './tasks-queries.ts';

export const CLAIMED_LABEL = 'bro:claimed';
export const BLOCKED_LABEL = 'blocked';
const DEFAULT_PRIORITY = 2;
export const QUERY_CAP = 1000;

// --- row derivation -----------------------------------------------------------

export const labelsOf = (n: IssueNode): string[] => (n.labels?.nodes ?? []).map(l => l.name);
export const assigneesOf = (n: IssueNode): string[] => (n.assignees?.nodes ?? []).map(a => a.login);
const anyOpen = (refs: Ref[] | undefined): boolean => (refs ?? []).some(r => r.state === 'OPEN');

function issueTypeOf(n: IssueNode, labels: string[], meta: Record<string, unknown>): string {
  const native = n.issueType?.name?.trim();
  if (native) {
    return native.toLowerCase();
  }
  const tagged = labels
    .find(l => /^(type|kind):/i.test(l))
    ?.split(':', 2)[1]
    ?.trim();
  if (tagged) {
    return tagged.toLowerCase();
  }
  if (labels.some(l => /^epic$/i.test(l))) {
    return 'epic';
  }
  return typeof meta.type === 'string' && meta.type !== '' ? meta.type : 'task';
}

function priorityOf(labels: string[], meta: Record<string, unknown>): number {
  for (const l of labels) {
    const m = /^p([0-4])$/i.exec(l) ?? /^priority[: -]([0-4])$/i.exec(l);
    if (m) {
      return Number(m[1]);
    }
  }
  const p = meta.priority;
  return typeof p === 'number' ? p : DEFAULT_PRIORITY;
}

/** An open issue is blocked when a dependency, a sub-issue, or the
 *  manual label says so. Without relation fields (GHES fallback) only
 *  the label survives — absent, not faked. */
const isBlocked = (n: IssueNode, labels: string[]): boolean =>
  labels.includes(BLOCKED_LABEL) || anyOpen(n.blockedBy?.nodes) || anyOpen(n.subIssues?.nodes);

function statusOf(n: IssueNode, labels: string[], assignees: string[]): string {
  if (n.state !== 'OPEN') {
    return 'closed';
  }
  if (labels.includes(CLAIMED_LABEL) || assignees.length > 0) {
    return 'in_progress';
  }
  return isBlocked(n, labels) ? 'blocked' : 'open';
}

export function toRow(n: IssueNode): TaskRow {
  const labels = labelsOf(n);
  const assignees = assigneesOf(n);
  const meta = bodyMeta(n.body);
  const row: TaskRow & { created_at?: string; __node?: IssueNode } = {
    id: String(n.number),
    title: n.title,
    status: statusOf(n, labels, assignees),
    issue_type: issueTypeOf(n, labels, meta),
    priority: priorityOf(labels, meta),
    labels,
    description: stripMeta(n.body),
    // a caller-supplied external ref (create/update stores it in the
    // trailer) beats the issue's own URL — losing it silently turns
    // writes into data the row can't return
    external_ref:
      typeof meta.external_ref === 'string' && meta.external_ref !== '' ? meta.external_ref : n.url,
    metadata: Object.keys(meta).length > 0 ? meta : null,
    created_at: n.createdAt,
    __node: n,
  };
  if (assignees.length > 0) {
    row.assignee = assignees.join(', ');
  }
  // `parent` is NOT mapped onto the row — in the TaskStore contract a
  // row.parent means "step of an orchestrated parent" (molecule step /
  // epic child), and `bro next` gates such rows out of the claimable
  // queue. A GitHub sub-issue has no orchestrator — it is ordinary
  // decomposed work that must stay claimable (its parent is already
  // blocked by the open-sub-issues rule). The parent edge is still
  // available through deps()/children() for callers that need it.
  if (n.stateReason === 'NOT_PLANNED' || n.stateReason === 'DUPLICATE') {
    row.close_reason = n.stateReason === 'NOT_PLANNED' ? 'not planned' : 'duplicate';
  }
  if (n.closedAt) {
    row.closed_at = n.closedAt;
  }
  return row;
}

/** Drop the transport carrier before a row leaves the store — node
 *  internals are mutation inputs, not contract. */
export const pub = (r: TaskRow & { __node?: IssueNode }): TaskRow => {
  const { __node: _drop, ...rest } = r;
  return rest;
};

// --- filtering ------------------------------------------------------------------

export function applyFilter(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  let q = rows;
  if (f.status !== undefined) {
    q = q.filter(r => r.status === f.status);
  } else if (f.all !== true) {
    q = q.filter(r => r.status !== 'closed');
  }
  for (const l of f.labels ?? []) {
    q = q.filter(r => r.labels?.includes(l));
  }
  for (const l of f.excludeLabels ?? []) {
    q = q.filter(r => !(r.labels ?? []).includes(l));
  }
  if (f.type !== undefined) {
    q = q.filter(r => r.issue_type === f.type);
  }
  if (f.limit !== undefined && f.limit > 0) {
    q = q.slice(0, f.limit);
  }
  return q;
}

export function statesFor(f: TaskFilter): string[] {
  if (f.all === true) {
    return ['OPEN', 'CLOSED'];
  }
  return f.status === 'closed' ? ['CLOSED'] : ['OPEN'];
}

/** Client-side filters still drop fetched rows — a query-level cap
 *  would truncate before labels/type/status get their say, hiding
 *  matches later in the page. Only a filter-free list may bound the
 *  fetch itself ('closed' maps 1:1 onto the state filter — nothing
 *  applyFilter could remove). */
const needsPostFilter = (f: TaskFilter): boolean =>
  (f.labels?.length ?? 0) > 0 ||
  (f.excludeLabels?.length ?? 0) > 0 ||
  f.type !== undefined ||
  (f.status !== undefined && f.status !== 'closed');

export const fetchCap = (f: TaskFilter): number =>
  needsPostFilter(f)
    ? QUERY_CAP
    : Math.min(f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP, QUERY_CAP);

const byPriority = (a: TaskRow, b: TaskRow): number =>
  (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
  String((a as TaskRow & { created_at?: string }).created_at ?? '').localeCompare(
    String((b as TaskRow & { created_at?: string }).created_at ?? '')
  );

/** ready = open + unblocked + unclaimed — derived status 'open' is
 *  exactly that set, already priority-ordered over created asc. */
export function readyOf(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  return rows
    .filter(r => r.status === 'open')
    .sort(byPriority)
    .slice(0, f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP);
}

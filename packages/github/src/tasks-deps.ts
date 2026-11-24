/**
 * Dep edges and the deps()/neighbors() reads (moved from tasks.ts).
 * Edges always leave in the generic rel vocabulary: blockedBy →
 * `type: 'blocked'` (X depends-on Y), parent/subIssue → `parent`.
 */
import { nativeTaskRel } from '@broject/core';
import type { DepOpts, TaskDepEdge, TaskRow } from '@broject/core';
import { issueNumber, queryIssueAsync, queryIssueSync } from './tasks-queries.ts';
import type { IssueNode } from './tasks-queries.ts';
import { pub, toRow } from './tasks-rows.ts';

const wants = (dir: 'up' | 'down', direction?: string): boolean =>
  direction === undefined || direction === dir;

/** X depends-on Y — blockedBy is X's own dep set (a 'down' read). */
const blockedByEdges = (n: IssueNode): TaskDepEdge[] =>
  (n.blockedBy?.nodes ?? []).map(b => ({
    issue_id: String(n.number),
    depends_on_id: String(b.number),
    type: 'blocked',
  }));

/** blocking is what depends on X ('up'). */
const blockingEdges = (n: IssueNode): TaskDepEdge[] =>
  (n.blocking?.nodes ?? []).map(b => ({
    issue_id: String(b.number),
    depends_on_id: String(n.number),
    type: 'blocked',
  }));

/** X depends-on Y — blockedBy is X's own dep set (a 'down' read);
 *  blocking is what depends on X ('up'). */
export function blockEdges(n: IssueNode, direction?: string): TaskDepEdge[] {
  return [
    ...(wants('down', direction) ? blockedByEdges(n) : []),
    ...(wants('up', direction) ? blockingEdges(n) : []),
  ];
}

/** subIssues read 'up' — the children that depend on this issue. */
const subIssueEdges = (n: IssueNode): TaskDepEdge[] =>
  (n.subIssues?.nodes ?? []).map(c => ({
    issue_id: String(c.number),
    depends_on_id: String(n.number),
    type: 'parent',
  }));

/** parent is a 'down' edge (this issue depends on it); subIssues read 'up'. */
export function parentEdges(n: IssueNode, direction?: string): TaskDepEdge[] {
  return [
    ...(wants('down', direction) && n.parent
      ? [{ issue_id: String(n.number), depends_on_id: String(n.parent.number), type: 'parent' }]
      : []),
    ...(wants('up', direction) ? subIssueEdges(n) : []),
  ];
}

/** blockedBy → `type: 'blocked'` edges (X depends-on Y); parent/subIssue
 *  → `parent`. Edges always leave in the generic rel vocabulary. */
export function depEdges(n: IssueNode, opts: DepOpts): TaskDepEdge[] {
  const rel = opts.rel === undefined ? undefined : nativeTaskRel(opts.rel);
  return [
    ...(rel === undefined || rel === 'blocks' ? blockEdges(n, opts.direction) : []),
    ...(rel === undefined || rel === 'parent-child' ? parentEdges(n, opts.direction) : []),
  ];
}

export function depsSync(dir: string, ids: string[], opts: DepOpts): TaskDepEdge[] {
  const out: TaskDepEdge[] = [];
  for (const id of ids) {
    const n = queryIssueSync(dir, issueNumber(dir, id));
    if (n) {
      out.push(...depEdges(n, opts));
    }
  }
  return out;
}

export async function depsAsync(dir: string, ids: string[], opts: DepOpts): Promise<TaskDepEdge[]> {
  const nodes = await Promise.all(ids.map(id => queryIssueAsync(dir, issueNumber(dir, id))));
  return nodes.flatMap(n => (n === undefined ? [] : depEdges(n, opts)));
}

/** Hydrated rows on the far side of `id`'s edges — the row-plane twin
 *  of deps(). `dependency_type` rides along normalized, matching the
 *  beads store's neighbors() shape. */
export async function neighborsAsync(dir: string, id: string, opts: DepOpts): Promise<TaskRow[]> {
  const n = await queryIssueAsync(dir, issueNumber(dir, id));
  if (n === undefined) {
    return [];
  }
  // edges carry the canonical issue number — a non-canonical input id
  // ('#42', a URL) compared raw picks the wrong endpoint, returning n
  // as its own neighbor
  const self = String(n.number);
  const others = new Set<string>();
  const relOf = new Map<string, string>();
  for (const e of depEdges(n, opts)) {
    const other = e.issue_id === self ? e.depends_on_id : e.issue_id;
    others.add(other);
    relOf.set(other, e.type);
  }
  const rows = await Promise.all(
    [...others].map(async o => {
      const node = await queryIssueAsync(dir, Number(o));
      if (node === undefined) {
        return undefined;
      }
      const rel = relOf.get(o);
      return rel === undefined
        ? (pub(toRow(node)) as TaskRow)
        : ({ ...pub(toRow(node)), dependency_type: rel } as TaskRow);
    })
  );
  return rows.filter((r): r is TaskRow => r !== undefined);
}

export function neighborsSync(dir: string, id: string, opts: DepOpts): TaskRow[] {
  const n = queryIssueSync(dir, issueNumber(dir, id));
  if (n === undefined) {
    return [];
  }
  const self = String(n.number);
  const others = new Map<string, string>();
  for (const e of depEdges(n, opts)) {
    others.set(e.issue_id === self ? e.depends_on_id : e.issue_id, e.type);
  }
  const rows: TaskRow[] = [];
  for (const [o, rel] of others) {
    const node = queryIssueSync(dir, Number(o));
    if (node !== undefined) {
      rows.push({ ...pub(toRow(node)), dependency_type: rel } as TaskRow);
    }
  }
  return rows;
}

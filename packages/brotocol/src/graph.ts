/**
 * Graph — resolve declared parentage into edges. A `parent:` frontmatter
 * value wins; otherwise a doc nested in a dir-doc's directory links to
 * that dir-doc positionally. Dangling ids and parent cycles come back
 * as diagnostics — the graph itself never hides a bad edge.
 */
import type { Diagnostic, Doc, Protocol } from './protocol.ts';
import { scan } from './scan.ts';

export interface Edge {
  /** child doc id */
  from: string;
  /** resolved parent doc id */
  to: string;
  via: 'frontmatter' | 'position';
}

export interface Graph {
  nodes: Doc[];
  edges: Edge[];
  diagnostics: Diagnostic[];
}

/** Doc resolution for parent ids — duplicates resolve path-first so an
 *  explicit edge never depends on walk order. */
export const docById = (nodes: Doc[]): Map<string, Doc[]> => {
  const m = new Map<string, Doc[]>();
  for (const n of nodes) {
    m.set(n.id, [...(m.get(n.id) ?? []), n]);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }
  return m;
};

/** `nodes` may be a pre-scanned snapshot (lint passes its own so
 *  duplicate-id and cycle checks see the same tree, not two walks). */
export function graph(protocol: Protocol, nodes: Doc[] = scan(protocol)): Graph {
  const byId = docById(nodes);
  const edges: Edge[] = [];
  const diagnostics: Diagnostic[] = [];
  const parentOf = new Map<Doc, Doc>();

  for (const n of nodes) {
    if (n.parentId === undefined || n.parentEdge === 'none') {
      continue;
    }
    const target = byId.get(n.parentId)?.[0];
    if (target === undefined) {
      diagnostics.push({
        severity: 'warn',
        rule: 'parent-not-found',
        message: `parent '${n.parentId}' does not resolve to a doc`,
        path: n.path,
        line: 1,
      });
      continue;
    }
    if (target !== n) {
      edges.push({ from: n.id, to: target.id, via: n.parentEdge as Edge['via'] });
      parentOf.set(n, target);
    } else {
      diagnostics.push({
        severity: 'error',
        rule: 'cycle',
        message: `doc '${n.id}' is its own parent`,
        path: n.path,
        line: 1,
      });
    }
  }

  const seen = new Set<Doc>();
  for (const n of nodes) {
    if (seen.has(n)) {
      continue;
    }
    const chain = new Map<Doc, number>();
    let cur: Doc | undefined = n;
    let i = 0;
    while (cur !== undefined && !chain.has(cur)) {
      chain.set(cur, i++);
      cur = parentOf.get(cur);
    }
    if (cur !== undefined) {
      const cycle = [...chain.entries()]
        .filter(([, idx]) => idx >= (chain.get(cur) ?? 0))
        .sort((a, b) => a[1] - b[1])
        .map(([d]) => d.id);
      diagnostics.push({
        severity: 'error',
        rule: 'cycle',
        message: `parent cycle: ${[...cycle, cur.id].join(' -> ')}`,
        path: cur.path,
        line: 1,
      });
    }
    for (const d of chain.keys()) {
      seen.add(d);
    }
  }
  return { nodes, edges, diagnostics };
}

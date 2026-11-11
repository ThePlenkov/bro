/**
 * Tree — the `id  relpath` listing indented by graph depth, mirroring
 * `bro spec tree`. Cyclic subtrees are unreachable from a root and are
 * left out — `graph()`/`lint()` carry the diagnostic.
 */
import { dirname, relative, resolve } from 'node:path';
import { docById } from './graph.ts';
import type { Doc, Protocol } from './protocol.ts';
import { scan } from './scan.ts';

/** Docs caught in a parent cycle — every node whose ancestor walk loops. */
const cyclicDocs = (nodes: Doc[], parentOf: Map<Doc, Doc>): Set<Doc> => {
  const cyclic = new Set<Doc>();
  const done = new Set<Doc>();
  for (const n of nodes) {
    if (done.has(n)) {
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
      for (const [d, idx] of chain) {
        if (idx >= (chain.get(cur) ?? 0)) {
          cyclic.add(d);
        }
      }
    }
    for (const d of chain.keys()) {
      done.add(d);
    }
  }
  return cyclic;
};

export function tree(protocol: Protocol): string[] {
  const nodes = scan(protocol);
  const byId = docById(nodes);
  const parentOf = new Map<Doc, Doc>();
  for (const n of nodes) {
    if (n.parentId === undefined || n.parentEdge === 'none') {
      continue;
    }
    const p = byId.get(n.parentId)?.[0];
    if (p !== undefined && p !== n) {
      parentOf.set(n, p);
    }
  }
  const cyclic = cyclicDocs(nodes, parentOf);
  const byParent = new Map<Doc | undefined, Doc[]>();
  for (const n of nodes) {
    if (cyclic.has(n)) {
      continue;
    }
    const p = parentOf.get(n);
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  const base = dirname(resolve(protocol.root));
  const lines: string[] = [];
  const rendered = new Set<Doc>();
  const walk = (parent: Doc | undefined, depth: number): void => {
    for (const n of byParent.get(parent) ?? []) {
      if (rendered.has(n)) {
        continue;
      }
      rendered.add(n);
      lines.push(`${'  '.repeat(depth)}${n.id}  ${relative(base, n.path)}`);
      walk(n, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines;
}

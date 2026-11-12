/**
 * Remove — delete a doc. A flat doc's file goes; a dir-doc loses only
 * its index file (parts stay — they were never the doc) unless
 * `{recursive: true}` removes the whole directory.
 */
import { dirname, resolve } from 'node:path';
import { ioRemove } from './io.ts';
import type { Protocol } from './protocol.ts';
import { get, scan } from './scan.ts';

export interface RemoveResult {
  id: string;
  removed: string[];
}

export function remove(
  protocol: Protocol,
  id: string,
  opts: { recursive?: boolean } = {}
): RemoveResult {
  const doc = get(protocol, id);
  if (doc === undefined) {
    throw new Error(`unknown doc '${id}'`);
  }
  const removed: string[] = [];
  if (doc.isDirDoc && opts.recursive === true) {
    const dir = dirname(doc.path);
    // a root dir-doc's dirname IS the tree — recursive removal would
    // delete every doc and every non-doc file under it.
    if (resolve(dir) === resolve(protocol.root)) {
      throw new Error(`refusing recursive removal of the tree root via '${doc.id}'`);
    }
    ioRemove(dir, true);
    removed.push(dir);
  } else {
    if (doc.isDirDoc) {
      // positional children keep no frontmatter link — dropping the
      // index would silently re-root them on the next scan, with no
      // dangling id for graph to diagnose.
      const hasChildren = scan(protocol).some(
        d => d !== doc && d.parentEdge === 'position' && d.parentId === doc.id
      );
      if (hasChildren) {
        throw new Error(
          `dir-doc '${doc.id}' has positional children — pass recursive or reparent them first`
        );
      }
    }
    ioRemove(doc.path);
    removed.push(doc.path);
  }
  return { id: doc.id, removed };
}

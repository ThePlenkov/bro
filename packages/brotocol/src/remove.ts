/**
 * Remove — delete a doc. A flat doc's file goes; a dir-doc loses only
 * its index file (parts stay — they were never the doc) unless
 * `{recursive: true}` removes the whole directory.
 */
import { dirname } from 'node:path';
import { ioRemove } from './io.ts';
import type { Protocol } from './protocol.ts';
import { get } from './scan.ts';

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
    ioRemove(dir, true);
    removed.push(dir);
  } else {
    ioRemove(doc.path);
    removed.push(doc.path);
  }
  return { id: doc.id, removed };
}

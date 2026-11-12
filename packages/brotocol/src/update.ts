/**
 * Update — splice-preserving frontmatter edit: the `---` span is located
 * and replaced by the re-dumped data, body bytes are never touched (a
 * full-doc rewrite would churn git diffs). Fields set to `undefined`
 * are deleted.
 */
import { dumpFrontmatter, parseFrontmatter } from '@broject/brose';
import { ioRead, ioWrite } from './io.ts';
import type { Doc, Protocol } from './protocol.ts';
import { get, scan } from './scan.ts';

const FM_SPAN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export function update(protocol: Protocol, id: string, fields: Record<string, unknown>): Doc {
  const doc = get(protocol, id);
  if (doc === undefined) {
    throw new Error(`unknown doc '${id}'`);
  }
  const content = ioRead(doc.path);
  const sets = new Map<string, unknown>();
  const drops = new Set<string>();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) {
      drops.add(k);
    } else {
      sets.set(k, v);
    }
  }
  // the id field is the doc's identity — deleting it silently renames
  // the doc to its fallback id, and writing an id another doc holds
  // creates a duplicate that makes `get` ambiguous. Neither may land.
  if (drops.has(protocol.idField)) {
    throw new Error(`cannot delete '${protocol.idField}' — it is the doc's identity`);
  }
  const idSet = sets.get(protocol.idField);
  if (idSet !== undefined && idSet !== doc.id) {
    if (typeof idSet !== 'string' || idSet === '') {
      throw new Error(`'${protocol.idField}' must be a non-empty string`);
    }
    const other = get(protocol, idSet);
    if (other !== undefined && other.path !== doc.path) {
      throw new Error(`id '${idSet}' is already held by ${other.path}`);
    }
    if (protocol.parentField !== undefined) {
      // positional children re-derive parentage on the next scan, but a
      // frontmatter `parent:` still names the old id — renaming would
      // orphan it into a graph diagnostic. Refuse; reparent first.
      const referenced = scan(protocol).some(
        d => d.path !== doc.path && d.parentEdge === 'frontmatter' && d.parentId === doc.id
      );
      if (referenced) {
        throw new Error(
          `cannot rename '${doc.id}' — documents declare it as '${protocol.parentField}'; reparent them first`
        );
      }
    }
  }
  // the merge goes through entry lists + fromEntries — no obj[key]
  // writes, so a caller key like `__proto__` becomes a plain own entry
  // instead of a setter invocation.
  const merged = Object.fromEntries([
    ...Object.entries(parseFrontmatter(content).data).filter(([k]) => !drops.has(k)),
    ...sets,
  ]);
  const m = FM_SPAN.exec(content);
  const next =
    m === null
      ? `---\n${dumpFrontmatter(merged)}---\n\n${content}`
      : `---\n${dumpFrontmatter(merged)}---${m[2]}${content.slice(m[0].length)}`;
  ioWrite(doc.path, next);
  // re-resolve by path so identity fields changed through `fields`
  // (id/parent) come back fresh — the old Doc would be stale.
  return scan(protocol).find(d => d.path === doc.path) ?? { ...doc, frontmatter: merged };
}

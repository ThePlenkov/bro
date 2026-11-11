/**
 * Update — splice-preserving frontmatter edit: the `---` span is located
 * and replaced by the re-dumped data, body bytes are never touched (a
 * full-doc rewrite would churn git diffs). Fields set to `undefined`
 * are deleted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dumpFrontmatter, parseFrontmatter } from '@broject/brose';
import type { Doc, Protocol } from './protocol.ts';
import { get, scan } from './scan.ts';

const FM_SPAN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export function update(protocol: Protocol, id: string, fields: Record<string, unknown>): Doc {
  const doc = get(protocol, id);
  if (doc === undefined) {
    throw new Error(`unknown doc '${id}'`);
  }
  const content = readFileSync(doc.path, 'utf8');
  const data = { ...parseFrontmatter(content).data };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) {
      delete data[k];
    } else {
      data[k] = v;
    }
  }
  const m = FM_SPAN.exec(content);
  const next =
    m === null
      ? `---\n${dumpFrontmatter(data)}---\n\n${content}`
      : `---\n${dumpFrontmatter(data)}---${m[2]}${content.slice(m[0].length)}`;
  writeFileSync(doc.path, next);
  // re-resolve by path so identity fields changed through `fields`
  // (id/parent) come back fresh — the old Doc would be stale.
  return scan(protocol).find(d => d.path === doc.path) ?? { ...doc, frontmatter: data };
}

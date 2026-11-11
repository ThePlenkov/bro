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

/**
 * Scan — walk the tree and collect docs. A directory is a dir-doc when
 * it holds `<dirname><suffix>` (indexName) or a legacy index alias — the
 * dir IS the doc, and any other `.md` inside it is a part, never a doc.
 * A file matching docGlob and not claimed as an index is a flat doc.
 * Positional parentage comes from the nearest enclosing dir-doc.
 */
import type { Dirent } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ioRead, ioReadDir } from './io.ts';
import { parseFrontmatter } from '@broject/brose';
import { type Doc, docSuffix, globMatch, type ParentEdge, type Protocol } from './protocol.ts';

const posix = (p: string): string => p.split(sep).join('/');

function indexFile(dir: string, names: string[]): string | undefined {
  let files: Set<string>;
  try {
    files = new Set(
      ioReadDir(dir)
        .filter(e => e.isFile())
        .map(e => e.name)
    );
  } catch {
    return undefined;
  }
  return names.find(n => files.has(n));
}

function makeDoc(
  protocol: Protocol,
  abs: string,
  isDirDoc: boolean,
  fallbackId: string,
  enclosing: Doc | undefined
): Doc | undefined {
  let fm: ReturnType<typeof parseFrontmatter>;
  try {
    fm = parseFrontmatter(ioRead(abs));
  } catch {
    // vanished or unreadable between readdir and read — a file the
    // scan can't read is a file the scan doesn't see.
    return undefined;
  }
  const declared = fm.data[protocol.idField];
  const id = typeof declared === 'string' && declared !== '' ? declared : fallbackId;
  const parent = protocol.parentField === undefined ? undefined : fm.data[protocol.parentField];
  let parentId: string | undefined;
  let parentEdge: ParentEdge = 'none';
  if (typeof parent === 'string' && parent !== '') {
    parentId = parent;
    parentEdge = 'frontmatter';
  } else if (enclosing !== undefined) {
    parentId = enclosing.id;
    parentEdge = 'position';
  }
  return { id, path: abs, parentId, parentEdge, frontmatter: fm.data, isDirDoc };
}

export function scan(protocol: Protocol): Doc[] {
  const root = resolve(protocol.root);
  const suffix = docSuffix(protocol.docGlob);
  const glob = protocol.docGlob;
  const indexNames = (d: string): string[] => [
    ...(protocol.indexName === undefined ? [] : [protocol.indexName(d)]),
    ...(protocol.indexAliases ?? []),
  ];
  const out: Doc[] = [];
  const walk = (dir: string, enclosing: Doc | undefined): void => {
    let self = enclosing;
    const idx = indexFile(dir, indexNames(basename(dir)));
    if (idx !== undefined) {
      const index = makeDoc(protocol, join(dir, idx), true, basename(dir), enclosing);
      if (index !== undefined) {
        self = index;
        out.push(index);
      }
    }
    let entries: Dirent[];
    try {
      entries = ioReadDir(dir).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, self);
      } else if (e.isFile() && e.name !== idx && globMatch(glob, posix(relative(root, abs)))) {
        const fallback = e.name.endsWith(suffix) ? e.name.slice(0, -suffix.length) : e.name;
        const d = makeDoc(protocol, abs, false, fallback, self);
        if (d !== undefined) {
          out.push(d);
        }
      }
    }
  };
  walk(root, undefined);
  return out;
}

export const list = scan;

/** Resolve one doc by id or by `aliases:` frontmatter membership. On a
 *  duplicate id the path-first doc wins — deterministic, matching the
 *  graph edge resolution. */
export function get(protocol: Protocol, id: string): Doc | undefined {
  const docs = scan(protocol);
  return (
    docs.find(d => d.id === id) ??
    docs.find(d => Array.isArray(d.frontmatter.aliases) && d.frontmatter.aliases.includes(id))
  );
}

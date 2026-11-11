/**
 * Create — render a doc through brose and write it into the tree.
 * Placement: flat docs land at `<root>/<id><suffix>`; `dir` makes it a
 * dir-doc `<base>/<dir>/<index>`; `parent` either sets the parent field
 * (flat parent) or writes into the parent's directory (dir-doc parent —
 * the positional edge IS the link, no frontmatter written). Refuses to
 * overwrite.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { create as broseCreate, createRegistry } from '@broject/brose';
import { type Doc, docSuffix, type Protocol } from './protocol.ts';
import { get, scan } from './scan.ts';

export interface CreateDocOpts {
  template: string;
  id: string;
  values?: Record<string, unknown>;
  /** create a dir-doc in this directory (name = basename(dir)) */
  dir?: string;
  /** parent doc id — frontmatter edge to a flat parent, positional edge
   *  into a dir-doc parent */
  parent?: string;
}

export function create(protocol: Protocol, opts: CreateDocOpts): Doc {
  const registry = createRegistry({ dirs: protocol.templateDirs, cwd: protocol.root });
  const resolved = registry.resolve(opts.template);
  if (resolved === undefined) {
    throw new Error(`unknown template '${opts.template}'`);
  }
  // brose emits only declared `fields:` — force the protocol's id/parent
  // fields into the frontmatter even when the template doesn't declare
  // them, so the written doc carries its identity.
  const t = {
    ...resolved,
    fields: {
      ...resolved.fields,
      [protocol.idField]: resolved.fields[protocol.idField] ?? {},
      ...(protocol.parentField === undefined
        ? {}
        : { [protocol.parentField]: resolved.fields[protocol.parentField] ?? {} }),
    },
  };
  const suffix = docSuffix(protocol.docGlob);
  let base = resolve(protocol.root);
  const values: Record<string, unknown> = {
    ...opts.values,
    [protocol.idField]: opts.id,
    template: `${t.name}@${t.version}`,
  };
  if (opts.parent !== undefined) {
    const p = get(protocol, opts.parent);
    if (p === undefined) {
      throw new Error(`unknown parent '${opts.parent}'`);
    }
    if (p.isDirDoc) {
      base = dirname(p.path);
    } else if (protocol.parentField !== undefined) {
      values[protocol.parentField] = p.id;
    }
  }
  const file =
    opts.dir === undefined
      ? join(base, `${opts.id}${suffix}`)
      : join(base, opts.dir, protocol.indexName?.(basename(opts.dir)) ?? `${opts.id}${suffix}`);
  if (existsSync(file)) {
    throw new Error(`file exists: ${file}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, broseCreate(t, values));
  return scan(protocol).find(d => d.path === file) as Doc;
}

/**
 * Create — render a doc through brose and write it into the tree.
 * Placement: flat docs land at `<root>/<id><suffix>`; `dir` makes it a
 * dir-doc `<base>/<dir>/<index>`; `parent` either sets the parent field
 * (flat parent) or writes into the parent's directory (dir-doc parent —
 * the positional edge IS the link, no frontmatter written). Refuses to
 * overwrite.
 */
import { basename, dirname, join, resolve, sep } from 'node:path';
import { create as broseCreate, createRegistry, type FieldSpec, ownValue } from '@broject/brose';
import { ioExists, ioWrite, resolveIn } from './io.ts';
import { type Doc, docSuffix, globMatch, type Protocol } from './protocol.ts';
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
  const ownField = (key: string): FieldSpec => ownValue<FieldSpec>(resolved.fields, key) ?? {};
  const t = {
    ...resolved,
    fields: {
      ...resolved.fields,
      [protocol.idField]: ownField(protocol.idField),
      ...(protocol.parentField === undefined
        ? {}
        : { [protocol.parentField]: ownField(protocol.parentField) }),
    },
  };
  const suffix = docSuffix(protocol.docGlob);
  let base = resolve(protocol.root);
  let values: Record<string, unknown> = {
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
      // the positional edge IS the link — a caller-supplied parent field
      // would win over it on the next scan and silently re-parent the doc.
      values = Object.fromEntries(
        Object.entries(values).filter(([k]) => k !== protocol.parentField)
      );
    } else if (protocol.parentField !== undefined) {
      Object.assign(values, { [protocol.parentField]: p.id });
    }
  }
  const name =
    opts.dir === undefined
      ? `${opts.id}${suffix}`
      : join(opts.dir, protocol.indexName?.(basename(opts.dir)) ?? `${opts.id}${suffix}`);
  if (opts.dir !== undefined) {
    // every configured index name in the target dir is a conflict — a
    // legacy `spec.md` next to the new canonical index makes the older
    // dir-doc vanish from lookup and orphans its inbound edges.
    const dirAbs = join(base, opts.dir);
    const target = join(opts.dir, basename(name));
    const conflict = [protocol.indexName?.(basename(opts.dir)), ...(protocol.indexAliases ?? [])]
      .filter((n): n is string => n !== undefined && join(opts.dir, n) !== target)
      .find(n => ioExists(join(dirAbs, n)));
    if (conflict !== undefined) {
      throw new Error(`directory '${opts.dir}' already has index '${conflict}'`);
    }
  }
  // the write must be discoverable — refuse before touching disk when
  // the id/dir combo can't match the configured glob (`?` arity, a
  // dir-prefixed pattern, …). `id`/`dir` also can't smuggle separators
  // the glob would have let through.
  if (!globMatch(protocol.docGlob, name.split(sep).join('/'))) {
    throw new Error(`doc name '${name}' does not match docGlob '${protocol.docGlob}'`);
  }
  // normalize, then prove the target stays under base — a `..` in
  // `id`/`dir` must not write outside the configured tree.
  const file = resolveIn(base, name);
  if (ioExists(file)) {
    throw new Error(`file exists: ${file}`);
  }
  // the destination is free but the id may live at another path —
  // creating here would duplicate it and make `get` ambiguous.
  if (get(protocol, opts.id) !== undefined) {
    throw new Error(`doc id '${opts.id}' already exists in the tree`);
  }
  try {
    ioWrite(file, broseCreate(t, values), { exclusive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`file exists: ${file}`);
    }
    throw e;
  }
  const created = scan(protocol).find(d => d.path === file);
  if (created === undefined) {
    throw new Error(`created file '${file}' was not discovered by scan — check docGlob`);
  }
  return created;
}

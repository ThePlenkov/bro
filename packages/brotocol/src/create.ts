/**
 * Create — render a doc through brose and write it into the tree.
 * Placement: flat docs land at `<root>/<id><suffix>`; `dir` makes it a
 * dir-doc `<base>/<dir>/<index>`; `parent` either sets the parent field
 * (flat parent) or writes into the parent's directory (dir-doc parent —
 * the positional edge IS the link, no frontmatter written). Refuses to
 * overwrite.
 */
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  create as broseCreate,
  createRegistry,
  type FieldSpec,
  ownValue,
  type Template,
} from '@broject/brose';
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

/** brose emits only declared `fields:` — force the protocol's id/parent
 *  fields into the frontmatter even when the template doesn't declare
 *  them, so the written doc carries its identity. */
function protocolFields(protocol: Protocol, resolved: Template): Template {
  const ownField = (key: string): FieldSpec => ownValue<FieldSpec>(resolved.fields, key) ?? {};
  return {
    ...resolved,
    fields: {
      ...resolved.fields,
      [protocol.idField]: ownField(protocol.idField),
      ...(protocol.parentField === undefined
        ? {}
        : { [protocol.parentField]: ownField(protocol.parentField) }),
    },
  };
}

/** Resolve `opts.parent`. A dir-doc parent moves the write base into the
 *  parent's directory and suppresses the caller-supplied parent field —
 *  the positional edge IS the link and a written field would silently
 *  re-parent the doc on the next scan. A flat parent writes the
 *  frontmatter edge. */
function parentBase(
  protocol: Protocol,
  opts: CreateDocOpts,
  values: Record<string, unknown>
): { base: string; values: Record<string, unknown> } {
  if (opts.parent === undefined) {
    return { base: resolve(protocol.root), values };
  }
  const p = get(protocol, opts.parent);
  if (p === undefined) {
    throw new Error(`unknown parent '${opts.parent}'`);
  }
  if (p.isDirDoc) {
    return {
      base: dirname(p.path),
      values: Object.fromEntries(
        Object.entries(values).filter(([k]) => k !== protocol.parentField)
      ),
    };
  }
  if (protocol.parentField !== undefined) {
    Object.assign(values, { [protocol.parentField]: p.id });
  }
  return { base: resolve(protocol.root), values };
}

/** The doc's path relative to its write base. */
function docRelName(protocol: Protocol, opts: CreateDocOpts, suffix: string): string {
  if (opts.dir === undefined) {
    return `${opts.id}${suffix}`;
  }
  return join(opts.dir, protocol.indexName?.(basename(opts.dir)) ?? `${opts.id}${suffix}`);
}

/** Every configured index name in the target dir is a conflict — a
 *  legacy `spec.md` next to the new canonical index makes the older
 *  dir-doc vanish from lookup and orphans its inbound edges. */
function assertNoIndexConflict(
  protocol: Protocol,
  base: string,
  dirName: string,
  name: string
): void {
  const dirAbs = join(base, dirName);
  const target = join(dirName, basename(name));
  const conflict = [protocol.indexName?.(basename(dirName)), ...(protocol.indexAliases ?? [])]
    .filter((n): n is string => n !== undefined && join(dirName, n) !== target)
    .find(n => ioExists(join(dirAbs, n)));
  if (conflict !== undefined) {
    throw new Error(`directory '${dirName}' already has index '${conflict}'`);
  }
}

/** Prove the write is safe before touching disk: the name must match
 *  the configured glob (else the doc lands undiscoverable — `?` arity,
 *  dir-prefixed patterns, …), must stay under base, must not exist, and
 *  must not duplicate an id already living at another path. */
function writeTarget(protocol: Protocol, base: string, name: string, id: string): string {
  if (!globMatch(protocol.docGlob, name.split(sep).join('/'))) {
    throw new Error(`doc name '${name}' does not match docGlob '${protocol.docGlob}'`);
  }
  const file = resolveIn(base, name);
  if (ioExists(file)) {
    throw new Error(`file exists: ${file}`);
  }
  if (get(protocol, id) !== undefined) {
    throw new Error(`doc id '${id}' already exists in the tree`);
  }
  return file;
}

/** Write exclusively and return the freshly-scanned doc — a write the
 *  scan can't see back is a config bug, not a success. */
function writeAndRescan(protocol: Protocol, file: string, content: string): Doc {
  try {
    ioWrite(file, content, { exclusive: true });
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

export function create(protocol: Protocol, opts: CreateDocOpts): Doc {
  const registry = createRegistry({ dirs: protocol.templateDirs, cwd: protocol.root });
  const resolved = registry.resolve(opts.template);
  if (resolved === undefined) {
    throw new Error(`unknown template '${opts.template}'`);
  }
  const t = protocolFields(protocol, resolved);
  const { base, values } = parentBase(protocol, opts, {
    ...opts.values,
    [protocol.idField]: opts.id,
    template: `${t.name}@${t.version}`,
  });
  const name = docRelName(protocol, opts, docSuffix(protocol.docGlob));
  if (opts.dir !== undefined) {
    assertNoIndexConflict(protocol, base, opts.dir, name);
  }
  const file = writeTarget(protocol, base, name, opts.id);
  return writeAndRescan(protocol, file, broseCreate(t, values));
}

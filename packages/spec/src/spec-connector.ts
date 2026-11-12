/**
 * The `brose` specs connector — SpecStore over the Brotocol spec
 * protocol (`@broject/brotocol` scan/get/create) with `@broject/brose`
 * templates, merged with the legacy spec-dir index for the migration
 * window: bead-keyed `<id>.md` specs and untemplated `<id>.spec.md`
 * files keep resolving until they are rewritten as KEY-N docs.
 *
 * This is the engine binding from BRO-1: `bro spec` verbs and the sdd
 * hook probes keep consuming the core `SpecStore` facade — they never
 * name a tool.
 *
 * Detection is format-driven: the connector claims a project whose
 * `sdd.dir` contains `*.spec.md` docs, deferring to explicit tool
 * layouts (`.specify/`, `openspec/`) exactly like `native` does.
 * Legacy `<id>.md`-only trees keep resolving to `native` — migration
 * is opt-in by adopting the marker, never a silent cutover.
 */
import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import {
  type Connector,
  type ConnectorCtx,
  loadConfig,
  type SpecNode,
  type SpecStore,
} from '@broject/core';
import {
  create,
  get,
  type Protocol,
  scan,
  specProtocol,
  specTemplateDir,
  update,
} from '@broject/brotocol';
import { findSpec, hasSpecFile, indexSpecDir, repoRoot, specDirAbs, specScope } from './legacy.ts';

/** Any `*.spec.md` under dir, early exit — the format-presence signal
 *  matchDir claims on. Bounded by the tree itself; spec dirs are small.
 *  Exported for `bro spec init`'s layout detection. */
export function hasSpecDoc(dir: string): boolean {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        stack.push(join(d, e.name));
      } else if (e.name.endsWith('.spec.md')) {
        return true;
      }
    }
  }
  return false;
}

const require = createRequire(import.meta.url);

/** brotocol's shipped template dir. `specTemplateDir` derives from
 *  brotocol's own import.meta.url — once the package is bundled into
 *  the cli (tsdown noExternal) that URL points into cli's dist, not the
 *  package. createRequire still resolves the installed package, so
 *  prefer it and keep specTemplateDir as the unbundled fallback. A
 *  missing dir is harmless — the registry skips unreadable dirs. */
function brotocolTemplates(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(join(dirname(dirname(require.resolve('@broject/brotocol'))), 'templates'));
  } catch {
    // package not resolvable from here — specTemplateDir may still work
  }
  dirs.push(specTemplateDir);
  return [...new Set(dirs)];
}

/** `owns:` (KEY-N specs) wins over `scope:` (legacy pathspecs); both
 *  may be a list or a single string in parsed frontmatter. */
function fmPaths(value: unknown): string[] | null {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const paths = items.filter((x): x is string => typeof x === 'string');
  return paths.length === 0 ? null : paths;
}

/** sdd.dir escaped the repo root — every op degrades the way the
 *  native connector's null base does: no coverage, no tree, loud
 *  scaffold. */
function degradedStore(): SpecStore {
  return {
    hasSpec: () => false,
    scaffold: () => {
      throw new Error('sdd.dir escapes the repo root — fix bro.config.json');
    },
    remedy: id => `fix connectors.specs or sdd.dir, then spec "${id}"`,
    policy: () => 'spec before code — sdd.dir escapes the repo root',
    tree: () => [],
    scope: () => null,
  };
}

function specStoreOver(
  root: string,
  specDir: string,
  specRoot: string,
  protocol: Protocol
): SpecStore {
  /** Protocol docs keyed by absolute path — they override the legacy
   *  index entry for the same file (frontmatter `id:` is authoritative
   *  over the path-derived legacy id). Dir-docs also feed the orphan
   *  fixup: a legacy child whose positional parent was renamed by a
   *  frontmatter id re-parents to the doc now owning its directory. */
  const protocolScan = (): {
    byPath: Map<string, SpecNode>;
    dirDocs: { id: string; dir: string }[];
  } => {
    const byPath = new Map<string, SpecNode>();
    const dirDocs: { id: string; dir: string }[] = [];
    if (!existsSync(specRoot)) {
      return { byPath, dirDocs };
    }
    for (const d of scan(protocol)) {
      const node: SpecNode = {
        id: d.id,
        path: relative(root, d.path),
      };
      if (d.parentId !== undefined) {
        node.parent = d.parentId;
      }
      if (d.parentEdge === 'frontmatter' || d.parentEdge === 'position') {
        node.parentVia = d.parentEdge;
      }
      byPath.set(d.path, node);
      if (d.isDirDoc) {
        dirDocs.push({ id: d.id, dir: dirname(d.path) });
      }
    }
    return { byPath, dirDocs };
  };

  return {
    hasSpec: id => get(protocol, id) !== undefined || hasSpecFile(root, specDir, id),
    scaffold(id, opts) {
      // the legacy index also sees `<id>.md`/dir-spec collisions the
      // protocol glob misses — refuse duplicates across BOTH views,
      // the way native's findSpec did
      const existing = findSpec(root, specDir, id);
      if (existing !== undefined) {
        throw new Error(
          `a spec for "${id}" already exists at ${existing.path} — refusing to duplicate`
        );
      }
      const parent = opts.parent;
      // a parent the protocol cannot see may still be a legacy spec —
      // create flat, then write the frontmatter edge `parent:` the
      // merged tree resolves through the legacy index
      const legacyParent =
        parent !== undefined &&
        get(protocol, parent) === undefined &&
        findSpec(root, specDir, parent) !== undefined;
      const doc = create(protocol, {
        template: 'brotocol/spec@1',
        id,
        values: { title: opts.title ?? '', status: 'draft' },
        ...(parent === undefined || legacyParent ? {} : { parent }),
      });
      if (legacyParent) {
        update(protocol, id, { [protocol.parentField ?? 'parent']: parent });
      }
      return doc.path;
    },
    remedy: id =>
      `write a spec for "${id}" (\`bro spec new ${id}\`), add a spec: link, or label 'trivial'`,
    policy: () =>
      "spec before code — *.spec.md docs on the Brotocol spec protocol (KEY-N ids, template: brotocol/spec@N), policy specs carry bro:sdd identity regions, or a spec: link in the bead (exempt: chore / molecule / 'trivial' / 'debt')",
    tree() {
      if (!existsSync(specRoot)) {
        return [];
      }
      const byPath = new Map<string, SpecNode>();
      const absByNode = new Map<SpecNode, string>();
      for (const n of indexSpecDir(specRoot, specDir)) {
        const { abs, dirSpec: _d, ...node } = n;
        byPath.set(abs, node);
        absByNode.set(node, abs);
      }
      const { byPath: proto, dirDocs } = protocolScan();
      for (const [abs, node] of proto) {
        byPath.set(abs, node);
        absByNode.set(node, abs);
      }
      const nodes = [...byPath.values()];
      // merged views can disagree on a dir's id (legacy path-derived vs
      // frontmatter `id:`) — a child edge naming the loser dangles.
      // Re-parent it to the nearest dir-doc that still contains it.
      const ids = new Set(nodes.map(n => n.id));
      for (const n of nodes) {
        if (n.parent === undefined || ids.has(n.parent)) {
          continue;
        }
        const abs = absByNode.get(n);
        if (abs === undefined) {
          continue;
        }
        const owner = dirDocs
          .filter(d => abs.startsWith(d.dir + '/'))
          .sort((a, b) => b.dir.length - a.dir.length)[0];
        if (owner !== undefined) {
          n.parent = owner.id;
          n.parentVia = 'position';
        }
      }
      return nodes.sort((a, b) => a.id.localeCompare(b.id));
    },
    scope: id => {
      const d = get(protocol, id);
      if (d !== undefined) {
        const declared = fmPaths(d.frontmatter.owns) ?? fmPaths(d.frontmatter.scope);
        if (declared !== null) {
          return declared;
        }
      }
      const node = findSpec(root, specDir, id);
      if (node === undefined) {
        return null;
      }
      const entries = specScope(node.abs);
      return entries.length === 0 ? null : entries;
    },
  };
}

export const specConnector: Connector = {
  name: 'brose',
  // claims format-bearing trees only — an explicit tool layout
  // (.specify/, openspec/) owns the repo even when stray *.spec.md
  // files sit beside it, same deferral native applies
  matchDir(dir) {
    try {
      const root = repoRoot(dir);
      if (existsSync(join(root, '.specify')) || existsSync(join(root, 'openspec'))) {
        return false;
      }
      const specDir = specDirAbs(dir, loadConfig(dir).sdd.dir);
      return specDir !== null && existsSync(specDir) && hasSpecDoc(specDir);
    } catch {
      return false;
    }
  },
  specs(ctx: ConnectorCtx): SpecStore {
    const { dir: specDir } = loadConfig(ctx.dir).sdd;
    const root = repoRoot(ctx.dir);
    const specRoot = specDirAbs(root, specDir);
    if (specRoot === null) {
      return degradedStore();
    }
    const protocol = specProtocol({ dir: specRoot });
    protocol.templateDirs = [...brotocolTemplates(), ...(protocol.templateDirs ?? [])];
    return specStoreOver(root, specDir, specRoot, protocol);
  },
};

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
import type { Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  create,
  get,
  type Protocol,
  scan,
  specProtocol,
  specTemplateDir,
  update,
} from '@broject/brotocol';
import {
  type Connector,
  type ConnectorCtx,
  loadConfig,
  type SpecNode,
  type SpecStore,
} from '@broject/core';
import { ioExists, ioRead, ioReadDir } from './io.ts';
import { findSpec, hasSpecFile, indexSpecDir, repoRoot, specDirAbs, specScope } from './legacy.ts';

/** Any `*.spec.md` under dir, early exit — the format-presence signal
 *  matchDir claims on. Bounded by the tree itself; spec dirs are small.
 *  Exported for `bro spec init`'s layout detection. */
export function hasSpecDoc(dir: string): boolean {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    if (d === undefined) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = ioReadDir(d);
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
    // the cli bundle emits brotocol's templates/ as a dist asset —
    // this module's own dir is dist/ in both the package and the bundle
    dirs.push(join(dirname(fileURLToPath(import.meta.url)), 'templates'));
  } catch {
    // import.meta.url always resolves — kept for symmetry with the
    // require probe below
  }
  try {
    dirs.push(join(dirname(dirname(require.resolve('@broject/brotocol'))), 'templates'));
  } catch {
    // package not resolvable from here — specTemplateDir may still work
  }
  dirs.push(specTemplateDir);
  return [...new Set(dirs.filter(d => ioExists(d)))];
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

type ProtocolView = {
  byPath: Map<string, SpecNode>;
  dirDocs: { id: string; dir: string }[];
};

type IndexedView = {
  byPath: Map<string, SpecNode>;
  absByNode: Map<SpecNode, string>;
};

function scanProtocolView(root: string, specRoot: string, protocol: Protocol): ProtocolView {
  const byPath = new Map<string, SpecNode>();
  const dirDocs: { id: string; dir: string }[] = [];
  if (!ioExists(specRoot)) {
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
}

function indexLegacyView(specRoot: string, specDir: string): IndexedView {
  const byPath = new Map<string, SpecNode>();
  const absByNode = new Map<SpecNode, string>();
  for (const n of indexSpecDir(specRoot, specDir)) {
    const { abs, dirSpec: _d, ...node } = n;
    byPath.set(abs, node);
    absByNode.set(node, abs);
  }
  return { byPath, absByNode };
}

function mergeSpecViews(legacy: IndexedView, protocol: ProtocolView): IndexedView {
  const byPath = new Map(legacy.byPath);
  const absByNode = new Map(legacy.absByNode);
  for (const [abs, node] of protocol.byPath) {
    byPath.set(abs, node);
    absByNode.set(node, abs);
  }
  return { byPath, absByNode };
}

function repairDanglingParents(
  nodes: SpecNode[],
  absByNode: Map<SpecNode, string>,
  dirDocs: { id: string; dir: string }[]
): void {
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
      .filter(d => abs.startsWith(d.dir + sep))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner !== undefined) {
      n.parent = owner.id;
      n.parentVia = 'position';
    }
  }
}

function mergedTree(
  root: string,
  specDir: string,
  specRoot: string,
  protocol: Protocol
): SpecNode[] {
  const legacy = indexLegacyView(specRoot, specDir);
  const protocolView = scanProtocolView(root, specRoot, protocol);
  const merged = mergeSpecViews(legacy, protocolView);
  const nodes = [...merged.byPath.values()];
  repairDanglingParents(nodes, merged.absByNode, protocolView.dirDocs);
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

function specStoreOver(
  root: string,
  specDir: string,
  specRoot: string,
  protocol: Protocol
): SpecStore {
  return {
    hasSpec: id => {
      const d = get(protocol, id);
      if (d !== undefined) {
        // parity with hasSpecFile: a zero-byte .spec.md is a scaffold
        // stub, not coverage — scan still derives its id from the name
        try {
          if (ioRead(d.path).trim() !== '') {
            return true;
          }
        } catch {
          /* unreadable doc — fall through to the legacy probe */
        }
      }
      return hasSpecFile(root, specDir, id);
    },
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
        template: 'brotocol/spec@2',
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
      if (!ioExists(specRoot)) {
        return [];
      }
      return mergedTree(root, specDir, specRoot, protocol);
    },
    scope: id => {
      const d = get(protocol, id);
      if (d !== undefined) {
        // a protocol doc that declares no owns/scope owns nothing — do
        // NOT fall through to a same-id legacy file's scope: that would
        // audit a different document's claimed surface
        const declared = fmPaths(d.frontmatter.owns) ?? fmPaths(d.frontmatter.scope);
        return declared;
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
      if (ioExists(join(root, '.specify')) || ioExists(join(root, 'openspec'))) {
        return false;
      }
      const specDir = specDirAbs(dir, loadConfig(dir).sdd.dir);
      return specDir !== null && ioExists(specDir) && hasSpecDoc(specDir);
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

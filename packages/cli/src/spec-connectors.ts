/**
 * Spec connectors — the SDD tools a project may already run, behind one
 * `specs` facade. Detection is project-layout (`matchDir`), never remote:
 * speckit's `.specify/` and openspec's `openspec/` claim their repos;
 * native `specs/` claims its configured dir and is also the fallback.
 * `agent` never matches — it is an explicit `connectors.specs: "agent"`
 * pick for projects that want the policy without any tool.
 *
 * For external tools the bead ↔ spec link is the `spec:` reference in
 * the bead description — specState checks it before asking the facade,
 * so every tool's hasSpec only answers "does this tool see a file for
 * this id".
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  gitTry,
  loadConfig,
  type Connector,
  type SpecNode,
  type SpecStore,
} from '@broject/core'

/** Repo root for ctx.dir — worktree-aware: a spec committed on the
 *  feature branch is found from a linked worktree, not the main one. */
export function repoRoot(dir: string): string {
  const r = gitTry(['-C', dir, 'rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : dir
}

/** Bead ids are word-ish (`bro-svk.5`); separators and dot-segments
 *  would let `spec new ../../x` write outside the spec dir. */
export function validBeadId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && !id.includes('..')
}

/** The configured spec dir must stay inside the checkout — an absolute
 *  or escaping `sdd.dir` returns null (probes fail open; commands
 *  report it as a config error). An existing dir is realpath'd too: a
 *  repo-local symlink pointing outside would otherwise let `spec new`
 *  write past the checkout. */
export function specDirAbs(dir: string, specDir: string): string | null {
  const root = resolve(repoRoot(dir))
  const abs = resolve(root, specDir)
  if (abs !== root && !abs.startsWith(root + sep)) {
    return null
  }
  try {
    const real = realpathSync(abs)
    return real === root || real.startsWith(root + sep) ? abs : null
  } catch {
    return abs // not yet created — the lexical check already held
  }
}

function specFilePath(dir: string, specDir: string, id: string): string | null {
  const base = specDirAbs(dir, specDir)
  return base === null ? null : join(base, `${id}.md`)
}

/** A spec directory's index file, in preference order — `spec.md`
 *  matches speckit's convention, README.md suits prose-first trees. */
const INDEX_NAMES = ['spec.md', 'README.md']

interface ResolvedSpec extends SpecNode {
  abs: string
  dirSpec: boolean
}

/** The spec tree as the filetree: `.md` files and index-bearing dirs
 *  are nodes; a node's parent is its enclosing spec dir, overridden by
 *  `parent:` frontmatter when present. `.md` files inside a spec dir
 *  are its children; inside a dir with no index (assets/, notes/) they
 *  are content, not specs — indexed subdirs still nest through. */
function indexSpecDir(absBase: string, relBase: string): ResolvedSpec[] {
  const nodes: ResolvedSpec[] = []
  const walk = (
    dirAbs: string,
    dirRel: string,
    parent: string | undefined,
    collectFiles: boolean,
    indexName?: string
  ): void => {
    let entries
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dirAbs, e.name)
      const rel = join(dirRel, e.name)
      if (e.isDirectory()) {
        const index = INDEX_NAMES.find((n) => {
          try {
            return statSync(join(abs, n)).isFile()
          } catch {
            return false
          }
        })
        if (index === undefined || !validBeadId(e.name)) {
          // no index, or a name that cannot be a spec id — transparent:
          // nested index dirs still hang off the nearest spec ancestor
          walk(abs, rel, parent, false)
          continue
        }
        const idxAbs = join(abs, index)
        nodes.push({ id: e.name, path: join(rel, index), abs: idxAbs, dirSpec: true, parent: specParent(idxAbs) ?? parent })
        walk(abs, rel, e.name, true, index)
      } else if (
        collectFiles &&
        e.name.endsWith('.md') &&
        e.name !== indexName
      ) {
        const id = basename(e.name, '.md')
        // a child cannot re-declare its dir spec's id — `foo/foo.md`
        // would self-parent and loop the tree walk
        if (!validBeadId(id) || id === parent) {
          continue
        }
        nodes.push({ id, path: rel, abs, dirSpec: false, parent: specParent(abs) ?? parent })
      }
    }
  }
  walk(absBase, relBase, undefined, true)
  return nodes
}

/** Pick between same-id nodes deterministically — a hand-created
 *  `specs/<id>.md` beside `specs/<id>/spec.md` is a user collision the
 *  scaffold refuses to create, but resolution must not depend on
 *  readdir order: a written spec beats a zero-byte scaffold, a dir
 *  spec (child-bearing) beats a flat file. */
function preferSpec(nodes: ResolvedSpec[]): ResolvedSpec | undefined {
  const nonEmpty = (n: ResolvedSpec): boolean => {
    try {
      return readFileSync(n.abs, 'utf8').trim() !== ''
    } catch {
      return false
    }
  }
  return nodes
    .slice()
    .sort((a, b) => Number(nonEmpty(b)) - Number(nonEmpty(a)) || Number(b.dirSpec) - Number(a.dirSpec))[0]
}

/** Resolve an id to its spec node — file or dir spec, at any depth. */
function findSpec(dir: string, specDir: string, id: string): ResolvedSpec | undefined {
  const base = specDirAbs(dir, specDir)
  if (base === null || !existsSync(base) || !validBeadId(id)) {
    return undefined
  }
  return preferSpec(indexSpecDir(base, specDir).filter((n) => n.id === id))
}

/** A non-empty spec file counts; a zero-byte scaffold does not. */
export function hasSpecFile(dir: string, specDir: string, id: string): boolean {
  try {
    const node = findSpec(dir, specDir, id)
    return node !== undefined && readFileSync(node.abs, 'utf8').trim() !== ''
  } catch {
    return false
  }
}

/** `parent: <bead-id>` from a spec file's frontmatter — the spec tree's
 *  edge. Frontmatter only: a body mention is prose, not structure. */
function specParent(path: string): string | undefined {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 2000)
    const fm = /^---\n([\s\S]*?)\n---/.exec(head)
    const m = /^parent:\s*([\w.-]+)\s*$/m.exec(fm ? fm[1]! : '')
    return m?.[1]
  } catch {
    return undefined
  }
}

/** Scaffold body — optional parent edge for spec-of-specs trees. */
function scaffoldBody(id: string, title: string, parent?: string): string {
  const fm = parent ? `---\nparent: ${parent}\n---\n\n` : ''
  return `${fm}# ${id} — ${title || 'spec'}\n\n## Problem\n\n## Design\n\n## Plan\n\n- [ ] …\n`
}

// --- native: <sdd.dir>/<bead-id>.md -------------------------------------------

export const nativeSpecConnector: Connector = {
  name: 'native',
  // native defers to a recognized tool layout — a speckit repo carries
  // both `.specify/` and a `specs/` dir; sdd.dir existing must not outbid
  // the tool that owns it. Bare repos still fall to native via order.
  matchDir: (dir) => {
    const root = repoRoot(dir)
    if (existsSync(join(root, '.specify')) || existsSync(join(root, 'openspec'))) {
      return false
    }
    const base = specDirAbs(dir, loadConfig(dir).sdd.dir)
    return base !== null && existsSync(base)
  },
  specs(ctx) {
    const { dir: specDir } = loadConfig(ctx.dir).sdd
    const root = ctx.dir
    return {
      // no index cache: a spec file can appear between calls in one
      // store's lifetime (agent writes it, next hasSpec must see it).
      // Specs dirs are tens of small files — a rescan is sub-ms.
      hasSpec: (id) => hasSpecFile(root, specDir, id),
      scaffold(id, opts) {
        const base = specDirAbs(root, specDir)
        if (base === null) {
          throw new Error(`sdd.dir "${specDir}" escapes the repo root — fix bro.config.json`)
        }
        // a dir-spec parent takes the child positionally — location is
        // the edge, so no parent: frontmatter is needed. A flat-file or
        // absent parent gets the frontmatter edge instead.
        const parent = opts.parent === undefined ? undefined : findSpec(root, specDir, opts.parent)
        // specs resolve at any depth — a same-id file elsewhere in the
        // tree is a collision, not a free slot at the root
        const existing = findSpec(root, specDir, id)
        if (existing !== undefined) {
          throw new Error(`a spec for "${id}" already exists at ${existing.path} — refusing to duplicate`)
        }
        const path =
          parent?.dirSpec === true
            ? join(dirname(parent.abs), `${id}.md`)
            : specFilePath(root, specDir, id)!
        if (existsSync(path)) {
          throw new Error(`${path} already exists — refusing to overwrite`)
        }
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, scaffoldBody(id, opts.title ?? '', parent?.dirSpec === true ? undefined : opts.parent))
        return path
      },
      remedy: (id) =>
        `write ${specDir}/${id}.md (\`bro spec new ${id}\`), add a spec: link, or label 'trivial'`,
      policy: () =>
        `spec before code — ${specDir}/<id>.md or <id>/ dir, or a spec: link in the bead (exempt: chore / 'trivial' / 'debt')`,
      tree() {
        const base = specDirAbs(root, specDir)
        if (base === null || !existsSync(base)) {
          return []
        }
        const nodes: SpecNode[] = indexSpecDir(base, specDir).map(({ abs: _a, dirSpec: _d, ...n }) => n)
        return nodes.sort((a, b) => a.id.localeCompare(b.id))
      },
    } satisfies SpecStore
  },
}

// --- speckit: .specify/ + specs/<NNN>-<slug>/spec.md ----------------------------

/** Speckit features live in `specs/<NNN>-<slug>/spec.md` — beads reach
 *  them through `spec:` links; a feature dir NAMING the bead also counts
 *  (`specs/012-bro-xk0/spec.md` adopts bead bro-xk0). */
export const speckitConnector: Connector = {
  name: 'speckit',
  matchDir: (dir) => existsSync(join(repoRoot(dir), '.specify')),
  specs(ctx) {
    const root = repoRoot(ctx.dir)
    const featuresDir = join(root, 'specs')
    const featureFor = (id: string): SpecNode | undefined => {
      if (!validBeadId(id)) {
        return undefined
      }
      try {
        for (const d of readdirSync(featuresDir)) {
          // exact or -<id> suffix: `b10` must not satisfy `b1`
          if (
            (d === id || d.endsWith(`-${id}`)) &&
            existsSync(join(featuresDir, d, 'spec.md'))
          ) {
            return { id, path: join('specs', d, 'spec.md') }
          }
        }
      } catch {
        // no specs/ dir — speckit not scaffolded yet
      }
      return undefined
    }
    return {
      hasSpec: (id) => featureFor(id) !== undefined,
      remedy: () =>
        'run the speckit flow (/speckit.specify) and link the bead: `spec: specs/<NNN>-<slug>/spec.md` in its description',
      policy: () =>
        'spec before code — speckit features in specs/<NNN>-<slug>/spec.md, linked from the bead via spec:',
      tree() {
        const nodes: SpecNode[] = []
        try {
          for (const d of readdirSync(featuresDir)) {
            const spec = join(featuresDir, d, 'spec.md')
            if (existsSync(spec)) {
              nodes.push({ id: d, path: join('specs', d, 'spec.md') })
            }
          }
        } catch {
          // fail-open
        }
        return nodes.sort((a, b) => a.id.localeCompare(b.id))
      },
    } satisfies SpecStore
  },
}

// --- openspec: openspec/changes/<id>/ + openspec/specs/ --------------------------

/** OpenSpec: a change under `openspec/changes/` named for the bead (or
 *  `openspec.spec.md` linked via spec:) counts during work; shipped
 *  capabilities under `openspec/specs/` are the stable spec layer. */
export const openspecConnector: Connector = {
  name: 'openspec',
  matchDir: (dir) => existsSync(join(repoRoot(dir), 'openspec')),
  specs(ctx) {
    const root = repoRoot(ctx.dir)
    const changesDir = join(root, 'openspec', 'changes')
    const shippedDir = join(root, 'openspec', 'specs')
    const list = (base: string, leaf: string): SpecNode[] => {
      const out: SpecNode[] = []
      try {
        for (const d of readdirSync(base)) {
          if (existsSync(join(base, d, leaf))) {
            out.push({ id: d, path: join(base.slice(root.length + 1), d, leaf) })
          }
        }
      } catch {
        // fail-open
      }
      return out
    }
    return {
      hasSpec: (id) =>
        validBeadId(id) &&
        (existsSync(join(changesDir, id, 'proposal.md')) ||
          existsSync(join(shippedDir, id, 'spec.md'))),
      remedy: () =>
        'open an openspec change named for the bead (`openspec` CLI → openspec/changes/<id>/proposal.md), or add a spec: link',
      policy: () =>
        'spec before code — openspec change in openspec/changes/<id>/proposal.md, or a spec: link in the bead',
      tree: () => [...list(shippedDir, 'spec.md'), ...list(changesDir, 'proposal.md')],
    } satisfies SpecStore
  },
}

// --- agent: policy without a tool ----------------------------------------------

/** `agent` — SDD enforced by instruction only: no tool owns spec files,
 *  so the connector contributes policy text and the `spec:` link is the
 *  only evidence path. Explicit config pick, never detected. */
export const agentSpecConnector: Connector = {
  name: 'agent',
  specs: () =>
    ({
      hasSpec: () => false,
      remedy: () =>
        'write the design doc first, then add `spec: <path-or-url>` to the bead description',
      policy: () =>
        'spec before code — write the design down first and link it via spec: in the bead (exempt: chore / \'trivial\' / \'debt\')',
      tree: () => [],
    }) satisfies SpecStore,
}

export const SPEC_CONNECTORS = [
  nativeSpecConnector,
  speckitConnector,
  openspecConnector,
  agentSpecConnector,
]

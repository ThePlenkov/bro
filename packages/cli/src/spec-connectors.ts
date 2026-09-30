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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
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
 *  report it as a config error). */
export function specDirAbs(dir: string, specDir: string): string | null {
  const root = resolve(repoRoot(dir))
  const abs = resolve(root, specDir)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

function specFilePath(dir: string, specDir: string, id: string): string | null {
  const base = specDirAbs(dir, specDir)
  return base === null ? null : join(base, `${id}.md`)
}

/** A non-empty spec file counts; a zero-byte scaffold does not. */
export function hasSpecFile(dir: string, specDir: string, id: string): boolean {
  if (!validBeadId(id)) {
    return false
  }
  try {
    const p = specFilePath(dir, specDir, id)
    return p !== null && statSync(p).isFile() && readFileSync(p, 'utf8').trim() !== ''
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
  matchDir: (dir) => {
    const base = specDirAbs(dir, loadConfig(dir).sdd.dir)
    return base !== null && existsSync(base)
  },
  specs(ctx) {
    const { dir: specDir } = loadConfig(ctx.dir).sdd
    const root = ctx.dir
    return {
      hasSpec: (id) => hasSpecFile(root, specDir, id),
      scaffold(id, opts) {
        const path = specFilePath(root, specDir, id)
        if (path === null) {
          throw new Error(`sdd.dir "${specDir}" escapes the repo root — fix bro.config.json`)
        }
        if (existsSync(path)) {
          throw new Error(`${path} already exists — refusing to overwrite`)
        }
        mkdirSync(specDirAbs(root, specDir)!, { recursive: true })
        writeFileSync(path, scaffoldBody(id, opts.title ?? '', opts.parent))
        return path
      },
      remedy: (id) =>
        `write ${specDir}/${id}.md (\`bro spec new ${id}\`), add a spec: link, or label 'trivial'`,
      policy: () =>
        `spec before code — ${specDir}/<id>.md or a spec: link in the bead (exempt: chore / 'trivial' / 'debt')`,
      tree() {
        const base = specDirAbs(root, specDir)
        if (base === null || !existsSync(base)) {
          return []
        }
        const nodes: SpecNode[] = []
        for (const f of readdirSync(base)) {
          if (!f.endsWith('.md')) {
            continue
          }
          const id = basename(f, '.md')
          if (!validBeadId(id)) {
            continue
          }
          const path = join(base, f)
          nodes.push({ id, parent: specParent(path), path: join(specDir, f) })
        }
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
          if (d.includes(id) && existsSync(join(featuresDir, d, 'spec.md'))) {
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

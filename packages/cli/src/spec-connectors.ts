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
        const fm = specParent(idxAbs)
        nodes.push({
          id: e.name,
          path: join(rel, index),
          abs: idxAbs,
          dirSpec: true,
          parent: fm ?? parent,
          parentVia: edgeVia(fm, parent),
        })
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
        const fm = specParent(abs)
        nodes.push({
          id,
          path: rel,
          abs,
          dirSpec: false,
          parent: fm ?? parent,
          parentVia: edgeVia(fm, parent),
        })
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
    .sort(
      (a, b) =>
        Number(nonEmpty(b)) - Number(nonEmpty(a)) ||
        Number(b.dirSpec) - Number(a.dirSpec) ||
        (a.path ?? '').localeCompare(b.path ?? '')
    )[0]
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

/** Edge origin for a resolved parent: an explicit `parent:` frontmatter
 *  line beats the positional enclosing dir spec; no edge at all leaves
 *  it unset. Renderers resolve the two differently on duplicate ids. */
function edgeVia(
  fm: string | undefined,
  positional: string | undefined
): SpecNode['parentVia'] {
  return fm !== undefined
    ? 'frontmatter'
    : positional !== undefined
      ? 'position'
      : undefined
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

const unquote = (s: string): string => {
  const t = s.trim()
  return t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    ? t.slice(1, -1)
    : t
}

/** Can a scalar begin at index i? — after `[`, `,`, or the fragment
 *  start (whitespace skipped). */
const opensScalar = (t: string, i: number): boolean => {
  for (let k = i - 1; k >= 0; k--) {
    if (t[k] !== ' ' && t[k] !== '\t') {
      return t[k] === '[' || t[k] === ','
    }
  }
  return true
}

/** The index just past a quoted scalar's closing quote starting at
 *  `start` (t[start] is the quote), or -1 when it never closes. `\\`
 *  escapes inside double quotes, `''` doubles inside single quotes. */
const closeQuote = (t: string, start: number): number => {
  const q = t[start]!
  for (let i = start + 1; i < t.length; i++) {
    if (q === '"' && t[i] === '\\') {
      i++
    } else if (t[i] === q) {
      if (q === "'" && t[i + 1] === "'") {
        i++
      } else {
        return i + 1
      }
    }
  }
  return -1
}

/** Index where a YAML comment begins — a `#` at the head or after a
 *  space/tab, outside quotes. Quotes only quote inside a flow list —
 *  in a bare scalar `docs/it's.md` the apostrophe is an ordinary
 *  character. -1 when the scalar runs to the end. */
const commentStart = (t: string, flow: boolean): number => {
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (flow && (ch === '"' || ch === "'") && opensScalar(t, i)) {
      const end = closeQuote(t, i)
      if (end !== -1) {
        i = end - 1
      }
    } else if (ch === '#' && (i === 0 || t[i - 1] === ' ' || t[i - 1] === '\t')) {
      return i
    }
  }
  return -1
}

/** One YAML scalar: a ` #…` comment (space- or tab-separated, outside
 *  quotes — `src/x.ts\t# note` drops its note) drops off a bare value;
 *  quoted values keep their #, and a comment may follow the closing
 *  quote — `"x" # note` is still x. */
const yamlScalar = (s: string): string => {
  const t = s.trim()
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = closeQuote(t, 0)
    const v = end !== -1 && /^\s*(#.*)?$/.test(t.slice(end)) ? t.slice(0, end) : t
    const u = unquote(v)
    // doubled single quotes collapse to one inside a single-quoted scalar
    return v.startsWith("'") && v.endsWith("'") ? u.replaceAll("''", "'") : u
  }
  const c = commentStart(t, t.startsWith('['))
  return unquote(c === -1 ? t : t.slice(0, c))
}

/** Split a flow list on commas outside quotes — `["a,b", 'c']` is two
 *  entries, not three. Quotes only open at scalar position — a bare
 *  `a'ts.ts` keeps its apostrophe. */
const flowItems = (s: string): string[] => {
  const items: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if ((ch === '"' || ch === "'") && opensScalar(s, i)) {
      const end = closeQuote(s, i)
      if (end !== -1) {
        cur += s.slice(i, end)
        i = end - 1
        continue
      }
    }
    if (ch === ',') {
      items.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  items.push(cur)
  return items
}

/** The scope value's items — a wrapped flow list joins its lines until
 *  the closing `]` (comments strip quote-aware per fragment, brackets
 *  survive); a block list reads `- ` items, skipping blank and
 *  comment-only lines as YAML allows. */
const scopeItems = (inline: string, body: string[]): string[] => {
  for (let j = 0; inline.startsWith('[') && !inline.endsWith(']') && j < body.length; j++) {
    const frag = body[j]!.trim()
    const c = commentStart(frag, true)
    inline += ` ${(c === -1 ? frag : frag.slice(0, c)).trimEnd()}`
  }
  if (inline !== '') {
    return inline.startsWith('[') && inline.endsWith(']')
      ? flowItems(inline.slice(1, -1)).map(yamlScalar).filter((s) => s !== '')
      : [inline]
  }
  const items: string[] = []
  for (const l of body) {
    const m = /^\s*-\s+/.exec(l)
    if (m === null) {
      if (/^\s*(#.*)?$/.test(l)) {
        continue
      }
      break
    }
    items.push(yamlScalar(l.slice(m[0].length)))
  }
  return items.filter((s) => s !== '')
}

/** `scope:` frontmatter — repo-relative pathspecs the spec claims for
 *  itself (spec drift's audit surface). A YAML list or a single string;
 *  an empty/absent key declares nothing and returns []. The whole file
 *  is read — a capped read would silently narrow a long frontmatter's
 *  declared scope into the commit fallback. Exported for the drift
 *  audit, which must read the *audited* file's scope — a connector's
 *  id-keyed lookup can resolve a different same-id file. */
export function specScope(path: string): string[] {
  try {
    const head = readFileSync(path, 'utf8')
    const fm = /^---\n([\s\S]*?)\n---/.exec(head)
    if (fm === null) {
      return []
    }
    const lines = fm[1]!.split('\n')
    const i = lines.findIndex((l) => /^scope:\s*/.test(l))
    if (i === -1) {
      return []
    }
    return scopeItems(
      yamlScalar(lines[i]!.replace(/^scope:\s*/, '')),
      lines.slice(i + 1)
    )
  } catch {
    return []
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
      // the tool's explicit scope only — `scope:` frontmatter on the
      // resolved spec file; the commit-refs fallback is the drift
      // engine's, not the connector's
      scope: (id) => {
        const node = findSpec(root, specDir, id)
        if (node === undefined) {
          return null
        }
        const entries = specScope(node.abs)
        return entries.length === 0 ? null : entries
      },
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

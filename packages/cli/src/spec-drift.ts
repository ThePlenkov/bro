/** Spec drift — the audit engine behind `bro spec drift` (spec:
 *  specs/bro-fvhz.md). This module owns the part that is beads+git,
 *  not tool-specific: resolving a spec'd bead to a repo path set.
 *  Connectors contribute only their *explicit* scope
 *  (`SpecStore.scope?`); the commit-refs fallback lives here.
 *
 *  Scope precedence (first hit wins):
 *    1. `scope:` frontmatter — validated: repo-relative only, and it
 *       must match at least one committed path. Violations are
 *       `unverifiable`, never silently widened or blessed.
 *    2. bead-id commits — commits on the drift ref whose *subject*
 *       contains `(<id>)`; the union of their touched paths.
 *    3. neither resolves → `no-scope`.
 *  The spec's own path is always excluded (`:(exclude)<spec-path>`) —
 *  a `scope: specs/**` cannot mask its own drift. */
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  gitLogPathRecords,
  gitTry,
  type SpecNode,
  type SpecStore,
} from '@broject/core'

export type ScopeResult =
  | { state: 'scoped'; via: 'frontmatter' | 'commits'; pathspecs: string[] }
  | { state: 'no-scope' }
  | { state: 'unverifiable'; reason: string }

/** Deterministic pick among same-id tree() nodes — the same rule the
 *  connector's hasSpec applies, re-derivable from SpecNode alone:
 *  non-empty beats scaffold, a dir spec (index under a dir named for
 *  the id) beats flat, and lexicographic order settles what the tool
 *  leaves ambiguous (openspec's hasSpec checks changes/ first —
 *  `openspec/changes` sorts before `openspec/specs`). */
export function pickSpecPath(dir: string, nodes: SpecNode[], id: string): string | undefined {
  const nonEmpty = (path: string): boolean => {
    try {
      return readFileSync(join(dir, path), 'utf8').trim() !== ''
    } catch {
      return false
    }
  }
  const dirSpec = (n: SpecNode): boolean =>
    n.path !== undefined && basename(dirname(n.path)) === n.id
  return nodes
    .filter((n) => n.id === id && n.path !== undefined)
    .slice()
    .sort(
      (a, b) =>
        Number(nonEmpty(b.path!)) - Number(nonEmpty(a.path!)) ||
        Number(dirSpec(b)) - Number(dirSpec(a)) ||
        a.path!.localeCompare(b.path!)
    )[0]?.path
}

/** A scope entry that can't name a repo path — an absolute path or a
 *  `..` segment — makes the row unverifiable ("bad scope path"),
 *  never silently widens. */
function badScopeEntry(entry: string): boolean {
  return (
    entry === '' ||
    isAbsolute(entry) ||
    /^[A-Za-z]:[\\/]/.test(entry) ||
    entry.split(/[\\/]/).includes('..')
  )
}

/** A subtract-only pathspec — `:(exclude…)`, `:(!…)`, `:!…`, `:^…`.
 *  An all-exclusion scope matches the whole repo minus a hole: silent
 *  widening, which the spec forbids. */
function negativePathspec(entry: string): boolean {
  if (entry.startsWith(':!') || entry.startsWith(':^')) {
    return true
  }
  const m = /^:\(([^)]*)\)/.exec(entry)
  if (m === null) {
    return false
  }
  const sigil = m[1]!.split(',').map((s) => s.trim())
  return sigil.includes('exclude') || sigil.some((s) => s.startsWith('!'))
}

/** Resolve bead `id` to its repo path set on `ref` — the drift
 *  engine's half of "spec vs code". `ref` resolution is the caller's
 *  (the recency probe owns the origin/HEAD → main → HEAD chain).
 *  `spec` is the serving facade; explicit scope and the spec path
 *  come from it, commits from git. */
export function resolveScope(dir: string, ref: string, id: string, spec: SpecStore): ScopeResult {
  const specPath = pickSpecPath(dir, spec.tree(), id)
  // the spec path is a filesystem path, not a user pathspec — literal
  // keeps a `specs/[id].md` name from globbing
  const exclude = specPath === undefined ? [] : [`:(exclude,literal)${specPath}`]
  const explicit = spec.scope?.(id) ?? null
  return explicit !== null && explicit.length > 0
    ? explicitScope(dir, ref, explicit, exclude)
    : commitScope(dir, ref, id, specPath, exclude)
}

/** Frontmatter scope — validated, never widened: bad entries and
 *  exclusion-only sets are unverifiable, and the match probe counts
 *  paths *after* the spec's own exclusion so `scope: <its own file>`
 *  can't pass as "covers something". */
function explicitScope(dir: string, ref: string, entries: string[], exclude: string[]): ScopeResult {
  const bad = entries.find(badScopeEntry)
  if (bad !== undefined) {
    return { state: 'unverifiable', reason: `bad scope path: ${bad}` }
  }
  if (entries.every(negativePathspec)) {
    return { state: 'unverifiable', reason: 'bad scope path: exclusion-only scope' }
  }
  // an explicit scope matching zero committed paths is a typo the
  // audit must not bless — history, not just the tree, so a scoped
  // path deleted later still resolves
  const r = gitTry(['-C', dir, 'log', '-1', '--format=%H', '--end-of-options', ref, '--', ...entries, ...exclude])
  if (r.code !== 0) {
    return { state: 'unverifiable', reason: `git log failed: ${r.err}` }
  }
  if (r.out.trim() === '') {
    return { state: 'unverifiable', reason: 'scope matches nothing' }
  }
  return { state: 'scoped', via: 'frontmatter', pathspecs: [...entries, ...exclude] }
}

/** Commit-refs fallback — the union of paths touched by commits whose
 *  subject carries `(<id>)`. A bead whose commits only ever touched its
 *  own spec file leaves nothing to audit → no-scope. */
function commitScope(dir: string, ref: string, id: string, specPath: string | undefined, exclude: string[]): ScopeResult {
  const records = gitLogPathRecords(dir, ref)
  if (records === null) {
    return { state: 'unverifiable', reason: 'git log failed' }
  }
  // `(<id>)` as a literal needle: the parens are part of the match, so
  // `(b10)` or a bare `b1` cannot satisfy bead `b1`
  const marker = `(${id})`
  const own = specPath === undefined ? undefined : `:(literal)${specPath}`
  const paths = new Set<string>()
  for (const rec of records) {
    if (!rec.subject.includes(marker)) {
      continue
    }
    for (const p of rec.paths) {
      // touched paths are exact file names, not user-written globs —
      // a literal `src/[id].ts` must not widen into a pathspec
      const lit = `:(literal)${p}`
      if (lit !== own) {
        paths.add(lit)
      }
    }
  }
  if (paths.size === 0) {
    return { state: 'no-scope' }
  }
  return { state: 'scoped', via: 'commits', pathspecs: [...paths, ...exclude] }
}

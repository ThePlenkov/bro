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
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  gitDriftRef,
  gitIsAncestor,
  gitIsShallow,
  gitLogPathRecords,
  gitLogStamp,
  gitTry,
  type GitStamp,
  type SpecNode,
  type SpecStore,
} from '@broject/core'
import { specScope } from './spec-connectors.ts'

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
 *  come from it, commits from git. `auditedSpecPath` is the path the
 *  caller actually audits (a `spec:` link can win over the tree pick)
 *  — it is the file the exclusion masks. */
export function resolveScope(dir: string, ref: string, id: string, spec: SpecStore, auditedSpecPath?: string): ScopeResult {
  const specPath = auditedSpecPath ?? pickSpecPath(dir, spec.tree(), id)
  // the spec path is a filesystem path, not a user pathspec — literal
  // keeps a `specs/[id].md` name from globbing
  const exclude = specPath === undefined ? [] : [`:(exclude,literal)${specPath}`]
  // the audited file's own declared scope — the connector's id-keyed
  // scope() can resolve a different same-id file than the one being
  // audited (a spec: link wins the audit), which would compare the
  // link's stamp against another spec's scope
  const explicit =
    specPath !== undefined ? specScope(join(dir, specPath)) : (spec.scope?.(id) ?? [])
  return explicit.length > 0
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

/** `git log` path records are a per-(dir,ref) fact — the commit-scope
 *  fallback's history scan is the run's most expensive call, so it is
 *  shared across audited beads instead of repeating per row. */
const logRecordsCache = new Map<string, ReturnType<typeof gitLogPathRecords>>()

function logPathRecords(dir: string, ref: string): ReturnType<typeof gitLogPathRecords> {
  const key = `${dir}\0${ref}`
  let r = logRecordsCache.get(key)
  if (r === undefined) {
    r = gitLogPathRecords(dir, ref)
    logRecordsCache.set(key, r)
  }
  return r
}

/** Commit-refs fallback — the union of paths touched by commits whose
 *  subject carries `(<id>)`. A bead whose commits only ever touched its
 *  own spec file leaves nothing to audit → no-scope. */
function commitScope(dir: string, ref: string, id: string, specPath: string | undefined, exclude: string[]): ScopeResult {
  const records = logPathRecords(dir, ref)
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

// --- staleness — the drift audit row ------------------------------------------

export type DriftState = 'STALE' | 'fresh' | 'no-scope' | 'unverifiable'

export interface DriftRow {
  id: string
  state: DriftState
  detail: string
}

/** Repo-level facts every drift row shares — resolved once per run, not
 *  per bead. `ref` is the comparison ref (origin/HEAD → main → HEAD;
 *  null = unborn/empty history), `shallow` the honesty gate the spec
 *  checks before any timestamp comparison (null = git failure). */
export interface DriftEnv {
  ref: string | null
  shallow: boolean | null
}

export function driftEnv(dir: string, ref?: string): DriftEnv {
  return { ref: ref ?? gitDriftRef(dir), shallow: gitIsShallow(dir) }
}

const unverifiable = (id: string, detail: string): DriftRow => ({ id, state: 'unverifiable', detail })

/** The bead's `spec:` link target when it names a repo-relative file
 *  that exists in the checkout — a local spec the drift audit can date.
 *  URLs, escapes, absolute paths, and prose mentions (`spec: linked
 *  external docs`) yield undefined: there is no local file to date
 *  (unverifiable), and the tree pick still gets its say. Trailing
 *  delimiters are stripped — the target often sits inside parentheses. */
export function specLinkPath(dir: string, desc: string | undefined): string | undefined {
  const t = /\bspec:\s*(\S+)/i.exec(desc ?? '')?.[1]?.replace(/[)\].,;:'"]+$/, '')
  if (
    t === undefined ||
    /^[a-z][a-z0-9+.-]*:/i.test(t) ||
    badScopeEntry(t) ||
    // a regular file only — a dir target would date every commit under
    // it, conflating the spec with everything it documents; lstat keeps
    // a symlink out — git dates the link entry, not its target's edits
    !existsSync(join(dir, t)) ||
    !lstatSync(join(dir, t)).isFile()
  ) {
    return undefined
  }
  // `spec: ./…` must normalize to the tracked path — git pathspecs
  // never match a leading `./`
  return t.replace(/^(?:\.[/\\])+/, '')
}

/** One drift row for bead `id` — every failure mode is a row, never a
 *  throw. Order is the spec's: shallow before any timestamp comparison,
 *  then the spec side (a spec with no local file or no landed commit
 *  can't be dated), then the scope side. `linkPath` is the bead's own
 *  `spec:` declaration resolved to a repo path — explicit wins over the
 *  tree pick. */
export function driftRow(dir: string, id: string, spec: SpecStore, env: DriftEnv, linkPath?: string): DriftRow {
  if (env.ref === null) {
    return unverifiable(id, 'unborn or empty history — no drift ref')
  }
  if (env.shallow !== false) {
    return unverifiable(id, env.shallow === true ? 'shallow history' : 'git failure')
  }
  const specPath = linkPath ?? pickSpecPath(dir, spec.tree(), id)
  if (specPath === undefined) {
    // covers the `spec:` external link — there is no local file to date
    return unverifiable(id, 'no local spec file to date')
  }
  const specStamp = gitLogStamp(dir, env.ref, [`:(literal)${specPath}`], { follow: true })
  if (specStamp.state === 'error') {
    return unverifiable(id, specStamp.err)
  }
  if (specStamp.state === 'none') {
    // uncommitted, or committed on a branch that hasn't landed on the ref
    return unverifiable(id, `no spec commit on ${env.ref}`)
  }
  const scope = resolveScope(dir, env.ref, id, spec, specPath)
  if (scope.state === 'no-scope') {
    return { id, state: 'no-scope', detail: 'no frontmatter scope, no bead-id commits' }
  }
  if (scope.state === 'unverifiable') {
    return unverifiable(id, scope.reason)
  }
  const scopeStamp = gitLogStamp(dir, env.ref, scope.pathspecs)
  if (scopeStamp.state === 'error') {
    return unverifiable(id, scopeStamp.err)
  }
  if (scopeStamp.state === 'none') {
    // resolveScope already proved the scope matches landed commits —
    // none here is a race or a git quirk, never fresh data
    return unverifiable(id, 'scope matched nothing')
  }
  return compare(id, specStamp.stamp, scopeStamp.stamp, dir)
}

/** The staleness predicate: same commit is fresh (spec and code landed
 *  together — the ideal), a strictly newer scope commit is STALE, and
 *  equal one-second committer timestamps on different SHAs resolve by
 *  ancestry — the scope commit predating the spec commit is fresh. */
function compare(id: string, spec: GitStamp, scope: GitStamp, dir: string): DriftRow {
  const detail = `spec@${spec.sha.slice(0, 8)} ${spec.iso} · scope@${scope.sha.slice(0, 8)} ${scope.iso}`
  if (spec.sha === scope.sha || scope.ts < spec.ts) {
    return { id, state: 'fresh', detail }
  }
  if (scope.ts > spec.ts) {
    return { id, state: 'STALE', detail }
  }
  const anc = gitIsAncestor(dir, scope.sha, spec.sha)
  if (anc === null) {
    return unverifiable(id, 'ancestry check failed')
  }
  return { id, state: anc ? 'fresh' : 'STALE', detail }
}

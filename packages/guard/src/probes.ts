/**
 * State probes — the live-repo predicates a guard's `when.state` names
 * (spec: specs/sessions/bro-nkn6.md). All reads are cheap and local:
 * argv-git/file stats only, memoized per event so N guards share one
 * `git status`. A read that fails marks its clause failed — a guard
 * whose condition can't be verified doesn't assert it.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { gitTry, type GuardState } from '@broject/core'
import { matchPath } from '@broject/learn'

/** One clause's verdict — `bro guard test` renders these rows. */
export interface ClauseVerdict {
  clause: string
  ok: boolean
  detail?: string
}

/** A probe's richer answer — `ok` is the verdict, `detail` the why a
 *  `bro guard test` row shows ('unverifiable: shallow history' reads
 *  very differently from 'fresh'). A bare boolean is fine when the
 *  name already says everything. */
export interface ProbeResult {
  ok: boolean
  detail?: string
}

/** Engine-registered named probes — the extensible slot for costlier
 *  predicates (spec-drift, docs freshness). Closed: a new predicate is
 *  an engine change, not config. Args are the guard's own `args` map. */
export type NamedProbe = (
  args: Record<string, unknown> | undefined,
  dir: string
) => boolean | ProbeResult

/** Live-state reads, lazy + memoized per event — an `armed`-only guard
 *  never pays for `git status`, and `changed`/`without` clauses share
 *  one porcelain call. */
export interface LiveState {
  /** Repo-relative worktree paths from `git status --porcelain` — null
   *  when git can't answer (not a repo, dead binary). */
  diffPaths(): string[] | null
  /** `git branch --show-current` — null on detached HEAD or failure. */
  branch(): string | null
  /** Gate aspects this session armed (the marker scan) — injected by
   *  the caller so probes stay free of hooks-layer imports. */
  armed(): Set<string>
  /** Repo-relative path exists — files and dirs. */
  exists(path: string): boolean
}

export function liveState(dir: string, armed?: () => Set<string>): LiveState {
  let diffCache: string[] | null | undefined
  let branchCache: string | null | undefined
  let armedCache: Set<string> | undefined
  return {
    diffPaths() {
      if (diffCache === undefined) {
        diffCache = readDiffPaths(dir)
      }
      return diffCache
    },
    branch() {
      if (branchCache === undefined) {
        const r = gitTry(['-C', dir, 'branch', '--show-current'])
        branchCache = r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null
      }
      return branchCache
    },
    armed() {
      armedCache ??= armed?.() ?? new Set<string>()
      return armedCache
    },
    exists(path) {
      // contract is repo-relative — a '../' or absolute path resolves
      // outside and would leak host filesystem state into a verdict
      const resolved = resolve(dir, path)
      const rel = relative(dir, resolved)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return false
      }
      return existsSync(resolved)
    },
  }
}

/** `git status --porcelain=v1 -z -uall` → repo-relative paths. -z
 *  avoids quote-parsing; `-uall` expands untracked dirs into files —
 *  without it `?? src/` hides that a `.test.ts` was touched, which is
 *  exactly what `without` clauses exist to see. On a rename/copy
 *  record the source path follows as the next NUL token — both sides
 *  count as touched (the old name going away IS a change). */
function readDiffPaths(dir: string): string[] | null {
  const r = gitTry(['-C', dir, 'status', '--porcelain=v1', '-z', '-uall'])
  if (r.code !== 0) {
    return null
  }
  const tokens = r.out.split('\0').filter((t) => t !== '')
  const paths: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.length < 4) {
      continue
    }
    paths.push(t.slice(3))
    if (t[0] === 'R' || t[0] === 'C' || t[1] === 'R' || t[1] === 'C') {
      // rename/copy: the next token is the source path
      const src = tokens[++i]
      if (src !== undefined) {
        paths.push(src)
      }
    }
  }
  return paths
}

/** Evaluate a `when.state` block — conjunctive across keys. Returns one
 *  verdict row per present key (the `guard test` rendering), plus the
 *  detail a miss needs to be diagnosable (the actual branch, the glob
 *  that hit, an unknown probe name). */
export function evalState(
  state: GuardState,
  dir: string,
  live: LiveState,
  probes: Record<string, NamedProbe> = {}
): ClauseVerdict[] {
  const out: ClauseVerdict[] = []
  if (state.diff !== undefined) {
    out.push(...evalDiff(state.diff, live.diffPaths()))
  }
  if (state.branch !== undefined) {
    const b = live.branch()
    const ok = b !== null && matchPath(b, state.branch)
    out.push({ clause: 'branch', ok, detail: b ?? 'no branch (detached?)' })
  }
  if (state.armed !== undefined) {
    const armed = live.armed()
    const missing = state.armed.filter((a) => !armed.has(a))
    out.push({
      clause: 'armed',
      ok: missing.length === 0,
      detail: missing.length > 0 ? `not armed: ${missing.join(',')}` : undefined,
    })
  }
  if (state.exists !== undefined) {
    const missing = state.exists.filter((p) => !live.exists(p))
    out.push({
      clause: 'exists',
      ok: missing.length === 0,
      detail: missing.length > 0 ? `missing: ${missing.join(',')}` : undefined,
    })
  }
  out.push(...evalProbes(state.probes ?? [], dir, probes))
  return out
}

/** `diff` rows — `git status` failing fails every declared diff clause
 *  (a guard whose condition can't be verified doesn't assert it). */
function evalDiff(
  diff: NonNullable<GuardState['diff']>,
  paths: string[] | null
): ClauseVerdict[] {
  const out: ClauseVerdict[] = []
  if (paths === null) {
    if (diff.changed !== undefined) {
      out.push({ clause: 'diff.changed', ok: false, detail: 'git status unavailable' })
    }
    if (diff.without !== undefined) {
      out.push({ clause: 'diff.without', ok: false, detail: 'git status unavailable' })
    }
    return out
  }
  if (diff.changed !== undefined) {
    const hit = diff.changed.find((g) => paths.some((p) => matchPath(p, g)))
    out.push({
      clause: 'diff.changed',
      ok: hit !== undefined,
      detail: hit === undefined ? `no diff path hits ${diff.changed.join(' | ')}` : hit,
    })
  }
  if (diff.without !== undefined) {
    const hit = diff.without.find((g) => paths.some((p) => matchPath(p, g)))
    out.push({
      clause: 'diff.without',
      ok: hit === undefined,
      detail: hit === undefined ? undefined : `diff touches ${hit}`,
    })
  }
  return out
}

/** `probes` rows — a throwing probe fails its clause with the error as
 *  detail; an unknown name fails closed (the registry is closed). */
function evalProbes(
  list: NonNullable<GuardState['probes']>,
  dir: string,
  probes: Record<string, NamedProbe>
): ClauseVerdict[] {
  const out: ClauseVerdict[] = []
  for (const p of list) {
    const fn = probes[p.name]
    if (fn === undefined) {
      // the registry is closed — an unknown name fails the clause and
      // shows in `bro guard test` (spec: never silently true)
      out.push({ clause: `probe:${p.name}`, ok: false, detail: 'unknown probe' })
      continue
    }
    let ok = false
    let detail: string | undefined
    try {
      const r = fn(p.args, dir)
      ok = typeof r === 'boolean' ? r : r.ok
      detail = typeof r === 'boolean' ? undefined : r.detail
    } catch (err) {
      detail = `threw: ${err instanceof Error ? err.message : err}`
    }
    out.push({ clause: `probe:${p.name}`, ok, detail })
  }
  return out
}

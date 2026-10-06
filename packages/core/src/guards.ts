/** Guard seam types — the contract `Connector.guards` speaks (spec:
 *  specs/sessions/bro-nkn6.md). Types live in core because the
 *  Connector interface owns the seam; validation and evaluation live
 *  in @broject/guard. */

/** Hook events a guard may fire on. 'session-start' covers all three
 *  rehydrate events; 'stop' contributes a passive hint, never a block. */
export const GUARD_EVENTS = ['session-start', 'prompt-submit', 'post-tool', 'stop'] as const
export type GuardEvent = (typeof GUARD_EVENTS)[number]

export const isGuardEvent = (v: unknown): v is GuardEvent =>
  typeof v === 'string' && (GUARD_EVENTS as readonly string[]).includes(v)

export const GUARD_NAME_RE = /^[\w][\w.-]*$/

/** Trace/prompt conditions — deliberately the same shape as learn's
 *  TriggerMatch (structurally interchangeable; keep the DSLs from
 *  drifting — the spec's shared-matcher argument depends on it). */
export interface GuardMatch {
  terms?: string[]
  commands?: string[]
  paths?: string[]
  tools?: string[]
  errors?: boolean
}

/** Live-state predicates — conjunctive across keys. */
export interface GuardState {
  /** Worktree diff globs: `changed` needs ≥1 hit, `without` needs zero. */
  diff?: { changed?: string[]; without?: string[] }
  /** Glob vs `git branch --show-current`. */
  branch?: string
  /** Gate aspects this session armed — all must hold. */
  armed?: string[]
  /** Repo-relative paths that must exist. */
  exists?: string[]
  /** Engine-registered named probes — unknown names fail the clause. */
  probes?: { name: string; args?: Record<string, unknown> }[]
}

/** Judge veto clause — one noul question; can only suppress, abstains
 *  when the judge is off/unavailable/low-confidence. */
export interface GuardJudge {
  question: string
  threshold?: number
}

export interface GuardWhen {
  on: GuardEvent[]
  match?: GuardMatch
  state?: GuardState
  judge?: GuardJudge
  /** Max fires per session, default 1 — the lesson budget semantics. */
  budget?: number
}

/** A declarative prompt contribution — pure data, no run, no side
 *  effect; the engine evaluates `when` and injects `say`. */
export interface Guard {
  name: string
  when: GuardWhen
  say: string
}

/** `say` render bounds — a guard is a pointer to policy, not a doc. */
export const GUARD_SAY_MAX_CHARS = 2_000
export const GUARD_SAY_MAX_LINES = 20
export const GUARD_DEFAULT_BUDGET = 1

const isStrList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '')

/** Validate a guard declaration — returns the problems, empty = valid.
 *  Two faces per the learn convention: config defs fail closed (dropped
 *  with a warning), connector contributions fail open (skipped). */
export function guardProblems(v: unknown): string[] {
  const problems: string[] = []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return ['not an object']
  }
  const g = v as { name?: unknown; when?: unknown; say?: unknown }
  if (typeof g.name !== 'string' || !GUARD_NAME_RE.test(g.name)) {
    problems.push('name must match /\\w[\\w.-]*/')
  }
  if (typeof g.say !== 'string' || g.say.trim() === '') {
    problems.push('say must be a non-empty string')
  }
  if (typeof g.when !== 'object' || g.when === null || Array.isArray(g.when)) {
    problems.push('when must be an object')
    return problems
  }
  const w = g.when as Record<string, unknown>
  if (!Array.isArray(w.on) || w.on.length === 0) {
    problems.push('when.on must name ≥1 event')
  } else {
    const bad = w.on.filter((e) => !isGuardEvent(e))
    if (bad.length > 0) {
      problems.push(`when.on has unknown event(s) ${JSON.stringify(bad)} — expected ${GUARD_EVENTS.join('|')}`)
    }
  }
  if (w.match !== undefined) {
    if (typeof w.match !== 'object' || w.match === null || Array.isArray(w.match)) {
      problems.push('when.match must be an object')
    } else {
      const m = w.match as Record<string, unknown>
      for (const k of ['terms', 'commands', 'paths', 'tools'] as const) {
        if (m[k] !== undefined && !isStrList(m[k])) {
          problems.push(`when.match.${k} must be a non-empty-string list`)
        }
      }
      if (m.errors !== undefined && typeof m.errors !== 'boolean') {
        problems.push('when.match.errors must be a boolean')
      }
    }
  }
  if (w.state !== undefined) {
    problems.push(...stateProblems(w.state))
  }
  if (w.judge !== undefined) {
    const j = w.judge as Record<string, unknown>
    if (typeof j !== 'object' || j === null || typeof j.question !== 'string' || j.question === '') {
      problems.push('when.judge.question must be a non-empty string')
    } else if (j.threshold !== undefined && (typeof j.threshold !== 'number' || j.threshold < 0 || j.threshold > 1)) {
      problems.push('when.judge.threshold must be a number in [0,1]')
    }
  }
  if (w.budget !== undefined && (typeof w.budget !== 'number' || !Number.isInteger(w.budget) || w.budget < 1)) {
    problems.push('when.budget must be an integer ≥1')
  }
  return problems
}

function stateProblems(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return ['when.state must be an object']
  }
  const s = v as Record<string, unknown>
  const out: string[] = []
  if (s.diff !== undefined) {
    const d = s.diff as Record<string, unknown>
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      out.push('when.state.diff must be an object')
    } else {
      for (const k of ['changed', 'without'] as const) {
        if (d[k] !== undefined && !isStrList(d[k])) {
          out.push(`when.state.diff.${k} must be a non-empty-string list`)
        }
      }
    }
  }
  if (s.branch !== undefined && (typeof s.branch !== 'string' || s.branch === '')) {
    out.push('when.state.branch must be a non-empty glob string')
  }
  if (s.armed !== undefined && !isStrList(s.armed)) {
    out.push('when.state.armed must be a non-empty-string list')
  }
  if (s.exists !== undefined && !isStrList(s.exists)) {
    out.push('when.state.exists must be a non-empty-string list')
  }
  if (s.probes !== undefined) {
    if (!Array.isArray(s.probes)) {
      out.push('when.state.probes must be a list')
    } else {
      s.probes.forEach((p, i) => {
        const probe = p as Record<string, unknown>
        if (typeof probe !== 'object' || probe === null || typeof probe.name !== 'string' || probe.name === '') {
          out.push(`when.state.probes[${i}] must name a probe`)
        }
      })
    }
  }
  return out
}

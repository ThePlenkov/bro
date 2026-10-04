/**
 * Lesson schema — the durable unit of `bro learn` (spec:
 * specs/sessions/bro-f4ot.1-learn.md). A lesson is a rule plus the
 * declarative trigger that decides when it surfaces; it is not a bead
 * and not a `bd remember` memory — memories inject unconditionally,
 * lessons exist to be trigger-gated.
 *
 * Validation has two faces: the write path (CLI add/capture) fails
 * closed on problems, the read path (store enumeration) fails open —
 * a kv entry that fails the schema is skipped with a warn line, never
 * a crash, so lessons written by a newer bro must not wedge an older
 * one.
 */

export const HOOK_EVENTS = ['session-start', 'prompt-submit', 'post-tool'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export const CONFIDENCES = ['tentative', 'established', 'proven'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export const LESSON_SOURCES = [
  'manual',
  'capture:drill',
  'capture:retro',
  'capture:act',
  'capture:mol',
  'probe',
] as const
export type LessonSource = (typeof LESSON_SOURCES)[number]

export const EVIDENCE_KINDS = ['bead', 'pr', 'session', 'command', 'text'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface Evidence {
  kind: EvidenceKind
  /** bead id, PR url, session id, or literal text */
  ref: string
}

export interface TriggerMatch {
  /** substring, case-insensitive — vs prompt text, claimed-bead
   *  titles/labels, trace lines */
  terms?: string[]
  /** prefixes vs exec commands in the session trace */
  commands?: string[]
  /** globs vs paths touched in the trace / worktree */
  paths?: string[]
  /** tool names in the trace ('exec', 'edit', 'write') */
  tools?: string[]
  /** trace shows ≥1 failed tool landing this session */
  errors?: boolean
}

export interface LessonTrigger {
  /** Hook events the lesson may fire on — at least one. */
  on: HookEvent[]
  /** Conjunctive across keys, disjunctive within a list: every present
   *  key must hit, any list entry satisfies its key. */
  match?: TriggerMatch
  /** Max fires per session (default 1) — a post-tool lesson must not
   *  nudge on every tool landing. */
  budget?: number
}

export interface Lesson {
  /** `learn-<slug>` — stable, dedup key */
  id: string
  trigger: LessonTrigger
  /** the rule — imperative, quotable as one line */
  lesson: string
  /** where it was learned — never empty */
  evidence: Evidence[]
  confidence: Confidence
  source: LessonSource
  /** ISO timestamp */
  createdAt: string
  updatedAt?: string
  /** bead/PR ref once graduated to a rule edit */
  promotedTo?: string
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function stringList(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => isNonEmptyStr(s))
}

/**
 * Schema check — returns the list of problems, empty when valid.
 * Shared by the write path (fail closed) and the read path (fail open:
 * a non-empty result means "skip this entry, warn, keep going").
 */
export function lessonProblems(v: unknown): string[] {
  const problems: string[] = []
  if (!isObj(v)) {
    return ['not an object']
  }
  if (!isNonEmptyStr(v.id) || !v.id.startsWith('learn-')) {
    problems.push('id must be a non-empty "learn-<slug>" string')
  }
  if (!isNonEmptyStr(v.lesson)) {
    problems.push('lesson must be a non-empty string')
  }
  const t = v.trigger
  if (!isObj(t)) {
    problems.push('trigger must be an object')
  } else {
    if (
      !Array.isArray(t.on) ||
      t.on.length === 0 ||
      !t.on.every((e) => (HOOK_EVENTS as readonly string[]).includes(e as string))
    ) {
      problems.push(`trigger.on must be a non-empty list of: ${HOOK_EVENTS.join(', ')}`)
    }
    if (t.match !== undefined) {
      if (!isObj(t.match)) {
        problems.push('trigger.match must be an object')
      } else {
        for (const key of ['terms', 'commands', 'paths', 'tools'] as const) {
          if (t.match[key] !== undefined && !stringList(t.match[key])) {
            problems.push(`trigger.match.${key} must be a list of non-empty strings`)
          }
        }
        if (t.match.errors !== undefined && typeof t.match.errors !== 'boolean') {
          problems.push('trigger.match.errors must be a boolean')
        }
      }
    }
    if (
      t.budget !== undefined &&
      (typeof t.budget !== 'number' || !Number.isInteger(t.budget) || t.budget < 1)
    ) {
      problems.push('trigger.budget must be a positive integer')
    }
  }
  if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
    problems.push('evidence must be a non-empty list')
  } else {
    for (const e of v.evidence) {
      if (
        !isObj(e) ||
        !(EVIDENCE_KINDS as readonly string[]).includes(e.kind as string) ||
        !isNonEmptyStr(e.ref)
      ) {
        problems.push(`evidence items must be {kind: ${EVIDENCE_KINDS.join('|')}, ref: string}`)
        break
      }
    }
  }
  if (!(CONFIDENCES as readonly string[]).includes(v.confidence as string)) {
    problems.push(`confidence must be one of: ${CONFIDENCES.join(', ')}`)
  }
  if (!(LESSON_SOURCES as readonly string[]).includes(v.source as string)) {
    problems.push(`source must be one of: ${LESSON_SOURCES.join(', ')}`)
  }
  if (!isNonEmptyStr(v.createdAt)) {
    problems.push('createdAt must be an ISO timestamp string')
  }
  if (v.updatedAt !== undefined && !isNonEmptyStr(v.updatedAt)) {
    problems.push('updatedAt must be a string when present')
  }
  if (v.promotedTo !== undefined && !isNonEmptyStr(v.promotedTo)) {
    problems.push('promotedTo must be a string when present')
  }
  return problems
}

/** Type-guard form of {@link lessonProblems}. */
export function isLesson(v: unknown): v is Lesson {
  return lessonProblems(v).length === 0
}

/**
 * Confidence ladder, v1 — promotes on evidence count alone and never
 * blocks on the ladder. 'proven' is earned by re-injection (v2 matcher
 * hit/outcome pairs); nothing here assigns it.
 *
 *   tentative    — one evidence item, unverified
 *   established  — ≥2 independent evidences, or one that already held
 *                  under a real gate (merged green, closed retro)
 */
export function deriveConfidence(
  evidence: Evidence[],
  opts: { heldUnderGate?: boolean } = {}
): Confidence {
  const independent = new Set(evidence.map((e) => `${e.kind}:${e.ref}`)).size
  if (independent >= 2 || (independent === 1 && opts.heldUnderGate === true)) {
    return 'established'
  }
  return 'tentative'
}

/** join('-') emits single dashes only — the slice can leave at most one
 *  trailing '-', so no trailing-repeat regex is needed (CodeQL: a
 *  `+-quantified` pattern on uncontrolled input is a polynomial-regex
 *  finding). */
const slugify = (s: string): string => {
  const slug = (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-').slice(0, 40)
  return slug.endsWith('-') ? slug.slice(0, -1) : slug
}

/**
 * Lesson id from its rule text — `learn-<slug>`, stable so the same
 * rule lands on the same key (the dedup property the schema documents).
 * Collision handling is the caller's: `add` refuses an existing id.
 */
export function lessonId(text: string): string {
  return `learn-${slugify(text) || 'lesson'}`
}

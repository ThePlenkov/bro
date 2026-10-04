/**
 * Probe — proactive knowledge acquisition (spec §Probe,
 * specs/sessions/bro-f4ot.1-learn.md). Two phases under one verb:
 *
 *   phase 1  store-first query — rank stored lessons against the
 *            question's terms; a hit short-circuits (the knowledge was
 *            already paid for). On a miss the caller gets gathered
 *            candidates — trace/store context the matcher can offer
 *            cheaply — and the question is logged to the fired set as
 *            an open gap.
 *   phase 2  recordProbeAnswer stores the session-distilled answer as a
 *            `source: probe` lesson, auto-recording {kind:'session',
 *            ref:<probe session>} plus the question as evidence — one
 *            investigation's output becomes the next session's
 *            trigger-indexed knowledge.
 *
 * A probe runs as a plain CLI call — no hook payload carries the firing
 * session, so the sid resolves from --session, else the newest live
 * marker session in this repo (the session that spawned the probe is
 * almost always the freshest live one), else 'cli'. No env-var lookup —
 * the sid lands in stored evidence and probe output, and a
 * process-environment source there reads as credential leakage to
 * scanners for zero gain over the explicit flag.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitTry, markerLive, taskStore, withFileLock } from '@broject/core'
import {
  applyCapture,
  planCapture,
  TERM_RE,
  TERM_STOPWORDS,
  type CaptureCandidate,
} from './capture.ts'
import {
  lessonId,
  type Evidence,
  type Lesson,
  type LessonTrigger,
} from './lesson.ts'
import { listLessons, LessonStoreError, withStoreLock, type SkippedEntry } from './store.ts'

/** "Live" for marker sessions — the same day-window the parallel-work
 *  nudge and the connector's previous-trace exclusion use. */
const LIVE_SESSION_MS = 24 * 60 * 60 * 1000

/** Ranked hits/candidates caps — probe output is a shortlist, not a
 *  dump. */
const HIT_CAP = 5
const CANDIDATE_CAP = 8
const TERM_CAP = 8
const TRACE_TAIL_LINES = 100

const safeId = (s: string): string => s.replace(/[^\w.-]/g, '_')
const oneLine = (s: string): string => s.trim().replace(/\s+/g, ' ')

/** `<git-common>/bro/hooks` — the dir the fired set and trace journal
 *  already live under. null outside a repo. Same resolution as the
 *  connector's. */
function hooksDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
  if (r.code !== 0 || r.out.trim() === '') {
    return null
  }
  return join(resolve(dir, r.out.trim()), 'bro', 'hooks')
}

/** Significant terms of a question — the same vocabulary capture uses
 *  for trigger terms, capped a little higher because a query is longer
 *  than a title. */
export function probeTerms(question: string): string[] {
  const out: string[] = []
  for (const m of question.toLowerCase().matchAll(TERM_RE)) {
    if (TERM_STOPWORDS.has(m[0]) || out.includes(m[0])) {
      continue
    }
    out.push(m[0])
    if (out.length >= TERM_CAP) {
      break
    }
  }
  return out
}

/**
 * The session a bare `bro learn probe` runs inside. An explicit
 * --session wins; else the newest *live* marker in the repo's hooks dir
 * names it (marker aspect sits after the last '.' — session ids may
 * carry dots); else 'cli'. Returns a real session when one can be
 * proven, never a guessed dead one.
 */
export function resolveSessionId(dir: string, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit.trim()
  }
  const hooks = hooksDir(dir)
  if (hooks === null) {
    return 'cli'
  }
  const now = Date.now()
  let best: { sid: string; mtime: number } | null = null
  try {
    for (const f of readdirSync(hooks)) {
      const dot = f.lastIndexOf('.')
      if (dot <= 0) {
        continue
      }
      try {
        const p = join(hooks, f)
        const st = statSync(p)
        if (!st.isFile()) {
          continue
        }
        const first = readFileSync(p, 'utf8').split('\n', 1)[0]
        if (!markerLive(first, st.mtimeMs, LIVE_SESSION_MS, now)) {
          continue
        }
        if (best === null || st.mtimeMs > best.mtime) {
          best = { sid: f.slice(0, dot), mtime: st.mtimeMs }
        }
      } catch {
        // unreadable marker — skip
      }
    }
  } catch {
    // no marker dir — no live session provable
  }
  return best?.sid ?? 'cli'
}

/** The haystack a question term is looked up in — the rule plus every
 *  match value, so "what happens after gh pr merge" hits a lesson whose
 *  trigger carries the command even though a question has no trace. */
function lessonHaystack(l: Lesson): string {
  const m = l.trigger.match ?? {}
  return [
    l.lesson,
    ...(m.terms ?? []),
    ...(m.commands ?? []),
    ...(m.paths ?? []),
    ...(m.tools ?? []),
  ]
    .join(' ')
    .toLowerCase()
}

export interface ProbeHit {
  lesson: Lesson
  /** distinct question terms found in the lesson's haystack */
  score: number
}

/** Rank lessons by distinct question-term coverage; ties break on the
 *  confidence ladder, then id — deterministic for the same store. */
export function rankLessons(question: string, lessons: Lesson[]): ProbeHit[] {
  const terms = probeTerms(question)
  if (terms.length === 0) {
    return []
  }
  const hits: ProbeHit[] = []
  for (const l of lessons) {
    const hay = lessonHaystack(l)
    const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
    if (score > 0) {
      hits.push({ lesson: l, score })
    }
  }
  const conf: Record<Lesson['confidence'], number> = {
    tentative: 0,
    established: 1,
    proven: 2,
  }
  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      conf[b.lesson.confidence] - conf[a.lesson.confidence] ||
      a.lesson.id.localeCompare(b.lesson.id)
  )
}

/** Trace lines worth investigating — journal entries whose command or
 *  touched paths carry a question term. The probing session's own
 *  journal first; when it hasn't journaled yet (fresh session, or a
 *  'cli' probe) the newest trace file on disk is the fallback. */
function traceCandidates(
  hooks: string,
  sid: string,
  terms: string[],
  cap: number
): string[] {
  const dir = join(hooks, 'trace')
  let file = join(dir, `${safeId(sid)}.jsonl`)
  try {
    if (!existsSync(file)) {
      let best: { path: string; mtime: number } | null = null
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) {
          continue
        }
        const p = join(dir, f)
        const mtime = statSync(p).mtimeMs
        if (best === null || mtime > best.mtime) {
          best = { path: p, mtime }
        }
      }
      if (best === null) {
        return []
      }
      file = best.path
    }
    const out: string[] = []
    for (const line of readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-TRACE_TAIL_LINES)) {
      const low = line.toLowerCase()
      if (!terms.some((t) => low.includes(t))) {
        continue
      }
      // keep the raw command/paths, not the JSON — a candidate the agent
      // can rerun or open, not a serialization it has to parse
      let what = line
      try {
        const e = JSON.parse(line) as { command?: unknown; paths?: unknown }
        if (typeof e.command === 'string' && e.command !== '') {
          what = e.command
        } else if (Array.isArray(e.paths) && e.paths.length > 0) {
          what = e.paths.filter((p): p is string => typeof p === 'string').join(' ')
        }
      } catch {
        // torn line — keep raw
      }
      const flat = oneLine(what)
      if (flat !== '' && !out.includes(flat)) {
        out.push(flat)
      }
      if (out.length >= cap) {
        break
      }
    }
    return out.map((c) => `trace: ${c}`)
  } catch {
    return [] // no trace dir yet — no candidates
  }
}

/** In-progress beads whose title carries a question term — a live bead
 *  may already hold the answer. */
function beadCandidates(dir: string, terms: string[], cap: number): string[] {
  try {
    const out: string[] = []
    for (const row of taskStore(dir).list({ status: 'in_progress' })) {
      const title = `${row.id} ${row.title ?? ''}`.trim()
      if (terms.some((t) => title.toLowerCase().includes(t))) {
        out.push(`bead: ${title}`)
      }
      if (out.length >= cap) {
        break
      }
    }
    return out
  } catch {
    return [] // a dead task store degrades candidates, never the probe
  }
}

/** Append `gap: <question>` to the session's fired file — the open-gap
 *  record the spec describes. Idempotent per session+question; a
 *  `gap:` line never equals a lesson id, so budget counting is inert.
 *  Best-effort like every fired-set write: a lost gap line costs
 *  observability, never correctness. */
function logGap(hooks: string, sid: string, question: string): boolean {
  const line = `gap:${question}`
  try {
    const dir = join(hooks, 'fired')
    const path = join(dir, safeId(sid) || 'cli')
    const run = (): boolean => {
      try {
        if (readFileSync(path, 'utf8').split('\n').includes(line)) {
          return false
        }
      } catch {
        // no fired file yet
      }
      appendFileSync(path, `${line}\n`)
      return true
    }
    mkdirSync(dir, { recursive: true })
    // count-check-append is one critical section, same as the
    // connector's fired-set write — two parallel probes must not
    // double-log one question
    try {
      return withFileLock(`${path}.lock`, run, {
        waitMs: 2_000,
        label: 'learn gap lock',
      })
    } catch {
      return run()
    }
  } catch {
    return false
  }
}

export interface ProbeQuery {
  question: string
  hits: ProbeHit[]
  /** cheap investigation context — only gathered on a miss */
  candidates: string[]
  sessionId: string
  /** the question landed in the fired set as an open gap */
  gapLogged: boolean
  /** corrupt kv entries encountered while reading the store */
  skipped: SkippedEntry[]
}

export interface ProbeQueryOptions {
  dir?: string
  sessionId?: string
  /** max ranked hits returned (default HIT_CAP) */
  limit?: number
}

/**
 * Phase 1 — the store-first query. Hits are ranked and returned; on a
 * miss the question is logged as an open gap and candidates are gathered
 * (the probing session's trace lines plus live beads carrying a term).
 * Schema-broken kv entries land in `skipped`; a store error propagates
 * (the caller can't probe a store it can't read).
 */
export function probeQuestion(question: string, opts: ProbeQueryOptions = {}): ProbeQuery {
  const dir = opts.dir ?? process.cwd()
  const sid = resolveSessionId(dir, opts.sessionId)
  const q = oneLine(question)
  const { lessons, skipped } = listLessons(dir)
  const hits = rankLessons(q, lessons).slice(0, opts.limit ?? HIT_CAP)
  if (hits.length > 0) {
    return { question: q, hits, candidates: [], sessionId: sid, gapLogged: false, skipped }
  }
  const hooks = hooksDir(dir)
  const terms = probeTerms(q)
  const candidates = [
    ...(hooks !== null ? traceCandidates(hooks, sid, terms, CANDIDATE_CAP) : []),
    ...beadCandidates(dir, terms, CANDIDATE_CAP),
  ].slice(0, CANDIDATE_CAP)
  const gapLogged = hooks !== null && q !== '' && logGap(hooks, sid, q)
  return { question: q, hits, candidates, sessionId: sid, gapLogged, skipped }
}

export interface RecordProbeOptions {
  /** the question that was probed — recorded as {kind:'text'} evidence */
  question: string
  /** the distilled answer — the rule, imperative, quotable as one line */
  lesson: string
  /** explicit trigger from CLI flags; when absent the caller derives
   *  one from the question's terms (the question IS the index) */
  trigger: LessonTrigger
  /** extra citations beyond the auto-recorded session+question */
  evidence?: Evidence[]
  dir?: string
  sessionId?: string
}

export interface RecordProbeResult {
  lesson: Lesson
  /** true when the answer folded into an existing lesson's evidence */
  merged: boolean
}

/**
 * Phase 2 — store the distilled answer as a `source: probe` lesson.
 * Evidence auto-records the probe session and the question itself;
 * dedup rides capture's plan/apply machine — same normalized rule text
 * merges evidence and recomputes confidence, a corrupt key or a
 * different rule on the same id throws rather than overwrite.
 */
export function recordProbeAnswer(opts: RecordProbeOptions): RecordProbeResult {
  const dir = opts.dir ?? process.cwd()
  const sid = resolveSessionId(dir, opts.sessionId)
  const question = oneLine(opts.question)
  const lesson = oneLine(opts.lesson)
  if (lesson === '') {
    throw new LessonStoreError('probe --lesson requires a non-empty answer')
  }
  const evidence: Evidence[] = [
    { kind: 'session', ref: sid },
    ...(question !== '' ? [{ kind: 'text' as const, ref: question }] : []),
    ...(opts.evidence ?? []),
  ]
  const candidate: CaptureCandidate = {
    lesson,
    trigger: opts.trigger,
    evidence,
    source: 'probe',
    origin: `probe:${question !== '' ? question : sid}`,
  }
  // plan→apply is one critical section — the store lock keeps a
  // concurrent probe/capture from overwriting this write's merged
  // evidence between the plan's read and apply's write
  const plan = withStoreLock(dir, () => {
    const p = planCapture([candidate], dir)
    if (p.skipped.length > 0) {
      const s = p.skipped[0]!
      throw new LessonStoreError(`${s.reason} — the answer was not stored`)
    }
    applyCapture(p, dir)
    return p
  })
  const written = plan.write[0]?.lesson ?? plan.merge[0]?.lesson
  if (written === undefined) {
    // nothing written and nothing merged: the same probe evidence was
    // already folded in — report the stored lesson as-is
    const existing = listLessons(dir).lessons.find((l) => l.id === lessonId(lesson))
    if (existing === undefined) {
      throw new LessonStoreError('probe answer produced no store write')
    }
    return { lesson: existing, merged: true }
  }
  return { lesson: written, merged: plan.merge.length > 0 }
}

/** The default trigger for a probe answer — the question's terms index
 *  it for session-start/prompt-submit, where a repeat of the question
 *  is exactly what should fire it. Explicit --on/--match-* flags
 *  override at the CLI layer. */
export function probeTrigger(question: string): LessonTrigger | undefined {
  const terms = probeTerms(question)
  if (terms.length === 0) {
    return undefined
  }
  return { on: ['session-start', 'prompt-submit'], match: { terms } }
}

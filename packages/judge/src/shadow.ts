/**
 * Shadow mode — verdicts annotate and journal, they never act (spec:
 * specs/sessions/bro-f4ot.2-judge.md §first consumer). `bro act
 * threads` and the drive fixer prompt render judge answers beside each
 * unresolved thread when `judge.mode: shadow`; resolution, the exit
 * gate, and fixer spawns stay exactly as deterministic as today.
 *
 * Cost discipline is the call site's: a subject whose
 * (threadId, commentSha, headSha) already has a verdict in the journal
 * is re-read, never re-judged; fresh decide() calls are bounded by
 * `judge.maxDecisionsPerRun` per command invocation.
 */
import { JudgeUnavailable } from '@broject/core'
import type {
  DecideResult,
  JudgeFacade,
  JudgeQuestion,
  ReviewThread,
  Verdict,
} from '@broject/core'
import {
  appendRow,
  findVerdict,
  readJournal,
  threadSubject,
} from './journal.ts'

/** The v1 act-triage question set — `action`'s option space IS the act
 *  plan's verdict space so agreement is measurable against the
 *  recorded outcome (`resolve` covers fix-then-resolve and
 *  invalid-finding-resolve; the disposition record distinguishes). */
export const ACT_THREAD_QUESTIONS: Record<string, JudgeQuestion> = {
  blocks_correctness: {
    type: 'noul',
    instructions:
      'Does this review thread report an issue that must be fixed before merge for correctness or security reasons?',
    criteria: {
      true: 'Merging without addressing it risks a real bug, regression, or vulnerability.',
      false: 'Style, docs, naming, optional refactor, or nit — safe to merge without a fix.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'Rate this review finding on the ordered severity scale.',
    criteria: [
      'cosmetic — style, docs, naming; no behavior impact',
      'minor — real but small; debt material, not merge-blocking',
      'should-fix — worth fixing before merge, not a production risk if deferred',
      'blocking — correctness or security; must not merge as-is',
    ],
  },
  action: {
    type: 'choice',
    instructions: 'What should the owning agent do with this review thread?',
    criteria: {
      resolve: 'Fix the finding in code, or resolve it as invalid — the thread is done.',
      reply: 'Answer substantively — the finding needs discussion or a rebuttal, not a code change.',
      defer: 'Real but non-blocking — file a debt bead with the thread as external ref and resolve as deferred.',
    },
  },
}

/** Severity level names for rendering — the wire scale is 0..N-1
 *  (0 = first/lowest level), so the rounded score IS the index:
 *  `2.8` on the 4-level scale rounds to level 3, `blocking`. */
const SEVERITY_LABELS = ['cosmetic', 'minor', 'should-fix', 'blocking']

/** The decide() state for one thread — the compact payload the backend
 *  sees; the first comment is the finding, `outdated` says the diff
 *  already moved past it. */
export function threadState(thread: ReviewThread): Record<string, unknown> {
  const c = thread.comment
  return {
    path: c?.path ?? null,
    line: c?.line ?? null,
    author: c?.author ?? null,
    bot: c?.bot ?? null,
    outdated: thread.outdated,
    body: c?.body ?? '',
  }
}

/** The annotation line — `judge: blocks_correctness 0.91 · severity
 *  2.8/4 (should-fix) · action resolve — decided by jev-1.13.0 (240ms,
 *  $0.0009)`. Answers still under the confidence threshold render a
 *  `· low: <keys>` tail — dimmed, never auto-trusted. */
export function formatAnnotation(v: Verdict): string {
  const parts: string[] = []
  const bc = v.answers.blocks_correctness
  if (bc?.type === 'noul') {
    parts.push(`blocks_correctness ${bc.noul.toFixed(2)}`)
  }
  const sev = v.answers.severity
  if (sev?.type === 'score') {
    const levels = SEVERITY_LABELS.length
    const label =
      SEVERITY_LABELS[Math.min(levels - 1, Math.max(0, Math.round(sev.score)))]!
    parts.push(`severity ${sev.score.toFixed(1)}/${levels} (${label})`)
  }
  const act = v.answers.action
  if (act?.type === 'choice') {
    parts.push(`action ${act.choice}`)
  }
  // question ids beyond the v1 set render generically — the annotation
  // survives a question-set change without a renderer change
  for (const [k, a] of Object.entries(v.answers)) {
    if (k === 'blocks_correctness' || k === 'severity' || k === 'action') {
      continue
    }
    parts.push(
      a.type === 'noul'
        ? `${k} ${a.noul.toFixed(2)}`
        : a.type === 'score'
          ? `${k} ${a.score.toFixed(1)}`
          : `${k} ${a.choice}`
    )
  }
  const cost = v.costUsd !== undefined ? `, $${v.costUsd}` : ''
  const low =
    v.lowConfidence !== undefined && v.lowConfidence.length > 0
      ? ` · low: ${v.lowConfidence.join(',')}`
      : ''
  return `judge: ${parts.join(' · ')} — decided by ${v.model} (${v.latencyMs}ms${cost})${low}`
}

export interface AnnotateOpts {
  /** Working dir — locates the shared journal via the common git dir. */
  dir: string
  /** Subject context stamped on fresh verdicts. */
  pr?: number
  headSha?: string
  /** The resolved judge facade — callers pass the chained
   *  `judgeFacade()`; tests inject fakes. */
  judge: JudgeFacade
  /** Fresh decide() calls this run may pay for — re-reads are free.
   *  Defaults to 50 (`judge.maxDecisionsPerRun`). */
  budget?: number
  /** Wall-clock ceiling for fresh calls — workers stop picking up new
   *  threads once it passes (in-flight decides still land). Keeps an
   *  interactive listing from stalling behind a slow-but-alive backend. */
  deadlineMs?: number
}

export interface AnnotateResult {
  /** threadId → rendered annotation line. */
  annotations: Map<string, string>
  /** Fresh decide() attempts this run — the cost signal a caller
   *  logs when it wants spend visible; attempts count against the
   *  budget, a failed call paid its timeout too. */
  decided: number
  /** Threads with no verdict at the end — budget spent, backend down,
   *  or a per-thread failure. */
  unjudged: number
}

/** In-flight decide() ceiling — enough parallelism that a healthy
 *  backend annotates a full budget in seconds instead of a ~150s
 *  sequential stall, small enough not to hammer it. */
const ANNOTATION_CONCURRENCY = 4

type PendingItem = { thread: ReviewThread; subject: Verdict['subject'] }

/** Bound an in-flight call by the remaining listing deadline —
 *  judge.timeoutMs can exceed it, so a decide started at deadline-ε
 *  would otherwise run past the listing's ceiling. The raced-off
 *  promise keeps running to completion but is muted — its late
 *  rejection must never surface as unhandled. */
function boundedBy<T>(call: Promise<T>, deadline?: number): Promise<T> {
  if (deadline === undefined) {
    return call
  }
  call.catch(() => {})
  const left = deadline - Date.now()
  if (left <= 0) {
    return Promise.reject(new Error('listing deadline'))
  }
  return Promise.race([
    call,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('listing deadline')), left).unref()
    ),
  ])
}

/** Judge every unresolved thread once — dedup re-reads first, fresh
 *  decide() calls bounded by `budget` and optional `deadlineMs`
 *  (attempts count, not just
 *  successes — a failed call still spent its timeout), everything
 *  journaled. A wedged backend (JudgeUnavailable) stops the workers
 *  fast rather than burning a timeout per thread; a per-thread failure
 *  skips that thread only. Rendered output is annotation — it is never
 *  applied to any gate. */
export async function annotateThreads(
  threads: ReviewThread[],
  opts: AnnotateOpts
): Promise<AnnotateResult> {
  const budget = opts.budget ?? 50
  const rows = readJournal(opts.dir)
  const annotations = new Map<string, string>()
  const pending: PendingItem[] = []
  for (const thread of threads) {
    if (thread.resolved) {
      continue
    }
    const subject = threadSubject(opts.pr, thread.id, thread.comment, opts.headSha)
    // an unresolved headSha loosens the dedup key — a cached verdict
    // could be from a different head entirely, so a moved head would be
    // served the old verdict; no headSha → no reuse, judge fresh
    const cached =
      opts.headSha === undefined
        ? undefined
        : findVerdict(rows, {
            threadId: thread.id,
            commentSha: subject.commentSha,
            headSha: opts.headSha,
          })
    if (cached !== undefined) {
      annotations.set(thread.id, formatAnnotation(cached))
    } else {
      pending.push({ thread, subject })
    }
  }
  const deadline =
    opts.deadlineMs !== undefined ? Date.now() + opts.deadlineMs : undefined
  let decided = 0
  let judged = 0
  let i = 0
  let dead = false
  /** Build + journal + annotate a verdict for one pending item — shared
   *  by the in-time path and the late-answer harvest below. */
  const record = (item: PendingItem, res: DecideResult): void => {
    const verdict: Verdict = {
      ts: new Date().toISOString(),
      kind: 'act-thread',
      subject: item.subject,
      questions: ACT_THREAD_QUESTIONS,
      answers: res.answers,
      model: res.model,
      latencyMs: res.latencyMs,
      ...(res.usage?.costUsd !== undefined ? { costUsd: res.usage.costUsd } : {}),
      ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
    }
    appendRow(opts.dir, verdict)
    rows.push(verdict)
    annotations.set(item.thread.id, formatAnnotation(verdict))
  }
  const worker = async (): Promise<void> => {
    while (
      !dead &&
      i < pending.length &&
      (deadline === undefined || Date.now() < deadline)
    ) {
      const item = pending[i]!
      i += 1
      if (decided >= budget) {
        continue
      }
      decided += 1 // an attempt consumes budget — it paid its timeout either way
      const call = opts.judge.decide(threadState(item.thread), ACT_THREAD_QUESTIONS)
      // the listing deadline can beat a call the provider still answers
      // — harvest the late verdict into the journal so the next run
      // re-reads it instead of re-paying the same decide
      let abandoned = false
      call.then(
        (late) => {
          if (abandoned) {
            try {
              record(item, late)
            } catch {
              // a journal failure on a background harvest is silent —
              // the next listing just re-decides
            }
          }
        },
        () => {}
      )
      let res
      try {
        res = await boundedBy(call, deadline)
      } catch (err) {
        abandoned = true
        // a dead backend ends the loop — re-asking every thread burns
        // one timeout each and buys nothing (fail-open per contract).
        // Set-only: an ordinary error must never clear a dead flag
        // another worker already raised
        if (err instanceof JudgeUnavailable) {
          dead = true
        }
        continue
      }
      judged += 1
      record(item, res)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ANNOTATION_CONCURRENCY, pending.length) }, worker)
  )
  return { annotations, decided, unjudged: pending.length - judged }
}

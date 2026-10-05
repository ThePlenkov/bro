/**
 * The typed answer contract — choice/score/noul validated against the
 * asked questions (wire contract: specs/sessions/bro-f4ot.2-judge.md).
 * Shared by the bindings whose wire already speaks typed judgments —
 * systemone natively, acp on a systemone-family model. `backend` is
 * the label error messages name; `by` is the provenance stamp each
 * mapped answer carries.
 */
import { JudgeUnavailable } from '@broject/core'
import type { JudgeAnswer, JudgeQuestion } from '@broject/core'
import { clamp01, isNum, isProbs } from './http.ts'

interface RawAnswer {
  type?: unknown
  choice?: unknown
  score?: unknown
  noul?: unknown
  confidence?: unknown
  probabilities?: unknown
}

/** A probs map whose keys all satisfy `on` — a weight keyed to an
 *  un-asked option isn't part of the question's contract, and its max
 *  would inflate derived confidence, so the answer is drift. */
const isProbsOn = (
  v: unknown,
  on: (key: string) => boolean
): v is Record<string, number> => isProbs(v) && Object.keys(v).every(on)

/** A canonical level index — '0'..'N-1', not '01', '-1', or 'x'. */
const isLevelKey = (key: string, levels: number): boolean => {
  const i = Number(key)
  return i >= 0 && i < levels && String(i) === key
}

/** Confidence off the wire: explicit value wins (clamped to 0..1 —
 *  out-of-range must never skip the escalation threshold); else the
 *  probability map's max; else 0. */
function deriveConfidence(v: unknown, probs: unknown): number {
  if (isNum(v)) {
    return clamp01(v)
  }
  if (!isProbs(probs)) {
    return 0
  }
  const vals = Object.values(probs)
  return vals.length > 0 ? clamp01(Math.max(...vals)) : 0
}

/** Map one wire answer to the contract, validated against the asked
 *  question — a `noul` answer to a `choice` question or an off-criteria
 *  pick is contract drift: JudgeUnavailable, fail-open. `qid` is the
 *  caller's question key (not sent to the model). */
function mapAnswer(
  qid: string,
  q: JudgeQuestion,
  raw: unknown,
  by: string,
  backend: string
): JudgeAnswer {
  if (typeof raw !== 'object' || raw === null) {
    throw new JudgeUnavailable(`${backend} returned a malformed answer for "${qid}"`)
  }
  const a = raw as RawAnswer
  if (a.type !== q.type) {
    throw new JudgeUnavailable(
      `${backend} answered "${qid}" with type ${JSON.stringify(a.type)} — expected ${q.type}`
    )
  }
  switch (a.type) {
    case 'choice': {
      const criteria = q.type === 'choice' ? q.criteria : {}
      if (
        typeof a.choice !== 'string' ||
        q.type !== 'choice' ||
        !Object.hasOwn(criteria, a.choice) ||
        !isProbsOn(a.probabilities, (k) => Object.hasOwn(criteria, k))
      ) {
        break
      }
      return {
        type: 'choice',
        choice: a.choice,
        probabilities: a.probabilities,
        confidence: deriveConfidence(a.confidence, a.probabilities),
        decidedBy: by,
      }
    }
    case 'score': {
      // the wire scale is 0..N-1 over the question's level array
      if (
        !isNum(a.score) ||
        q.type !== 'score' ||
        a.score < 0 ||
        a.score > q.criteria.length - 1 ||
        !isProbs(a.probabilities)
      ) {
        break
      }
      return {
        type: 'score',
        score: a.score,
        probabilities: a.probabilities,
        confidence: deriveConfidence(a.confidence, a.probabilities),
        decidedBy: by,
      }
    }
    case 'noul': {
      // P(yes) is a probability — outside [0,1] is contract drift
      if (!isNum(a.noul) || a.noul < 0 || a.noul > 1) {
        break
      }
      return {
        type: 'noul',
        noul: a.noul,
        // derived — the API returns only P(yes); a confident no is confident
        confidence: Math.max(a.noul, 1 - a.noul),
        decidedBy: by,
      }
    }
  }
  throw new JudgeUnavailable(`${backend} returned a malformed answer for "${qid}"`)
}

/** Map the wire's `answers` map onto the asked questions — an unasked
 *  id in the reply is drift we ignore, an asked-but-absent one is "no
 *  verdict" (the chain marks it low), an asked-but-malformed one fails
 *  open. */
export function mapTypedAnswers(
  rawAnswers: unknown,
  questions: Record<string, JudgeQuestion>,
  by: string,
  backend: string
): Record<string, JudgeAnswer> {
  if (typeof rawAnswers !== 'object' || rawAnswers === null) {
    throw new JudgeUnavailable(`${backend} returned no answers map`)
  }
  const raw = rawAnswers as Record<string, unknown>
  const answers: Record<string, JudgeAnswer> = {}
  for (const [qid, q] of Object.entries(questions)) {
    // hasOwn — an unanswered "constructor" qid would otherwise read
    // Object.prototype.constructor and fail open as malformed
    const a = raw[qid]
    if (Object.hasOwn(raw, qid) && a !== undefined) {
      // defineProperty — `answers["__proto__"] = v` would mutate the
      // map's prototype instead of owning the answer
      Object.defineProperty(answers, qid, {
        value: mapAnswer(qid, q, a, by, backend),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }
  return answers
}

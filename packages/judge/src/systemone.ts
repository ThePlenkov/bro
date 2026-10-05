/**
 * The `systemone` connector — TypeSafe's System One API as a JudgeFacade
 * (spec: specs/sessions/bro-f4ot.2-judge.md, contract per
 * https://docs.typesafe.ai/api.md). POST {baseUrl}/v1/systemone with
 * Bearer $TYPESAFE_API_KEY (env var only, never in config; base URL
 * overridable via TYPESAFE_BASE_URL).
 *
 * Error mapping per the documented contract: 401/403 auth and
 * 429/529/5xx-after-retries → JudgeUnavailable (fail-open); 422
 * validation → throw (the caller's bug, not an outage). noul answers
 * carry no confidence on the wire — the connector derives
 * confidence = max(noul, 1 - noul): a confident "no" is still confident.
 */
import { JudgeUnavailable } from '@broject/core'
import type {
  Connector,
  DecideResult,
  JudgeAnswer,
  JudgeQuestion,
} from '@broject/core'
import { isEnvName, type JudgeConfig } from './config.ts'
import { deadlineJudge, judgeConfig, type DeadlineJudge } from './chain.ts'
import {
  clamp01,
  isNum,
  isProbs,
  mapUsage,
  objOr,
  postJson,
  stripTrailingSlashes,
  type FetchFn,
  type HttpResult,
} from './http.ts'

const SYSTEMONE_NAME = 'systemone'

interface RawAnswer {
  type?: unknown
  choice?: unknown
  score?: unknown
  noul?: unknown
  confidence?: unknown
  probabilities?: unknown
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
function mapAnswer(qid: string, q: JudgeQuestion, raw: unknown): JudgeAnswer {
  if (typeof raw !== 'object' || raw === null) {
    throw new JudgeUnavailable(`systemone returned a malformed answer for "${qid}"`)
  }
  const a = raw as RawAnswer
  if (a.type !== q.type) {
    throw new JudgeUnavailable(
      `systemone answered "${qid}" with type ${JSON.stringify(a.type)} — expected ${q.type}`
    )
  }
  switch (a.type) {
    case 'choice': {
      if (
        typeof a.choice !== 'string' ||
        q.type !== 'choice' ||
        !Object.hasOwn(q.criteria, a.choice) ||
        !isProbs(a.probabilities)
      ) {
        break
      }
      return {
        type: 'choice',
        choice: a.choice,
        probabilities: a.probabilities,
        confidence: deriveConfidence(a.confidence, a.probabilities),
        decidedBy: SYSTEMONE_NAME,
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
        decidedBy: SYSTEMONE_NAME,
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
        decidedBy: SYSTEMONE_NAME,
      }
    }
  }
  throw new JudgeUnavailable(`systemone returned a malformed answer for "${qid}"`)
}

export interface SystemoneJudgeOpts {
  /** Test seam — injects a scripted transport. */
  fetch?: FetchFn
}

/** The configured key from its env var — a non-NAME apiKeyEnv is a
 *  config bug (throws, never echoed); a missing var is fail-open. */
function apiKey(cfg: JudgeConfig): string {
  if (!isEnvName(cfg.apiKeyEnv)) {
    throw new Error('judge.apiKeyEnv is not a valid environment variable name')
  }
  const key = process.env[cfg.apiKeyEnv]
  if (key === undefined || key === '') {
    throw new JudgeUnavailable(
      `${cfg.apiKeyEnv} is not set — export a TypeSafe API key (https://docs.typesafe.ai)`
    )
  }
  return key
}

/** System One's error contract → the throw the caller sees: 401/403 auth is
 *  "unavailable" (fail-open — never a gate input), 422 validation is
 *  the caller's bug (a plain error, not fail-open), everything else is
 *  the service being down. */
function throwForStatus(res: HttpResult): never {
  const err = objOr(res.body).error
  const errObj = objOr(err)
  let detail = `HTTP ${res.status}`
  if (typeof err === 'string') {
    detail = err
  } else if (typeof errObj.message === 'string') {
    detail = errObj.message
  }
  if (res.status === 401 || res.status === 403) {
    throw new JudgeUnavailable(`systemone auth failed — ${detail}`)
  }
  if (res.status === 422) {
    // validation — the caller's payload, not an outage
    throw new Error(`systemone rejected the request — ${detail}`)
  }
  throw new JudgeUnavailable(`systemone unavailable — ${detail}`)
}

export function systemoneJudge(cfg: JudgeConfig, opts: SystemoneJudgeOpts = {}): DeadlineJudge {
  const base = process.env.TYPESAFE_BASE_URL ?? cfg.baseUrl
  const endpoint = `${stripTrailingSlashes(base)}/v1/systemone`
  async function decideWithin(
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult> {
    const key = apiKey(cfg)
    const started = Date.now()
    const res = await postJson(
      endpoint,
      { model: cfg.model, state, questions },
      { authorization: `Bearer ${key}` },
      deadline,
      // the documented transient contract: rate-limited + every 5xx
      (s) => s === 429 || s >= 500,
      opts.fetch
    )
    if (res.status !== 200) {
      throwForStatus(res)
    }
    const body = objOr(res.body)
    const rawAnswers = body.answers
    if (typeof rawAnswers !== 'object' || rawAnswers === null) {
      throw new JudgeUnavailable('systemone returned no answers map')
    }
    const answers: Record<string, JudgeAnswer> = {}
    // map only asked questions — an unasked id in the reply is drift
    // we ignore, an asked-but-absent one is "no verdict" (the chain
    // marks it low), an asked-but-malformed one fails open
    for (const [qid, q] of Object.entries(questions)) {
      // hasOwn — an unanswered "constructor" qid would otherwise read
      // Object.prototype.constructor and fail open as malformed
      const a = (rawAnswers as Record<string, unknown>)[qid]
      if (Object.hasOwn(rawAnswers, qid) && a !== undefined) {
        answers[qid] = mapAnswer(qid, q, a)
      }
    }
    return {
      answers,
      model: typeof body.model === 'string' ? body.model : cfg.model,
      latencyMs: Date.now() - started,
      usage: mapUsage(body, 'input_tokens'),
      // the chain owns thresholding — a raw backend reports none
      lowConfidence: [],
    }
  }
  return deadlineJudge(cfg.timeoutMs, decideWithin)
}

export const systemoneConnector: Connector = {
  name: SYSTEMONE_NAME,
  auth(ctx) {
    const { apiKeyEnv } = judgeConfig(ctx.dir).judge
    if (!isEnvName(apiKeyEnv)) {
      return 'judge.apiKeyEnv is not a valid environment variable name'
    }
    return process.env[apiKeyEnv]
      ? null
      : `${apiKeyEnv} is not set — export a TypeSafe API key (https://docs.typesafe.ai)`
  },
  judge: (ctx) => systemoneJudge(judgeConfig(ctx.dir).judge),
}

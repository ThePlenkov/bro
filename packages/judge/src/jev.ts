/**
 * The `jev` connector — TypeSafe's hosted decision API as a JudgeFacade
 * (spec: specs/sessions/bro-f4ot.2-judge.md). POST {baseUrl}/v1/decide
 * with Bearer $JEV_API_KEY (jv_live_… — env var only, never in config).
 *
 * Error mapping per spec: 400 validation → throw (caller's bug);
 * 401/403/402 → JudgeUnavailable (fail-open — credits and auth are
 * "unavailable", never a gate input); 502 + network → bounded retry
 * with backoff inside the shared deadline, then JudgeUnavailable.
 * noul answers carry no confidence on the wire — the connector derives
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

const JEV_NAME = 'jev'

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

/** Map one wire answer to the contract — `qid` is the caller's question
 *  key (not sent to the model). A malformed entry is contract drift:
 *  JudgeUnavailable, fail-open. */
function mapAnswer(qid: string, raw: unknown): JudgeAnswer {
  if (typeof raw !== 'object' || raw === null) {
    throw new JudgeUnavailable(`jev returned a malformed answer for "${qid}"`)
  }
  const a = raw as RawAnswer
  switch (a.type) {
    case 'choice': {
      if (typeof a.choice !== 'string' || !isProbs(a.probabilities)) {
        break
      }
      return {
        type: 'choice',
        choice: a.choice,
        probabilities: a.probabilities,
        confidence: deriveConfidence(a.confidence, a.probabilities),
        decidedBy: JEV_NAME,
      }
    }
    case 'score': {
      if (!isNum(a.score) || !isProbs(a.probabilities)) {
        break
      }
      return {
        type: 'score',
        score: a.score,
        probabilities: a.probabilities,
        confidence: deriveConfidence(a.confidence, a.probabilities),
        decidedBy: JEV_NAME,
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
        // derived — jev returns only P(yes); a confident no is confident
        confidence: Math.max(a.noul, 1 - a.noul),
        decidedBy: JEV_NAME,
      }
    }
  }
  throw new JudgeUnavailable(`jev returned a malformed answer for "${qid}"`)
}

export interface JevJudgeOpts {
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
      `${cfg.apiKeyEnv} is not set — export a jv_live_ key (https://jevtypesafeai.com → Get API key)`
    )
  }
  return key
}

/** jev's error contract → the throw the caller sees (spec:
 *  bro-f4ot.2-judge). The body's own error detail wins over the status
 *  when both exist; `max_tokens_exceeded` is a caller bug even on a
 *  non-400 status. */
function throwForStatus(res: HttpResult): never {
  const body = objOr(res.body)
  const err = body.error
  const errObj = objOr(err)
  let detail = `HTTP ${res.status}`
  if (typeof err === 'string') {
    detail = err
  } else if (typeof errObj.message === 'string') {
    detail = errObj.message
  }
  const code = typeof errObj.code === 'string' ? errObj.code : undefined
  if (res.status === 401 || res.status === 403) {
    throw new JudgeUnavailable(`jev auth failed — ${detail}`)
  }
  if (res.status === 402) {
    throw new JudgeUnavailable(`jev out of credits — ${detail}`)
  }
  if (res.status === 400 || res.status === 404 || code === 'max_tokens_exceeded') {
    // validation / unknown endpoint / over budget — the caller's
    // bug or payload, not an outage: throw, don't fail-open
    throw new Error(`jev rejected the request — ${detail}`)
  }
  throw new JudgeUnavailable(`jev unavailable — ${detail}`)
}

export function jevJudge(cfg: JudgeConfig, opts: JevJudgeOpts = {}): DeadlineJudge {
  const endpoint = `${stripTrailingSlashes(cfg.baseUrl)}/v1/decide`
  async function decideWithin(
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult> {
    const key = apiKey(cfg)
    const started = Date.now()
    const res = await postJson(
      endpoint,
      { ...(cfg.model !== undefined ? { model: cfg.model } : {}), state, questions },
      { authorization: `Bearer ${key}` },
      deadline,
      [502],
      opts.fetch
    )
    if (res.status !== 200) {
      throwForStatus(res)
    }
    const body = objOr(res.body)
    const rawAnswers = body.answers
    if (typeof rawAnswers !== 'object' || rawAnswers === null) {
      throw new JudgeUnavailable('jev returned no answers map')
    }
    const answers: Record<string, JudgeAnswer> = {}
    for (const [qid, a] of Object.entries(rawAnswers)) {
      answers[qid] = mapAnswer(qid, a)
    }
    return {
      answers,
      model: typeof body.model === 'string' ? body.model : (cfg.model ?? 'jev'),
      latencyMs: Date.now() - started,
      usage: mapUsage(body, 'input_tokens'),
      // the chain owns thresholding — a raw backend reports none
      lowConfidence: [],
    }
  }
  return deadlineJudge(cfg.timeoutMs, decideWithin)
}

export const jevConnector: Connector = {
  name: JEV_NAME,
  auth(ctx) {
    const { apiKeyEnv } = judgeConfig(ctx.dir).judge
    if (!isEnvName(apiKeyEnv)) {
      return 'judge.apiKeyEnv is not a valid environment variable name'
    }
    return process.env[apiKeyEnv]
      ? null
      : `${apiKeyEnv} is not set — export a jv_live_ key (https://jevtypesafeai.com → Get API key)`
  },
  judge: (ctx) => jevJudge(judgeConfig(ctx.dir).judge),
}

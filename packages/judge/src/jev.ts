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
import type { JudgeConfig } from './config.ts'
import { judgeConfig, type DeadlineJudge } from './chain.ts'
import { postJson, remaining, type FetchFn } from './http.ts'

const JEV_NAME = 'jev'

interface RawAnswer {
  type?: unknown
  choice?: unknown
  score?: unknown
  noul?: unknown
  confidence?: unknown
  probabilities?: unknown
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const isProbs = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v).every((p) => isNum(p))

/** Map one wire answer to the contract — `qid` is the caller's question
 *  key (not sent to the model). A malformed entry is contract drift:
 *  JudgeUnavailable, fail-open. */
function mapAnswer(qid: string, raw: RawAnswer): JudgeAnswer {
  const confidence = (v: unknown, probs: unknown): number =>
    isNum(v) ? v : isProbs(probs) ? Math.max(...Object.values(probs)) : 0
  switch (raw.type) {
    case 'choice': {
      if (typeof raw.choice !== 'string' || !isProbs(raw.probabilities)) {
        break
      }
      return {
        type: 'choice',
        choice: raw.choice,
        probabilities: raw.probabilities,
        confidence: confidence(raw.confidence, raw.probabilities),
        decidedBy: JEV_NAME,
      }
    }
    case 'score': {
      if (!isNum(raw.score) || !isProbs(raw.probabilities)) {
        break
      }
      return {
        type: 'score',
        score: raw.score,
        probabilities: raw.probabilities,
        confidence: confidence(raw.confidence, raw.probabilities),
        decidedBy: JEV_NAME,
      }
    }
    case 'noul': {
      if (!isNum(raw.noul)) {
        break
      }
      return {
        type: 'noul',
        noul: raw.noul,
        // derived — jev returns only P(yes); a confident no is confident
        confidence: Math.max(raw.noul, 1 - raw.noul),
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

export function jevJudge(cfg: JudgeConfig, opts: JevJudgeOpts = {}): DeadlineJudge {
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/decide`
  async function decideWithin(
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult> {
    const key = process.env[cfg.apiKeyEnv]
    if (key === undefined || key === '') {
      throw new JudgeUnavailable(
        `${cfg.apiKeyEnv} is not set — export a jv_live_ key (https://jevtypesafeai.com → Get API key)`
      )
    }
    const started = Date.now()
    const res = await postJson(
      endpoint,
      { ...(cfg.model !== undefined ? { model: cfg.model } : {}), state, questions },
      { authorization: `Bearer ${key}` },
      deadline,
      [502],
      opts.fetch
    )
    const body = (typeof res.body === 'object' && res.body !== null
      ? res.body
      : {}) as Record<string, unknown>
    // the service's own code wins over the status when both exist
    const detail =
      typeof body.error === 'string'
        ? body.error
        : typeof (body.error as Record<string, unknown> | undefined)?.message === 'string'
          ? String((body.error as Record<string, unknown>).message)
          : `HTTP ${res.status}`
    const code =
      typeof (body.error as Record<string, unknown> | undefined)?.code === 'string'
        ? String((body.error as Record<string, unknown>).code)
        : undefined
    switch (res.status) {
      case 200:
        break
      case 401:
      case 403:
        throw new JudgeUnavailable(`jev auth failed — ${detail}`)
      case 402:
        throw new JudgeUnavailable(`jev out of credits — ${detail}`)
      default:
        if (res.status === 400 || res.status === 404 || code === 'max_tokens_exceeded') {
          // validation / unknown endpoint / over budget — the caller's
          // bug or payload, not an outage: throw, don't fail-open
          throw new Error(`jev rejected the request — ${detail}`)
        }
        throw new JudgeUnavailable(`jev unavailable — ${detail}`)
    }
    const rawAnswers = body.answers
    if (typeof rawAnswers !== 'object' || rawAnswers === null) {
      throw new JudgeUnavailable('jev returned no answers map')
    }
    const answers: Record<string, JudgeAnswer> = {}
    for (const [qid, a] of Object.entries(rawAnswers)) {
      answers[qid] = mapAnswer(qid, a as RawAnswer)
    }
    const rawUsage = (
      typeof body.usage === 'object' && body.usage !== null ? body.usage : {}
    ) as Record<string, unknown>
    const usage: DecideResult['usage'] = {}
    if (isNum(rawUsage.input_tokens)) {
      usage.inputTokens = rawUsage.input_tokens
    }
    if (isNum(rawUsage.cost_usd)) {
      usage.costUsd = rawUsage.cost_usd
    }
    return {
      answers,
      model: typeof body.model === 'string' ? body.model : (cfg.model ?? 'jev'),
      latencyMs: Date.now() - started,
      usage: Object.keys(usage).length > 0 ? usage : undefined,
      // the chain owns thresholding — a raw backend reports none
      lowConfidence: [],
    }
  }
  return {
    decide: (state, questions) =>
      decideWithin(state, questions, Date.now() + cfg.timeoutMs),
    decideWithin: (state, questions, deadline) => {
      if (remaining(deadline) <= 0) {
        return Promise.reject(new JudgeUnavailable('judge budget spent'))
      }
      return decideWithin(state, questions, deadline)
    },
  }
}

export const jevConnector: Connector = {
  name: JEV_NAME,
  auth(ctx) {
    const { apiKeyEnv } = judgeConfig(ctx.dir).judge
    return process.env[apiKeyEnv]
      ? null
      : `${apiKeyEnv} is not set — export a jv_live_ key (https://jevtypesafeai.com → Get API key)`
  },
  judge: (ctx) => jevJudge(judgeConfig(ctx.dir).judge),
}

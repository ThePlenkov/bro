/**
 * The `llm-judge` connector — an OpenAI-compatible chat endpoint driven
 * into the JudgeQuestion contract (spec: bro-f4ot.2-judge). It renders
 * state + questions into one structured prompt, maps the model's JSON
 * reply back onto typed answers, and reports the model's own
 * confidence — parsed or mapped to a middling 0.5, never fabricated
 * high; the stats buckets decide whether that self-report earns trust.
 *
 * Two jobs: escalation on low primary confidence (`judge.fallback`),
 * and the whole judge where jev isn't provisioned — including jev
 * itself over OrcaRouter's OpenAI-compat wrapper
 * (`connectors.judge: llm-judge` + `judge.llm.model: typesafe/jev-1.13`).
 * Slower and costlier than jev — answers carry decidedBy 'llm-judge' so
 * stats score each backend on its own record.
 */
import { JudgeUnavailable } from '@broject/core'
import type {
  Connector,
  DecideResult,
  JudgeAnswer,
  JudgeQuestion,
} from '@broject/core'
import { isEnvName, type JudgeConfig, type JudgeLlmConfig } from './config.ts'
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

const LLM_NAME = 'llm-judge'

/** The structured-output contract we ask the chat model to fill. */
function renderPrompt(state: unknown, questions: Record<string, JudgeQuestion>): string {
  const stateText =
    typeof state === 'string' ? state : JSON.stringify(state, null, 2)
  return `You are a calibrated decision model. Evaluate the STATE and answer every question in QUESTIONS.

STATE:
${stateText}

QUESTIONS (JSON map — the keys are question ids):
${JSON.stringify(questions, null, 2)}

Respond with STRICT JSON only — no prose, no markdown fences:
{"answers": {"<question-id>": <answer>, …}}

Answer shape per question type — copy the question's "type":
- "noul":   {"type":"noul","noul":<0..1 probability the answer is yes>}
- "choice": {"type":"choice","choice":"<one criteria key>","probabilities":{"<key>":<p>, …}}
- "score":  {"type":"score","score":<probability-weighted level — 0 = first/lowest level, N-1 = last/highest, fractional allowed>,"probabilities":{"<level index>":<p>, …}}

Add "confidence": <0..1> to every answer — an honest self-assessment, low when unsure.
Answer EVERY question id exactly once.`
}

/** Self-reported confidence, clamped; absent/unparsable → 0.5 — mapped,
 *  never fabricated high. */
function modelConfidence(v: unknown): number {
  return isNum(v) ? clamp01(v) : 0.5
}

/** Map one model reply onto the question's declared answer type. The
 *  reply's own "type" is untrusted — the question decides. Missing
 *  fields degrade: confidence falls to 0.5, an absent probabilities
 *  map stays empty rather than fabricating a winner-take-all 1.0, and
 *  an unusable answer (off-criteria choice, non-numeric value) is
 *  omitted — one bad answer must not sink the rest of the batch. */
function mapAnswer(q: JudgeQuestion, raw: unknown): JudgeAnswer | undefined {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  switch (q.type) {
    case 'choice': {
      const choice = typeof a.choice === 'string' ? a.choice : undefined
      // own-property — `in` would accept inherited keys like "toString"
      if (choice === undefined || !Object.hasOwn(q.criteria, choice)) {
        return undefined
      }
      return {
        type: 'choice',
        choice,
        probabilities: isProbs(a.probabilities) ? a.probabilities : {},
        confidence: modelConfidence(a.confidence),
        decidedBy: LLM_NAME,
      }
    }
    case 'score': {
      // the scale is 0..N-1 over the question's levels — an off-scale
      // self-report is unusable, not clamped into a wrong verdict
      if (!isNum(a.score) || a.score < 0 || a.score > q.criteria.length - 1) {
        return undefined
      }
      return {
        type: 'score',
        score: a.score,
        probabilities: isProbs(a.probabilities) ? a.probabilities : {},
        confidence: modelConfidence(a.confidence),
        decidedBy: LLM_NAME,
      }
    }
    case 'noul': {
      if (!isNum(a.noul)) {
        return undefined
      }
      return {
        type: 'noul',
        noul: clamp01(a.noul),
        confidence: modelConfidence(a.confidence),
        decidedBy: LLM_NAME,
      }
    }
  }
}

/** Strip a ```lang … ``` wrapper without regex — a lazy-match pattern
 *  on untrusted model text is a SAST finding, a string walk isn't. */
function unfence(text: string): string {
  if (!text.startsWith('```') || !text.endsWith('```') || text.length < 6) {
    return text
  }
  const nl = text.indexOf('\n')
  if (nl === -1 || nl >= text.length - 3) {
    return text
  }
  return text.slice(nl + 1, -3).trim()
}

/** Strict JSON, forgiving extraction — a fence or preamble around an
 *  otherwise-valid payload is a formatting quirk, not a new question. */
function parseReply(content: string): Record<string, unknown> {
  const text = unfence(content.trim())
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // a preamble like "Here is the JSON:" is a formatting quirk — the
    // outermost {…} still carries the payload
    const open = text.indexOf('{')
    const close = text.lastIndexOf('}')
    if (open === -1 || close <= open) {
      throw new Error('not an object')
    }
    parsed = JSON.parse(text.slice(open, close + 1))
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('not an object')
  }
  const answers = (parsed as Record<string, unknown>).answers
  if (typeof answers !== 'object' || answers === null) {
    throw new Error('missing "answers" object')
  }
  return answers as Record<string, unknown>
}

export interface LlmJudgeOpts {
  fetch?: FetchFn
}

function unconfigured(): never {
  throw new JudgeUnavailable(
    'judge.llm is not configured — set judge.llm { baseUrl, model, apiKeyEnv? } in bro.config.json'
  )
}

/** Auth headers from the configured env var — a non-NAME apiKeyEnv is
 *  a config bug (throws, never echoed); a missing var is fail-open. */
function authHeaders(llm: JudgeLlmConfig): Record<string, string> {
  if (llm.apiKeyEnv === undefined) {
    return {}
  }
  if (!isEnvName(llm.apiKeyEnv)) {
    throw new Error('judge.llm.apiKeyEnv is not a valid environment variable name')
  }
  const key = process.env[llm.apiKeyEnv]
  if (key === undefined || key === '') {
    throw new JudgeUnavailable(`${llm.apiKeyEnv} is not set — export it for llm-judge`)
  }
  return { authorization: `Bearer ${key}` }
}

/** llm error contract → throw. 400/404 are caller bugs; everything
 *  else (incl. 401/403 — an unprovisioned fallback is "unavailable",
 *  not a gate input) is JudgeUnavailable. */
function throwForStatus(res: HttpResult): never {
  const err = objOr(res.body).error
  const errObj = objOr(err)
  const msg =
    typeof errObj.message === 'string' ? errObj.message : `HTTP ${res.status}`
  if (res.status === 400 || res.status === 404) {
    throw new Error(`llm-judge rejected the request — ${msg}`)
  }
  throw new JudgeUnavailable(`llm-judge unavailable — ${msg}`)
}

/** choices[0].message.content — a missing/typed-wrong reply is "no
 *  verdict", not a gate input. */
function replyContent(body: unknown): string {
  const choices = objOr(body).choices
  const content =
    Array.isArray(choices) && choices.length > 0
      ? (choices[0] as { message?: { content?: unknown } }).message?.content
      : undefined
  if (typeof content !== 'string') {
    throw new JudgeUnavailable('llm-judge returned no message content')
  }
  return content
}

/** Map every asked question against the raw reply — an unusable entry
 *  is omitted (the chain marks it low), never sinks the batch. */
function collectAnswers(
  questions: Record<string, JudgeQuestion>,
  rawAnswers: Record<string, unknown>
): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {}
  for (const [qid, q] of Object.entries(questions)) {
    const raw = rawAnswers[qid]
    if (raw === undefined) {
      continue // unanswered questions just stay absent — the chain marks them low
    }
    const mapped = mapAnswer(q, raw)
    if (mapped !== undefined) {
      answers[qid] = mapped
    }
  }
  return answers
}

export function llmJudge(cfg: JudgeConfig, opts: LlmJudgeOpts = {}): DeadlineJudge {
  const llm: JudgeLlmConfig | undefined = cfg.llm
  const endpoint =
    llm !== undefined ? `${stripTrailingSlashes(llm.baseUrl)}/chat/completions` : ''
  async function decideWithin(
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult> {
    if (llm === undefined) {
      unconfigured()
    }
    const started = Date.now()
    const res = await postJson(
      endpoint,
      {
        model: llm.model,
        messages: [{ role: 'user', content: renderPrompt(state, questions) }],
        response_format: { type: 'json_object' },
        temperature: 0,
      },
      authHeaders(llm),
      deadline,
      (s) => s === 429 || s >= 500,
      opts.fetch
    )
    if (res.status !== 200) {
      throwForStatus(res)
    }
    const body = objOr(res.body)
    let rawAnswers: Record<string, unknown>
    try {
      rawAnswers = parseReply(replyContent(body))
    } catch (err) {
      if (err instanceof JudgeUnavailable) {
        throw err
      }
      // an unparsable reply is "no verdict", not a gate input — fail open
      throw new JudgeUnavailable(
        `llm-judge returned unparseable JSON — ${err instanceof Error ? err.message : err}`
      )
    }
    return {
      answers: collectAnswers(questions, rawAnswers),
      model: typeof body.model === 'string' ? body.model : llm.model,
      latencyMs: Date.now() - started,
      usage: mapUsage(body, 'prompt_tokens'),
      lowConfidence: [],
    }
  }
  return deadlineJudge(cfg.timeoutMs, decideWithin)
}

export const llmJudgeConnector: Connector = {
  name: LLM_NAME,
  auth(ctx) {
    const { judge } = judgeConfig(ctx.dir)
    if (judge.llm === undefined) {
      return 'judge.llm is not configured — set judge.llm { baseUrl, model } in bro.config.json'
    }
    return judge.llm.apiKeyEnv !== undefined && !process.env[judge.llm.apiKeyEnv]
      ? `${judge.llm.apiKeyEnv} is not set — export it for llm-judge`
      : null
  },
  judge: (ctx) => llmJudge(judgeConfig(ctx.dir).judge),
}

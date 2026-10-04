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
import type { JudgeConfig, JudgeLlmConfig } from './config.ts'
import { judgeConfig, type DeadlineJudge } from './chain.ts'
import { postJson, remaining, type FetchFn } from './http.ts'

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
- "score":  {"type":"score","score":<number on the level scale: 0 = first level, N-1 = last>,"probabilities":{"<level index>":<p>, …}}

Add "confidence": <0..1> to every answer — an honest self-assessment, low when unsure.
Answer EVERY question id exactly once.`
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const isProbs = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v).every((p) => isNum(p))

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
      if (choice === undefined || !(choice in q.criteria)) {
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
      if (!isNum(a.score)) {
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

/** Strict JSON, forgiving extraction — a fence or preamble around an
 *  otherwise-valid payload is a formatting quirk, not a new question. */
function parseReply(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const text = fence?.[1] ?? trimmed
  const parsed = JSON.parse(text) as unknown
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

export function llmJudge(cfg: JudgeConfig, opts: LlmJudgeOpts = {}): DeadlineJudge {
  const llm: JudgeLlmConfig | undefined = cfg.llm
  const endpoint =
    llm !== undefined ? `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions` : ''
  async function decideWithin(
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult> {
    if (llm === undefined) {
      unconfigured()
    }
    const headers: Record<string, string> = {}
    if (llm.apiKeyEnv !== undefined) {
      const key = process.env[llm.apiKeyEnv]
      if (key === undefined || key === '') {
        throw new JudgeUnavailable(`${llm.apiKeyEnv} is not set — export it for llm-judge`)
      }
      headers.authorization = `Bearer ${key}`
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
      headers,
      deadline,
      [429, 500, 502, 503, 504],
      opts.fetch
    )
    const body = (typeof res.body === 'object' && res.body !== null
      ? res.body
      : {}) as Record<string, unknown>
    const errMsg =
      typeof (body.error as Record<string, unknown> | undefined)?.message === 'string'
        ? String((body.error as Record<string, unknown>).message)
        : `HTTP ${res.status}`
    switch (res.status) {
      case 200:
        break
      case 400:
      case 404:
        throw new Error(`llm-judge rejected the request — ${errMsg}`)
      default:
        throw new JudgeUnavailable(`llm-judge unavailable — ${errMsg}`)
    }
    const choices = body.choices
    const content =
      Array.isArray(choices) && choices.length > 0
        ? (choices[0] as { message?: { content?: unknown } }).message?.content
        : undefined
    if (typeof content !== 'string') {
      throw new JudgeUnavailable('llm-judge returned no message content')
    }
    let rawAnswers: Record<string, unknown>
    try {
      rawAnswers = parseReply(content)
    } catch (err) {
      // an unparsable reply is "no verdict", not a gate input — fail open
      throw new JudgeUnavailable(
        `llm-judge returned unparseable JSON — ${err instanceof Error ? err.message : err}`
      )
    }
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
    const rawUsage = (
      typeof body.usage === 'object' && body.usage !== null ? body.usage : {}
    ) as Record<string, unknown>
    const usage: DecideResult['usage'] = {}
    if (isNum(rawUsage.prompt_tokens)) {
      usage.inputTokens = rawUsage.prompt_tokens
    }
    return {
      answers,
      model: typeof body.model === 'string' ? body.model : llm.model,
      latencyMs: Date.now() - started,
      usage: Object.keys(usage).length > 0 ? usage : undefined,
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

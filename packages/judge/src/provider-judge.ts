/**
 * JudgeFacade over a `providers` entry (spec: specs/bro-ribc.1.md,
 * milestone 3) — `judge.provider` names an entry, its kind picks the
 * adapter: systemone's native typed call, or the prompt-and-parse
 * adapter over the openai-compat chat surface. The prose machinery is
 * what llm-judge carried — moved here because an `openai-compat`
 * provider consumed by a judge IS llm-judge, and the connector name
 * survives only as the synthesized entry's alias.
 *
 * `decidedBy` lands as `provider:<name>` for registry entries so stats
 * score each service on its own record; the legacy aliases keep their
 * bare names ('systemone', 'llm-judge') so existing journals stay
 * comparable. A prompt-and-parsed answer is prose-grade evidence —
 * it never masquerades as a calibrated typed judgment.
 */
import {
  isEnvName,
  JudgeUnavailable,
  PROVIDER_REGISTRY,
  ProviderSurfaceError,
} from '@broject/core'
import type {
  DecideResult,
  JudgeAnswer,
  JudgeQuestion,
  ProviderEntry,
} from '@broject/core'
import { clamp01, isNum, isProbs, providerClient } from '@broject/providers'
import type { AcpSeam, FetchFn, ProviderChat } from '@broject/providers'
import { deadlineJudge, type DeadlineJudge } from './deadline.ts'
import type { JudgeConfig } from './config.ts'

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
function mapAnswer(
  q: JudgeQuestion,
  raw: unknown,
  by: string
): JudgeAnswer | undefined {
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
        decidedBy: by,
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
        decidedBy: by,
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
        decidedBy: by,
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

/** Map every asked question against the raw reply — an unusable entry
 *  is omitted (the chain marks it low), never sinks the batch. */
function collectAnswers(
  questions: Record<string, JudgeQuestion>,
  rawAnswers: Record<string, unknown>,
  by: string
): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {}
  for (const [qid, q] of Object.entries(questions)) {
    // hasOwn — an unanswered "constructor" qid would otherwise read
    // Object.prototype.constructor and be treated as answered
    const raw = Object.hasOwn(rawAnswers, qid) ? rawAnswers[qid] : undefined
    if (raw === undefined) {
      continue // unanswered questions just stay absent — the chain marks them low
    }
    const mapped = mapAnswer(q, raw, by)
    if (mapped !== undefined) {
      answers[qid] = mapped
    }
  }
  return answers
}

/** One prose decide over a provider's chat surface — render, call,
 *  parse, stamp `by`. An unparsable reply is "no verdict" — fail open,
 *  never a gate input. */
export async function proseDecide(
  by: string,
  chat: ProviderChat,
  state: unknown,
  questions: Record<string, JudgeQuestion>,
  deadline: number
): Promise<DecideResult> {
  const started = Date.now()
  const res = await chat(renderPrompt(state, questions), deadline)
  let rawAnswers: Record<string, unknown>
  try {
    rawAnswers = parseReply(res.content)
  } catch (err) {
    if (err instanceof JudgeUnavailable) {
      throw err
    }
    throw new JudgeUnavailable(
      `${by} returned unparseable JSON — ${err instanceof Error ? err.message : err}`
    )
  }
  return {
    answers: collectAnswers(questions, rawAnswers, by),
    model: res.model,
    latencyMs: Date.now() - started,
    usage: res.usage,
    lowConfidence: [],
  }
}

/** The config field an entry's apiKeyEnv actually lives at — a
 *  resolve that hit a synthesized alias is fed by the legacy field,
 *  so auth/key errors must name THAT field, not a registry path the
 *  user never wrote. */
export function providerKeyField(
  name: string,
  providers: Record<string, ProviderEntry>
): string {
  if (providers[name] === undefined) {
    if (name === 'systemone') {
      return 'judge.apiKeyEnv'
    }
    if (name === 'llm-judge') {
      return 'judge.llm.apiKeyEnv'
    }
  }
  return `providers.${name}.apiKeyEnv`
}

export interface ProviderJudgeOpts {
  /** Test seam — the bindings take a scripted transport. */
  fetch?: FetchFn
  /** Model override — wins over the entry's pinned model. The caller
   *  decides when `judge.model` applies (judgeFacade: the primary
   *  only — the fallback's pin is its own contract). */
  model?: string
  /** The config field key errors name — providerKeyField() resolves
   *  synthesized aliases back to their legacy source field. */
  keyField?: string
  /** acp-kind session seam — tests inject an in-process agent peer. */
  acp?: AcpSeam
}

/** JudgeFacade over a named provider entry — the kind selects the
 *  adapter (spec's capability matrix). */
export function providerJudge(
  name: string,
  entry: ProviderEntry,
  cfg: JudgeConfig,
  opts: ProviderJudgeOpts = {}
): DeadlineJudge {
  const client = providerClient(name, entry, {
    fetch: opts.fetch,
    model: opts.model,
    keyField: opts.keyField,
    acp: opts.acp,
  })
  const by = `provider:${name}`
  if (client.call !== undefined) {
    return deadlineJudge(cfg.timeoutMs, client.call)
  }
  if (client.chat !== undefined) {
    const chat = client.chat
    // an 'auto' kind (acp) serving prose flags the stamp — a
    // prompt-and-parsed answer must never share the provider's typed
    // bucket in stats' byDecider (spec: fidelity laundering is the
    // failure this guards; always-prose kinds need no marker — their
    // name already says what they are)
    const proseBy =
      PROVIDER_REGISTRY[entry.type].call === 'auto' ? `${by}:prose` : by
    return deadlineJudge(cfg.timeoutMs, (state, questions, deadline) =>
      proseDecide(proseBy, chat, state, questions, deadline)
    )
  }
  // unreachable while every bound kind serves a surface — a kind that
  // resolves to no member is a registry defect, not user error
  throw new ProviderSurfaceError(name, entry, 'call')
}

/** The judge's effective registry — the user's `providers` entries
 *  plus the anonymous entries legacy config synthesizes under their
 *  connector aliases: `judge.{baseUrl,model,apiKeyEnv}` → 'systemone',
 *  `judge.llm` → 'llm-judge'. A named entry always wins over the
 *  synthesized one of the same name — the user claimed the alias. */
export function synthesizedProviders(
  cfg: JudgeConfig,
  providers: Record<string, ProviderEntry>
): Record<string, ProviderEntry> {
  const out = { ...providers }
  // legacy judge.* config → anonymous api entries under their
  // connector aliases — the host is the user's baseUrl, the one
  // pinned model rides its wire
  out.systemone ??= {
    type: 'api',
    baseUrl: cfg.baseUrl,
    apiKeyEnv: cfg.apiKeyEnv,
    models: { [cfg.model]: 'systemone' },
  }
  if (cfg.llm !== undefined) {
    out['llm-judge'] ??= {
      type: 'api',
      baseUrl: cfg.llm.baseUrl,
      apiKeyEnv: cfg.llm.apiKeyEnv,
      models: { [cfg.llm.model]: 'openai-compat' },
    }
  }
  return out
}

/** Provider-mode auth preflight for `bro judge decide`/`replay` — the
 *  entry's apiKeyEnv resolves to an env var or the remediation line
 *  names the field the user actually wrote (never the var name,
 *  never the value). */
export function providerJudgeAuth(
  name: string,
  entry: ProviderEntry,
  keyField = `providers.${name}.apiKeyEnv`
): string | null {
  // apiKeyCommand wins over apiKeyEnv at call time, so a configured
  // command satisfies auth — a missing env var must not veto it (the
  // preflight probes; it never runs the secret lookup itself, whose
  // failures surface at call time as fail-open JudgeUnavailable)
  if ('apiKeyCommand' in entry && entry.apiKeyCommand !== undefined) {
    return null
  }
  const envName = 'apiKeyEnv' in entry ? entry.apiKeyEnv : undefined
  if (envName === undefined) {
    return null
  }
  if (!isEnvName(envName)) {
    return `${keyField} is not a valid environment variable name`
  }
  return process.env[envName]
    ? null
    : `the env var named by ${keyField} is not set — export it for judge.provider "${name}"`
}

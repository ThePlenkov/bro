import type { ConfigSection } from '@broject/core'

// the SCREAMING_SNAKE rule moved to core with the providers registry —
// re-exported here so `import { isEnvName } from './config.ts'` keeps working
export { isEnvName } from '@broject/core'

export interface JudgeLlmConfig {
  /** OpenAI-compatible base URL — the connector POSTs
   *  `${baseUrl}/chat/completions` (include `/v1` when the host needs it). */
  baseUrl: string
  model: string
  /** Env var NAME holding the key — config never carries the value. */
  apiKeyEnv?: string
}

export interface JudgeConfig {
  /** 'off' | 'shadow' — v1 has no acting mode; shadow is annotate-only.
   *  The `bro judge decide` smoke path runs regardless. */
  mode: 'off' | 'shadow'
  /** Model for the primary backend — the API requires it. Defaults to
   *  the `jev-latest` alias; pin a version in production so thresholds
   *  don't drift under the same inputs. */
  model: string
  /** TypeSafe API base — `${baseUrl}/v1/systemone` is the evaluate
   *  endpoint; `TYPESAFE_BASE_URL` in the environment overrides. */
  baseUrl: string
  /** Env var NAME holding the TypeSafe API key — never the value. */
  apiKeyEnv: string
  /** Per-answer confidence threshold — below it the answer escalates
   *  to `fallback` (when configured) and lands in lowConfidence. */
  confidence: number
  /** Escalation connector name — e.g. 'llm-judge'. Omit for none. */
  fallback?: string
  /** Bounds the WHOLE decide() — primary, retries, and escalation
   *  share one deadline; an escalation starting with 200ms left gets
   *  200ms, not a fresh budget. */
  timeoutMs: number
  /** Cost bound per command invocation — enforced by the consuming
   *  command (act threads / drive / replay), not per decide() call. */
  maxDecisionsPerRun: number
  /** llm-judge backend config — required only when the fallback (or
   *  primary, via connectors.judge) is llm-judge. */
  llm?: JudgeLlmConfig
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  mode: 'off',
  model: 'jev-latest',
  baseUrl: 'https://api.typesafe.ai',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  confidence: 0.6,
  timeoutMs: 3000,
  maxDecisionsPerRun: 50,
}

const JUDGE_MODES = ['off', 'shadow'] as const

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined

/** bro.config.json `judge` section — bad values warn + fall back. */
export const judgeSection: ConfigSection<JudgeConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  if (
    obj.mode !== undefined &&
    !(JUDGE_MODES as readonly unknown[]).includes(obj.mode)
  ) {
    console.error(
      `bro.config: judge.mode must be "off" or "shadow" — got ${JSON.stringify(obj.mode)}`
    )
  }
  const llmObj = (
    typeof obj.llm === 'object' && obj.llm !== null ? obj.llm : {}
  ) as Record<string, unknown>
  const llmBase = str(llmObj.baseUrl)
  const llmModel = str(llmObj.model)
  // an llm section missing either half is unusable — warn instead of
  // silently configuring a fallback that can never answer
  const llm =
    llmBase !== undefined && llmModel !== undefined
      ? { baseUrl: llmBase, model: llmModel, apiKeyEnv: str(llmObj.apiKeyEnv) }
      : undefined
  if (obj.llm !== undefined && llm === undefined) {
    console.error(
      'bro.config: judge.llm needs both "baseUrl" and "model" — llm-judge disabled'
    )
  }
  // a supplied-but-invalid scalar warns, then falls back — a config
  // mistake must never silently change escalation behavior
  const numField = (name: string, min: number, max: number): number | undefined => {
    const v = num(obj[name], min, max)
    if (v === undefined && obj[name] !== undefined) {
      console.error(`bro.config: judge.${name} must be a number in ${min}..${max}`)
    }
    return v
  }
  return {
    mode: (JUDGE_MODES as readonly unknown[]).includes(obj.mode)
      ? (obj.mode as JudgeConfig['mode'])
      : DEFAULT_JUDGE_CONFIG.mode,
    model: str(obj.model) ?? DEFAULT_JUDGE_CONFIG.model,
    baseUrl: str(obj.baseUrl) ?? DEFAULT_JUDGE_CONFIG.baseUrl,
    apiKeyEnv: str(obj.apiKeyEnv) ?? DEFAULT_JUDGE_CONFIG.apiKeyEnv,
    confidence: numField('confidence', 0, 1) ?? DEFAULT_JUDGE_CONFIG.confidence,
    fallback: str(obj.fallback),
    timeoutMs:
      numField('timeoutMs', 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_JUDGE_CONFIG.timeoutMs,
    maxDecisionsPerRun:
      numField('maxDecisionsPerRun', 1, Number.MAX_SAFE_INTEGER) ??
      DEFAULT_JUDGE_CONFIG.maxDecisionsPerRun,
    llm,
  }
}

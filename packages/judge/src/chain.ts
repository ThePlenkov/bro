/**
 * The judge chain — one decide() over primary + optional fallback
 * (spec: specs/sessions/bro-f4ot.2-judge.md). Primary answers →
 * answers under `judge.confidence` are re-asked on the `judge.fallback`
 * connector → merge (fallback answers keep `decidedBy` honest) →
 * `lowConfidence` lists whatever neither backend answered confidently.
 * Facade-internal: the consumer called one decide().
 *
 * Provider mode (spec: bro-ribc.1): `judge.provider` names a
 * `providers` entry and bypasses connector resolution — the entry's
 * kind picks the adapter; `judge.fallback` then names a provider, not
 * a connector. Legacy judge.* + connectors.judge config keeps working
 * through synthesized entries — one deprecation line per command.
 */
import {
  facade,
  facadeName,
  loadConfig,
  JudgeUnavailable,
  requireProviderSurface,
  warnDeprecated,
} from '@broject/core'
import type {
  ConnectorCtx,
  DecideResult,
  JudgeAnswer,
  JudgeFacade,
  ProviderEntry,
} from '@broject/core'
import { judgeSection, type JudgeConfig } from './config.ts'
import { callWithin } from './deadline.ts'
import {
  providerJudge,
  providerKeyField,
  synthesizedProviders,
} from './provider-judge.ts'
import type { FetchFn } from './http.ts'

// the deadline seam moved to ./deadline.ts — re-exported so importers
// of './chain.ts' (systemone, llm-judge, provider-judge) keep working
export { deadlineJudge } from './deadline.ts'
export type { DeadlineJudge } from './deadline.ts'

const lowKeys = (answers: Record<string, JudgeAnswer>, threshold: number): string[] =>
  Object.entries(answers)
    .filter(([, a]) => a.confidence < threshold)
    .map(([k]) => k)

/** Sum usage across the chained calls — fields absent on either side
 *  stay absent (never fabricate a cost). */
function mergeUsage(
  a: DecideResult['usage'],
  b: DecideResult['usage']
): DecideResult['usage'] {
  if (a === undefined && b === undefined) {
    return undefined
  }
  const out: { inputTokens?: number; costUsd?: number } = {}
  const tokens = (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0)
  if (tokens > 0) {
    out.inputTokens = tokens
  }
  const cost = (a?.costUsd ?? 0) + (b?.costUsd ?? 0)
  if (cost > 0) {
    out.costUsd = cost
  }
  return out
}

/** Primary → fallback composition. `primary`/`fallback` are already
 *  resolved facades; the chain owns the shared deadline and the
 *  confidence threshold, per spec. */
export function chainedJudge(
  primary: JudgeFacade,
  fallback: JudgeFacade | undefined,
  opts: { confidence: number; timeoutMs: number }
): JudgeFacade {
  return {
    async decide(state, questions) {
      const started = Date.now()
      const deadline = started + opts.timeoutMs
      const res = await callWithin(primary, state, questions, deadline)
      // an asked question with no answer at all is as unconfident as a
      // low one — it escalates and lands in lowConfidence the same way
      const unconfident = (ans: Record<string, JudgeAnswer>): string[] => [
        // hasOwn — 'constructor' in ans is true via the prototype even
        // when no answer landed; `in` would hide an unanswered qid
        ...Object.keys(questions).filter((k) => !Object.hasOwn(ans, k)),
        ...lowKeys(ans, opts.confidence),
      ]
      const low = unconfident(res.answers)
      if (low.length === 0) {
        return { ...res, lowConfidence: [] }
      }
      // no fallback configured, or no budget left to spend on one —
      // low-confidence answers mark the list, they aren't hidden
      if (fallback === undefined || Date.now() >= deadline) {
        return { ...res, lowConfidence: low }
      }
      // a low key that isn't an asked question (or is an inherited name
      // like 'toString') has no question payload to re-ask
      const retry = Object.fromEntries(
        low.filter((k) => Object.hasOwn(questions, k)).map((k) => [k, questions[k]!])
      )
      let esc: DecideResult
      try {
        esc = await callWithin(fallback, state, retry, deadline)
      } catch (err) {
        // unavailability is fail-open; an ordinary error is the
        // caller's bug (validation) — propagate, don't masquerade as
        // "no confident answer"
        if (!(err instanceof JudgeUnavailable)) {
          throw err
        }
        return { ...res, lowConfidence: low }
      }
      const answers = { ...res.answers }
      for (const k of low) {
        // hasOwn — an inherited member (esc.answers['constructor'] is
        // Object itself) is not an answer and must not be merged in
        const a = Object.hasOwn(esc.answers, k) ? esc.answers[k] : undefined
        if (a !== undefined) {
          answers[k] = a
        }
      }
      return {
        answers,
        model: res.model,
        latencyMs: Date.now() - started,
        usage: mergeUsage(res.usage, esc.usage),
        lowConfidence: unconfident(answers),
      }
    },
  }
}

/** The normalized judge config + connector preferences + provider
 *  registry for a dir — loadConfig normalizes every section through
 *  the same schema the CLI registers, so package consumers and the
 *  command read identical values. */
export function judgeConfig(dir: string): {
  judge: JudgeConfig
  connectors: Record<string, string>
  providers: Record<string, ProviderEntry>
} {
  try {
    const cfg = loadConfig(dir, { judge: judgeSection }) as Record<string, unknown>
    return {
      judge: cfg.judge as JudgeConfig,
      connectors: cfg.connectors as Record<string, string>,
      providers: cfg.providers as Record<string, ProviderEntry>,
    }
  } catch {
    return { judge: judgeSection(undefined), connectors: {}, providers: {} }
  }
}

export interface JudgeFacadeOpts {
  /** Explicit primary connector — wins over connectors.judge config.
   *  The connector namespace is the legacy surface: passing it keeps
   *  the synthesized-entry path even when judge.provider is set. */
  connector?: string
  /** Test seam — provider-mode bindings take a scripted transport. */
  fetch?: FetchFn
}

/** Judge config keys that feed a provider-shaped decision — the
 *  deprecation line keys off the user having written one, not off the
 *  default path a bare config walks. */
const LEGACY_PROVIDER_KEYS = new Set(['model', 'baseUrl', 'apiKeyEnv', 'llm', 'fallback'])

/** The names legacy config materializes — a resolve that lands on one
 *  the user didn't define is consuming a synthesized entry. */
const SYNTHESIZED_ALIASES = new Set(['systemone', 'llm-judge'])

let legacyWarned = false

function warnLegacyJudgeOnce(): void {
  if (legacyWarned) {
    return
  }
  legacyWarned = true
  warnDeprecated(
    'judge resolution via connectors.judge / judge.{model,baseUrl,apiKeyEnv,llm,fallback} — they synthesize provider entries',
    'write a providers entry + judge.provider (spec bro-ribc.1)'
  )
}

/** One deprecation line per command — the legacy surfaces still work
 *  (they synthesize provider entries), the warning is the migration
 *  nudge. A serving connector outside the judge aliases isn't ours to
 *  deprecate, and a config with no provider-shaping keys written is
 *  the default path, not a legacy config. */
function warnLegacyJudge(
  cfg: JudgeConfig,
  connectors: Record<string, string>,
  connectorOpt: string | undefined,
  serving: string
): void {
  if (legacyWarned || (serving !== 'systemone' && serving !== 'llm-judge')) {
    return
  }
  const legacyInUse =
    connectorOpt !== undefined ||
    connectors.judge !== undefined ||
    (cfg.provided ?? []).some((k) => LEGACY_PROVIDER_KEYS.has(k))
  if (legacyInUse) {
    warnLegacyJudgeOnce()
  }
}

/** Resolve the serving judge facade for `dir`. Provider mode:
 *  `judge.provider` names a registry entry — kind picks the adapter,
 *  `judge.fallback` names a second provider (the synthesized legacy
 *  aliases resolve too), an unknown name is a startup error.
 *  Legacy mode: the standard precedence (explicit → connectors.judge
 *  → registry order) over connectors that now wrap synthesized
 *  entries, then the `judge.fallback` connector — a name with no
 *  `judge` capability throws: a misconfigured name is loud, never a
 *  silent downgrade to primary-only. */
export function judgeFacade(dir: string, opts: JudgeFacadeOpts = {}): JudgeFacade {
  const { judge: cfg, connectors, providers } = judgeConfig(dir)
  const ctx: ConnectorCtx = { dir }
  if (cfg.provider !== undefined && opts.connector === undefined) {
    const entries = synthesizedProviders(cfg, providers)
    // a resolve that lands on a synthesized alias is consuming legacy
    // judge.* config — it works, but it's the surface we're retiring
    const hitsAlias = (n: string | undefined): boolean =>
      n !== undefined && providers[n] === undefined && SYNTHESIZED_ALIASES.has(n)
    if (hitsAlias(cfg.provider) || hitsAlias(cfg.fallback)) {
      warnLegacyJudgeOnce()
    }
    // judge.model is the PRIMARY's knob — it overrides the entry pin
    // only when the user wrote a usable value, and it never touches
    // the fallback's pin (that's its own contract)
    const model = cfg.provided?.includes('model') ? cfg.model : undefined
    const primary = providerJudge(
      cfg.provider,
      requireProviderSurface(entries, cfg.provider, 'call'),
      cfg,
      { fetch: opts.fetch, model, keyField: providerKeyField(cfg.provider, providers) }
    )
    const fallback =
      cfg.fallback !== undefined && cfg.fallback !== cfg.provider
        ? providerJudge(
            cfg.fallback,
            requireProviderSurface(entries, cfg.fallback, 'call'),
            cfg,
            {
              fetch: opts.fetch,
              keyField: providerKeyField(cfg.fallback, providers),
            }
          )
        : undefined
    return chainedJudge(primary, fallback, cfg)
  }
  const serving = facadeName('judge', ctx, {
    connector: opts.connector,
    prefer: connectors,
  })
  warnLegacyJudge(cfg, connectors, opts.connector, serving)
  const primary = facade('judge', ctx, { connector: opts.connector, prefer: connectors })
  const fallback =
    cfg.fallback !== undefined && cfg.fallback !== serving
      ? facade('judge', ctx, { connector: cfg.fallback })
      : undefined
  return chainedJudge(primary, fallback, cfg)
}

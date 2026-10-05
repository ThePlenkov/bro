/**
 * The `systemone` provider binding — TypeSafe's System One API
 * (spec: specs/bro-ribc.1.md, wire contract per
 * specs/sessions/bro-f4ot.2-judge.md). POST {baseUrl}/v1/systemone with
 * Bearer $<apiKeyEnv>; `baseUrl` defaults to the hosted API, env
 * TYPESAFE_BASE_URL overrides. Typed fidelity — the wire speaks
 * choice/score/noul natively; drift fails open (JudgeUnavailable).
 *
 * `by` is the caller's provenance stamp — `provider:<name>` for a
 * registry entry, the bare alias for a synthesized legacy one.
 * `keyField` is the config path error messages name (never the env
 * var's NAME — an all-caps pasted key would echo the secret).
 */
import { isEnvName, JudgeUnavailable } from '@broject/core'
import type { DecideResult, ProviderEntry } from '@broject/core'
import {
  mapUsage,
  objOr,
  postJson,
  runKeyCommand,
  stripTrailingSlashes,
  type FetchFn,
  type HttpResult,
} from './http.ts'
import type { AcpSeam, ProviderCall } from './registry.ts'
import { mapTypedAnswers } from './typed.ts'

type SystemoneEntry = Extract<ProviderEntry, { type: 'systemone' }>

/** The hosted API default — the entry's baseUrl is optional for this
 *  kind (PROVIDER_REGISTRY), so the binding owns the fallback. */
const DEFAULT_BASE_URL = 'https://api.typesafe.ai'

export interface ProviderWireOpts {
  /** Test seam — injects a scripted transport. */
  fetch?: FetchFn
  /** Per-call model override — wins over the entry's pinned model
   *  (`judge.model` in provider mode); provenance still reports the
   *  resolved model. */
  model?: string
  /** The config FIELD path error messages name — never the env var's
   *  name, which could BE the pasted secret. */
  keyField?: string
  /** acp-kind session seam (spec bro-ribc.1 §acp) — `peer` replaces the
   *  spawned `command` with an in-process AgentApp (tests), `cwd` is
   *  the session's working directory (default: process.cwd()). */
  acp?: AcpSeam
}

/** The configured key — apiKeyCommand (secret-store lookup) wins over
 *  apiKeyEnv; a non-NAME apiKeyEnv is a config bug (throws, never
 *  echoed); a missing var is fail-open, and every message names the
 *  config FIELD, never the value. */
function apiKey(entry: SystemoneEntry, keyField: string, deadline: number): string {
  if (entry.apiKeyCommand !== undefined) {
    return runKeyCommand(entry.apiKeyCommand, keyField, deadline)
  }
  if (entry.apiKeyEnv === undefined || !isEnvName(entry.apiKeyEnv)) {
    throw new Error(`${keyField} is not a valid environment variable name`)
  }
  const key = process.env[entry.apiKeyEnv]
  if (key === undefined || key === '') {
    throw new JudgeUnavailable(
      `the env var named by ${keyField} is not set — export a TypeSafe API key (https://docs.typesafe.ai)`
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

/** The typed call surface for a `systemone` entry — one decide() over
 *  the shared deadline. */
export function systemoneCall(
  by: string,
  entry: SystemoneEntry,
  opts: ProviderWireOpts = {}
): ProviderCall {
  const keyField = opts.keyField ?? 'apiKeyEnv'
  const model = opts.model ?? entry.model
  const base = process.env.TYPESAFE_BASE_URL ?? entry.baseUrl ?? DEFAULT_BASE_URL
  const endpoint = `${stripTrailingSlashes(base)}/v1/systemone`
  return async (state, questions, deadline): Promise<DecideResult> => {
    const key = apiKey(entry, keyField, deadline)
    const started = Date.now()
    const res = await postJson(
      endpoint,
      { model, state, questions },
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
    // map only asked questions — an unasked id in the reply is drift
    // we ignore, an asked-but-absent one is "no verdict" (the chain
    // marks it low), an asked-but-malformed one fails open
    const answers = mapTypedAnswers(body.answers, questions, by, 'systemone')
    return {
      answers,
      model: typeof body.model === 'string' ? body.model : model,
      latencyMs: Date.now() - started,
      usage: mapUsage(body, 'input_tokens'),
      // the chain owns thresholding — a raw backend reports none
      lowConfidence: [],
    }
  }
}

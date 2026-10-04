/**
 * Shared POST-JSON transport for judge backends. `judge.timeoutMs`
 * bounds the WHOLE chained decide() — this helper takes the run's
 * absolute deadline (epoch ms), never a per-attempt timeout: retries
 * and escalation spend the same budget (spec: bro-f4ot.2-judge).
 */
import { JudgeUnavailable } from '@broject/core'
import type { DecideResult } from '@broject/core'

export type FetchFn = typeof fetch

export interface HttpResult {
  status: number
  /** Parsed JSON body — undefined when the body isn't JSON. */
  body: unknown
}

const RETRYABLE_NETWORK = 3 // total attempts on retryable failure
const BACKOFF_MS = 150
const MAX_BACKOFF_MS = 1000

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** Remaining run budget — a call with nothing left fails before it
 *  starts, so an escalation can't restart the clock. */
export function remaining(deadline: number): number {
  return deadline - Date.now()
}

export const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

/** A probability map — a plain object (never an array) of 0..1
 *  weights; anything else is contract drift. */
export const isProbs = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((p) => isNum(p) && p >= 0 && p <= 1)

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Trailing-slash strip without a regex — a `/+$` expression on a
 *  configured URL trips the polynomial-regex scanner; a walk can't. */
export function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) {
    end -= 1
  }
  return s.slice(0, end)
}

/** Response body as a plain object — a scalar/null body reads as {}. */
export const objOr = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

/** Wire usage (`input_tokens`/`prompt_tokens`, `cost_usd`) → contract
 *  shape; a field absent on the wire stays absent — never fabricate a
 *  cost. */
export function mapUsage(
  body: Record<string, unknown>,
  tokensKey: 'input_tokens' | 'prompt_tokens'
): DecideResult['usage'] {
  const raw = objOr(body.usage)
  const usage: { inputTokens?: number; costUsd?: number } = {}
  const tokens = raw[tokensKey]
  // a token count is a nonnegative integer — a fractional or negative
  // wire value is drift, not usage
  if (Number.isSafeInteger(tokens) && (tokens as number) >= 0) {
    usage.inputTokens = tokens as number
  }
  const cost = raw.cost_usd
  if (isNum(cost) && cost >= 0) {
    usage.costUsd = cost
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** A status → retriable test — e.g. jev's `429` + every `5xx`. */
export type RetryWhen = (status: number) => boolean

/** POST a JSON payload; returns status + parsed body for the caller's
 *  error mapping. `retryWhen` (429 + 5xx for jev) and network failures
 *  get bounded backoff retries inside the deadline; expiry, exhaustion,
 *  and DNS/TLS-style failures all surface as JudgeUnavailable —
 *  fail-open is the contract. */
export async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  deadline: number,
  retryWhen: RetryWhen,
  fetchImpl: FetchFn = fetch
): Promise<HttpResult> {
  // serialize once, up front — a cyclic or BigInt payload is the
  // caller's bug and must throw as an ordinary error, not be retried
  // and reported as the backend being unreachable
  const bodyJson = JSON.stringify(payload)
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRYABLE_NETWORK; attempt += 1) {
    const left = remaining(deadline)
    if (left <= 0) {
      throw new JudgeUnavailable(`judge backend timed out (budget spent)`)
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: bodyJson,
        signal: AbortSignal.timeout(left),
      })
      const text = await res.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
      if (!retryWhen(res.status) || attempt === RETRYABLE_NETWORK - 1) {
        return { status: res.status, body }
      }
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new JudgeUnavailable(`judge backend timed out`)
      }
      lastErr = err
    }
    // bounded backoff — capped, and the next attempt must still fit
    // the deadline
    const wait = Math.min(BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
    if (remaining(deadline) - wait <= 0) {
      break
    }
    await sleep(wait) // NOSONAR — bounded serial retries; overlapping attempts would defeat the backoff
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new JudgeUnavailable(`judge backend unreachable — ${msg}`)
}

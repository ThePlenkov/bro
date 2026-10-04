/**
 * Shared POST-JSON transport for judge backends. `judge.timeoutMs`
 * bounds the WHOLE chained decide() — this helper takes the run's
 * absolute deadline (epoch ms), never a per-attempt timeout: retries
 * and escalation spend the same budget (spec: bro-f4ot.2-judge).
 */
import { JudgeUnavailable } from '@broject/core'

export type FetchFn = typeof fetch

export interface HttpResult {
  status: number
  /** Parsed JSON body — undefined when the body isn't JSON. */
  body: unknown
}

const RETRYABLE_NETWORK = 3 // total attempts on retryable failure
const BACKOFF_MS = 150

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** Remaining run budget — a call with nothing left fails before it
 *  starts, so an escalation can't restart the clock. */
export function remaining(deadline: number): number {
  return deadline - Date.now()
}

/** POST a JSON payload; returns status + parsed body for the caller's
 *  error mapping. `retryStatuses` (502/429/…) and network failures get
 *  bounded backoff retries inside the deadline; expiry, exhaustion, and
 *  DNS/TLS-style failures all surface as JudgeUnavailable — fail-open
 *  is the contract. */
export async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  deadline: number,
  retryStatuses: readonly number[],
  fetchImpl: FetchFn = fetch
): Promise<HttpResult> {
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
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(left),
      })
      const text = await res.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
      if (!retryStatuses.includes(res.status) || attempt === RETRYABLE_NETWORK - 1) {
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
    // bounded backoff — the next attempt must still fit the deadline
    const wait = BACKOFF_MS * 2 ** attempt
    if (remaining(deadline) - wait <= 0) {
      break
    }
    await sleep(wait)
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new JudgeUnavailable(`judge backend unreachable — ${msg}`)
}

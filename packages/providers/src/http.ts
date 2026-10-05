/**
 * Shared POST-JSON transport for provider bindings. The caller's
 * absolute deadline (epoch ms) bounds the WHOLE call — never a
 * per-attempt timeout: retries spend the same budget (spec:
 * bro-f4ot.2-judge, bro-ribc.1).
 */
import { execFileSync } from 'node:child_process'
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
  while (end > 0 && s.codePointAt(end - 1) === 47) {
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

/** A status → retriable test — e.g. systemone's `429` + every `5xx`. */
export type RetryWhen = (status: number) => boolean

/** POST a JSON payload; returns status + parsed body for the caller's
 *  error mapping. `retryWhen` (429 + 5xx for systemone) and network failures
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

/** Minimal operator-config tokenizer — the same rules acp.ts exposes
 *  as shellWords, minus the acp-specific error type so non-acp
 *  consumers (key commands) can share it. */
export function splitShellWords(command: string): string[] {
  const words: string[] = []
  let cur = ''
  let open = false
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === undefined && (ch === "'" || ch === '"')) {
      quote = ch
      open = true
    } else if (ch === quote) {
      quote = undefined
    } else if (quote === undefined && ch === '\\' && i + 1 < command.length) {
      cur += command[++i]
      open = true
    } else if (quote === undefined && /\s/.test(ch)) {
      if (open) {
        words.push(cur)
        cur = ''
        open = false
      }
    } else {
      cur += ch
      open = true
    }
  }
  if (quote !== undefined) {
    throw new Error(`unclosed ${quote} quote`)
  }
  if (open) {
    words.push(cur)
  }
  return words
}

const KEY_COMMAND_TIMEOUT_MS = 10_000

/** A secret from an operator-configured command (`apiKeyCommand`) —
 *  the config names a PROGRAM (secret-tool, pass, op …), the key only
 *  ever exists on its stdout. Exec'd without a shell under a short
 *  timeout; anything but a non-empty stdout is fail-open, and the
 *  message names the field, never the command's stderr (a tool may
 *  echo fragments of what it was fed). The wait is synchronous, so it
 *  shares the caller's deadline: a hung lookup can't burn past the
 *  budget postJson would check only after stdout returns. */
export function runKeyCommand(command: string, keyField: string, deadline?: number): string {
  const argv = splitShellWords(command)
  const bin = argv[0]
  if (bin === undefined) {
    throw new Error(`${keyField} is empty`)
  }
  const left = deadline === undefined ? KEY_COMMAND_TIMEOUT_MS : remaining(deadline)
  if (left <= 0) {
    throw new JudgeUnavailable(`${keyField} command never ran — the call's budget is spent`)
  }
  let out: string
  try {
    out = execFileSync(bin, argv.slice(1), {
      encoding: 'utf8',
      timeout: Math.min(KEY_COMMAND_TIMEOUT_MS, left),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err)
    throw new JudgeUnavailable(`${keyField} command failed — ${msg}`)
  }
  const key = out.trim()
  if (key === '') {
    throw new JudgeUnavailable(`${keyField} command produced no key`)
  }
  return key
}

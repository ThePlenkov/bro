/**
 * `bro serve` provider plane — the Anthropic Messages API surface
 * (spec: bro-om6m8). `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
 * points a Claude Code session at this server; `/v1/*` requests are
 * byte-proxied to the configured upstream with the client's session
 * token swapped for the real credential. The proxy owns auth, not
 * the protocol — SSE frames, tool_use blocks, and beta surface all
 * pass through untouched, so the wire contract is the upstream's.
 *
 * Config (server-side env, never the client's):
 *   BRO_PROVIDER_UPSTREAM  default https://api.anthropic.com — any
 *                          Messages-API endpoint (Z.AI, DashScope,
 *                          a local model gateway)
 *   BRO_PROVIDER_API_KEY   the real credential — falls back to the
 *                          operator's ANTHROPIC_API_KEY / AUTH_TOKEN
 *
 * Client-side wiring (documented, not enforced):
 *   env.ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *   ANTHROPIC_AUTH_TOKEN=<serve.json token> — or apiKeyHelper that
 *   prints it; possession of the 0600 file IS the auth boundary.
 */

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ProviderConfig {
  /** Messages-API base — the proxy forwards to `<upstream><req.url>`. */
  upstream: string
  /** The real credential — replaces the client's session token. */
  apiKey: string
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com'

/** Provider config from the server's own environment — the upstream
 *  credential lives here, never in the client request. No key means
 *  the dep stays unwired and `/v1/*` 404s like any unknown path:
 *  a half-configured provider is a miss, not a degraded proxy. */
export function providerConfig(env: NodeJS.ProcessEnv): ProviderConfig | undefined {
  const apiKey =
    env.BRO_PROVIDER_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN
  if (apiKey === undefined || apiKey.trim() === '') {
    return undefined
  }
  const upstream = (env.BRO_PROVIDER_UPSTREAM ?? DEFAULT_UPSTREAM).replace(/\/+$/, '')
  return { upstream, apiKey }
}

/** Headers that must not ride the proxy — hop-by-hop framing, the
 *  listener's own Host, the swapped credentials, and any declared
 *  length (the body is streamed; Node re-frames it). */
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
  'x-api-key',
])

const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (DROP_REQUEST.has(lower) || value === undefined) {
      continue
    }
    out[lower] = Array.isArray(value) ? value.join(', ') : value
  }
  // the credential swap — the client proves the session token, the
  // upstream sees the real key; apiKeyHelper output never crosses
  out['x-api-key'] = apiKey
  out.authorization = `Bearer ${apiKey}`
  // identity only — a gzip'd upstream body would arrive decompressed
  // by fetch while the response headers still said gzip + a stale
  // content-length; forcing identity keeps the pipe byte-honest
  out['accept-encoding'] = 'identity'
  return out
}

const HAS_BODY = new Set(['POST', 'PUT', 'PATCH'])

/** The Anthropic-shaped transport error — claude-code surfaces the
 *  envelope it understands instead of a bare socket failure. */
function sendUpstreamError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(
    `${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n`
  )
}

/** `(req, res)` raw-stream proxy for `/v1/*` — sits below the
 *  ServeResponse envelope because real Messages bodies exceed the
 *  256KB readBody cap and SSE answers must pipe, never buffer. */
export function providerProxy(
  cfg: ProviderConfig
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = req.method ?? 'GET'
    const target = `${cfg.upstream}${req.url ?? '/'}`
    let upstream: Response
    try {
      upstream = await fetch(target, {
        method,
        headers: forwardHeaders(req, cfg.apiKey),
        ...(HAS_BODY.has(method)
          ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' as const }
          : {}),
      })
    } catch (err) {
      sendUpstreamError(
        res,
        502,
        `bro provider: upstream unreachable — ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    const headers: Record<string, string> = {}
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name.toLowerCase())) {
        headers[name] = value
      }
    })
    res.writeHead(upstream.status, headers)
    if (upstream.body === null) {
      res.end()
      return
    }
    const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
    // mid-stream failures can't re-send the status — destroy is the
    // honest end: the client's transport reports a truncated response
    body.on('error', () => res.destroy())
    body.pipe(res)
  }
}

/** Fire-and-forget OTEL emission — bro's own telemetry plane.
 *  Opt-in via the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (the same env
 *  claude-code reads): log events push to `<ep>/v1/logs`, spans to
 *  `<ep>/v1/traces`, as OTLP/HTTP-JSON with `service.name=bro`. Unset →
 *  silent no-ops. Never throws, never awaited — telemetry must not
 *  stall or fail the request path.
 *
 *  Trace model: one session = one trace. The conductor opens a
 *  `serve.http` span per request and passes its context down —
 *  `acp.open`/`acp.turn` spans nest under it. An incoming `traceparent`
 *  header is honored so instrumented callers (otel claude, sdk clients)
 *  land in the SAME trace; the terminal path (bro spawning `devin acp`
 *  directly) emits the same span names with `peer.*` / `child.*`
 *  attribution from the live process tree. */

import { randomBytes } from 'node:crypto'

const ENDPOINT = (): string | undefined => {
  const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  return ep === undefined || ep === '' ? undefined : ep.replace(/\/$/, '')
}

type AttrValue = string | number | boolean

function attr(k: string, v: AttrValue): { key: string; value: Record<string, unknown> } {
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { key: k, value: { intValue: v } }
      : { key: k, value: { doubleValue: v } }
  }
  if (typeof v === 'boolean') return { key: k, value: { boolValue: v } }
  return { key: k, value: { stringValue: v } }
}

const attrs = (a: Record<string, AttrValue>): { key: string; value: Record<string, unknown> }[] =>
  Object.entries(a).map(([k, v]) => attr(k, v))

const nanos = (ms: number): string => String(BigInt(ms) * 1_000_000n)

const resource = (): { attributes: { key: string; value: Record<string, unknown> }[] } => ({
  attributes: [
    attr('service.name', 'bro'),
    attr('service.version', process.env.BRO_VERSION ?? 'dev'),
  ],
})

function post(path: string, body: unknown): void {
  const ep = ENDPOINT()
  if (ep === undefined) return
  void fetch(`${ep}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {})
}

/** Push one OTEL log record. `a` becomes structured metadata —
 *  filterable in loki via `| key="value"` and unwrappable for metrics. */
export function otelEvent(name: string, a: Record<string, AttrValue> = {}): void {
  post('/v1/logs', {
    resourceLogs: [
      {
        resource: resource(),
        scopeLogs: [
          {
            scope: { name: 'bro.serve.events' },
            logRecords: [
              {
                timeUnixNano: nanos(Date.now()),
                body: { stringValue: `bro.${name}` },
                attributes: [attr('event.name', name), ...attrs(a)],
              },
            ],
          },
        ],
      },
    ],
  })
}

/** Span context — a trace/span id pair handed down the call tree.
 *  `parent` links into a caller's trace (e.g. a traceparent header);
 *  undefined parent = this span roots a fresh trace. */
export interface OtelCtx {
  traceId: string
  spanId: string
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}
export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

/** Parse a W3C `traceparent` header (`00-<trace>-<span>-<flags>`) into a
 *  parent context — the conductor honors it so an instrumented caller's
 *  spans and ours land in one trace. */
export function otelParent(header: string | string[] | undefined): OtelCtx | undefined {
  const h = Array.isArray(header) ? header[0] : header
  if (h === undefined) return undefined
  const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(h.trim())
  if (m === null || m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) return undefined
  return { traceId: m[1]!, spanId: m[2]! }
}

export interface OtelSpan {
  /** Hand this down to nested emissions so their spans attach here. */
  ctx: OtelCtx
  /** Emit the completed span. `status` 'error' flips the OTEL flag. */
  end: (a?: Record<string, AttrValue>, status?: 'ok' | 'error') => void
}

/** Open a span; nothing is sent until `.end()`. `startMs` defaults to
 *  now — pass an earlier timestamp to cover work already started. */
export function otelSpan(
  name: string,
  a: Record<string, AttrValue> = {},
  opts: { parent?: OtelCtx; startMs?: number; kind?: number } = {}
): OtelSpan {
  const ctx: OtelCtx = { traceId: opts.parent?.traceId ?? newTraceId(), spanId: newSpanId() }
  const startMs = opts.startMs ?? Date.now()
  return {
    ctx,
    end: (more = {}, status = 'ok') =>
      post('/v1/traces', {
        resourceSpans: [
          {
            resource: resource(),
            scopeSpans: [
              {
                scope: { name: 'bro.acp' },
                spans: [
                  {
                    traceId: ctx.traceId,
                    spanId: ctx.spanId,
                    ...(opts.parent === undefined ? {} : { parentSpanId: opts.parent.spanId }),
                    name,
                    kind: opts.kind ?? 2, // SPAN_KIND_SERVER
                    startTimeUnixNano: nanos(startMs),
                    endTimeUnixNano: nanos(Date.now()),
                    attributes: attrs({ ...a, ...more }),
                    status:
                      status === 'error'
                        ? { code: 2, message: String(more['error'] ?? '') }
                        : { code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
  }
}

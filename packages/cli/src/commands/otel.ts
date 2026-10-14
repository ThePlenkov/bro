/** Fire-and-forget OTEL log events — the conductor's own telemetry.
 *  Opt-in via the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (the same env
 *  claude-code reads): when set, events push to `<ep>/v1/logs` as
 *  OTLP/HTTP-JSON with `service.name=bro`; unset → a silent no-op.
 *  Never throws, never awaited — telemetry must not stall or fail the
 *  request path. */

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

/** Push one OTEL log record. `attrs` become structured metadata —
 *  filterable in loki via `| key="value"` and unwrappable for metrics. */
export function otelEvent(name: string, attrs: Record<string, AttrValue> = {}): void {
  const ep = ENDPOINT()
  if (ep === undefined) return
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr('service.name', 'bro'),
            attr('service.version', process.env.BRO_VERSION ?? 'dev'),
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'bro.serve.events' },
            logRecords: [
              {
                timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                body: { stringValue: `bro.${name}` },
                attributes: [
                  attr('event.name', name),
                  ...Object.entries(attrs).map(([k, v]) => attr(k, v)),
                ],
              },
            ],
          },
        ],
      },
    ],
  })
  void fetch(`${ep}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body,
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {})
}

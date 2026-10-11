/** `telemetry` config section — a separate module so plugins.ts can
 *  register the schema without importing the command's dependency tree
 *  (same pattern as drive-config.ts). Holds the OTLP exporter knobs;
 *  the perf journals need no config. */
import type { ConfigSection } from '@broject/core'

export interface OtlpConfig {
  /** Collector base URL — `http://host:4318` or a full `/v1/traces`
   *  path. Empty means off (the default). */
  endpoint: string
  /** Extra request headers (auth tokens live here — config, never argv). */
  headers: Record<string, string>
  /** service.name on exported spans. */
  serviceName: string
  /** Min ms between auto-flush respawns from the post-tool hook. */
  flushMs: number
  /** POST timeout — a wedged collector degrades to a dropped batch. */
  timeoutMs: number
}

export interface TelemetryConfig {
  otlp: OtlpConfig
}

export const DEFAULT_OTLP_FLUSH_MS = 60_000
export const DEFAULT_OTLP_TIMEOUT_MS = 10_000
export const DEFAULT_OTLP_SERVICE = 'bro'

const posInt = (v: unknown, dflt: number, min = 1): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.ceil(v) : dflt

/** bro.config.json `telemetry` section. */
export const telemetrySection: ConfigSection<TelemetryConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const otlp = (typeof obj.otlp === 'object' && obj.otlp !== null ? obj.otlp : {}) as Record<
    string,
    unknown
  >
  return {
    otlp: {
      endpoint:
        typeof otlp.endpoint === 'string' && otlp.endpoint.trim() !== ''
          ? otlp.endpoint.trim()
          : '',
      headers:
        typeof otlp.headers === 'object' && otlp.headers !== null && !Array.isArray(otlp.headers)
          ? Object.fromEntries(
              Object.entries(otlp.headers).filter(
                ([k, v]) => typeof k === 'string' && typeof v === 'string'
              )
            )
          : {},
      serviceName:
        typeof otlp.serviceName === 'string' && otlp.serviceName.trim() !== ''
          ? otlp.serviceName.trim()
          : DEFAULT_OTLP_SERVICE,
      flushMs: posInt(otlp.flushMs, DEFAULT_OTLP_FLUSH_MS),
      timeoutMs: posInt(otlp.timeoutMs, DEFAULT_OTLP_TIMEOUT_MS),
    },
  }
}

/** `k=v,k2=v2` — the OTEL_EXPORTER_OTLP_HEADERS wire shape. Bare or
 *  empty items drop silently; a malformed env must not kill telemetry
 *  resolution. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined) {
    return out
  }
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k !== '') {
      out[k] = v
    }
  }
  return out
}

/** Merge config + OTEL_* env into the effective OTLP settings — env
 *  wins on every key (the operator's live override, same rule as
 *  BRO_GLOBAL_BEADS). `BRO_TELEMETRY=0` short-circuits to a null
 *  endpoint: telemetry off is absolute, not configurable. */
export function resolveOtlp(
  cfg: OtlpConfig,
  env: NodeJS.ProcessEnv = process.env
): OtlpConfig {
  if (env.BRO_TELEMETRY === '0') {
    return { ...cfg, endpoint: '' }
  }
  const endpoint = (
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    cfg.endpoint
  ).trim()
  return {
    endpoint,
    headers: { ...cfg.headers, ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) },
    serviceName:
      env.OTEL_SERVICE_NAME !== undefined && env.OTEL_SERVICE_NAME.trim() !== ''
        ? env.OTEL_SERVICE_NAME.trim()
        : cfg.serviceName,
    flushMs: cfg.flushMs,
    timeoutMs: cfg.timeoutMs,
  }
}

/** POST URL for the traces signal — a configured `/v1/traces` tail is
 *  used verbatim (Langfuse's `/api/public/otel` prefix needs the base
 *  form, a bare collector port needs the append). */
export function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '')
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`
}

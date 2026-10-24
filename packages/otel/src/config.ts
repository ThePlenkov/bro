/** `otel` config section — the hook-telemetry policy (spec
 *  specs/bro-xgejl.md). The facade owns this schema so it resolves the
 *  same section whether it runs inside `bro hooks` or a long-lived
 *  host; the CLI registers it as the `otel` plugin's configKey.
 *
 *  Shape:
 *    otel: {
 *      enabled: boolean                      // default false — off means zero payload work
 *      exporter: { type: 'file'|'otlp'|'stdout', path?, endpoint?, headers? }
 *      hooks: { '*': false|true|{sample?, collect?}, '<hook>': same }
 *    }
 *
 *  `'*'` is the default per-hook policy, a named entry overrides it.
 *  `true` enables the hook at meta-only level (event + session +
 *  duration + outcome — never payload); an object adds `sample` (keep
 *  probability) and `collect` (dotted payload paths to export). `false`
 *  drops the hook entirely. An absent `'*'` reads as `true`: the
 *  master `enabled` switch alone is enough to light every hook at the
 *  count level — `'*': false` is the "enabled but silent" spelling. */
import type { ConfigSection } from '@broject/core'

export const OTEL_EXPORTER_TYPES = ['file', 'otlp', 'stdout'] as const
export type OtelExporterType = (typeof OTEL_EXPORTER_TYPES)[number]

/** Every event the bro dispatch can emit — the catalog `bro otel
 *  status` and the skill document. Kebab names; host spellings map
 *  through `hookEventName`. The last three are the payload-less
 *  git-hook events — they emit meta rows only. */
export const OTEL_HOOK_EVENTS = [
  'session-start',
  'post-compaction',
  'pre-compact',
  'prompt-submit',
  'pre-tool',
  'post-tool',
  'stop',
  'permission',
  'prepare-commit-msg',
  'reference-transaction',
  'post-merge',
] as const

export interface OtelHookPolicy {
  /** false drops the hook before any record is built. */
  enabled: boolean
  /** Keep probability per event, clamped [0,1]. */
  sample: number
  /** Dotted payload paths allowed into the record — empty = meta only. */
  collect: string[]
}

export interface OtelExporterConfig {
  type: OtelExporterType
  /** file sink path — '' resolves to <git-common>/bro/otel/hooks.jsonl. */
  path: string
  /** otlp collector base URL — '' falls back to the standard
   *  OTEL_EXPORTER_OTLP_* env / provider.env resolution. */
  endpoint: string
  /** otlp-only request headers (auth tokens live here, never argv). */
  headers: Record<string, string>
}

export interface OtelConfig {
  enabled: boolean
  exporter: OtelExporterConfig
  /** Resolved per-hook policies keyed by bro event name; `'*'` is the
   *  fallback entry — always materialized. */
  hooks: Record<string, OtelHookPolicy>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** One hooks-table entry → a normalized policy. `false` = off,
 *  `true`/absent fields = on with sample 1 and no payload collection. */
function hookPolicy(raw: unknown): OtelHookPolicy {
  if (raw === false) {
    return { enabled: false, sample: 1, collect: [] }
  }
  const obj = isObj(raw) ? raw : {}
  return {
    enabled: obj.enabled !== false,
    sample:
      typeof obj.sample === 'number' && Number.isFinite(obj.sample)
        ? Math.min(1, Math.max(0, obj.sample))
        : 1,
    collect: Array.isArray(obj.collect)
      ? obj.collect.filter((f): f is string => typeof f === 'string' && f !== '')
      : [],
  }
}

/** bro.config `otel` section. */
export const otelSection: ConfigSection<OtelConfig> = (raw) => {
  const obj = isObj(raw) ? raw : {}
  const exporter = isObj(obj.exporter) ? obj.exporter : {}
  const hooks = isObj(obj.hooks) ? obj.hooks : {}
  const type: OtelExporterType = OTEL_EXPORTER_TYPES.includes(
    exporter.type as OtelExporterType
  )
    ? (exporter.type as OtelExporterType)
    : 'file'
  return {
    enabled: obj.enabled === true,
    exporter: {
      type,
      path:
        typeof exporter.path === 'string' && exporter.path.trim() !== ''
          ? exporter.path.trim()
          : '',
      endpoint:
        typeof exporter.endpoint === 'string' && exporter.endpoint.trim() !== ''
          ? exporter.endpoint.trim()
          : '',
      headers: isObj(exporter.headers)
        ? Object.fromEntries(
            Object.entries(exporter.headers).filter(
              ([k, v]) => typeof k === 'string' && typeof v === 'string'
            )
          )
        : {},
    },
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([name, v]) => [name, hookPolicy(v)])
    ),
  }
}

/** The resolved policy for one hook — its own entry when configured,
 *  else `'*'`, else on-at-meta-level (see the module doc: absent `'*'`
 *  reads as `true`). */
export function resolveHookPolicy(cfg: OtelConfig, name: string): OtelHookPolicy {
  return cfg.hooks[name] ?? cfg.hooks['*'] ?? { enabled: true, sample: 1, collect: [] }
}

/** Host event spellings → bro's kebab event names — `bro otel test`
 *  and `collect` policies speak either dialect. Unmapped input lowercases
 *  verbatim (already-bro names pass through). */
export function hookEventName(raw: string): string {
  const host: Record<string, string> = {
    sessionstart: 'session-start',
    postcompaction: 'post-compaction',
    precompact: 'pre-compact',
    userpromptsubmit: 'prompt-submit',
    pretooluse: 'pre-tool',
    posttooluse: 'post-tool',
    posttoolusefailure: 'post-tool',
    stop: 'stop',
    permissionrequest: 'permission',
    preparecommitmsg: 'prepare-commit-msg',
    referencetransaction: 'reference-transaction',
    postmerge: 'post-merge',
  }
  const key = raw.trim().toLowerCase()
  return host[key] ?? key
}

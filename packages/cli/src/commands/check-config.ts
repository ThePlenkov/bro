/**
 * `check` config section for `bro check` — a leaf module so plugins.ts
 * can register the schema at load time without cycling through
 * check.ts (which needs plugins.ts's loadBroConfig at run time).
 */
import type { ConfigSection } from '@broject/core'

export interface CheckConfig {
  /** Explicit sverka binary (path or PATH command) — skips resolution. */
  bin?: string
  /** sverka --config path. */
  config?: string
  /** sverka --entry id. */
  entry?: string
  /** sverka --executor. */
  executor?: 'host' | 'docker'
  /** pass --evaluate — collect *.sarif artifacts and run the policy gate. */
  evaluate: boolean
}

export const CHECK_EXECUTORS = ['host', 'docker'] as const

/** bro.config.json `check` section — all fields optional; bad values
 *  warn and fall back, never crash the load. */
export const checkSection: ConfigSection<CheckConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const str = (k: 'bin' | 'config' | 'entry'): string | undefined =>
    typeof obj[k] === 'string' && (obj[k] as string).trim() !== ''
      ? (obj[k] as string).trim()
      : undefined
  if (
    obj.executor !== undefined &&
    !(CHECK_EXECUTORS as readonly unknown[]).includes(obj.executor)
  ) {
    console.error(
      `bro.config: check.executor must be host|docker — got ${JSON.stringify(obj.executor)}`
    )
  }
  return {
    ...(str('bin') !== undefined ? { bin: str('bin') } : {}),
    ...(str('config') !== undefined ? { config: str('config') } : {}),
    ...(str('entry') !== undefined ? { entry: str('entry') } : {}),
    executor: (CHECK_EXECUTORS as readonly unknown[]).includes(obj.executor)
      ? (obj.executor as CheckConfig['executor'])
      : undefined,
    evaluate: obj.evaluate === true,
  }
}

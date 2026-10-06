import type { ConfigSection, Guard } from '@broject/core'
import { guardProblems } from '@broject/core'

export interface GuardConfig {
  /** Kill switch — off emits nothing. Default on: no guards declared
   *  means nothing fires anyway, so the flag exists to silence a live
   *  config, not to gate adoption. */
  enabled: boolean
  /** Cap on emitted guard lines per hook event — injection is a
   *  budget, not a dump. */
  maxPerEvent: number
  /** The repo's own guard declarations — malformed defs fail CLOSED:
   *  dropped with a warning at load, never half-parsed. */
  defs: Guard[]
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enabled: true,
  maxPerEvent: 3,
  defs: [],
}

/** bro.config.json `guard` section — bad scalars warn + fall back; a
 *  malformed def is dropped (the agent reads the warning, the guard
 *  never half-fires). */
export const guardSection: ConfigSection<GuardConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const defs = (Array.isArray(obj.defs) ? obj.defs : []).filter((d): d is Guard => {
    const problems = guardProblems(d)
    if (problems.length > 0) {
      const name = (d as { name?: unknown }).name
      const label = typeof name === 'string' ? `'${name}'` : '<unnamed>'
      console.error(
        `bro.config: guard.defs ${label} is malformed — dropped: ${problems.join('; ')}`
      )
      return false
    }
    return true
  })
  return {
    enabled:
      typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_GUARD_CONFIG.enabled,
    maxPerEvent:
      typeof obj.maxPerEvent === 'number' &&
      Number.isInteger(obj.maxPerEvent) &&
      obj.maxPerEvent >= 1
        ? obj.maxPerEvent
        : DEFAULT_GUARD_CONFIG.maxPerEvent,
    defs,
  }
}

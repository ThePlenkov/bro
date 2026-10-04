import type { ConfigSection } from '@broject/core'
import { LESSON_SOURCES } from './lesson.ts'

export interface LearnConfig {
  /** Kill switch — the connector probes emit nothing when off. Default
   *  on: an empty store injects nothing anyway, so the flag exists to
   *  silence a live store, not to gate adoption. */
  enabled: boolean
  /** Max lesson lines any single probe may emit — injection is a
   *  budget, not a dump. */
  maxInject: number
  /** Lesson sources eligible for injection — empty means all. Entries
   *  outside LessonSource would silently match nothing, so they're
   *  dropped with a warning rather than stored. */
  sources: string[]
}

export const DEFAULT_LEARN_CONFIG: LearnConfig = {
  enabled: true,
  maxInject: 3,
  sources: [],
}

/** bro.config.json `learn` section — bad values warn + fall back. */
export const learnSection: ConfigSection<LearnConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const sources = Array.isArray(obj.sources)
    ? obj.sources.filter((s): s is string => {
        const ok =
          typeof s === 'string' &&
          (LESSON_SOURCES as readonly string[]).includes(s)
        if (typeof s === 'string' && s.trim() !== '' && !ok) {
          console.error(
            `bro.config: learn.sources has unknown source ${JSON.stringify(s)} — expected one of ${LESSON_SOURCES.join('|')}`
          )
        }
        return ok
      })
    : DEFAULT_LEARN_CONFIG.sources
  // a nonempty allowlist that validates to nothing fails CLOSED — ''
  // matches no LessonSource, where [] reads as "all sources" downstream
  if (Array.isArray(obj.sources) && obj.sources.length > 0 && sources.length === 0) {
    sources.push('')
  }
  return {
    enabled:
      typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_LEARN_CONFIG.enabled,
    maxInject:
      typeof obj.maxInject === 'number' &&
      Number.isInteger(obj.maxInject) &&
      obj.maxInject >= 1
        ? obj.maxInject
        : DEFAULT_LEARN_CONFIG.maxInject,
    sources,
  }
}

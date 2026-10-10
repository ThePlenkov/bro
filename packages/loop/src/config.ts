import type { ConfigSection } from '@broject/core'
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from './types.ts'

/** `loop` config section — strings normalized, numbers must be finite
 *  non-negatives, everything else falls back to the default. */
export const loopSection: ConfigSection<LoopConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const str = (k: keyof LoopConfig) =>
    typeof obj[k] === 'string' && (obj[k] as string).trim() !== ''
      ? (obj[k] as string).trim()
      : DEFAULT_LOOP_CONFIG[k]
  const num = (
    k:
      | 'stallMin'
      | 'crashExitMs'
      | 'mergeTimeoutMin'
      | 'fixRounds'
      | 'maxItems'
      | 'maxOpen'
      | 'batch'
      | 'batchMinPriority'
      | 'parkedKeep'
      | 'parkedTtlDays',
    min = 0
  ) =>
    typeof obj[k] === 'number' && Number.isFinite(obj[k]) && (obj[k] as number) >= min
      ? (obj[k] as number)
      : DEFAULT_LOOP_CONFIG[k]
  return {
    agent: str('agent') as string,
    provider: str('provider') as string,
    profile: str('profile') as string,
    model: str('model') as string,
    bootstrap: str('bootstrap') as string,
    stallMin: num('stallMin', 1),
    crashExitMs: num('crashExitMs'),
    mergeTimeoutMin: num('mergeTimeoutMin', 1),
    fixRounds: num('fixRounds'),
    maxItems: num('maxItems'),
    maxOpen: num('maxOpen', 1),
    batch: num('batch', 1),
    batchMinPriority: num('batchMinPriority'),
    parkedKeep: num('parkedKeep'),
    parkedTtlDays: num('parkedTtlDays'),
  }
}

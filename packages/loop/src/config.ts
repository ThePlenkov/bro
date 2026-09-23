import type { ConfigSection } from '@bro/core'
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
      ? (obj[k] as string)
      : DEFAULT_LOOP_CONFIG[k]
  const num = (k: 'agentTimeoutMin' | 'mergeTimeoutMin' | 'fixRounds' | 'maxItems') =>
    typeof obj[k] === 'number' && Number.isFinite(obj[k]) && (obj[k] as number) >= 0
      ? (obj[k] as number)
      : DEFAULT_LOOP_CONFIG[k]
  return {
    agent: str('agent') as string,
    bootstrap: str('bootstrap') as string,
    agentTimeoutMin: num('agentTimeoutMin'),
    mergeTimeoutMin: num('mergeTimeoutMin'),
    fixRounds: num('fixRounds'),
    maxItems: num('maxItems'),
  }
}

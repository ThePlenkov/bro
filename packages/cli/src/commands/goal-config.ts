/** `goal` config section — a separate module so plugins.ts can register
 *  the schema without importing the command's dependency tree (same
 *  pattern as watch-config.ts). Spec: specs/goal/bro-6vcll.md. */
import type { ConfigSection } from '@broject/core'

export interface GoalConfig {
  /** Default turn budget for goals set without `--turns` — stop-hook
   *  evaluations before the goal self-pauses (`status: budget`).
   *  0 = no cap. */
  maxTurns: number
  /** false pins reminders-only even when the judge facade resolves —
   *  the model verdict is the optional upgrade, not the contract. */
  judge: boolean
}

/** bro.config.json `goal` section. */
export const goalSection: ConfigSection<GoalConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    maxTurns:
      typeof obj.maxTurns === 'number' &&
      Number.isInteger(obj.maxTurns) &&
      obj.maxTurns >= 0
        ? obj.maxTurns
        : 25,
    judge: obj.judge !== false,
  }
}

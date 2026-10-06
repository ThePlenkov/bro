export {
  GUARD_DEFAULT_BUDGET,
  GUARD_EVENTS,
  GUARD_NAME_RE,
  GUARD_SAY_MAX_CHARS,
  GUARD_SAY_MAX_LINES,
  guardProblems,
  isGuardEvent,
} from '@broject/core'
export type {
  CollectedGuard,
  Guard,
  GuardEvent,
  GuardJudge,
  GuardMatch,
  GuardState,
  GuardWhen,
} from '@broject/core'
export { collectGuards } from '@broject/core'
export type { GuardConfig } from './config.ts'
export { DEFAULT_GUARD_CONFIG, guardSection } from './config.ts'

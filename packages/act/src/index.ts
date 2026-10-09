export type { ExitGate, PrActState, PrCheck } from './types.ts'
export { fetchPrActState } from './state.ts'
export { evaluateExitGate } from './exit-gate.ts'
export { docsOnly, effectiveMaxRounds, isDocsPath } from './docs.ts'
export { gatePending, waitForGate } from './wait.ts'
export type { GateWaitResult, WaitOptions } from './wait.ts'
export {
  ACT_ACTIONS,
  parseActPlan,
  PLAN_KIND as ACT_PLAN_KIND,
  PLAN_VERSION as ACT_PLAN_VERSION,
} from './plan.ts'
export type { ActAction, ActPlan, ActThreadVerdict } from './plan.ts'
export {
  acquireMergeSlot,
  mergeSlotHolder,
  parseAcquire,
  parseCheck,
  releaseMergeSlot,
} from './merge-slot.ts'
export type { MergeSlot } from './merge-slot.ts'
export { actConnector } from './connector.ts'
export {
  deadWatchPlan,
  hasLiveWatch,
  listWatches,
  rearmWatches,
  watchBegin,
  watchEnd,
  watchHeartbeat,
  watchMarkerKind,
  watchRetire,
} from './pending-watch.ts'
export type { ListedWatch, PendingWatch } from './pending-watch.ts'
export { checkHistory, checkHistoryPath, fileCheckHistory } from './check-history.ts'
export type { CheckHistory, CheckObservation } from './check-history.ts'

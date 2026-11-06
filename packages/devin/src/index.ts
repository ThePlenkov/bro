/**
 * `@broject/devin` — the devin facade for bro.
 *
 * Everything bro knows about the devin CLI lives here: how a devin
 * session is marked (the lock dir) and counted, how the CLI's grammar
 * spells a session start, and how the store behind the lane telemetry
 * counts requests. bro's core stays vendor-blind (REVIEW.md) and asks
 * this package through the plane registry.
 *
 * NOT to be confused with the bro **devin plugin** (`plugins/devin/bro`)
 * — the client adapter that carries bro's skills and hooks into the
 * devin CLI. That one inherits this facade; it does not contain it.
 */
export {
  countDevinBatchWorkers,
  countDevinSessions,
  countDevinWorkers,
  devinLogsDir,
  devinLocksDir,
  devinPidAgentId,
  devinPidBead,
  devinPidCwd,
  devinPidIsBatch,
  devinPidIsWorker,
  devinPidLog,
  devinProcDir,
  devinSessionPlane,
  devinSessionTranscript,
  devinTranscriptsDir,
  listDevinSessions,
  renderDevinTranscript,
} from './plane.ts'
export { countDevinSessionStarts } from './starts.ts'
export {
  devinStorePath,
  devinUsageStatePath,
  emitDevinUsage,
  readDevinUsageState,
  sampleDevinUsage,
  writeDevinUsageState,
} from './usage.ts'
export type {
  DevinLaneCounts,
  DevinModelUsage,
  DevinUsageSample,
  DevinUsageState,
} from './usage.ts'

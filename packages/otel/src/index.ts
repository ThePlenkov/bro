/**
 * @broject/otel — hook-first telemetry (spec: specs/bro-xgejl.md).
 * emitHook is the single entry the hook dispatch path calls; the otel
 * config section owns enable/exporter/per-hook policy.
 */
export {
  collectFields,
  emitHook,
  hookRecord,
  otelConfigFor,
  otelConfigReset,
  otelSinkPath,
  readSinkRows,
} from './facade.ts'
export type { HookMeta, OtelHookRecord, ResolvedOtelConfig } from './facade.ts'
export {
  hookEventName,
  otelSection,
  OTEL_EXPORTER_TYPES,
  OTEL_HOOK_EVENTS,
  resolveHookPolicy,
} from './config.ts'
export type {
  OtelConfig,
  OtelExporterConfig,
  OtelExporterType,
  OtelHookPolicy,
} from './config.ts'

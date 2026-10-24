/** emitHook — the hook-telemetry facade (spec specs/bro-xgejl.md).
 *  `bro hooks <event>` dispatch calls this once per event with the
 *  normalized payload; the facade resolves the `otel` config section,
 *  applies the per-hook policy (enable + sample + collect allowlist),
 *  builds one record, and writes it to the configured sink.
 *
 *  Everything is sync and fail-open: hooks are short-lived processes
 *  on the session's critical path — telemetry must never stall, throw,
 *  or change a hook's answer. When `otel.enabled` is false (the
 *  default) the cost is one memoized config read and a boolean. */
import { randomInt } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gitCommonDir, loadConfig, withFileLock } from '@broject/core'
import { otelEvent } from '@broject/providers'
import { otelSection, resolveHookPolicy, type OtelConfig, type OtelHookPolicy } from './config.ts'

export interface HookMeta {
  sessionId?: string
  /** Host dialect the dispatch detected — cursor | codex | default. */
  client?: string
  durationMs?: number
  /** false marks the dispatch threw — the hook still answered fail-open. */
  ok?: boolean
  error?: string
  /** Config + git anchor — the repo the hook fired for (default cwd). */
  dir?: string
}

/** One exported hook event — the file/stdout sink row, and the shape
 *  `bro otel test` prints. `payload` holds only allowlisted scalars. */
export interface OtelHookRecord {
  ts: string
  event: string
  session?: string
  client: string
  ms?: number
  ok: boolean
  error?: string
  payload?: Record<string, string | number | boolean>
}

type Scalar = string | number | boolean

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `a.b.c` against the payload — scalar leaf → attribute, anything
 *  else (missing, object, array) reports back as skipped. */
function dig(payload: unknown, path: string): { hit: boolean; v?: Scalar } {
  let cur: unknown = payload
  for (const seg of path.split('.')) {
    if (!isObj(cur)) return { hit: false }
    // own-property descriptor — a `__proto__`/`constructor` segment in a
    // collect path reads the prototype chain on a bracket access; the
    // descriptor form keeps the payload a pure data walk.
    const d = Object.getOwnPropertyDescriptor(cur, seg)
    if (d === undefined) return { hit: false }
    cur = d.value
  }
  if (typeof cur === 'string' || typeof cur === 'boolean') return { hit: true, v: cur }
  if (typeof cur === 'number' && Number.isFinite(cur)) return { hit: true, v: cur }
  return { hit: false }
}

/** Apply the collect allowlist — `fields` are the scalars that made it
 *  into the record, `skipped` the requested paths with no scalar leaf. */
export function collectFields(
  payload: unknown,
  collect: string[]
): { fields: Record<string, Scalar>; skipped: string[] } {
  const fields: Record<string, Scalar> = {}
  const skipped: string[] = []
  for (const path of collect) {
    const r = dig(payload, path)
    if (r.hit) fields[path] = r.v as Scalar
    else skipped.push(path)
  }
  return { fields, skipped }
}

/** Build the export record for one event — pure, exported so
 *  `bro otel test` can show exactly what a sink would receive. */
export function hookRecord(
  name: string,
  payload: unknown,
  meta: HookMeta,
  policy: OtelHookPolicy
): { record: OtelHookRecord; skipped: string[] } {
  const { fields, skipped } = collectFields(payload, policy.collect)
  const record: OtelHookRecord = {
    ts: new Date().toISOString(),
    event: `hook.${name}`,
    client: meta.client ?? 'default',
    ok: meta.ok !== false,
  }
  if (meta.sessionId !== undefined && meta.sessionId !== '') record.session = meta.sessionId
  if (meta.durationMs !== undefined) record.ms = meta.durationMs
  if (meta.error !== undefined && meta.error !== '') record.error = meta.error
  if (Object.keys(fields).length > 0) record.payload = fields
  return { record, skipped }
}

// --- sinks ---------------------------------------------------------------------

/** file exporter cap — same journal discipline as the perf/trace
 *  files: a size ceiling that trims to a kept tail, never unbounded. */
const SINK_MAX_BYTES = 512 * 1024
const SINK_KEEP_LINES = 2_000

/** The file sink's default path — `<git-common>/bro/otel/hooks.jsonl`,
 *  sibling of the perf/trace journals; a non-git dir falls back to the
 *  user's state dir rather than dropping the event. */
export function otelSinkPath(cfg: OtelConfig, dir: string): string {
  if (cfg.exporter.path !== '') {
    return resolve(dir, cfg.exporter.path)
  }
  const common = gitCommonDir(dir)
  return common !== null
    ? join(common, 'bro', 'otel', 'hooks.jsonl')
    : join(homedir(), '.local', 'state', 'bro', 'otel-hooks.jsonl')
}

function writeFileSink(path: string, record: OtelHookRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const line = `${JSON.stringify(record)}\n`
  const append = (): void => {
    appendFileSync(path, line)
    if (statSync(path).size > SINK_MAX_BYTES) {
      const kept = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .slice(-SINK_KEEP_LINES)
      writeFileSync(path, `${kept.join('\n')}\n`)
    }
  }
  try {
    // waitMs 0 — a contended lock degrades to the plain append; the
    // event must land, never stall the hook that produced it.
    withFileLock(`${path}.lock`, append, { waitMs: 0, label: 'otel sink' })
  } catch {
    append()
  }
}

/** One record → the otelEvent attribute bag. */
function recordAttrs(record: OtelHookRecord): Record<string, Scalar> {
  const a: Record<string, Scalar> = { client: record.client, ok: record.ok }
  if (record.session !== undefined) a.session = record.session
  if (record.ms !== undefined) a.ms = record.ms
  if (record.error !== undefined) a.error = record.error
  for (const [k, v] of Object.entries(record.payload ?? {})) {
    a[`payload.${k}`] = v
  }
  return a
}

function writeSink(cfg: OtelConfig, record: OtelHookRecord, dir: string): void {
  switch (cfg.exporter.type) {
    case 'file':
      writeFileSink(otelSinkPath(cfg, dir), record)
      return
    case 'otlp':
      // detached delivery — a dead collector cannot stall the hook's
      // exit behind an in-flight fetch (same shape as exit-path spans).
      otelEvent(record.event, recordAttrs(record), {
        endpoint: cfg.exporter.endpoint === '' ? undefined : cfg.exporter.endpoint,
        detached: true,
      })
      return
    case 'stdout':
      // stderr, not stdout — the hook's stdout is the host's control
      // channel; a telemetry row there corrupts the protocol answer.
      console.error(JSON.stringify(record))
      return
  }
}

// --- config ---------------------------------------------------------------------

const cfgMemo = new Map<string, OtelConfig>()

/** Resolved `otel` section for dir, memoized for the process — hook
 *  invocations are one-shot; long-lived hosts (serve) pay one read. */
export function otelConfigFor(dir: string): OtelConfig {
  const key = resolve(dir)
  let cfg = cfgMemo.get(key)
  if (cfg === undefined) {
    cfg = loadConfig(key, { otel: otelSection }).otel as OtelConfig
    cfgMemo.set(key, cfg)
  }
  return cfg
}

/** Test seam — drop memoized config so a rewritten file re-reads. */
export function otelConfigReset(): void {
  cfgMemo.clear()
}

// --- entry -----------------------------------------------------------------------

/** The repo the hook fired for — config + git anchor. */
function anchorDir(meta: HookMeta): string {
  return meta.dir ?? process.cwd()
}

/** Every early gate — global kill switch, master switch, per-hook
 *  policy, sample roll — before any record work happens. */
function shouldEmit(cfg: OtelConfig, policy: OtelHookPolicy): boolean {
  if (process.env.BRO_TELEMETRY === '0' || !cfg.enabled || !policy.enabled) {
    return false
  }
  return policy.sample >= 1 || randomInt(1_000_000) / 1_000_000 < policy.sample
}

/** Emit one hook event through the telemetry pipeline. Never throws,
 *  never awaits — a telemetry bug loses one row at worst. `enabled=false`
 *  short-circuits before any payload work. */
export function emitHook(name: string, payload: unknown, meta: HookMeta = {}): void {
  try {
    const dir = anchorDir(meta)
    const cfg = otelConfigFor(dir)
    const policy = resolveHookPolicy(cfg, name)
    if (!shouldEmit(cfg, policy)) {
      return
    }
    writeSink(cfg, hookRecord(name, payload, meta, policy).record, dir)
  } catch {
    // drop-on-error — telemetry must never stall or fail the caller
  }
}

/** Read sink rows back — `bro otel status` event counts. Torn lines
 *  skip themselves; a missing file is an empty list, not an error. */
export function readSinkRows(path: string): OtelHookRecord[] {
  const rows: OtelHookRecord[] = []
  if (!existsSync(path)) {
    return rows
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const r: unknown = JSON.parse(line)
      if (isObj(r) && typeof r.event === 'string') {
        rows.push(r as unknown as OtelHookRecord)
      }
    } catch {
      // torn write — skip the row, keep the report
    }
  }
  return rows
}

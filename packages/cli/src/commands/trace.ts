/**
 * `bro trace` — OTLP export of the session trace journals (spec:
 * specs/telemetry/bro-huy5o.11.md). One verb: `export` — reads
 * `<git-common>/bro/hooks/trace/*.jsonl`, maps unexported lines to
 * OTLP spans, POSTs them to the configured endpoint over OTLP/HTTP
 * JSON. Off without an endpoint (`telemetry.otlp.endpoint` or
 * OTEL_EXPORTER_OTLP_*); the hook-side auto-flush respawns this same
 * command detached, so a dead collector can only lose spans — never
 * stall a session.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { hooksDir, safeId } from '@broject/learn'
import { withFileLock } from '@broject/core'
import { VERSION } from '../version.ts'
import { loadBroConfig } from '../plugins.ts'
import {
  resolveOtlp,
  telemetrySection,
  tracesUrl,
  type OtlpConfig,
  type TelemetryConfig,
} from './trace-config.ts'

// --- OTLP/HTTP JSON shapes -------------------------------------------------------

type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAttrValue[] } }

interface OtlpKeyValue {
  key: string
  value: OtlpAttrValue
}

interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpKeyValue[]
  status?: { code: number }
}

/** Journal fields with their own mapping — anything else primitive
 *  lands as a `bro.<key>` attribute verbatim (forward-compat for
 *  token/cost fields the journal may gain). */
const STRUCTURAL = new Set(['ts', 'tool', 'command', 'paths', 'ok'])

const COMMAND_ATTR_MAX = 4000

/** One OTLP attribute for a journal field — number/string/bool only;
 *  objects the journal doesn't know are skipped, not serialized. */
function fieldAttr(key: string, v: unknown): OtlpKeyValue | null {
  if (typeof v === 'string') {
    return v === ''
      ? null
      : {
          key: `bro.${key}`,
          value: { stringValue: v.length > COMMAND_ATTR_MAX ? v.slice(0, COMMAND_ATTR_MAX) : v },
        }
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Number.isInteger(v)
      ? { key: `bro.${key}`, value: { intValue: v } }
      : { key: `bro.${key}`, value: { doubleValue: v } }
  }
  if (typeof v === 'boolean') {
    return { key: `bro.${key}`, value: { boolValue: v } }
  }
  return null
}

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

const nano = (ms: number): string => `${BigInt(Math.max(0, Math.round(ms))) * 1_000_000n}`

/** Journal line → span. `traceId` is deterministic per session file,
 *  `spanId` a content hash — a re-sent line lands on the same span and
 *  dedups server-side. Duration is the gap to the next entry's ts (the
 *  journal records landings, not intervals; the last entry is a point). */
export function lineToSpan(
  session: string,
  raw: Record<string, unknown>,
  nextTs: number | undefined
): OtlpSpan | null {
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) {
    return null
  }
  const traceId = sha256hex(`bro:${session}`).slice(0, 32)
  const spanId = sha256hex(`${traceId}|${JSON.stringify(raw)}`).slice(0, 16)
  const tool = typeof raw.tool === 'string' && raw.tool !== '' ? raw.tool : 'event'
  const end = nextTs !== undefined && nextTs > raw.ts ? nextTs : raw.ts
  const attributes: OtlpKeyValue[] = [{ key: 'bro.session', value: { stringValue: session } }]
  for (const [k, v] of Object.entries(raw)) {
    if (STRUCTURAL.has(k)) {
      continue
    }
    const a = fieldAttr(k, v)
    if (a !== null) {
      attributes.push(a)
    }
  }
  if (tool !== 'event') {
    attributes.push({ key: 'bro.tool', value: { stringValue: tool } })
  }
  if (typeof raw.command === 'string' && raw.command !== '') {
    attributes.push({
      key: 'bro.command',
      value: {
        stringValue:
          raw.command.length > COMMAND_ATTR_MAX
            ? raw.command.slice(0, COMMAND_ATTR_MAX)
            : raw.command,
      },
    })
  }
  if (Array.isArray(raw.paths)) {
    const paths = raw.paths.filter((p): p is string => typeof p === 'string')
    if (paths.length > 0) {
      attributes.push({
        key: 'bro.paths',
        value: { arrayValue: { values: paths.map((p) => ({ stringValue: p })) } },
      })
    }
  }
  return {
    traceId,
    spanId,
    name: `bro.${tool}`,
    kind: 1,
    startTimeUnixNano: nano(raw.ts),
    endTimeUnixNano: nano(end),
    attributes,
    ...(raw.ok === false ? { status: { code: 2 } } : {}),
  }
}

/** Parse one journal line — a torn trailing write or a non-object line
 *  yields no span but still counts toward the cursor (it IS consumed). */
export function parseJournalLine(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** One journal's raw lines → spans, pairing each entry with the next
 *  ts for its duration. */
export function journalSpans(session: string, lines: string[]): OtlpSpan[] {
  const entries: Array<Record<string, unknown>> = []
  const spans: OtlpSpan[] = []
  for (const l of lines) {
    const e = parseJournalLine(l)
    if (e !== null) {
      entries.push(e)
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const next = entries[i + 1]
    const nextTs = typeof next?.ts === 'number' ? next.ts : undefined
    const s = lineToSpan(session, entries[i]!, nextTs)
    if (s !== null) {
      spans.push(s)
    }
  }
  return spans
}

/** The OTLP/HTTP JSON request body — one resourceSpans carrying every
 *  pending span; scope names the emitter so a backend can tell bro's
 *  journals from a host's own OTel SDK. */
export function spansPayload(
  spans: OtlpSpan[],
  repo: string,
  cfg: OtlpConfig
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: cfg.serviceName } },
            { key: 'service.version', value: { stringValue: VERSION } },
            { key: 'bro.repo', value: { stringValue: repo } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: '@broject/bro', version: VERSION },
            spans,
          },
        ],
      },
    ],
  }
}

// --- export cursor ---------------------------------------------------------------

interface ExportCursor {
  v: number
  /** Last detached-flush respawn — the hook path's throttle stamp. */
  spawnedAt?: number
  /** Last POST failure — the only record a dead collector leaves. */
  lastError?: string
  lastErrorAt?: number
  /** journal file basename → lines already sent + when. */
  sessions: Record<string, { line: number; at: number }>
}

const CURSOR_NAME = '.export.json'

const cursorPath = (traceDir: string): string => join(traceDir, CURSOR_NAME)

function readCursor(path: string): ExportCursor {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const c = v as Partial<ExportCursor>
      return {
        v: 1,
        ...(typeof c.spawnedAt === 'number' ? { spawnedAt: c.spawnedAt } : {}),
        ...(typeof c.lastError === 'string' ? { lastError: c.lastError } : {}),
        ...(typeof c.lastErrorAt === 'number' ? { lastErrorAt: c.lastErrorAt } : {}),
        sessions:
          typeof c.sessions === 'object' && c.sessions !== null
            ? (c.sessions as ExportCursor['sessions'])
            : {},
      }
    }
  } catch {
    // absent or torn cursor — everything re-exports (spans dedup by id)
  }
  return { v: 1, sessions: {} }
}

function writeCursor(path: string, cursor: ExportCursor): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    withFileLock(`${path}.lock`, () => {
      writeFileSync(path, JSON.stringify(cursor))
    })
  } catch {
    // a lost cursor re-sends — spans dedup by id server-side
  }
}

// --- journals --------------------------------------------------------------------

/** `trace/*.jsonl` — one journal per session; the filter matches on
 *  the sanitized id because that's what the file is named. */
function journalFiles(traceDir: string, sessionFilter?: string): Array<{ session: string; path: string }> {
  const wanted = sessionFilter === undefined ? undefined : `${safeId(sessionFilter)}.jsonl`
  const out: Array<{ session: string; path: string }> = []
  try {
    for (const f of readdirSync(traceDir)) {
      if (!f.endsWith('.jsonl') || (wanted !== undefined && f !== wanted)) {
        continue
      }
      out.push({ session: f.slice(0, -'.jsonl'.length), path: join(traceDir, f) })
    }
  } catch {
    // no trace dir yet — nothing to export
  }
  return out
}

export interface ExportResult {
  endpoint: string
  sessions: number
  spans: number
  /** --dry-run: payload built, nothing POSTed, cursor untouched. */
  dryRun: boolean
  posted: boolean
  error?: string
  payload?: Record<string, unknown>
}

/** The export itself — journals → spans → one POST, cursor advance on
 *  success. Never throws: every failure lands in the result (and the
 *  cursor's lastError for the detached path's postmortem). */
export async function exportTraces(opts: {
  dir: string
  session?: string | undefined
  dryRun?: boolean
  otlp?: OtlpConfig | undefined
}): Promise<ExportResult | null> {
  const hooks = hooksDir(opts.dir)
  if (hooks === null) {
    return null
  }
  const traceDir = join(hooks, 'trace')
  const cfg =
    opts.otlp ?? resolveOtlp((telemetrySection as (r: unknown) => TelemetryConfig)(
      (loadBroConfig(opts.dir) as Record<string, unknown>).telemetry
    ).otlp)
  const result: ExportResult = {
    endpoint: cfg.endpoint === '' ? '' : tracesUrl(cfg.endpoint),
    sessions: 0,
    spans: 0,
    dryRun: opts.dryRun === true,
    posted: false,
  }
  if (cfg.endpoint === '') {
    result.error =
      'no OTLP endpoint configured — set telemetry.otlp.endpoint or OTEL_EXPORTER_OTLP_ENDPOINT'
    return result
  }
  const cPath = cursorPath(traceDir)
  const cursor = readCursor(cPath)
  const spans: OtlpSpan[] = []
  const advance = new Map<string, number>()
  for (const j of journalFiles(traceDir, opts.session)) {
    let lines: string[]
    try {
      lines = readFileSync(j.path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
    } catch {
      // a racing reap can unlink mid-scan — that journal just sits out
      continue
    }
    let off = cursor.sessions[basename(j.path)]?.line ?? 0
    if (off > lines.length) {
      // the journal trimmed or was recreated past the cursor — resync
      // to the live tail (a resend dedups by span id)
      off = 0
    }
    const fresh = lines.slice(off)
    if (fresh.length === 0) {
      continue
    }
    spans.push(...journalSpans(j.session, fresh))
    advance.set(basename(j.path), lines.length)
  }
  result.sessions = advance.size
  result.spans = spans.length
  if (spans.length === 0) {
    return result
  }
  // hooks = <common>/.git→bro/hooks — the repo name is the main
  // worktree's basename, three levels up (shared across linked trees)
  result.payload = spansPayload(spans, basename(dirname(dirname(dirname(hooks)))), cfg)
  if (result.dryRun) {
    return result
  }
  try {
    const res = await fetch(result.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cfg.headers },
      body: JSON.stringify(result.payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    if (!res.ok) {
      throw new Error(`OTLP endpoint ${result.endpoint} answered ${res.status}`)
    }
    for (const [file, line] of advance) {
      cursor.sessions[file] = { line, at: Date.now() }
    }
    delete cursor.lastError
    delete cursor.lastErrorAt
    writeCursor(cPath, cursor)
    result.posted = true
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    cursor.lastError = result.error
    cursor.lastErrorAt = Date.now()
    writeCursor(cPath, cursor)
  }
  return result
}

// --- hook-side auto-flush ----------------------------------------------------------

/** Detached `bro trace export` respawn — the post-merge pattern:
 *  argv[1] is this CLI's entry in dev and installs alike, execPath
 *  sidesteps shim rules, detached+ignore+unref returns instantly. */
function spawnFlush(entry: string): void {
  const child = spawn(process.execPath, [entry, 'trace', 'export'], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {})
  child.unref()
}

/** Throttled auto-flush for emitPostTool — at most one respawn per
 *  flushMs per repo. Off without a resolved endpoint; every failure
 *  (config read, stamp write, spawn) degrades to silence — the hook
 *  must never feel the exporter. `now`/`spawnFn` inject for tests. */
export function maybeSpawnTraceFlush(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  spawnFn: (entry: string) => void = spawnFlush
): void {
  try {
    if (env.BRO_TELEMETRY === '0') {
      return
    }
    const hooks = hooksDir(dir)
    if (hooks === null) {
      return
    }
    const cfg = resolveOtlp(
      telemetrySection(
        (loadBroConfig(dir) as Record<string, unknown>).telemetry
      ).otlp,
      env
    )
    if (cfg.endpoint === '') {
      return
    }
    const cPath = join(hooks, 'trace', CURSOR_NAME)
    const cursor = readCursor(cPath)
    if (now - (cursor.spawnedAt ?? 0) < cfg.flushMs) {
      return
    }
    const entry = process.argv[1]
    if (entry === undefined || !existsSync(entry)) {
      return
    }
    // stamp before the spawn — two racing hooks both past the throttle
    // may still double-flush, but a lost stamp must not respawn-storm
    cursor.spawnedAt = now
    writeCursor(cPath, cursor)
    spawnFn(entry)
  } catch {
    // the exporter never affects the agent — silence is the contract
  }
}

// --- command -----------------------------------------------------------------------

export async function runTraceCommand(argv: string[]): Promise<void> {
  const [verb, ...args] = argv
  if (verb !== 'export') {
    console.error('usage: bro trace export [--session <id>] [--dry-run] [--json]')
    process.exit(2)
  }
  const si = args.indexOf('--session')
  const session = si >= 0 ? args[si + 1] : undefined
  const dryRun = args.includes('--dry-run')
  const json = args.includes('--json')
  const r = await exportTraces({ dir: process.cwd(), session, dryRun })
  if (json) {
    const { payload: _p, ...rest } = r ?? { endpoint: '', sessions: 0, spans: 0, dryRun, posted: false }
    console.log(JSON.stringify({ ...(r === null ? { error: 'not a git repo' } : rest) }))
  }
  if (r === null) {
    if (!json) {
      console.error('bro trace export: not a git repo — no journals to read')
    }
    process.exit(1)
  }
  if (r.error !== undefined && !r.posted) {
    if (!json) {
      console.error(`bro trace export: ${r.error}`)
    }
    process.exit(1)
  }
  if (r.dryRun) {
    if (!json) {
      console.log(JSON.stringify(r.payload, null, 2))
    }
    return
  }
  if (json) {
    return
  }
  console.log(
    r.spans === 0
      ? 'nothing to export — all journals already flushed'
      : `exported ${r.spans} span(s) from ${r.sessions} session(s) → ${r.endpoint}`
  )
}

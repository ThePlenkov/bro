/**
 * `bro otel` — the hook-telemetry operator surface (spec:
 * specs/bro-xgejl.md). The facade (@broject/otel emitHook) rides the
 * `bro hooks` dispatch; this command inspects and toggles it.
 *
 *   bro otel status [--json]   enabled? exporter? per-hook policies +
 *                              event counts read back from the file sink
 *   bro otel test <hook>       resolve the policy and print the exact
 *                              record the sink would receive (--json)
 *   bro otel on | off          flip otel.enabled in bro.config.local.json
 *                              (telemetry is operator config — the toggle
 *                              lands local, never the committed file)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, hasHelpFlag, printUsage, type ExitCode } from '@broject/core'
import { otelEndpoint } from '@broject/providers'
import {
  hookEventName,
  hookRecord,
  OTEL_HOOK_EVENTS,
  otelSinkPath,
  readSinkRows,
  resolveHookPolicy,
  type OtelConfig,
} from '@broject/otel'
import { loadBroConfig } from '../plugins.ts'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function otelConfig(dir: string): OtelConfig {
  return loadBroConfig(dir).otel as OtelConfig
}

function usage(exitCode: ExitCode = EXIT.usage): never {
  printUsage(
    `Usage: bro otel <command> [args…]

Commands:
  status [--json]   otel.enabled, the resolved exporter (file path /
                    otlp endpoint), '*' + per-hook policies, and event
                    counts from the file sink
  test <hook>       fire a synthetic payload through the facade's record
                    builder — shows the policy, the exact exported row,
                    and the payload fields the allowlist dropped. Bro
                    (post-tool) and host (PostToolUse) names both work
  on | off          write otel.enabled to bro.config.local.json — the
                    local layer, never the committed config`,
    exitCode
  )
}

// --- on | off --------------------------------------------------------------------

/** Write otel.enabled into bro.config.local.json — create or merge,
 *  never clobber sibling keys. A .ts sibling shadows the json, so its
 *  presence refuses the write (same rule as `bro setup`). */
function cmdSetEnabled(dir: string, enabled: boolean): void {
  const tsPath = join(dir, 'bro.config.local.ts')
  if (existsSync(tsPath)) {
    console.error(
      `error: bro.config.local.ts shadows the .json — set "otel": { "enabled": ${enabled} } there directly`
    )
    process.exit(EXIT.usage)
  }
  const path = join(dir, 'bro.config.local.json')
  let cfg: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isObj(raw)) cfg = raw
  } catch {
    // absent or unreadable local config — start fresh
  }
  const section = isObj(cfg.otel) ? cfg.otel : {}
  cfg.otel = { ...section, enabled }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`)
  console.log(`otel.enabled=${enabled} → ${path}`)
}

// --- status ----------------------------------------------------------------------

interface StatusReport {
  enabled: boolean
  exporter: { type: string; target: string }
  defaultPolicy: { enabled: boolean; sample: number; collect: string[] }
  overrides: Record<string, { enabled: boolean; sample: number; collect: string[] }>
  /** Event → row count in the file sink (absent for non-file exporters). */
  counts?: Record<string, number>
  sink?: string
}

function cmdStatus(dir: string, json: boolean): void {
  const cfg = otelConfig(dir)
  const target =
    cfg.exporter.type === 'file'
      ? otelSinkPath(cfg, dir)
      : cfg.exporter.type === 'otlp'
        ? (cfg.exporter.endpoint === '' ? otelEndpoint() : cfg.exporter.endpoint) ??
          '(no endpoint — OTEL_EXPORTER_OTLP_ENDPOINT unset)'
        : 'stderr'
  const report: StatusReport = {
    enabled: cfg.enabled,
    exporter: { type: cfg.exporter.type, target },
    defaultPolicy: cfg.hooks['*'] ?? { enabled: true, sample: 1, collect: [] },
    overrides: Object.fromEntries(
      Object.entries(cfg.hooks).filter(([k]) => k !== '*')
    ),
  }
  if (cfg.exporter.type === 'file') {
    report.sink = target
    const counts: Record<string, number> = {}
    for (const row of readSinkRows(target)) {
      counts[row.event] = (counts[row.event] ?? 0) + 1
    }
    report.counts = counts
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`otel: ${cfg.enabled ? 'enabled' : 'DISABLED'}  exporter=${report.exporter.type} → ${target}`)
  const p = report.defaultPolicy
  console.log(
    `policy "*": ${p.enabled ? 'on' : 'off'}  sample=${p.sample}  collect=[${p.collect.join(', ')}]`
  )
  for (const [name, pol] of Object.entries(report.overrides)) {
    console.log(
      `policy ${name}: ${pol.enabled ? 'on' : 'off'}  sample=${pol.sample}  collect=[${pol.collect.join(', ')}]`
    )
  }
  const counts = report.counts ?? {}
  const rows = OTEL_HOOK_EVENTS.map(
    (e) => `  ${e.padEnd(24)} ${counts[`hook.${e}`] ?? 0}`
  )
  console.log(`events${report.sink === undefined ? '' : ` (${report.sink})`}:`)
  console.log(rows.join('\n'))
}

// --- test ----------------------------------------------------------------------

/** The synthetic payload — one field per known hook-input key so
 *  `collect` show every path it could take, not just the usual ones. */
const SYNTHETIC_PAYLOAD = {
  session_id: 'otel-test-session',
  hook_event_name: 'PostToolUse',
  tool_name: 'exec',
  tool_use_id: 'toolu-synthetic',
  tool_input: { command: 'git status', file_path: 'src/index.ts', path: 'src', files: ['a.ts'] },
  tool_response: { success: true },
  prompt: 'synthetic prompt text',
  stop_hook_active: false,
  turn_id: 'codex-turn-synthetic',
}

function cmdTest(dir: string, rawName: string | undefined, json: boolean): void {
  if (rawName === undefined) {
    console.error('error: bro otel test needs a hook name — `bro otel test session-start`')
    process.exit(EXIT.usage)
  }
  const name = hookEventName(rawName)
  const cfg = otelConfig(dir)
  const policy = resolveHookPolicy(cfg, name)
  const { record, skipped } = hookRecord(name, SYNTHETIC_PAYLOAD, {
    sessionId: SYNTHETIC_PAYLOAD.session_id,
    client: 'test',
    durationMs: 0,
    ok: true,
  }, policy)
  // payload keys present but outside the allowlist — what the policy
  // dropped. `collect` paths are dotted; compare on the top-level key.
  const collectedRoots = new Set(policy.collect.map((p) => p.split('.')[0]))
  const notCollected = Object.keys(SYNTHETIC_PAYLOAD).filter(
    (k) => !collectedRoots.has(k)
  )
  const report = {
    hook: name,
    enabled: cfg.enabled && policy.enabled,
    policy,
    record,
    skippedCollectPaths: skipped,
    payloadFieldsNotCollected: notCollected,
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (!cfg.enabled) {
    console.log('otel.enabled=false — nothing exports; this is the would-be record:')
  } else if (!policy.enabled) {
    console.log(`policy for "${name}" is off — nothing exports; this is the would-be record:`)
  }
  console.log(JSON.stringify(record, null, 2))
  console.log(`policy: sample=${policy.sample}  collect=[${policy.collect.join(', ') || 'meta only'}]`)
  if (skipped.length > 0) {
    console.log(`collect paths with no scalar value: ${skipped.join(', ')}`)
  }
  if (notCollected.length > 0) {
    console.log(`payload fields not collected: ${notCollected.join(', ')}`)
  }
}

// --- dispatch ----------------------------------------------------------------------

export function runOtelCommand(argv: string[]): void {
  const [sub, ...rest] = argv
  if (hasHelpFlag(argv)) {
    usage(EXIT.ok)
  }
  const dir = process.cwd()
  switch (sub) {
    case 'on':
      cmdSetEnabled(dir, true)
      return
    case 'off':
      cmdSetEnabled(dir, false)
      return
    case 'test':
      cmdTest(dir, rest.find((a) => !a.startsWith('-')), rest.includes('--json'))
      return
    case 'status':
    case undefined:
      cmdStatus(dir, rest.includes('--json'))
      return
    default:
      console.error(`error: unknown otel command "${sub}"`)
      usage()
  }
}

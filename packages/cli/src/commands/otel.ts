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
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, gitTry, hasHelpFlag, printUsage, withFileLock, type ExitCode } from '@broject/core'
import { otelEndpoint } from '@broject/providers'
import {
  hookEventName,
  hookRecord,
  OTEL_HOOK_EVENTS,
  otelConfigFor,
  otelSinkPath,
  readSinkRows,
  resolveHookPolicy,
  type ResolvedOtelConfig,
} from '@broject/otel'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The facade's resolved config — operator provenance applied, so
 *  status/test report what hooks will actually do, not the raw merge. */
function otelConfig(req: { dir: string }): ResolvedOtelConfig {
  return otelConfigFor(req.dir)
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
 *  presence refuses the write (same rule as `bro setup`). An existing
 *  file that does not parse is operator data — refuse rather than
 *  overwrite it with only the toggle. */
function cmdSetEnabled(toggle: { dir: string; enabled: boolean }): void {
  const { dir, enabled } = toggle
  const tsPath = join(dir, 'bro.config.local.ts')
  if (existsSync(tsPath)) {
    console.error(
      `error: bro.config.local.ts shadows the .json — set "otel": { "enabled": ${enabled} } there directly`
    )
    process.exit(EXIT.usage)
  }
  const path = join(dir, 'bro.config.local.json')
  // refuse to write if bro.config.local.json is tracked by git (local-operator config must be untracked)
  try {
    const r = gitTry(['-C', dir, 'ls-files', '--error-unmatch', '--', 'bro.config.local.json'], 2000)
    if (r.code === 0) {
      console.error(
        `error: bro.config.local.json is tracked by git — local operator config must be untracked (move to a gitignored override or set "otel": { "enabled": ${enabled} } in an untracked bro.config.local.json)`
      )
      process.exit(EXIT.usage)
    }
    // If git repo exists but file not tracked, that's fine. If not in a git repo,
    // gitTry will fail - but facade won't trust it; refuse to write in non-git repos
    // to match facade's trust model.
    const repoCheck = gitTry(['-C', dir, 'rev-parse', '--git-dir'], 1000)
    if (repoCheck.code !== 0) {
      console.error(
        `error: not a git repository — bro.config.local.json must live in a git repo (and be untracked) to be trusted as operator config`
      )
      process.exit(EXIT.usage)
    }
  } catch {
    console.error('error: failed to validate git repository state')
    process.exit(EXIT.usage)
  }
  let didWrite = false
  try {
    withFileLock(
      `${path}.lock`,
      () => {
        let cfg: Record<string, unknown> = {}
        if (existsSync(path)) {
          try {
            const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
            if (!isObj(raw)) throw new Error('top-level value is not an object')
            cfg = raw
          } catch (e) {
            console.error(
              `error: ${path} exists but does not parse — fix or remove it first (${e instanceof Error ? e.message : e})`
            )
            process.exit(EXIT.usage)
          }
        }
        if ('otel' in cfg && !isObj((cfg as Record<string, unknown>).otel)) {
          console.error('error: cfg.otel exists but is not an object')
          process.exit(EXIT.usage)
        }
        const section = isObj(cfg.otel) ? (cfg.otel as Record<string, unknown>) : {}
        cfg.otel = { ...section, enabled }
        // temp + rename — a direct overwrite can leave a truncated file on a
        // mid-write crash; operator config loses every sibling section.
        const tmp = `${path}.tmp-${process.pid}`
        try {
          writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
        } catch {
          writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
        }
        try {
          chmodSync(tmp, 0o600)
        } catch {
          // best-effort
        }
        renameSync(tmp, path)
        try {
          chmodSync(path, 0o600)
        } catch {
          // best-effort
        }
        didWrite = true
      },
      { label: 'bro otel on/off' }
    )
  } catch (e) {
    if (e instanceof Error && e.message === 'exit 2') {
      throw e
    }
    // if lock failed, fall through - validation already done outside lock
  }
  if (!didWrite && !existsSync(path)) {
    // best effort without lock already done? but we did write inside lock; just in case
  }
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

/** Where the resolved exporter sends rows — path, endpoint, or the
 *  literal 'stderr' marker the status line already used. */
function statusTarget(view: { cfg: ResolvedOtelConfig; dir: string }): string {
  const { cfg, dir } = view
  if (cfg.exporter.type === 'file') {
    return otelSinkPath(cfg, dir)
  }
  if (cfg.exporter.type === 'stdout') {
    return 'stderr'
  }
  return (
    (cfg.exporter.endpoint === '' ? otelEndpoint() : cfg.exporter.endpoint) ??
    '(no endpoint — OTEL_EXPORTER_OTLP_ENDPOINT unset)'
  )
}

function buildStatusReport(view: { cfg: ResolvedOtelConfig; dir: string }): StatusReport {
  const { cfg } = view
  const target = statusTarget(view)
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
  return report
}

function printStatusReport(report: StatusReport, cfg: ResolvedOtelConfig): void {
  const killSwitch = process.env.BRO_TELEMETRY === '0'
  const effectiveEnabled = cfg.enabled && !killSwitch
  console.log(
    `otel: ${effectiveEnabled ? 'enabled' : killSwitch ? 'DISABLED (BRO_TELEMETRY=0)' : 'DISABLED'}  exporter=${report.exporter.type} → ${report.exporter.target}`
  )
  if (cfg.armedByCommitted) {
    console.log(
      'note: a committed otel.enabled=true is ignored — arming, exporter and collect are operator decisions; `bro otel on` writes the trusted local layer'
    )
  }
  if (killSwitch) {
    console.log('note: BRO_TELEMETRY=0 is set — all telemetry is disabled (kill switch)')
  }
  const p = report.defaultPolicy
  console.log(
    `policy "*": ${p.enabled ? 'on' : 'off'}  sample=${p.sample}  collect=[${p.collect.join(', ')}]`
  )
  for (const [name, pol] of Object.entries(report.overrides)) {
    console.log(
      `policy ${name}: ${pol.enabled ? 'on' : 'off'}  sample=${pol.sample}  collect=[${pol.collect.join(', ')}]`
    )
  }
  if (report.counts === undefined) {
    console.log(
      `events: counts unavailable for exporter=${report.exporter.type} (read from the file sink only)`
    )
    return
  }
  const counts = report.counts
  const rows = OTEL_HOOK_EVENTS.map(
    (e) => `  ${e.padEnd(24)} ${counts[`hook.${e}`] ?? 0}`
  )
  console.log(`events${report.sink === undefined ? '' : ` (${report.sink})`}:`)
  console.log(rows.join('\n'))
}

function cmdStatus(run: { dir: string; json: boolean }): void {
  const cfg = otelConfig({ dir: run.dir })
  const report = buildStatusReport({ cfg, dir: run.dir })
  if (run.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  printStatusReport(report, cfg)
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

/** Git-hook events emit meta rows only; they receive no payload. */
const PAYLOAD_LESS_EVENTS = new Set(['prepare-commit-msg', 'reference-transaction', 'post-merge'])

function cmdTest(run: { dir: string; rawName: string | undefined; json: boolean }): void {
  const { dir, rawName, json } = run
  if (rawName === undefined) {
    console.error('error: bro otel test needs a hook name — `bro otel test session-start`')
    process.exit(EXIT.usage)
  }
  const name = hookEventName(rawName)
  const cfg = otelConfig({ dir })
  const policy = resolveHookPolicy(cfg, name)
  const killSwitch = process.env.BRO_TELEMETRY === '0'
  const payload = PAYLOAD_LESS_EVENTS.has(name) ? {} : SYNTHETIC_PAYLOAD
  const { record, skipped } = hookRecord(name, payload, {
    sessionId: (payload as Record<string, unknown>).session_id as string | undefined,
    client: 'test',
    durationMs: 0,
    ok: true,
  }, policy)
  // payload keys present but outside the allowlist — what the policy
  // dropped. `collect` paths are dotted; compare on the top-level key.
  const collectedRoots = new Set(policy.collect.map((p) => p.split('.')[0]))
  const notCollected = PAYLOAD_LESS_EVENTS.has(name)
    ? []
    : Object.keys(SYNTHETIC_PAYLOAD).filter((k) => !collectedRoots.has(k))
  const report = {
    hook: name,
    enabled: cfg.enabled && policy.enabled && !killSwitch,
    killSwitch,
    policy,
    record,
    skippedCollectPaths: skipped,
    payloadFieldsNotCollected: notCollected,
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (killSwitch) {
    console.log('BRO_TELEMETRY=0 — nothing exports; this is the would-be record:')
  } else if (!cfg.enabled) {
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
      cmdSetEnabled({ dir, enabled: true })
      return
    case 'off':
      cmdSetEnabled({ dir, enabled: false })
      return
    case 'test':
      cmdTest({ dir, rawName: rest.find((a) => !a.startsWith('-')), json: rest.includes('--json') })
      return
    case 'status':
    case undefined:
      cmdStatus({ dir, json: rest.includes('--json') })
      return
    default:
      console.error(`error: unknown otel command "${sub}"`)
      usage()
  }
}

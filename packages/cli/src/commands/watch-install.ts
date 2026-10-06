/**
 * `bro watch install|uninstall` — the heartbeat on a non-agent timer
 * (bro-7xgk.5). A session holder's only job is keeping the turn-loop
 * alive; polling belongs to a scheduler with zero inference per tick —
 * a systemd user timer when `systemctl --user` answers, a managed
 * crontab line otherwise. Entries are per-repo, named
 * `bro-watch-<h8>` where `<h8>` is the git-common-dir's sha256 prefix:
 * each repo's `--once --notify` drops into its own mailbox.
 *
 *   bro watch install [--every N] [--print]   install the poll for this repo
 *   bro watch uninstall                       remove it
 *
 * `--print` emits the artifacts the resolved backend would install
 * (both when no scheduler is detectable) without touching anything.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitTry } from '@broject/core'
import { cliVersion } from './githooks.ts'

export interface SchedRun {
  code: number
  out: string
  err: string
}

/** Injectable for tests — the real runner's PATH lookup is the
 *  contract (same as gh/bd/git elsewhere). A missing binary reports
 *  127 like the shell would. */
export type SchedRunner = (cmd: string, args: string[], stdin?: string) => SchedRun

export const realRun: SchedRunner = (cmd, args, stdin) => {
  const r = spawnSync(cmd, args, { input: stdin, encoding: 'utf8' }) // NOSONAR — PATH lookup is the contract
  if (r.error !== undefined) {
    return { code: 127, out: '', err: r.error.message }
  }
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

export interface WatchSchedDeps {
  run?: SchedRunner
  /** PATH + XDG_CONFIG_HOME source — injected in tests. */
  env?: NodeJS.ProcessEnv
  /** ~ — injected in tests so no real unit dir is touched. */
  home?: string
}

/** The absolute git common dir — units hash on this so a repo's timer
 *  survives a moved checkout and worktrees share one entry. */
export function watchCommonDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  let common = r.code === 0 ? r.out.trim() : ''
  if (common === '') {
    const rel = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
    common = rel.code === 0 && rel.out.trim() !== '' ? resolve(dir, rel.out.trim()) : ''
  }
  return common === '' ? null : common
}

export function watchUnitHash(commonDir: string): string {
  return createHash('sha256').update(commonDir).digest('hex').slice(0, 8)
}

export const unitName = (commonDir: string): string => `bro-watch-${watchUnitHash(commonDir)}`
export const cronTag = (commonDir: string): string => `# bro-watch-${watchUnitHash(commonDir)}`

/** Single-quote for sh — the only quoting that survives both systemd's
 *  ExecStart parse and cron's `sh -c` line. */
const shq = (s: string): string => `'${s.replaceAll("'", `'"'"'`)}'`

/** The watch invocation — `bro` on PATH first, the version-pinned npx
 *  fallback second (same contract the git-hook shim bakes). */
function watchInvocation(version: string): string {
  return `bro watch --once --notify || npx -y --prefer-offline "@broject/bro@${version}" watch --once --notify`
}

/** % is systemd's specifier escape — a path containing one would
 *  silently expand; %% is the literal. A newline can't be expressed at
 *  all — it would start a new directive, so the caller's `[Section]`
 *  boundary dissolves: refuse. */
const unitEsc = (s: string): string => {
  if (/[\n\r]/.test(s)) {
    throw new Error(`path contains a newline — a unit file cannot express it: ${JSON.stringify(s)}`)
  }
  return s.replaceAll('%', '%%')
}

/** Type=oneshot service — the scheduler owns the cadence; watch exits
 *  after one snapshot+drop. PATH is captured at install time because a
 *  user manager doesn't inherit nvm/~/.local shims. Every interpolated
 *  path goes through unitEsc — a newline in a checkout name would
 *  otherwise inject a new directive (a8fh). */
export function systemdService(dir: string, version: string, envPath: string): string {
  return `[Unit]
Description=bro watch heartbeat — ${unitEsc(dir)}
Documentation=https://github.com/theplenkov/bro

[Service]
Type=oneshot
WorkingDirectory=${unitEsc(dir)}
Environment="PATH=${unitEsc(envPath).replaceAll('"', '\\"')}"
ExecStart=/bin/sh -c ${shq(watchInvocation(version))}
`
}

export function systemdTimer(unit: string, everySec: number): string {
  return `[Unit]
Description=bro watch heartbeat timer — ${unit}

[Timer]
OnBootSec=${everySec}s
OnUnitActiveSec=${everySec}s
Unit=${unit}.service

[Install]
WantedBy=timers.target
`
}

/** The 5-field schedule for a seconds cadence. The minute field tops
 *  at 59 — a 90-minute step is not "every 90 minutes", it fires once
 *  an hour (or is rejected). Larger intervals move up a field,
 *  rounding UP so the effective cadence is never faster than
 *  configured. */
export function cronSchedule(everySec: number): string {
  const mins = Math.ceil(everySec / 60)
  if (mins <= 1) {
    return '* * * * *'
  }
  if (mins < 60) {
    return `*/${mins} * * * *`
  }
  const hours = Math.ceil(mins / 60)
  if (hours < 24) {
    return `0 */${hours} * * *`
  }
  return `0 0 */${Math.ceil(hours / 24)} * *`
}

/** A managed line is a crontab TEXT FIELD: a newline starts a new job
 *  before any shell quoting applies, and a bare `%` ends the command
 *  (the rest becomes stdin). Newlines can't be expressed — refuse;
 *  `%` escapes as `\%`. */
const cronEsc = (s: string): string => {
  if (/[\n\r]/.test(s)) {
    throw new Error(
      `path contains a newline — cron cannot express it safely (use systemd or rename): ${JSON.stringify(s)}`
    )
  }
  return s.replaceAll('%', '\\%')
}

/** One managed crontab line — the tag is the identity; reinstall
 *  replaces by tag, uninstall strips by tag, foreign lines untouched.
 *  Cron's granularity is minutes; intervalSec rounds up into the
 *  minute/hour/day field that can express it. env-prefix on
 *  `sh -c` lands PATH in the child's environment. */
export function cronLine(
  dir: string,
  everySec: number,
  envPath: string,
  commonDir: string,
  version: string
): string {
  const sched = cronSchedule(everySec)
  const d = cronEsc(dir)
  const p = cronEsc(envPath)
  return `${sched} cd ${shq(d)} && PATH=${shq(p)} sh -c ${shq(watchInvocation(version))} >/dev/null 2>&1 ${cronTag(commonDir)}`
}

export type SchedBackend = 'systemd' | 'cron'

/** systemd user first — a timer survives and needs no babysitting;
 *  crontab is the portable floor; null when neither answers. A dead
 *  systemctl binary (127) is not a user-bus problem — it's absence. */
export function detectBackend(run: SchedRunner): SchedBackend | null {
  const s = run('systemctl', ['--user', 'is-system-running'])
  if (s.code === 0 || ['degraded', 'starting', 'initializing'].includes(s.out.trim())) {
    return 'systemd'
  }
  return run('crontab', ['-l']).code === 127 ? null : 'cron'
}

interface Resolved {
  common: string
  unit: string
  unitDir: string
  envPath: string
  run: SchedRunner
}

function resolveSched(dir: string, deps: WatchSchedDeps): Resolved | { error: string } {
  const common = watchCommonDir(dir)
  if (common === null) {
    return { error: 'not a git repository — --notify would have no mailbox to drop into' }
  }
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  return {
    common,
    unit: unitName(common),
    unitDir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    envPath: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    run: deps.run ?? realRun,
  }
}

/** Artifacts for --print (and the install-nowhere guidance). */
export function printArtifacts(
  dir: string,
  everySec: number,
  version: string,
  deps: WatchSchedDeps
): string | { error: string } {
  const r = resolveSched(dir, deps)
  if ('error' in r) {
    return r
  }
  const service = `${r.unit}.service`
  const timer = `${r.unit}.timer`
  let cron: string
  try {
    cron = cronLine(dir, everySec, r.envPath, r.common, version)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return [
    `# ${service} — install under ${r.unitDir}`,
    systemdService(dir, version, r.envPath),
    `# ${timer} — then: systemctl --user daemon-reload && systemctl --user enable --now ${timer}`,
    systemdTimer(r.unit, everySec),
    `# or a crontab line`,
    cron,
  ].join('\n')
}

/** systemd install: write both units, daemon-reload, enable --now.
 *  Identical files still re-enable (a disabled timer is not
 *  "already"); changed files rewrite in place. */
function installSystemd(
  r: Resolved,
  dir: string,
  everySec: number,
  version: string
): { state: 'installed' | 'updated' | 'already' | 'error'; detail: string } {
  const service = systemdService(dir, version, r.envPath)
  const timer = systemdTimer(r.unit, everySec)
  const servicePath = join(r.unitDir, `${r.unit}.service`)
  const timerPath = join(r.unitDir, `${r.unit}.timer`)
  try {
    const had = existsSync(servicePath) || existsSync(timerPath)
    const same =
      existsSync(servicePath) &&
      existsSync(timerPath) &&
      readFileSync(servicePath, 'utf8') === service &&
      readFileSync(timerPath, 'utf8') === timer
    if (!same) {
      mkdirSync(r.unitDir, { recursive: true })
      writeFileSync(servicePath, service)
      writeFileSync(timerPath, timer)
    }
    const reload = r.run('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) {
      return { state: 'error', detail: `systemctl daemon-reload: ${reload.err.trim()}` }
    }
    const enable = r.run('systemctl', ['--user', 'enable', '--now', `${r.unit}.timer`])
    if (enable.code !== 0) {
      return { state: 'error', detail: `systemctl enable: ${enable.err.trim()}` }
    }
    return {
      state: same ? 'already' : had ? 'updated' : 'installed',
      detail: `${r.unit}.timer every ${everySec}s (systemd --user)`,
    }
  } catch (err) {
    return { state: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** `crontab -l` has three outcomes, not two: the binary is absent
 *  (missing — nothing could be scheduled), the table read failed
 *  (failed — the state is UNKNOWN and a blind `crontab -` write would
 *  replace every existing job with ours alone), or the lines. */
type CrontabRead = { lines: string[] } | { missing: true } | { failed: string }

function readCrontab(run: SchedRunner): CrontabRead {
  const r = run('crontab', ['-l'])
  if (r.code === 127) {
    return { missing: true }
  }
  if (r.code === 0) {
    return { lines: r.out.split('\n') }
  }
  // "no crontab for <user>" is an empty table — the only nonzero that
  // is safe to treat as empty
  if (/no crontab for/i.test(r.err) || /no crontab for/i.test(r.out)) {
    return { lines: [] }
  }
  return { failed: r.err.trim() || `crontab -l exited ${r.code}` }
}

/** Remove a repo's managed lines. `missing` — no crontab binary, so
 *  nothing exists to remove; `failed` — the read or rewrite failed and
 *  the caller must not treat that as "nothing there". */
function stripCronTag(
  run: SchedRunner,
  tag: string
): { removed: number } | { missing: true } | { failed: string } {
  const table = readCrontab(run)
  if ('missing' in table) {
    return { missing: true }
  }
  if ('failed' in table) {
    return { failed: table.failed }
  }
  const kept = table.lines.filter((l) => !l.includes(tag))
  const removed = table.lines.length - kept.length
  if (removed === 0) {
    return { removed: 0 }
  }
  const w = run('crontab', ['-'], kept.join('\n'))
  return w.code === 0 ? { removed } : { failed: w.err.trim() || `crontab - exited ${w.code}` }
}

function installCron(
  r: Resolved,
  dir: string,
  everySec: number,
  version: string
): { state: 'installed' | 'updated' | 'already' | 'error'; detail: string } {
  const tag = cronTag(r.common)
  let line: string
  try {
    line = cronLine(dir, everySec, r.envPath, r.common, version)
  } catch (err) {
    return { state: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  const table = readCrontab(r.run)
  if ('missing' in table) {
    return { state: 'error', detail: 'crontab not found on PATH' }
  }
  if ('failed' in table) {
    return { state: 'error', detail: `crontab -l: ${table.failed}` }
  }
  const lines = table.lines
  const kept = lines.filter((l) => !l.includes(tag))
  // exactly one tagged line and it IS the current one — nothing to do
  if (kept.length === lines.length - 1 && lines.some((l) => l === line)) {
    return { state: 'already', detail: `crontab ${tag}` }
  }
  const w = r.run('crontab', ['-'], [...kept, line].join('\n') + '\n')
  if (w.code !== 0) {
    return { state: 'error', detail: `crontab -: ${w.err.trim()}` }
  }
  return {
    state: kept.length === lines.length ? 'installed' : 'updated',
    detail: `crontab "${cronSchedule(everySec)}" (${tag})`,
  }
}

export interface WatchInstallResult {
  state: 'installed' | 'updated' | 'already' | 'removed' | 'absent' | 'printed' | 'error'
  backend?: SchedBackend
  detail: string
}

export function installWatch(
  dir: string,
  opts: { everySec: number; print?: boolean },
  deps: WatchSchedDeps = {}
): WatchInstallResult {
  const r = resolveSched(dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  const version = cliVersion()
  const backend = detectBackend(r.run)
  if (opts.print === true) {
    const out = printArtifacts(dir, opts.everySec, version, deps)
    return typeof out === 'string'
      ? { state: 'printed', backend: backend ?? undefined, detail: out }
      : { state: 'error', detail: out.error }
  }
  if (backend === null) {
    const out = printArtifacts(dir, opts.everySec, version, deps)
    return {
      state: 'error',
      detail:
        'no scheduler found — neither `systemctl --user` nor `crontab` answers. ' +
        'Install the entry by hand (`bro watch install --print`):\n' +
        (typeof out === 'string' ? out : ''),
    }
  }
  // one entry per repo, one backend — a surviving foreign-backend entry
  // would double the cadence
  if (backend === 'systemd') {
    const strip = stripCronTag(r.run, cronTag(r.common))
    if ('failed' in strip) {
      // can't prove the crontab lost our line — enabling systemd anyway
      // risks both schedulers ticking
      return {
        state: 'error',
        backend,
        detail: `cannot strip the crontab entry (${strip.failed}) — refusing to double-schedule`,
      }
    }
    const res = installSystemd(r, dir, opts.everySec, version)
    return { ...res, backend }
  }
  // cron install — a stale systemd unit for this repo goes best-effort
  const svc = join(r.unitDir, `${r.unit}.service`)
  const tmr = join(r.unitDir, `${r.unit}.timer`)
  const hadUnits = existsSync(svc) || existsSync(tmr)
  const disable = r.run('systemctl', ['--user', 'disable', '--now', `${r.unit}.timer`])
  rmSync(svc, { force: true })
  rmSync(tmr, { force: true })
  if (hadUnits) {
    // a deleted unit lingers in `systemctl --user list-timers` until
    // the manager re-reads its unit dir
    r.run('systemctl', ['--user', 'daemon-reload'])
  }
  const res = installCron(r, dir, opts.everySec, version)
  if (hadUnits && disable.code !== 0 && res.state !== 'error') {
    // files are gone but the live manager may still fire the timer —
    // cron is in, so the survivor would double-tick
    return {
      ...res,
      backend,
      detail: `${res.detail} — warning: stale systemd timer may still fire (disable: ${disable.err.trim() || `exited ${disable.code}`})`,
    }
  }
  return { ...res, backend }
}

export function uninstallWatch(dir: string, deps: WatchSchedDeps = {}): WatchInstallResult {
  const r = resolveSched(dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  const tag = cronTag(r.common)
  let removed = false
  let warn = ''
  const backend = detectBackend(r.run)
  if (backend === 'systemd' || r.run('systemctl', ['--version']).code !== 127) {
    const hadUnits = existsSync(join(r.unitDir, `${r.unit}.service`)) ||
      existsSync(join(r.unitDir, `${r.unit}.timer`))
    const disable = r.run('systemctl', ['--user', 'disable', '--now', `${r.unit}.timer`])
    for (const ext of ['service', 'timer']) {
      const p = join(r.unitDir, `${r.unit}.${ext}`)
      if (existsSync(p)) {
        rmSync(p)
        removed = true
      }
    }
    if (removed) {
      r.run('systemctl', ['--user', 'daemon-reload'])
    }
    if (hadUnits && disable.code !== 0) {
      // files are deleted but the loaded timer may linger — say so
      // instead of reporting a clean removal
      warn = `warning: systemd disable failed — a live timer may linger (${disable.err.trim() || `exited ${disable.code}`})`
    }
  }
  const stripped = stripCronTag(r.run, tag)
  if ('failed' in stripped) {
    // the managed line may still be in the table — 'absent' would lie
    return {
      state: 'error',
      backend: backend ?? undefined,
      detail: `crontab strip failed — the managed line may remain: ${stripped.failed}`,
    }
  }
  removed = removed || ('removed' in stripped && stripped.removed > 0)
  return {
    state: removed ? 'removed' : 'absent',
    backend: backend ?? undefined,
    detail: [removed ? `${r.unit} removed` : `no entry for ${r.unit}`, warn]
      .filter((s) => s !== '')
      .join(' — '),
  }
}

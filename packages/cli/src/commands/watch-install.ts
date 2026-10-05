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
 *  silently expand; %% is the literal. */
const unitEsc = (s: string): string => s.replaceAll('%', '%%')

/** Type=oneshot service — the scheduler owns the cadence; watch exits
 *  after one snapshot+drop. PATH is captured at install time because a
 *  user manager doesn't inherit nvm/~/.local shims. */
export function systemdService(dir: string, version: string, envPath: string): string {
  return `[Unit]
Description=bro watch heartbeat — ${dir}
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

/** One managed crontab line — the tag is the identity; reinstall
 *  replaces by tag, uninstall strips by tag, foreign lines untouched.
 *  Cron's granularity is minutes; intervalSec rounds up. env-prefix on
 *  `sh -c` lands PATH in the child's environment. */
export function cronLine(
  dir: string,
  everySec: number,
  envPath: string,
  commonDir: string,
  version: string
): string {
  const mins = Math.max(1, Math.ceil(everySec / 60))
  const sched = mins === 1 ? '* * * * *' : `*/${mins} * * * *`
  return `${sched} cd ${shq(dir)} && PATH=${shq(envPath)} sh -c ${shq(watchInvocation(version))} >/dev/null 2>&1 ${cronTag(commonDir)}`
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
  return [
    `# ${service} — install under ${r.unitDir}`,
    systemdService(dir, version, r.envPath),
    `# ${timer} — then: systemctl --user daemon-reload && systemctl --user enable --now ${timer}`,
    systemdTimer(r.unit, everySec),
    `# or a crontab line`,
    cronLine(dir, everySec, r.envPath, r.common, version),
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

/** Read the current crontab; a missing table (fresh user) is empty,
 *  not an error. */
function readCrontab(run: SchedRunner): string[] | null {
  const r = run('crontab', ['-l'])
  if (r.code === 127) {
    return null
  }
  return r.code === 0 ? r.out.split('\n') : []
}

/** Remove a repo's managed lines; returns null when crontab is
 *  unusable. */
function stripCronTag(run: SchedRunner, tag: string): number | null {
  const lines = readCrontab(run)
  if (lines === null) {
    return null
  }
  const kept = lines.filter((l) => !l.includes(tag))
  const removed = lines.length - kept.length
  if (removed === 0) {
    return 0
  }
  const w = run('crontab', ['-'], kept.join('\n'))
  return w.code === 0 ? removed : null
}

function installCron(
  r: Resolved,
  dir: string,
  everySec: number,
  version: string
): { state: 'installed' | 'updated' | 'already' | 'error'; detail: string } {
  const tag = cronTag(r.common)
  const line = cronLine(dir, everySec, r.envPath, r.common, version)
  const lines = readCrontab(r.run)
  if (lines === null) {
    return { state: 'error', detail: 'crontab -l failed' }
  }
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
    detail: `crontab entry every ${Math.max(1, Math.ceil(everySec / 60))}min (${tag})`,
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
    stripCronTag(r.run, cronTag(r.common))
    const res = installSystemd(r, dir, opts.everySec, version)
    return { ...res, backend }
  }
  // cron install — a stale systemd unit for this repo goes best-effort
  const svc = join(r.unitDir, `${r.unit}.service`)
  const tmr = join(r.unitDir, `${r.unit}.timer`)
  r.run('systemctl', ['--user', 'disable', '--now', `${r.unit}.timer`])
  rmSync(svc, { force: true })
  rmSync(tmr, { force: true })
  const res = installCron(r, dir, opts.everySec, version)
  return { ...res, backend }
}

export function uninstallWatch(dir: string, deps: WatchSchedDeps = {}): WatchInstallResult {
  const r = resolveSched(dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  const tag = cronTag(r.common)
  let removed = false
  const backend = detectBackend(r.run)
  if (backend === 'systemd' || r.run('systemctl', ['--version']).code !== 127) {
    r.run('systemctl', ['--user', 'disable', '--now', `${r.unit}.timer`])
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
  }
  const stripped = stripCronTag(r.run, tag)
  removed = removed || (stripped ?? 0) > 0
  return {
    state: removed ? 'removed' : 'absent',
    backend: backend ?? undefined,
    detail: removed ? `${r.unit} removed` : `no entry for ${r.unit}`,
  }
}

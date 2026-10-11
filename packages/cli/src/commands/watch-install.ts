/**
 * `bro watch install|uninstall` — the session-pulse arm/disarm
 * (bro-killn). The systemd/crontab *writers* are retired: OS service
 * management is outside the agent-plugin horizon — durable state
 * already survives reboots; only the cadence needed a home, and the
 * orchestrator session is it (spec: specs/bro-killn.md).
 *
 *   bro watch install [--every N] [--print]   arm the pulse for this repo
 *   bro watch uninstall                       disarm + strip any legacy entry
 *
 * `install` writes `<git-common>/bro/pulse.json` — the want-marker the
 * session-start hook rearms from when no live `bro watch --every` holds
 * `bro/pulse.lock`. Both verbs still strip legacy `bro-watch-<h8>`
 * systemd units and managed crontab lines: timers already installed on
 * machines must not double-tick beside the pulse. `--print` emits the
 * marker payload and the rearm command without touching anything.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitTry } from '@broject/core'
import { armPulse, disarmPulse, pulseLive, pulseMarkerPath } from './watch-pulse.ts'

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

export type SchedBackend = 'systemd' | 'cron'

/** systemd user first — crontab is the portable floor; null when
 *  neither answers. A dead systemctl binary (127) is not a user-bus
 *  problem — it's absence. */
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
  run: SchedRunner
}

function resolveSched(dir: string, deps: WatchSchedDeps): Resolved | { error: string } {
  const common = watchCommonDir(dir)
  if (common === null) {
    return { error: 'not a git repository — the pulse marker has no common dir to live in' }
  }
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  return {
    common,
    unit: unitName(common),
    unitDir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    run: deps.run ?? realRun,
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

/** systemd side of the legacy strip: disable the timer, delete both
 *  unit files, reload so the manager re-reads the dir. A disable that
 *  fails while units existed warns — files are gone but the loaded
 *  timer may linger, and a clean 'removed' would lie. */
function retireSystemdUnits(r: Resolved): { removed: boolean; warn: string } {
  const hadUnits =
    existsSync(join(r.unitDir, `${r.unit}.service`)) ||
    existsSync(join(r.unitDir, `${r.unit}.timer`))
  const disable = r.run('systemctl', ['--user', 'disable', '--now', `${r.unit}.timer`])
  let removed = false
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
  return {
    removed,
    warn:
      hadUnits && disable.code !== 0
        ? `warning: systemd disable failed — a live timer may linger (${disable.err.trim() || `exited ${disable.code}`})`
        : '',
  }
}

/** The legacy strip both verbs share — a pre-retirement `bro-watch-<h8>`
 *  entry still ticking beside the session pulse would double the
 *  cadence. Removal only; nothing here writes a scheduler entry. */
function stripLegacy(
  r: Resolved
): { removed: boolean; warn: string } | { failed: string } {
  const tag = cronTag(r.common)
  const backend = detectBackend(r.run)
  const retired =
    backend === 'systemd' || r.run('systemctl', ['--version']).code !== 127
      ? retireSystemdUnits(r)
      : { removed: false, warn: '' }
  const stripped = stripCronTag(r.run, tag)
  if ('failed' in stripped) {
    // the managed line may still be in the table — 'absent' would lie
    return { failed: `crontab strip failed — the managed line may remain: ${stripped.failed}` }
  }
  return {
    removed: retired.removed || ('removed' in stripped && stripped.removed > 0),
    warn: retired.warn,
  }
}

export interface WatchInstallResult {
  state: 'installed' | 'updated' | 'already' | 'removed' | 'absent' | 'printed' | 'error'
  backend?: SchedBackend
  detail: string
}

/** The rearm command --print and the install detail both show. */
function rearmCommand(everySec: number, pulseSec: number): string {
  return `bro watch --every ${everySec} --for ${Math.max(pulseSec, everySec)} --notify`
}

export function installWatch(
  dir: string,
  opts: { everySec: number; pulseSec: number; print?: boolean },
  deps: WatchSchedDeps = {}
): WatchInstallResult {
  const r = resolveSched(dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  if (opts.print === true) {
    return {
      state: 'printed',
      detail: [
        `# ${pulseMarkerPath(dir)} — the want-marker; session-start rearms a dead pulse from it`,
        JSON.stringify({ everySec: opts.everySec, armedAt: '<install time>' }, null, 2),
        '# the session owns the cadence — no OS timer is installed:',
        `${rearmCommand(opts.everySec, opts.pulseSec)}   # bounded window; on end: bro drive → digest → re-arm`,
      ].join('\n'),
    }
  }
  const strip = stripLegacy(r)
  if ('failed' in strip) {
    return { state: 'error', detail: strip.failed }
  }
  let arm: ReturnType<typeof armPulse>
  try {
    arm = armPulse(dir, opts.everySec)
  } catch (err) {
    return { state: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  const suffix = [
    strip.removed ? 'legacy scheduler entry removed' : '',
    strip.warn,
  ]
    .filter((s) => s !== '')
    .join(' — ')
  const verb =
    arm.state === 'already' ? 'already armed' : arm.state === 'updated' ? 're-armed' : 'armed'
  return {
    state: arm.state === 'armed' ? 'installed' : arm.state === 'updated' ? 'updated' : 'already',
    detail:
      `watch pulse ${verb} — ${rearmCommand(opts.everySec, opts.pulseSec)} ` +
      '(the session owns the cadence; no OS timer installed)' +
      (suffix === '' ? '' : ` — ${suffix}`),
  }
}

export function uninstallWatch(dir: string, deps: WatchSchedDeps = {}): WatchInstallResult {
  const r = resolveSched(dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  const marker = disarmPulse(dir)
  const strip = stripLegacy(r)
  if ('failed' in strip) {
    return {
      state: 'error',
      detail: `${marker === 'disarmed' ? 'pulse disarmed — ' : ''}${strip.failed}`,
    }
  }
  const removed = marker === 'disarmed' || strip.removed
  // a running `bro watch --every` keeps its lock until it exits —
  // disarm drops the rearm intent, not the live process
  const live = pulseLive(dir)
  const liveNote = live.live ? `live pulse still running (pid ${live.pid}) — exits on its own` : ''
  return {
    state: removed ? 'removed' : 'absent',
    detail: [
      removed
        ? `${marker === 'disarmed' ? 'pulse disarmed' : 'no pulse marker'}${strip.removed ? ' — legacy entry removed' : ''}`
        : `no pulse marker or legacy entry for ${r.unit}`,
      strip.warn,
      liveNote,
    ]
      .filter((s) => s !== '')
      .join(' — '),
  }
}

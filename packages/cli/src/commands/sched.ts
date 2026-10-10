/**
 * The poll-on-a-scheduler engine (bro-te73m) — extracted from
 * watch-install so every cadence-owned verb can install itself:
 * `bro watch install` was the first consumer, `bro rig install` the
 * second. A session holder's only job is keeping the turn-loop alive;
 * polling belongs to a scheduler with zero inference per tick — a
 * systemd user timer when `systemctl --user` answers, a managed
 * crontab line otherwise.
 *
 * Entries are per-repo, named `<spec.prefix>-<h8>` where `<h8>` is the
 * git-common-dir's sha256 prefix — worktrees share one entry and a
 * moved checkout keeps its unit. The spec carries everything
 * verb-specific:
 *
 *   prefix      unit + cron-tag prefix ('bro-watch', 'bro-rig')
 *   label       Description stem ('bro watch heartbeat')
 *   hint        the install command named in no-scheduler guidance
 *   invocation  the ExecStart/cron shell line (bro first, npx fallback)
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

export interface SchedSpec {
  /** unit + cron-tag prefix — `<prefix>-<h8>` */
  prefix: string
  /** Description stem — `<label> — <dir>` service, `<label> timer — <unit>` timer */
  label: string
  /** the install command printed when no scheduler answers — 'bro watch install' */
  hint: string
  /** ExecStart / crontab shell line — bro on PATH first, pinned npx fallback */
  invocation: (version: string) => string
}

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

export interface SchedDeps {
  run?: SchedRunner
  /** PATH + XDG_CONFIG_HOME source — injected in tests. */
  env?: NodeJS.ProcessEnv
  /** ~ — injected in tests so no real unit dir is touched. */
  home?: string
}

/** The absolute git common dir — units hash on this so a repo's timer
 *  survives a moved checkout and worktrees share one entry. */
export function schedCommonDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  let common = r.code === 0 ? r.out.trim() : ''
  if (common === '') {
    const rel = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
    common = rel.code === 0 && rel.out.trim() !== '' ? resolve(dir, rel.out.trim()) : ''
  }
  return common === '' ? null : common
}

export function schedUnitHash(commonDir: string): string {
  return createHash('sha256').update(commonDir).digest('hex').slice(0, 8)
}

export const unitName = (spec: SchedSpec, commonDir: string): string =>
  `${spec.prefix}-${schedUnitHash(commonDir)}`
export const cronTag = (spec: SchedSpec, commonDir: string): string =>
  `# ${spec.prefix}-${schedUnitHash(commonDir)}`

/** Single-quote for sh — the only quoting that survives both systemd's
 *  ExecStart parse and cron's `sh -c` line. */
const shq = (s: string): string => `'${s.replaceAll("'", `'"'"'`)}'`

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

/** Type=oneshot service — the scheduler owns the cadence; the verb exits
 *  after one pass. PATH is captured at install time because a user
 *  manager doesn't inherit nvm/~/.local shims. Every interpolated path
 *  goes through unitEsc — a newline in a checkout name would otherwise
 *  inject a new directive (a8fh). */
export function systemdService(
  spec: SchedSpec,
  dir: string,
  version: string,
  envPath: string
): string {
  return `[Unit]
Description=${spec.label} — ${unitEsc(dir)}
Documentation=https://github.com/theplenkov/bro

[Service]
Type=oneshot
WorkingDirectory=${unitEsc(dir)}
Environment="PATH=${unitEsc(envPath).replaceAll('"', '\\"')}"
ExecStart=/bin/sh -c ${shq(spec.invocation(version))}
`
}

export function systemdTimer(spec: SchedSpec, unit: string, everySec: number): string {
  return `[Unit]
Description=${spec.label} timer — ${unit}

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
 *  configured. A whole-field step resets at the boundary — a 7-minute
 *  step fires at :56 and again at :00 — so non-divisor steps instead
 *  range from the step value (`7-59/7`), keeping every gap ≥ the
 *  cadence. */
export function cronSchedule(everySec: number): string {
  const mins = Math.ceil(everySec / 60)
  if (mins <= 1) {
    return '* * * * *'
  }
  if (mins < 60) {
    const minuteField = 60 % mins === 0 ? `*/${mins}` : `${mins}-59/${mins}`
    return `${minuteField} * * * *`
  }
  const hours = Math.ceil(mins / 60)
  if (hours < 24) {
    const hourField = 24 % hours === 0 ? `*/${hours}` : `${hours}-23/${hours}`
    return `0 ${hourField} * * *`
  }
  const days = Math.ceil(hours / 24)
  const dayField = days === 1 ? '*/1' : `${days}-31/${days}`
  return `0 0 ${dayField} * *`
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
  spec: SchedSpec,
  dir: string,
  everySec: number,
  envPath: string,
  commonDir: string,
  version: string
): string {
  const sched = cronSchedule(everySec)
  const d = cronEsc(dir)
  const p = cronEsc(envPath)
  return `${sched} cd ${shq(d)} && PATH=${shq(p)} sh -c ${shq(spec.invocation(version))} >/dev/null 2>&1 ${cronTag(spec, commonDir)}`
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

function resolveSched(spec: SchedSpec, dir: string, deps: SchedDeps): Resolved | { error: string } {
  const common = schedCommonDir(dir)
  if (common === null) {
    return { error: 'not a git repository — nothing to schedule against' }
  }
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  return {
    common,
    unit: unitName(spec, common),
    unitDir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    envPath: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    run: deps.run ?? realRun,
  }
}

/** Artifacts for --print (and the install-nowhere guidance). */
export function printArtifacts(
  spec: SchedSpec,
  dir: string,
  everySec: number,
  version: string,
  deps: SchedDeps
): string | { error: string } {
  const r = resolveSched(spec, dir, deps)
  if ('error' in r) {
    return r
  }
  const service = `${r.unit}.service`
  const timer = `${r.unit}.timer`
  let cron: string
  try {
    cron = cronLine(spec, dir, everySec, r.envPath, r.common, version)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return [
    `# ${service} — install under ${r.unitDir}`,
    systemdService(spec, dir, version, r.envPath),
    `# ${timer} — then: systemctl --user daemon-reload && systemctl --user enable --now ${timer}`,
    systemdTimer(spec, r.unit, everySec),
    `# or a crontab line`,
    cron,
  ].join('\n')
}

/** systemd install: write both units, daemon-reload, enable --now.
 *  Identical files still re-enable (a disabled timer is not
 *  "already"); changed files rewrite in place. */
function installSystemd(
  spec: SchedSpec,
  r: Resolved,
  dir: string,
  everySec: number,
  version: string
): { state: 'installed' | 'updated' | 'already' | 'error'; detail: string } {
  const service = systemdService(spec, dir, version, r.envPath)
  const timer = systemdTimer(spec, r.unit, everySec)
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
  spec: SchedSpec,
  r: Resolved,
  dir: string,
  everySec: number,
  version: string
): { state: 'installed' | 'updated' | 'already' | 'error'; detail: string } {
  const tag = cronTag(spec, r.common)
  let line: string
  try {
    line = cronLine(spec, dir, everySec, r.envPath, r.common, version)
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

export interface SchedInstallResult {
  state: 'installed' | 'updated' | 'already' | 'removed' | 'absent' | 'printed' | 'error'
  backend?: SchedBackend
  detail: string
}

export function installSched(
  spec: SchedSpec,
  dir: string,
  version: string,
  opts: { everySec: number; print?: boolean },
  deps: SchedDeps = {}
): SchedInstallResult {
  const r = resolveSched(spec, dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  const backend = detectBackend(r.run)
  if (opts.print === true) {
    const out = printArtifacts(spec, dir, opts.everySec, version, deps)
    return typeof out === 'string'
      ? { state: 'printed', backend: backend ?? undefined, detail: out }
      : { state: 'error', detail: out.error }
  }
  if (backend === null) {
    const out = printArtifacts(spec, dir, opts.everySec, version, deps)
    return {
      state: 'error',
      detail:
        'no scheduler found — neither `systemctl --user` nor `crontab` answers. ' +
        `Install the entry by hand (\`${spec.hint} --print\`):\n` +
        (typeof out === 'string' ? out : ''),
    }
  }
  // one entry per repo, one backend — a surviving foreign-backend entry
  // would double the cadence
  if (backend === 'systemd') {
    const strip = stripCronTag(r.run, cronTag(spec, r.common))
    if ('failed' in strip) {
      // can't prove the crontab lost our line — enabling systemd anyway
      // risks both schedulers ticking
      return {
        state: 'error',
        backend,
        detail: `cannot strip the crontab entry (${strip.failed}) — refusing to double-schedule`,
      }
    }
    const res = installSystemd(spec, r, dir, opts.everySec, version)
    return { ...res, backend }
  }
  // cron install — a stale systemd unit for this repo goes best-effort
  return installCronPath(spec, r, dir, opts.everySec, version, backend)
}

/** Cron backend: a stale systemd unit for this repo is retired
 *  best-effort — files are deleted either way; a disable that fails on
 *  a still-loaded timer earns a warning on the result, never a
 *  rollback (the cron entry is already live, and a lingering timer
 *  would double-tick). */
function installCronPath(
  spec: SchedSpec,
  r: Resolved,
  dir: string,
  everySec: number,
  version: string,
  backend: SchedBackend
): SchedInstallResult {
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
  const res = installCron(spec, r, dir, everySec, version)
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

/** systemd side of uninstall: disable the timer, delete both unit
 *  files, reload so the manager re-reads the dir. A disable that fails
 *  while units existed warns — files are gone but the loaded timer may
 *  linger, and a clean 'removed' would lie. */
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

export function uninstallSched(
  spec: SchedSpec,
  dir: string,
  deps: SchedDeps = {}
): SchedInstallResult {
  const r = resolveSched(spec, dir, deps)
  if ('error' in r) {
    return { state: 'error', detail: r.error }
  }
  const tag = cronTag(spec, r.common)
  const backend = detectBackend(r.run)
  const retired =
    backend === 'systemd' || r.run('systemctl', ['--version']).code !== 127
      ? retireSystemdUnits(r)
      : { removed: false, warn: '' }
  const stripped = stripCronTag(r.run, tag)
  if ('failed' in stripped) {
    // the managed line may still be in the table — 'absent' would lie
    return {
      state: 'error',
      backend: backend ?? undefined,
      detail: `crontab strip failed — the managed line may remain: ${stripped.failed}`,
    }
  }
  const removed = retired.removed || ('removed' in stripped && stripped.removed > 0)
  return {
    state: removed ? 'removed' : 'absent',
    backend: backend ?? undefined,
    detail: [removed ? `${r.unit} removed` : `no entry for ${r.unit}`, retired.warn]
      .filter((s) => s !== '')
      .join(' — '),
  }
}

/** Where the repo's entry lives right now — the read side for
 *  `… status` verbs. 'both' is the double-tick hazard install refuses;
 *  'unknown' when the crontab read failed and no units exist. */
export function schedState(
  spec: SchedSpec,
  dir: string,
  deps: SchedDeps = {}
): { state: 'systemd' | 'cron' | 'both' | 'none' | 'unknown'; unit: string } {
  const common = schedCommonDir(dir)
  if (common === null) {
    return { state: 'none', unit: '' }
  }
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const unit = unitName(spec, common)
  const unitDir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user')
  const systemd =
    existsSync(join(unitDir, `${unit}.service`)) || existsSync(join(unitDir, `${unit}.timer`))
  const run = deps.run ?? realRun
  const table = readCrontab(run)
  if ('missing' in table) {
    return { state: systemd ? 'systemd' : 'none', unit }
  }
  if ('failed' in table) {
    return { state: systemd ? 'systemd' : 'unknown', unit }
  }
  const cron = table.lines.some((l) => l.includes(cronTag(spec, common)))
  return {
    state: systemd && cron ? 'both' : systemd ? 'systemd' : cron ? 'cron' : 'none',
    unit,
  }
}

/**
 * `bro rig` — the rig's checkout freshness (bro-te73m): keep the
 * machine's main checkout tracking its upstream, rebuilt and
 * hotpatched. The ad-hoc setsid poller this replaces pulled on a
 * cadence; the verb separates the two halves:
 *
 *   bro rig sync [--repo <dir>]      one pass — fetch → merge --ff-only
 *                                    @{upstream} → the post-merge
 *                                    refresh (install → build → patch)
 *   bro rig status [--repo] [--json] the read plane — no network
 *   bro rig watch [--every N]        the supervisor loop (setsid shape)
 *      [--for S]
 *   bro rig install [--every N]      arm the cadence — a rig-pulse.json
 *      [--print]                        want-marker the session's
 *                                    checkpoints rearm a bounded watch
 *                                    window from (bro-killn: no OS
 *                                    scheduler, the session owns it)
 *   bro rig uninstall                disarm the marker
 *
 * The target is "the local main checkout": `--repo` > `rig.repo` >
 * the main worktree of the repo containing cwd — a scratch `loop/*`
 * worktree never becomes the target. Upstream tracking does the rest:
 * whatever branch the main checkout sits on, sync fast-forwards it to
 * `@{upstream}` — a diverged or dirty tree is reported, never resolved
 * or pulled over.
 *
 * The refresh verdict is asserted from `post-merge.done`, not the
 * worker's log (state-assertions rule): done-sha == HEAD means the
 * install→build→patch chain completed on this head.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  awaitFileLock,
  dropMailbox,
  gitTry,
  loadConfig,
  LockTimeout,
  mailboxDir,
  hasHelpFlag,
  printUsage,
  shQuote,
  withFileLock,
  worktreeGitDir,
} from '@broject/core'
import { flag, positionals } from './args.ts'
import { MIN_INTERVAL_SEC, MAX_INTERVAL_SEC } from './drive-config.ts'
import {
  freshnessSection,
  postMergeDoneSha,
  resolveSteps,
  runPostMergeRefresh,
  type FreshnessConfig,
} from './postmerge.ts'
import { rigSection, type RigConfig } from './rig-config.ts'
import { runRigNext } from './rig-next.ts'
import {
  armRigPulse,
  disarmRigPulse,
  rigPulseLive,
  rigPulseLockPath,
  rigPulseMarkerPath,
  rigPulseState,
} from './rig-pulse.ts'
import { isOrchestratorSession } from './watch-pulse.ts'
import { parseWorktreePorcelain } from './work.ts'

/** Two concurrent syncs on one checkout race `git merge` against
 *  `git merge` (and npm against npm through the refresh) — a lockfile
 *  turns the second caller into a clean 'skipped'. Held through the
 *  refresh so a poller can't observe the pulled-but-unbuilt gap. */
const LOCK_WAIT_MS = 60_000

/** `~` expands; a relative path resolves against cwd — operator
 *  configs should write absolute paths, but a relative one must not
 *  silently miss. */
function expandRepoPath(p: string, cwd: string): string {
  const t = p.trim()
  const expanded = t === '~' ? homedir() : t.startsWith(`~/`) ? join(homedir(), t.slice(2)) : t
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

export interface RigRepo {
  repo: string
  via: 'flag' | 'config' | 'worktree'
}

/** `--repo` > `rig.repo` config > the current repo's main worktree —
 *  `git worktree list`'s first entry is always the primary checkout.
 *  An explicitly named dir is honored verbatim (a worktree target is
 *  the operator's call); auto-resolution never picks a scratch
 *  worktree. */
export function resolveRigRepo(
  cwd: string,
  cfg: RigConfig,
  flagRepo?: string
): RigRepo | { error: string } {
  if (flagRepo !== undefined) {
    return { repo: expandRepoPath(flagRepo, cwd), via: 'flag' }
  }
  if (cfg.repo !== undefined) {
    return { repo: expandRepoPath(cfg.repo, cwd), via: 'config' }
  }
  const r = gitTry(['-C', cwd, 'worktree', 'list', '--porcelain'])
  if (r.code !== 0) {
    return { error: 'not a git repository — pass --repo or set rig.repo' }
  }
  const main = parseWorktreePorcelain(r.out)[0]
  if (main === undefined) {
    return { error: 'git worktree list returned no main entry' }
  }
  return { repo: main.path, via: 'worktree' }
}

const gitIn = (repo: string, args: string[]) => gitTry(['-C', repo, ...args])

export interface RigSyncResult {
  state: 'synced' | 'current' | 'skipped' | 'incomplete' | 'error'
  repo: string
  detail: string
  branch?: string
  upstream?: string
  pulled?: { from: string; to: string }
}

export interface RigSyncDeps {
  /** the install→build→patch chain — injectable for tests; production
   *  is postmerge.ts's serialized worker. */
  refresh?: (cwd: string) => void
  /** transition drop for live sessions — injectable; production drops
   *  into the repo mailbox. */
  notify?: (text: string) => void
  /** done-sha read — injectable so tests don't need the refresh to
   *  write state. */
  doneSha?: (cwd: string) => string | null
}

const defaultDoneSha = (cwd: string): string | null => postMergeDoneSha(cwd)

function notifyDrop(repo: string, text: string): void {
  const mb = mailboxDir(repo)
  if (mb !== null) {
    try {
      dropMailbox(mb, text, 'rig')
    } catch {
      // a dropped-ball mailbox must not fail the sync that produced it
    }
  }
}

/** One freshness pass over `repo`, serialized on
 *  `<gitdir>/bro/rig-sync.lock`. Never throws — the result carries the
 *  classification so a supervisor tick can't die on a bad fetch. */
export function rigSync(repo: string, deps: RigSyncDeps = {}): RigSyncResult {
  const gitdir = worktreeGitDir(repo)
  if (gitdir === null) {
    return { state: 'error', repo, detail: `${repo} is not a git worktree` }
  }
  try {
    return withFileLock(join(gitdir, 'bro', 'rig-sync.lock'), () => syncOnce(repo, deps), {
      waitMs: LOCK_WAIT_MS,
      label: 'rig sync lock',
    })
  } catch (err) {
    if (err instanceof LockTimeout) {
      return { state: 'skipped', repo, detail: 'another rig sync is running' }
    }
    return {
      state: 'error',
      repo,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The pre-pull guards — cheapest first, a human mid-edit outranks a
 *  stale checkout. A guard trip is the result; a clean pass hands back
 *  the tracking context the pull/refresh half works from. */
function syncGuards(repo: string): RigSyncResult | SyncTrack {
  const base = { repo }
  const dirty = gitIn(repo, ['status', '--porcelain'])
  if (dirty.code !== 0) {
    return { ...base, state: 'error', detail: `git status: ${dirty.err}` }
  }
  if (dirty.out.trim() !== '') {
    return { ...base, state: 'skipped', detail: 'worktree dirty — not pulling over uncommitted work' }
  }
  const branch = gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  const up = gitIn(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const upstream = up.out.trim()
  if (up.code !== 0 || upstream === '') {
    return {
      ...base,
      state: 'error',
      branch: branch === 'HEAD' ? undefined : branch,
      detail: 'no upstream — the checkout tracks nothing (detached HEAD or unpublished branch)',
    }
  }
  const fetch = gitIn(repo, ['fetch'])
  if (fetch.code !== 0) {
    return { ...base, state: 'error', branch, upstream, detail: `git fetch: ${fetch.err}` }
  }
  const counts = gitIn(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  const [aheadS, behindS] = counts.out.trim().split(/\s+/)
  const ahead = Number(aheadS)
  const behind = Number(behindS)
  if (counts.code !== 0 || !Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return {
      ...base,
      state: 'error',
      branch,
      upstream,
      detail: `rev-list HEAD...@{upstream}: ${counts.err || counts.out.trim()}`,
    }
  }
  return { branch, upstream, ahead, behind }
}

interface SyncTrack {
  branch: string
  upstream: string
  ahead: number
  behind: number
}

function syncOnce(repo: string, deps: RigSyncDeps): RigSyncResult {
  const base = { repo }
  const g = syncGuards(repo)
  if ('state' in g) {
    return g
  }
  const { branch, upstream, ahead, behind } = g

  const pull = pullPhase(repo, branch, upstream, ahead, behind, deps)
  if ('error' in pull) {
    return pull.error
  }
  const pulled = pull.pulled

  const head = gitIn(repo, ['rev-parse', 'HEAD']).out.trim()
  const span = pulled === undefined ? '' : `${pulled.from.slice(0, 12)}..${pulled.to.slice(0, 12)}`

  // Same bootstrap gate the post-merge dispatcher applies: no
  // package.json means there is nothing to build, and a missing
  // node_modules means the checkout was never bootstrapped — the
  // operator bootstraps once, the mechanic takes over after. Without
  // the gate a non-node repo would 'npm install' itself into a frozen
  // done-sha every tick.
  const bootstrapped =
    existsSync(join(repo, 'package.json')) && existsSync(join(repo, 'node_modules'))
  if (!bootstrapped) {
    const note = 'refresh skipped — not bootstrapped (needs package.json + node_modules)'
    return pulled === undefined
      ? { ...base, state: 'current', branch, upstream, detail: `current @ ${head.slice(0, 12)} — ${note}` }
      : { ...base, state: 'synced', branch, upstream, pulled, detail: `pulled ${span} — ${note}` }
  }

  // Unconditional — a refresh killed mid-build leaves done-sha behind
  // HEAD and this pass is the healer. The worker serializes on
  // post-merge.lock; an installed git hook's detached worker either
  // holds it (we wait) or already advanced the done-sha (we no-op).
  ;(deps.refresh ?? runPostMergeRefresh)(repo)

  const done = (deps.doneSha ?? defaultDoneSha)(repo)
  if (done !== head) {
    return {
      ...base,
      state: 'incomplete',
      branch,
      upstream,
      pulled,
      detail:
        `refresh incomplete — done-sha ${done === '' || done === null ? '(none)' : done.slice(0, 12)} ≠ HEAD ${head.slice(0, 12)}` +
        (pulled === undefined ? '' : ` after pulling ${span}`) +
        '; see the post-merge log',
    }
  }
  if (pulled !== undefined) {
    return {
      ...base,
      state: 'synced',
      branch,
      upstream,
      pulled,
      detail: `pulled ${span} — refreshed @ ${head.slice(0, 12)}`,
    }
  }
  return {
    ...base,
    state: 'current',
    branch,
    upstream,
    detail: `current @ ${head.slice(0, 12)} (${ahead} ahead, 0 behind ${upstream})`,
  }
}

/** The ff-only catch-up — diverged checkouts and failed merges are
 *  errors the caller reports; a successful pull drops the mailbox
 *  transition. Extracted so `syncOnce` reads guard → fetch → pull →
 *  refresh in one straight line. */
function pullPhase(
  repo: string,
  branch: string,
  upstream: string,
  ahead: number,
  behind: number,
  deps: RigSyncDeps
): { pulled?: { from: string; to: string } } | { error: RigSyncResult } {
  const base = { repo, branch, upstream }
  if (behind === 0) {
    return {}
  }
  if (ahead > 0) {
    return {
      error: {
        ...base,
        state: 'error',
        detail: `diverged from ${upstream} (${ahead} ahead, ${behind} behind) — needs a manual rebase`,
      },
    }
  }
  const from = gitIn(repo, ['rev-parse', 'HEAD']).out.trim()
  const merge = gitIn(repo, ['merge', '--ff-only', '@{upstream}'])
  if (merge.code !== 0) {
    return {
      error: {
        ...base,
        state: 'error',
        detail: `merge --ff-only ${upstream}: ${merge.err || merge.out.trim()}`,
      },
    }
  }
  const to = gitIn(repo, ['rev-parse', 'HEAD']).out.trim()
  ;(deps.notify ?? ((t) => notifyDrop(repo, t)))(
    `rig: pulled ${from.slice(0, 12)}..${to.slice(0, 12)} into ${repo} — refresh queued`
  )
  return { pulled: { from, to } }
}

// --- status -------------------------------------------------------------------

export interface RigStatus {
  repo: string
  via: string
  error?: string
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  dirty?: number
  head?: string
  bootstrapped?: boolean
  doneSha?: string
  fresh?: boolean
  steps?: string[]
  pulse?: string
}

/** The read plane — stored refs only, no fetch: `behind` is what the
 *  last poll (or any fetch) learned, which is exactly what `rig status`
 *  should report. */
export function rigStatus(repo: string, via: string): RigStatus {
  const out: RigStatus = { repo, via }
  const gitdir = worktreeGitDir(repo)
  if (gitdir === null) {
    out.error = `${repo} is not a git worktree`
    return out
  }
  const branch = gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  out.branch = branch === 'HEAD' ? '(detached)' : branch
  const up = gitIn(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (up.code === 0 && up.out.trim() !== '') {
    out.upstream = up.out.trim()
    const counts = gitIn(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const [a, b] = counts.out.trim().split(/\s+/).map(Number)
    if (counts.code === 0 && Number.isFinite(a) && Number.isFinite(b)) {
      out.ahead = a
      out.behind = b
    }
  }
  const dirty = gitIn(repo, ['status', '--porcelain'])
  if (dirty.code === 0) {
    out.dirty = dirty.out.split('\n').filter(Boolean).length
  }
  out.head = gitIn(repo, ['rev-parse', 'HEAD']).out.trim()
  // same bootstrap gate as syncOnce — a non-node or never-installed
  // checkout has no refresh story to report
  out.bootstrapped =
    existsSync(join(repo, 'package.json')) && existsSync(join(repo, 'node_modules'))
  if (out.bootstrapped) {
    const done = postMergeDoneSha(repo)
    out.doneSha = done ?? undefined
    out.fresh = done !== null && done === out.head
    const freshness =
      (loadConfig(repo, { freshness: freshnessSection }) as { freshness?: FreshnessConfig })
        .freshness ?? {}
    // `changed: true` previews the dep-manifest path — the worst case a
    // pull can queue, which is what an operator audits
    out.steps = resolveSteps(repo, freshness, true)
  }
  out.pulse = rigPulseState(repo)
  return out
}

function refreshLine(s: RigStatus): string {
  if (s.bootstrapped === false) {
    return 'n/a — not bootstrapped (needs package.json + node_modules)'
  }
  if (s.fresh === true) {
    return `fresh @ ${(s.head ?? '').slice(0, 12)}`
  }
  const done = (s.doneSha ?? '') === '' ? '(none)' : (s.doneSha ?? '').slice(0, 12)
  return `stale — done ${done} ≠ HEAD ${(s.head ?? '').slice(0, 12)}`
}

function printStatus(s: RigStatus): void {
  console.log(`rig:      ${s.repo} (${s.via})`)
  if (s.error !== undefined) {
    console.log(`error:    ${s.error}`)
    return
  }
  const drift = s.ahead !== undefined ? ` — ahead ${s.ahead}, behind ${s.behind}` : ''
  const track = s.upstream === undefined ? '(no upstream)' : `${s.upstream}${drift}`
  const dirty =
    s.dirty === undefined ? 'unknown' : s.dirty === 0 ? 'clean' : `dirty (${s.dirty})`
  console.log(`branch:   ${s.branch} → ${track}`)
  console.log(`worktree: ${dirty}`)
  console.log(`refresh:  ${refreshLine(s)}`)
  if (s.bootstrapped === true) {
    const steps = s.steps !== undefined && s.steps.length > 0 ? s.steps.join(' && ') : '(none resolved)'
    console.log(`steps:    ${steps}`)
  }
  console.log(`pulse:    ${s.pulse}`)
}

// --- dispatch -----------------------------------------------------------------

function usage(exitCode = 2): never {
  printUsage(`usage:
  bro rig sync [--repo <dir>]       fetch → merge --ff-only @{upstream} → refresh
  bro rig status [--repo <dir>] [--json]
  bro rig next [<item>] [--json]    the engine's re-entry verdict: step|gate|wait|done|blocked
  bro rig watch [--repo <dir>] [--every SEC] [--for SEC]
  bro rig install [--repo <dir>] [--every SEC] [--print]
  bro rig uninstall [--repo <dir>]
  install arms the session pulse — no OS timer is written`, exitCode)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Every subcommand needs a repo — an unresolvable one is the same
 *  error everywhere, so the gate lives here once. */
function needRepo(resolved: RigRepo | { error: string }): RigRepo {
  if ('error' in resolved) {
    console.error(`bro rig: ${resolved.error}`)
    process.exit(1)
  }
  return resolved
}

/** `--every` parsing shared by watch and install — the cadence bound
 *  is the same contract in both. */
function everyArg(argv: string[], cfg: RigConfig): number {
  const everyRaw = flag(argv, '--every')
  const everySec = everyRaw === undefined ? cfg.intervalSec : Number(everyRaw)
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? everySec}"`
    )
    process.exit(2)
  }
  return everySec
}

function cmdSync(resolved: RigRepo | { error: string }): never {
  const { repo } = needRepo(resolved)
  const r = rigSync(repo)
  console.log(`rig ${r.state}: ${r.detail}`)
  process.exit(r.state === 'error' || r.state === 'incomplete' ? 1 : 0)
}

function cmdStatus(resolved: RigRepo | { error: string }, argv: string[]): never {
  const { repo, via } = needRepo(resolved)
  const s = rigStatus(repo, via)
  if (argv.includes('--json')) {
    console.log(JSON.stringify(s, null, 2))
  } else {
    printStatus(s)
  }
  process.exit(s.error === undefined ? 0 : 1)
}

async function cmdWatch(
  argv: string[],
  cfg: RigConfig,
  resolved: RigRepo | { error: string }
): Promise<void> {
  const { repo } = needRepo(resolved)
  const everySec = everyArg(argv, cfg)
  const forRaw = flag(argv, '--for')
  const forSec = forRaw === undefined ? undefined : Number(forRaw)
  // NaN or an overflowing --for is no bound at all — deadline stays
  // unreachable and the loop ticks forever at --every's cadence
  if (
    forSec !== undefined &&
    (!Number.isFinite(forSec) || forSec <= 0 || !Number.isFinite(forSec * 1000))
  ) {
    console.error(`error: --for needs a finite seconds value >0, got "${forRaw}"`)
    process.exit(2)
  }
  // GUARD (bro-killn): spawned workers pin BRO_AGENT_ID at spawn —
  // they never own a cadence; the orchestrator session does. Same
  // predicate and refusal shape as `bro watch --every`.
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never run the rig cadence; ' +
        'the orchestrator session owns it'
    )
    process.exit(2)
  }
  // the bound starts before the first tick — a slow pull already
  // spends --for budget (watch's contract)
  const deadline =
    forSec === undefined ? Number.POSITIVE_INFINITY : performance.now() + forSec * 1000
  // One rig pulse per repo: `bro/rig-pulse.lock` is held for the
  // process lifetime — a rearmed window stands by behind the
  // incumbent and takes over when it exits, never ticks concurrently
  // (same contract as the watch pulse, spec bro-2duu9).
  const lock = rigPulseLockPath(repo)
  const releasePulse =
    lock === null
      ? () => {}
      : await awaitFileLock(lock, {
          label: 'rig pulse lock',
          onStandby: (pid) =>
            console.error(
              `bro rig watch: pulse already held${pid === null ? '' : ` by pid ${pid}`} — standing by`
            ),
        })
  try {
    for (;;) {
      const r = rigSync(repo)
      console.log(`[${new Date().toISOString()}] rig ${r.state}: ${r.detail}`)
      if (performance.now() >= deadline) {
        console.log('rig watch: --for expired')
        return
      }
      await sleep(Math.min(everySec * 1000, deadline - performance.now()))
    }
  } finally {
    releasePulse()
  }
}

function cmdInstall(
  argv: string[],
  cfg: RigConfig,
  resolved: RigRepo | { error: string }
): never {
  const { repo } = needRepo(resolved)
  const everySec = everyArg(argv, cfg)
  const win = Math.max(cfg.pulseSec, everySec)
  const rearm = `bro rig watch --repo ${shQuote(repo)} --every ${everySec} --for ${win}`
  if (argv.includes('--print')) {
    console.log(
      [
        `# ${rigPulseMarkerPath(repo)} — the want-marker; session checkpoints rearm a dead pulse from it`,
        JSON.stringify({ repo, everySec, armedAt: '<install time>' }, null, 2),
        '# the session owns the cadence — no OS timer is installed:',
        `${rearm}   # bounded window; a dead pulse rearms on the next checkpoint`,
      ].join('\n')
    )
    process.exit(0)
  }
  try {
    const arm = armRigPulse(repo, repo, everySec)
    const verb =
      arm.state === 'already' ? 'already armed' : arm.state === 'updated' ? 're-armed' : 'armed'
    console.log(
      `rig pulse ${verb} — ${rearm} ` + '(the session owns the cadence; no OS timer installed)'
    )
    process.exit(0)
  } catch (err) {
    console.error(`bro rig: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

function cmdUninstall(resolved: RigRepo | { error: string }): never {
  const { repo } = needRepo(resolved)
  const marker = disarmRigPulse(repo)
  // a running `bro rig watch` keeps its lock until it exits —
  // disarm drops the rearm intent, not the live process
  const live = rigPulseLive(repo)
  const liveNote = live.live
    ? `live rig pulse still running (pid ${live.pid}) — exits on its own`
    : ''
  console.log(
    [marker === 'disarmed' ? 'rig pulse disarmed' : 'no rig pulse marker', liveNote]
      .filter((s) => s !== '')
      .join(' — ')
  )
  process.exit(0)
}

export async function runRigCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) {
    usage(0)
  }
  const pos = positionals(argv, new Set(['--repo', '--every', '--for']), {
    boolFlags: new Set(['--json', '--print']),
  })
  const sub = pos[0] ?? 'status'
  // flags read from the full argv — `--repo` is legal before the
  // subcommand too, and must not silently drop
  const cwd = process.cwd()
  const cfg =
    (loadConfig(cwd, { rig: rigSection }) as { rig?: RigConfig }).rig ?? rigSection(undefined)
  const resolved = resolveRigRepo(cwd, cfg, flag(argv, '--repo'))

  if (sub === 'sync') {
    cmdSync(resolved)
  }
  if (sub === 'status') {
    cmdStatus(resolved, argv)
  }
  if (sub === 'next') {
    runRigNext(cwd, pos[1], argv.includes('--json') || argv.some((a) => a.startsWith('--json=')))
  }
  if (sub === 'watch') {
    await cmdWatch(argv, cfg, resolved)
  }
  if (sub === 'install') {
    cmdInstall(argv, cfg, resolved)
  }
  if (sub === 'uninstall') {
    cmdUninstall(resolved)
  }
  usage()
}

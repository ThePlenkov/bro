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
 *   bro rig install [--every N]      the cadence on a real scheduler —
 *      [--print]                        systemd user timer or managed
 *                                    crontab line, survives reboot
 *   bro rig uninstall                strip the scheduled entry
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
  dropMailbox,
  gitTry,
  loadConfig,
  LockTimeout,
  mailboxDir,
  withFileLock,
} from '@broject/core'
import { flag, positionals } from './args.ts'
import { MIN_INTERVAL_SEC, MAX_INTERVAL_SEC } from './drive-config.ts'
import { cliVersion } from './githooks.ts'
import {
  freshnessSection,
  postMergeDoneSha,
  resolveSteps,
  runPostMergeRefresh,
  worktreeGitDir,
  type FreshnessConfig,
} from './postmerge.ts'
import { rigSection, type RigConfig } from './rig-config.ts'
import {
  installSched,
  schedState,
  uninstallSched,
  type SchedSpec,
} from './sched.ts'
import { parseWorktreePorcelain } from './work.ts'

/** Two concurrent syncs on one checkout race `git merge` against
 *  `git merge` (and npm against npm through the refresh) — a lockfile
 *  turns the second caller into a clean 'skipped'. Held through the
 *  refresh so a poller can't observe the pulled-but-unbuilt gap. */
const LOCK_WAIT_MS = 60_000

export const RIG_SPEC: SchedSpec = {
  prefix: 'bro-rig',
  label: 'bro rig freshness',
  hint: 'bro rig install',
  invocation: (version: string) =>
    `bro rig sync || npx -y --prefer-offline "@broject/bro@${version}" rig sync`,
}

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

function syncOnce(repo: string, deps: RigSyncDeps): RigSyncResult {
  const base = { repo }
  // cheapest guards first — a human mid-edit outranks a stale checkout
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

  let pulled: { from: string; to: string } | undefined
  if (behind > 0) {
    if (ahead > 0) {
      return {
        ...base,
        state: 'error',
        branch,
        upstream,
        detail: `diverged from ${upstream} (${ahead} ahead, ${behind} behind) — needs a manual rebase`,
      }
    }
    const from = gitIn(repo, ['rev-parse', 'HEAD']).out.trim()
    const merge = gitIn(repo, ['merge', '--ff-only', '@{upstream}'])
    if (merge.code !== 0) {
      return {
        ...base,
        state: 'error',
        branch,
        upstream,
        detail: `merge --ff-only ${upstream}: ${merge.err || merge.out.trim()}`,
      }
    }
    pulled = { from, to: gitIn(repo, ['rev-parse', 'HEAD']).out.trim() }
    ;(deps.notify ?? ((t) => notifyDrop(repo, t)))(
      `rig: pulled ${pulled.from.slice(0, 12)}..${pulled.to.slice(0, 12)} into ${repo} — refresh queued`
    )
  }

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
  scheduler?: string
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
  out.scheduler = schedState(RIG_SPEC, repo).state
  return out
}

function printStatus(s: RigStatus): void {
  console.log(`rig:      ${s.repo} (${s.via})`)
  if (s.error !== undefined) {
    console.log(`error:    ${s.error}`)
    return
  }
  const track =
    s.upstream === undefined
      ? '(no upstream)'
      : `${s.upstream}${s.ahead !== undefined ? ` — ahead ${s.ahead}, behind ${s.behind}` : ''}`
  console.log(`branch:   ${s.branch} → ${track}`)
  console.log(
    `worktree: ${s.dirty === undefined ? 'unknown' : s.dirty === 0 ? 'clean' : `dirty (${s.dirty})`}`
  )
  console.log(
    `refresh:  ${
      s.bootstrapped === false
        ? 'n/a — not bootstrapped (needs package.json + node_modules)'
        : s.fresh === true
          ? `fresh @ ${(s.head ?? '').slice(0, 12)}`
          : `stale — done ${(s.doneSha ?? '') === '' ? '(none)' : (s.doneSha ?? '').slice(0, 12)} ≠ HEAD ${(s.head ?? '').slice(0, 12)}`
    }`
  )
  if (s.bootstrapped === true) {
    console.log(`steps:    ${s.steps !== undefined && s.steps.length > 0 ? s.steps.join(' && ') : '(none resolved)'}`)
  }
  console.log(`sched:    ${s.scheduler}`)
}

// --- dispatch -----------------------------------------------------------------

function usage(): never {
  console.error(`usage:
  bro rig sync [--repo <dir>]       fetch → merge --ff-only @{upstream} → refresh
  bro rig status [--repo <dir>] [--json]
  bro rig watch [--repo <dir>] [--every SEC] [--for SEC]
  bro rig install [--repo <dir>] [--every SEC] [--print]
  bro rig uninstall [--repo <dir>]`)
  process.exit(2)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runRigCommand(argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--repo', '--every', '--for']), {
    boolFlags: new Set(['--json', '--print']),
  })
  const sub = pos[0] ?? 'status'
  // flags read from the full argv — `--repo` is legal before the
  // subcommand too, and must not silently drop
  const cwd = process.cwd()
  const cfg = (loadConfig(cwd, { rig: rigSection }) as { rig?: RigConfig }).rig ?? {
    intervalSec: 600,
  }
  const resolved = resolveRigRepo(cwd, cfg, flag(argv, '--repo'))

  if (sub === 'sync') {
    if ('error' in resolved) {
      console.error(`bro rig: ${resolved.error}`)
      process.exit(1)
    }
    const r = rigSync(resolved.repo)
    console.log(`rig ${r.state}: ${r.detail}`)
    process.exit(r.state === 'error' || r.state === 'incomplete' ? 1 : 0)
  }

  if (sub === 'status') {
    if ('error' in resolved) {
      console.error(`bro rig: ${resolved.error}`)
      process.exit(1)
    }
    const s = rigStatus(resolved.repo, resolved.via)
    if (argv.includes('--json')) {
      console.log(JSON.stringify(s, null, 2))
    } else {
      printStatus(s)
    }
    process.exit(s.error === undefined ? 0 : 1)
  }

  if (sub === 'watch') {
    if ('error' in resolved) {
      console.error(`bro rig: ${resolved.error}`)
      process.exit(1)
    }
    const everyRaw = flag(argv, '--every')
    const forRaw = flag(argv, '--for')
    const everySec = everyRaw === undefined ? cfg.intervalSec : Number(everyRaw)
    if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
      console.error(
        `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? everySec}"`
      )
      process.exit(2)
    }
    // the bound starts before the first tick — a slow pull already
    // spends --for budget (watch's contract)
    const deadline =
      forRaw === undefined ? Number.POSITIVE_INFINITY : performance.now() + Number(forRaw) * 1000
    const repo = resolved.repo
    for (;;) {
      const r = rigSync(repo)
      console.log(`[${new Date().toISOString()}] rig ${r.state}: ${r.detail}`)
      if (performance.now() >= deadline) {
        console.log('rig watch: --for expired')
        return
      }
      await sleep(Math.min(everySec * 1000, deadline - performance.now()))
    }
  }

  if (sub === 'install') {
    if ('error' in resolved) {
      console.error(`bro rig: ${resolved.error}`)
      process.exit(1)
    }
    const everyRaw = flag(argv, '--every')
    const everySec = everyRaw === undefined ? cfg.intervalSec : Number(everyRaw)
    if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
      console.error(
        `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? everySec}"`
      )
      process.exit(2)
    }
    const r = installSched(RIG_SPEC, resolved.repo, cliVersion(), {
      everySec,
      print: argv.includes('--print'),
    })
    console.log(r.detail)
    process.exit(r.state === 'error' ? 1 : 0)
  }

  if (sub === 'uninstall') {
    if ('error' in resolved) {
      console.error(`bro rig: ${resolved.error}`)
      process.exit(1)
    }
    const r = uninstallSched(RIG_SPEC, resolved.repo)
    console.log(r.detail)
    process.exit(r.state === 'error' ? 1 : 0)
  }

  usage()
}

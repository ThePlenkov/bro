/**
 * `bro drive` — the post-PR review driver: the write-side counterpart of
 * `bro watch`'s gates plane. Spec: specs/sessions/bro-f4ot/bro-tui8.md.
 *
 *   bro drive [--once]        one supervision pass over open PRs (default)
 *   bro drive --every N       a pass every N seconds — cadence owned by
 *                             the deployment, same contract as bro watch
 *   bro drive --no-merge      supervise only — never merge
 *   bro drive --connector <name>  spawn fixers on one backend
 *   bro drive --json          one JSON line per PR verdict
 *
 * Each pass enumerates open PRs on fleet branches (every worktree's
 * branch + local work/,loop/,stack/ branches — a `bro work leave`
 * orphans the PR, not the branch), probes the act exit gate, and:
 *
 *   threads>0, occupied    → skip — a live session owns the worktree
 *   threads>0, orphaned    → spawn/respawn the PR's fixer agent on its
 *                            fixer bead (facade dedup + respawn semantics)
 *   CONFLICTING, orphaned  → the same fixer spawn with a rebase work
 *                            order — an orphaned conflicted PR stalls
 *                            forever without one (bro-glkes)
 *   ci-fail/SAST, orphaned → the same fixer spawn with a class work
 *                            order (run log / annotations) — a settled
 *                            blocker is a remediation start, not a
 *                            terminal 'blocked' (bro-atb2g)
 *   green, occupied        → report; the owner's merge step lands it
 *   green, orphaned        → bro act merge (unless --no-merge /
 *                            drive.merge:'never'), then retire the
 *                            worktree and close the fixer bead
 *   PR settled             → close a dangling fixer bead
 *
 * Occupancy is the guard bro-pywx hardens: never spawn into a worktree
 * a live session works in. Planes: the agents facade, a live foreign
 * watch marker on the PR (a `bro loop` heartbeat, `act wait`, convoy —
 * bro-0aa87's mutual exclusion: the gate already has a supervisor),
 * the worktree's own claim marker, fresh .work markers, and a /proc cwd
 * scan that follows a process's ancestry to an agent-shaped root —
 * occupied is always the safe verdict (a skipped pass, never
 * double-work).
 *
 * One drive per repo: `bro/drive.lock` in the git common dir is held
 * heartbeated for the process lifetime — a second `bro drive` (a
 * respawn wrapper's duplicate) stands by behind the incumbent and
 * takes over when it exits, never runs concurrently (spec bro-2duu9).
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  acquireAgentRegistryLock,
  acquireFileLock,
  agentRegistryPath,
  awaitFileLock,
  checkBeads,
  emitLifecycle,
  ensureAuth,
  facade,
  facadeName,
  gitCommonDir,
  gitTry,
  patchAgentRegistry,
  readAgentRegistry,
  reviewHost,
  SpawnError,
  type AgentInfo,
  type AgentRegistryEntry,
  type CheckInfo,
  type IgnoreCheckRule,
  type PrMeta,
  type ReviewFacade,
  type ReviewThread,
  type TaskRow,
  type TaskStore,
} from '@broject/core'
import {
  checkHistory,
  evaluateExitGate,
  failingCiChecks,
  fetchPrActState,
  isSast,
  listWatches,
  liveSastChecks,
  watchEnd,
  watchHeartbeat,
  watchMarkerKind,
  type ExitGate,
  type ListedWatch,
  type PrActState,
} from '@broject/act'
import {
  annotateThreads,
  judgeConfig,
  judgeFacade,
} from '@broject/judge'
import { loadAgentEnv, type AgentConnectorEnv } from '../agent-connectors.ts'
import { flag } from './args.ts'
import { defaultBranch, runActCommand } from './act.ts'
import { spawnStepAgent } from './agents.ts'
import { collectAgents } from './fleet.ts'
import {
  driveSection,
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  type DriveConfig,
} from './drive-config.ts'
import { loadBroConfig } from '../plugins.ts'
import {
  claimLockPath,
  deleteMergedLocalBranch,
  LIVE_MARKER_MS,
  mainWorktree,
  parseWorktreePorcelain,
  removeMergedWorktree,
  worktreeClaim,
  worktreePathFor,
} from './work.ts'
import { isOrchestratorSession } from './watch-pulse.ts'
export { LIVE_MARKER_MS, worktreeClaim }

function usage(): never {
  console.error(`Usage: bro drive [--once] [--every [SEC]] [--no-merge] [--connector <name>] [--json]`)
  process.exit(2)
}

// --- args ------------------------------------------------------------------------

export interface DriveArgs {
  everySec?: number
  merge: boolean
  json: boolean
  connector?: string
}

export function driveArgs(argv: string[], defaultEverySec = 300): DriveArgs {
  const base: DriveArgs = {
    json: argv.includes('--json'),
    merge: !argv.includes('--no-merge'),
    connector: flag(argv, '--connector'),
  }
  const every = argv.filter((a) => a === '--every' || a.startsWith('--every='))
  if (every.length > 1) {
    console.error('error: --every may be given only once')
    process.exit(2)
  }
  if (every.length === 0) {
    return base
  }
  const tok = every[0]!
  let everyRaw: string | undefined
  if (tok === '--every') {
    // a bare --every takes the configured cadence — flagValue's contract
    // (next token must not look like an option) still applies when a
    // value follows
    const next = argv[argv.indexOf(tok) + 1]
    everyRaw = next !== undefined && next.trim() !== '' && !next.startsWith('--') ? next : undefined
  } else {
    everyRaw = tok.slice('--every='.length)
    if (everyRaw === '') {
      console.error('error: --every requires a value')
      process.exit(2)
    }
  }
  const everySec = everyRaw === undefined ? defaultEverySec : Number(everyRaw)
  // the same 0.1s floor fleet applies — a sub-floor cadence is a busy
  // loop hammering the review host, not a poll
  if (
    !Number.isFinite(everySec) ||
    everySec < MIN_INTERVAL_SEC ||
    everySec > MAX_INTERVAL_SEC
  ) {
    throw new Error(
      `--every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? defaultEverySec}"`
    )
  }
  return { ...base, everySec }
}

// --- candidate set ----------------------------------------------------------------

/** Branch prefixes a PR can outlive its worktree on — `bro work leave`
 *  drops the tree, not the branch. */
export const FLEET_BRANCH_PREFIXES = ['work/', 'loop/', 'stack/']

/** Every branch that can hold an orphaned PR: each worktree's branch
 *  plus local fleet-prefixed branches. `complete` is false when any
 *  git listing failed — a partial set is under-counted, not drained. */
export function candidateBranches(root: string): { branches: string[]; complete: boolean } {
  const branches = new Set<string>()
  let complete = true
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain'])
  if (wt.code === 0) {
    for (const w of parseWorktreePorcelain(wt.out)) {
      if (w.branch) {
        branches.add(w.branch)
      }
    }
  } else {
    complete = false
  }
  for (const prefix of FLEET_BRANCH_PREFIXES) {
    const res = gitTry(['-C', root, 'branch', '--list', `${prefix}*`, '--format=%(refname:short)'])
    if (res.code === 0) {
      for (const b of res.out.split('\n').filter((s) => s !== '')) {
        branches.add(b)
      }
    } else {
      complete = false
    }
  }
  return { branches: [...branches], complete }
}

/** work/bro-x → bro-x; stack/name/3-bro-x → 3-bro-x. */
export function branchSlug(branch: string): string {
  return branch.split('/').pop() ?? branch
}

// --- occupancy --------------------------------------------------------------------

// The marker/registry occupancy plane (detailMatches, liveWorkDetails,
// hooksDirOf, registryEntryState) lives in proc-owner.ts — work.ts's
// litter sweep needs the same verdicts and can't reach drive.ts
// (drive imports work). Re-exported here so existing importers keep
// working.
import {
  agentProcessesIn,
  detailMatches,
  hooksDirOf,
  liveWorkDetails,
  registryEntryState,
  type ProcHit,
} from './proc-owner.ts'
export {
  agentProcessesIn,
  detailMatches,
  liveWorkDetails,
  registryEntryState,
}
export type { ProcHit }

export interface OccupancyCtx {
  /** All backends' agents for the pass. */
  agents: AgentInfo[]
  /** The PR's fixer bead, when one exists — its live agent is our own
   *  fixer, reported as such rather than as a foreign occupant. */
  fixerBead?: string
  branch: string
  worktree?: string
  /** Fresh .work marker details. */
  workDetails: string[]
  /** Injectable /proc scan — tests pass a stub. */
  scanProc?: (worktree: string) => ProcHit[]
  /** Injectable worktree-claim probe — tests pass a stub. */
  scanClaim?: (worktree: string) => string | undefined
  /** The PR being judged — the supervision plane keys on it. */
  pr?: number
  /** Watch-marker snapshot — a live foreign marker is a supervisor
   *  already owning this PR's gate (bro-0aa87). */
  watches?: ListedWatch[]
}

/** A live watch marker from a non-drive watcher (a `loop` heartbeat, an
 *  `act wait`, a convoy supervisor) means the PR's gate already has an
 *  owner — drive exists for UNSUPERVISED PRs, so these are occupants.
 *  Drive-kind markers self-exclude: a second `bro drive` shares the
 *  fixer bead / merge slot machinery instead of starving this pass by
 *  mutual exclusion. */
export function supervisedBy(
  watches: ListedWatch[] | undefined,
  pr: number | undefined
): ListedWatch | undefined {
  if (watches === undefined || pr === undefined) {
    return undefined
  }
  return watches.find(
    (l) => l.alive && l.watch.pr === pr && watchMarkerKind(l.file, l.watch) !== 'drive'
  )
}

/** Worktree-local occupancy proofs — a live agent process inside the
 *  worktree, or a fresh claim marker on it. */
function worktreeOccupant(opts: OccupancyCtx, live: AgentInfo[]): string | undefined {
  if (opts.worktree === undefined) {
    return undefined
  }
  const wt = resolve(opts.worktree)
  const agent = live.find(
    (a) => typeof a.worktree === 'string' && resolve(a.worktree) === wt
  )
  if (agent) {
    return `agent ${agent.id} live in ${basename(opts.worktree)}`
  }
  const claim = (opts.scanClaim ?? worktreeClaim)(opts.worktree)
  return claim === undefined
    ? undefined
    : `worktree ${basename(opts.worktree)} claimed${claim === '' ? '' : ` by ${claim}`}`
}

/** Why a PR's worktree is owned right now — undefined = orphaned, the
 *  driver's whole reason to exist. A live agent or session ALWAYS wins
 *  the argument: skipped pass, never double-work on one branch. */
export function occupied(opts: OccupancyCtx): string | undefined {
  const live = opts.agents.filter((a) => a.state === 'running' || a.state === 'spawned')
  // fixer agents spawn with molStep = the fixer bead's id, so this match
  // names our own worker — reported as the fixer, not a foreign occupant
  if (opts.fixerBead !== undefined && live.some((a) => a.molStep === opts.fixerBead)) {
    return `fixer agent live on ${opts.fixerBead}`
  }
  const sup = supervisedBy(opts.watches, opts.pr)
  if (sup !== undefined) {
    return `supervised by ${watchMarkerKind(sup.file, sup.watch)} pid ${sup.watch.pid}`
  }
  const wt = worktreeOccupant(opts, live)
  if (wt !== undefined) {
    return wt
  }
  const slug = branchSlug(opts.branch)
  const detail = opts.workDetails.find((d) =>
    detailMatches(d, { branch: opts.branch, slug, worktree: opts.worktree })
  )
  if (detail !== undefined) {
    return `session armed work on ${detail}`
  }
  if (opts.worktree !== undefined && opts.scanProc !== undefined) {
    const hit = opts.scanProc(opts.worktree)[0]
    if (hit) {
      return `process ${hit.pid} live in ${basename(opts.worktree)}`
    }
  }
  return undefined
}

// --- fixer bead ---------------------------------------------------------------------

/** One persistent bead per PR — the fixer's molStep, so facade dedup
 *  and respawn (same agentId on rebind) come free. */
export const FIXER_LABEL = 'fixer'
export const fixerRef = (pr: number): string => `drive:pr:${pr}`

/** The open fixer bead for a PR — external_ref upsert across passes. */
export function fixerBeadFor(store: TaskStore, pr: number): TaskRow | undefined {
  const ref = fixerRef(pr)
  return store
    .list({ labels: [FIXER_LABEL], all: true })
    .find((r) => r.external_ref === ref && r.status !== 'closed')
}

function ensureFixerBead(store: TaskStore, pr: number, link: string, branch: string): TaskRow {
  return (
    fixerBeadFor(store, pr) ??
    store.create({
      title: `review fixer — PR #${pr}`,
      description:
        `Spawned by \`bro drive\` — work the gate state on ${link} ` +
        `(branch \`${branch}\`): review threads, a conflict rebase, ` +
        `failing checks, or SAST findings — whichever the spawn prompt ` +
        `orders. Push, never merge.`,
      type: 'task',
      labels: [FIXER_LABEL],
      externalRef: fixerRef(pr),
    })
  )
}

function closeFixer(store: TaskStore, id: string, reason: string): void {
  try {
    if (store.get(id)?.status !== 'closed') {
      store.close(id, reason)
      emitLifecycle(process.cwd(), {
        kind: 'close',
        bead: id,
        to: 'closed',
        detail: { via: 'drive', reason },
      })
    }
  } catch (err) {
    console.error(`drive: could not close fixer bead ${id} — ${errText(err)}`)
  }
}

// --- fixer worktree + prompt ---------------------------------------------------------

/** <local> vs origin/<branch> is linear — one contains the other, so a
 *  checkout of it can always reach the remote tip (ahead/equal already
 *  does, behind fast-forwards). Divergence is refused to every fixer
 *  path: a rebase replaying a tip that misses remote commits drops them
 *  when the lease push lands (the lease itself passes — the tracking
 *  ref was just refreshed by the fetch). Missing refs — no remote, an
 *  unborn branch — pass: nothing to check against. */
function remoteLinear(root: string, local: string, branch: string): boolean {
  const remote = `origin/${branch}`
  if (
    gitTry(['-C', root, 'rev-parse', '--verify', remote]).code !== 0 ||
    gitTry(['-C', root, 'rev-parse', '--verify', local]).code !== 0
  ) {
    return true
  }
  return (
    gitTry(['-C', root, 'merge-base', '--is-ancestor', remote, local]).code === 0 ||
    gitTry(['-C', root, 'merge-base', '--is-ancestor', local, remote]).code === 0
  )
}

/** A standing checkout's refresh to origin/<branch>'s tip — the same ff
 *  the create path runs. Divergence is excluded by remoteLinear before
 *  the loop, so a ff refusal is a dirty or mid-merge tree — reported,
 *  never clobbered. No remote ref passes: nothing to be stale against. */
function ffToRemoteTip(dir: string, branch: string): boolean {
  const remote = `origin/${branch}`
  if (gitTry(['-C', dir, 'rev-parse', '--verify', remote]).code !== 0) {
    return true
  }
  return gitTry(['-C', dir, 'merge', '--ff-only', remote, '--quiet']).code === 0
}

/** A standing checkout of <branch> at <dir> — handed over once it can
 *  reach the remote tip: a standing checkout can still lag commits
 *  pushed since it was made, so it fast-forwards like the create path.
 *  undefined when the dir stands on another branch (foreign — never
 *  clobbered). */
function reuseFixerWorktree(dir: string, branch: string): { path?: string; err?: string } | undefined {
  const on = gitTry(['-C', dir, 'branch', '--show-current']).out.trim()
  if (on !== branch) {
    return undefined
  }
  if (!ffToRemoteTip(dir, branch)) {
    return { err: `${dir} can't fast-forward to origin/${branch}` }
  }
  return { path: dir }
}

/** The fresh `<repo>--<slug>` checkout: the existing local branch, else
 *  a new one at origin/<branch>'s tip — the orphan-PR shape. */
function addFixerWorktree(
  mainRoot: string,
  dir: string,
  branch: string
): { path?: string; created?: boolean; err?: string } {
  const add = gitTry(['-C', mainRoot, 'worktree', 'add', dir, branch])
  if (add.code === 0) {
    // the fetch refreshed origin/<branch>, not the local ref the
    // worktree just checked out — ff or the fixer works a stale tip;
    // a refusal means the branch moved mid-call — retire the dir we
    // just made rather than hand over a tip that can't cover it
    if (!ffToRemoteTip(dir, branch)) {
      gitTry(['-C', mainRoot, 'worktree', 'remove', dir])
      return { err: `${branch} moved while its worktree was being added` }
    }
    emitLifecycle(mainRoot, {
      kind: 'worktree',
      to: 'created',
      detail: { via: 'drive', worktree: dir, branch },
    })
    return { path: dir, created: true }
  }
  const retry = gitTry(['-C', mainRoot, 'worktree', 'add', '-b', branch, dir, `origin/${branch}`])
  if (retry.code === 0) {
    emitLifecycle(mainRoot, {
      kind: 'worktree',
      to: 'created',
      detail: { via: 'drive', worktree: dir, branch },
    })
    return { path: dir, created: true }
  }
  return { err: retry.err || add.err }
}

/** The PR's fixer checkout: the branch's existing worktree, else a fresh
 *  `<repo>--<slug>` on it — `created` marks a dir this call added so the
 *  caller can retire it when the work evaporates. A dir standing on
 *  another branch is never clobbered: distinct branches sharing the
 *  final slug (work/x vs loop/x) fall back to the branch-namespaced
 *  `<repo>--work-x` path instead of refusing as foreign. Either path is
 *  handed over only once it can reach origin/<branch>'s tip — a fixer
 *  rebasing a stale tip omits the commits pushed since, and the lease
 *  push drops them on the PR. */
export function ensureFixerWorktree(
  mainRoot: string,
  branch: string
): { path?: string; created?: boolean; err?: string } {
  // fetch first — an orphaned PR's remote head may be newer than ours;
  // a branch diverged from it is refused outright: no checkout of it
  // can keep both histories
  gitTry(['-C', mainRoot, 'fetch', 'origin', branch, '--quiet'])
  if (!remoteLinear(mainRoot, branch, branch)) {
    return { err: `${branch} diverged from origin/${branch}` }
  }
  for (const name of new Set([branchSlug(branch), branch.replaceAll('/', '-')])) {
    const dir = worktreePathFor(mainRoot, name)
    if (existsSync(dir)) {
      const r = reuseFixerWorktree(dir, branch)
      if (r !== undefined) {
        return r
      }
      continue
    }
    return addFixerWorktree(mainRoot, dir, branch)
  }
  return {
    err: `every worktree path for ${branch} is held by a foreign branch`,
  }
}

/** The fixer's work order — unresolved threads at spawn time (the prompt
 *  tells it to re-fetch; more may land while it works). `judge` carries
 *  the shadow verdict line for a thread — annotation the fixer may
 *  read, never an instruction it must obey. */
export function buildFixerPrompt(opts: {
  pr: number
  link: string
  branch: string
  worktree: string
  threads: {
    path?: string | null
    line?: number | null
    author?: string
    body?: string
    judge?: string
  }[]
}): string {
  const list = opts.threads
    .map(
      (t) =>
        `- ${t.path ?? ''}:${t.line ?? ''} [${t.author ?? '?'}] ${(t.body ?? '').trim()}` +
        (t.judge !== undefined ? `\n    ${t.judge}` : '')
    )
    .join('\n')
  return [
    `# Review fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    `This PR has ${opts.threads.length} unresolved review thread(s). The live list`,
    `is \`bro act threads ${opts.pr}\` — more may have arrived since this prompt.`,
    '',
    list,
    '',
    'Rules:',
    '- Read skills/act/SKILL.md first — it owns this loop\'s policy.',
    '- Fix valid findings on this branch; commit and push — the push is the verdict.',
    '- Resolve fixed threads silently; reply + resolve with the reason on reject/defer.',
    '- Defer non-blocking nits (P2/P3) to debt beads — never chase a perfect PR.',
    '- NEVER merge — `bro drive` owns the merge on green.',
    '- Exit when threads are zero or all deferred.',
    '',
  ].join('\n')
}

/** Shadow-mode judge verdicts for the fixer prompt's thread list —
 *  annotation only, journaled beside `bro act threads`' own verdicts
 *  (same journal, same dedup key). The budget is shared across the
 *  whole pass: `maxDecisionsPerRun` bounds a run, not each fixer PR.
 *  Every failure degrades to "no annotation" — a dead judge must
 *  never stall a fixer spawn. */
async function driveShadowNotes(
  dir: string,
  pr: number,
  headSha: string,
  open: ReviewThread[],
  budget: { remaining: number }
): Promise<Map<string, string> | undefined> {
  const cfg = judgeConfig(dir).judge
  if (cfg.mode !== 'shadow') {
    return undefined
  }
  try {
    const res = await annotateThreads(open, {
      dir,
      pr,
      headSha,
      judge: judgeFacade(dir),
      // a spent budget still renders journaled verdicts — re-reads
      // are free; only fresh decide() calls are bounded
      budget: Math.max(0, budget.remaining),
    })
    budget.remaining -= res.decided
    return res.annotations
  } catch {
    return undefined
  }
}

// --- the pass -------------------------------------------------------------------------

interface Ctx {
  mainRoot: string
  rev: ReviewFacade
  /** The reviews connector's name — fixer work orders name host-CLI
   *  commands, so the prompt must match the backend actually serving
   *  this repo (gh on github, glab api on gitlab). */
  host: string
  repo: string
  act: {
    ignoreChecks: IgnoreCheckRule[]
    maxRounds: number
    docsPaths: string[]
    docsMaxRounds: number
  }
  merge: boolean
  json: boolean
  connector?: string
  /** --every interval in seconds — defined only in loop mode, which is
   *  also what turns on watch heartbeats; a --once pass is a report,
   *  not supervision. */
  everySec?: number
  env: AgentConnectorEnv
  store: TaskStore
}

interface PassWork {
  worktreeByBranch: Map<string, string>
  agents: AgentInfo[]
  workDetails: string[]
  /** Watch-marker snapshot for the supervision plane — a `loop`
   *  heartbeat or `act wait` landing mid-pass is re-read under the
   *  occupancy locks (freshOccupancy), never trusted stale. */
  watches: ListedWatch[]
  /** Fresh decide() calls the pass may still pay for — the shadow
   *  judge's `maxDecisionsPerRun` bound is per run, not per PR. */
  judgeBudget: { remaining: number }
}

export interface PrVerdict {
  pr: number
  link: string
  verdict: string
  detail?: string
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const say = (ctx: Ctx, msg: string): void => {
  if (ctx.json) {
    console.error(msg)
  } else {
    console.log(msg)
  }
}

/** `bro act merge` reports via process.exitCode — normalize it into a
 *  verdict without leaking the code into the driver's own exit. */
async function mergeGreen(ctx: Ctx, pr: number): Promise<boolean> {
  const saved = process.exitCode
  process.exitCode = 0
  try {
    await runActCommand(['merge', String(pr)])
    return process.exitCode === 0
  } catch (err) {
    console.error(`drive: merge threw — ${errText(err)}`)
    return false
  } finally {
    process.exitCode = saved
  }
}

/** Post-merge local retirement — same guards as `act merge --cleanup`:
 *  the worktree only goes when verifiably clean, the branch only when
 *  its tip is the merged head. Never throws into the pass. */
function retireLanding(ctx: Ctx, state: PrActState, worktree: string | undefined): void {
  try {
    const all = parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out)
    const main = all[0]
    if (worktree !== undefined && main) {
      const here = all.find((w) => w.path === worktree)
      if (here && here.path !== main.path) {
        removeMergedWorktree(worktree, here, main)
      } else if (here && here.branch === state.headRef) {
        // the merged branch is checked out in the MAIN worktree — the
        // delete below can never land while it is, so switch the main
        // checkout to the default branch first (same move as
        // cleanupAfterMerge; a dirty main keeps the branch, never data)
        const def = defaultBranch()
        const res = gitTry(['-C', main.path, 'switch', def])
        if (res.code !== 0) {
          say(ctx, `drive: could not switch ${main.path} to ${def} (${res.err})`)
        }
      }
    }
    deleteMergedLocalBranch(state.headRef, state.headSha)
  } catch (err) {
    say(ctx, `drive: post-merge cleanup failed — ${errText(err)}`)
  }
}

/** The agents plane for the in-lock occupancy refresh — a registry
 *  re-read, never conn.list(): a backend liveness probe (a slow
 *  `gc session list` runs ~30s) inside the hold would outlast the 20s
 *  lock wait and time out `bro work enter` stamps and competing spawns
 *  (bro-taq6). The registry is written under the lock we hold, so the
 *  read catches every spawn that landed during the wait. */
export function registryAgents(dir: string): AgentInfo[] {
  const reg = agentRegistryPath(dir)
  const home = reg === null ? null : join(dirname(reg), 'agents')
  return Object.entries(readAgentRegistry(dir)).map(([molStep, e]) => ({
    id: e.agentId,
    spawnedAt: typeof e.spawnedAt === 'string' ? e.spawnedAt : undefined,
    molStep,
    backend: e.backend,
    pid: typeof e.pid === 'number' ? e.pid : undefined,
    state: registryEntryState(home, e),
    worktree: typeof e.worktree === 'string' ? e.worktree : undefined,
  }))
}

/** Fresh occupancy inputs — the pass-level snapshot predates the
 *  thread refetch by seconds, long enough for a claim to land unseen.
 *  Call under the occupancy locks: a pre-lock snapshot can still miss a
 *  claim that lands while the registry lock is being waited on. Cheap
 *  planes only — registry, .work markers — so the hold stays far under
 *  the 20s lock wait (bro-taq6). 'spawned' is registryEntryState's
 *  "nothing cheap could prove" — a pid-less remote-backend entry
 *  inherits the pass's real probe when it's the same agent GENERATION
 *  (a lost fixer stays respawn-able); an entry the pass never saw, a
 *  re-minted agentId, or a respawned same-id entry (a fresh spawnedAt)
 *  keeps the conservative live verdict — the pass's probe measured a
 *  dead generation, not this run (cubic). A thrown registry read
 *  (readAgentRegistry rethrows EACCES/EIO) is degradation, not
 *  emptiness — it falls back to the pass snapshot the way
 *  collectAgents did rather than propagate an 'error' verdict out
 *  of the lock-held section. */
export function freshOccupancy(
  dir: string,
  known: AgentInfo[]
): Pick<PassWork, 'agents' | 'workDetails' | 'watches'> {
  const byStep = new Map(known.map((a) => [a.molStep, a]))
  let fresh: AgentInfo[]
  try {
    fresh = registryAgents(dir)
  } catch {
    fresh = known
  }
  const agents = fresh.map((a) => {
    const seen = byStep.get(a.molStep)
    return a.state === 'spawned' &&
      seen !== undefined &&
      seen.id === a.id &&
      seen.spawnedAt !== undefined &&
      seen.spawnedAt === a.spawnedAt
      ? { ...a, state: seen.state }
      : a
  })
  const hooks = hooksDirOf(dir)
  return {
    agents,
    workDetails: hooks === null ? [] : liveWorkDetails(hooks),
    // listWatches is a cheap local read — a supervisor that stamped its
    // heartbeat while the lock was being waited on is caught here
    watches: listWatches(dir),
  }
}

/** Lock order is registry → claim, everywhere, and the registry lock
 *  is THE shared occupancy lock every claimant plane serializes on
 *  (bro-qry9): a spawning claimant writes its registry entry + agent
 *  .work marker under it, `bro work enter` stamps its claim under it
 *  (then the worktree's own claim lock), and a session's .work arm
 *  writes under it too. Occupancy-check→remove / check→spawn sections
 *  hold BOTH so a claim lands before the probe or after the action —
 *  never between. The spawn path re-acquires the registry lock
 *  re-entrantly, which is why registry must come first. */
function acquireOccupancyLocks(dir: string, wt: string | undefined): () => void {
  const releaseReg = acquireAgentRegistryLock(dir)
  let releaseClaim: () => void = () => {}
  try {
    const claimLock = wt === undefined ? null : claimLockPath(wt)
    if (claimLock !== null) {
      releaseClaim = acquireFileLock(claimLock, { label: `${basename(wt!)} claim lock` })
    }
  } catch (err) {
    // a thrown claim acquire must not strand the registry lock — a busy
    // worktree would otherwise wedge every agent operation this process
    releaseReg()
    throw err
  }
  return () => {
    releaseClaim()
    releaseReg()
  }
}

/** Remove a just-created fixer worktree iff still orphaned — the
 *  occupancy refresh, probe, and `git worktree remove` all run under
 *  both occupancy locks (see acquireOccupancyLocks). Refreshing inside
 *  the hold matters: the lock wait itself is a window where a claimant
 *  can land a registry entry a pre-lock snapshot would miss. Returns
 *  the occupancy detail when the tree is owned or a lock can't be
 *  taken, undefined when retired. */
async function retireIfOrphaned(
  ctx: Ctx,
  pr: number,
  wt: string,
  branch: string,
  fixer: TaskRow | undefined,
  known: AgentInfo[]
): Promise<string | undefined> {
  let release: () => void
  try {
    release = acquireOccupancyLocks(ctx.mainRoot, wt)
  } catch (err) {
    // a lock we can't take is indistinguishable from an active claimer —
    // occupied is always the safe verdict
    return `occupancy re-check failed — ${errText(err)}`
  }
  try {
    const fresh = freshOccupancy(ctx.mainRoot, known)
    const occ = occupied({
      agents: fresh.agents,
      fixerBead: fixer?.id,
      branch,
      worktree: wt,
      workDetails: fresh.workDetails,
      scanProc: agentProcessesIn,
      pr,
      watches: fresh.watches,
    })
    if (occ !== undefined) {
      return occ
    }
    // the work evaporated after we checked out — retire the dir we
    // just added or it lingers as an orphaned fixer worktree
    const rm = gitTry(['-C', ctx.mainRoot, 'worktree', 'remove', wt])
    if (rm.code === 0) {
      emitLifecycle(ctx.mainRoot, {
        kind: 'worktree',
        to: 'removed',
        detail: { via: 'drive', worktree: wt, branch, reason: 'orphaned' },
      })
    }
    return undefined
  } finally {
    release()
  }
}

async function spawnFixer(
  ctx: Ctx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  known: AgentInfo[],
  judgeBudget: { remaining: number }
): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let wt = worktree
  let created = false
  if (wt === undefined) {
    const ensured = ensureFixerWorktree(ctx.mainRoot, state.headRef)
    if (ensured.path === undefined) {
      return { pr, link, verdict: 'no-worktree', detail: ensured.err }
    }
    wt = ensured.path
    created = ensured.created === true
  }
  // threads may have settled between the gate fetch and now — spawning a
  // fixer on an empty list burns an agent for nothing
  const open = (await ctx.rev.reviewThreads({ repo: ctx.repo, pr })).filter(
    (t) => !t.resolved
  )
  if (open.length === 0) {
    if (created) {
      // re-check occupancy before retiring a dir we just added — another
      // owner could claim it during the thread refetch, and `git
      // worktree remove` on a clean tree deletes even a live cwd. The
      // refresh + check + remove all run inside retireIfOrphaned under
      // both occupancy locks: a claimant writes its registry entry +
      // .work marker under the same locks, so a claim lands before the
      // check or after the remove — never between
      const retire = await retireIfOrphaned(ctx, pr, wt, state.headRef, fixer, known)
      if (retire !== undefined) {
        return { pr, link, verdict: 'occupied', detail: retire }
      }
    }
    return { pr, link, verdict: 'threads-resolved' }
  }
  // shadow-mode judge verdicts annotate the prompt's thread list —
  // journaled and rendered, never applied (the fixer still resolves,
  // replies, and defers by its own reading). Runs BEFORE the occupancy
  // locks: a budget of sequential decide() calls under the locks would
  // hold them past other claimants' lock timeouts. Occupancy is still
  // re-read under the locks immediately before the spawn, so a claim
  // landing during annotation is caught the same way.
  const notes = await driveShadowNotes(ctx.mainRoot, pr, state.headSha, open, judgeBudget)
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    known,
    prompt: buildFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      worktree: wt,
      threads: open.map((t) => ({
        path: t.comment?.path,
        line: t.comment?.line,
        author: t.comment?.author,
        body: t.comment?.body,
        judge: notes?.get(t.id),
      })),
    }),
  })
}

/** The rebase fixer's work order — the drive twin of the loop's
 *  conflict round (`buildRebasePrompt` in @broject/loop): the gate
 *  reports CONFLICTING, the fixer rebases the PR's branch onto its
 *  declared base and force-pushes. The rebase IS the fix: no thread
 *  work is owed on this spawn. */
export function buildRebaseFixerPrompt(opts: {
  pr: number
  link: string
  branch: string
  base: string
  worktree: string
}): string {
  return [
    `# Rebase fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    `This PR has merge conflicts with its base branch \`${opts.base}\`. The rebase`,
    'IS the work — no review-thread fixing is owed on this spawn.',
    '',
    `- \`git fetch origin ${opts.branch} ${opts.base}\` — the PR branch too:`,
    '  commits pushed since this checkout was made are invisible to a stale',
    `  tip. Fold them in first (\`git rebase origin/${opts.branch}\`) or the`,
    '  base rebase drops them on the lease push.',
    `- \`git rebase origin/${opts.base}\` —`,
    '  if a rebase is already in progress here, resolve it instead',
    '  (`git rebase --continue` / `--abort` and restart if the state is too',
    '  tangled).',
    "- Keep this PR's own changes — conflicts are with base-branch work that",
    "  landed since, not with the task. When in doubt, preserve the PR's",
    "  intent over the incoming edit's shape.",
    "- Re-verify after the rebase (build/test as the repo's contract asks),",
    '  then `git push --force-with-lease` — the push is the verdict.',
    '',
    'Rules:',
    '- NEVER merge — `bro drive` owns the merge on green.',
    "- If the conflicts genuinely can't be resolved without redesign, say so",
    '  as your final message — do not leave the rebase half-done.',
    '',
  ].join('\n')
}

/** Everything the locked spawn ceremony needs — an options bag so the
 *  helper stays under the parameter cap. */
interface FixerSpawn {
  branch: string
  wt: string
  fixer: TaskRow | undefined
  known: AgentInfo[]
  prompt: string
  /** prefixes the spawned detail so a rebase round reads differently
   *  in the pass log. */
  tag?: string
  /** Same-head dedup (bro-atb2g) — the head this work order targets and
   *  its blocker class. Recorded on the fixer bead's registry entry at
   *  spawn; a clean-exit attempt on the same (head, class) never gets
   *  an identical replay. Thread fixers stay undeduped: new threads
   *  land on an unmoved head, so replay there is real work. */
  attempt?: { head: string; cls: string }
}

/** The attempt record on the fixer bead's registry entry — one head
 *  plus the blocker classes already tried on it. A head move resets
 *  the record (a pushed head earns a fresh round); a `down`/reap of
 *  the entry clears it (operator semantics). */
interface FixerAttempt {
  head: string
  classes: string[]
}

function fixerAttemptOf(entry: AgentRegistryEntry | undefined): FixerAttempt | undefined {
  const v = entry?.fixerAttempt
  if (typeof v !== 'object' || v === null) {
    return undefined
  }
  const a = v as Partial<FixerAttempt>
  return typeof a.head === 'string' && Array.isArray(a.classes)
    ? { head: a.head, classes: a.classes.filter((c): c is string => typeof c === 'string') }
    : undefined
}

/** The dedup verdict: this (head, class) already ran a fixer that
 *  exited clean — the same prompt on the same head is deterministic
 *  replay. `cause` is read off the entry (the connector harvests it
 *  into the registry at .exit time): only 'ok' is a deliberated
 *  verdict — crash/lost/unclassified exits keep respawn semantics,
 *  and rate_limited/quota are refused downstream by the spawn guard.
 *  `stopped` lifts the dedup like it lifts a budget wall — `bro agents
 *  down` is the operator's manual clear. */
export function fixerAttemptSpent(
  entry: AgentRegistryEntry | undefined,
  head: string,
  cls: string
): boolean {
  if (entry?.cause !== 'ok' || entry.stopped === true) {
    return false
  }
  const a = fixerAttemptOf(entry)
  return a?.head === head && a.classes.includes(cls)
}

/** Stamp the attempt on the fixer bead's entry — runs inside the
 *  spawn's locked section right after the spawn write (the lock is
 *  re-entrant; the patch merges so connector fields survive). */
function recordFixerAttempt(dir: string, molStep: string, head: string, cls: string): void {
  const prev = fixerAttemptOf(readAgentRegistry(dir)[molStep])
  const classes = prev?.head === head ? prev.classes : []
  patchAgentRegistry(dir, molStep, {
    fixerAttempt: { head, classes: classes.includes(cls) ? classes : [...classes, cls] },
  })
}

/** Cheap pre-check for the locked dedup inside spawnFixerAgent — a
 *  spent verdict decided up front never pays the worktree checkout.
 *  The authoritative re-check still runs under the spawn locks: only
 *  this drive writes the record (one drive per repo, drive.lock), so
 *  no third party can flip spent → unspent between here and there. */
function fixerSpent(
  ctx: Ctx,
  pr: number,
  headSha: string,
  fixer: TaskRow | undefined,
  cls: string
): PrVerdict | undefined {
  if (fixer === undefined) {
    return undefined
  }
  const entry = readAgentRegistry(ctx.mainRoot)[fixer.id]
  return fixerAttemptSpent(entry, headSha, cls)
    ? {
        pr,
        link: ctx.rev.prLink(ctx.repo, pr),
        verdict: 'fixer-spent',
        detail:
          `${cls} fixer already exited clean on this head — ` +
          'a pushed head earns a fresh round',
      }
    : undefined
}

/** The locked spawn ceremony both fixer kinds share — a last occupancy
 *  read right before the spawn (the gap since the pass-level check
 *  covered the worktree create + state refetch, long enough for another
 *  owner to arm this branch), the fixer bead, then the facade spawn.
 *  Both occupancy locks are held across refresh→probe→spawn (see
 *  acquireOccupancyLocks) so a `bro work enter` or a competing spawn
 *  can't land a claim between — the refresh itself must come after the
 *  acquire, or the lock wait is one more stale-input window. */
async function spawnFixerAgent(
  ctx: Ctx,
  pr: number,
  s: FixerSpawn
): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let release: () => void
  try {
    release = acquireOccupancyLocks(ctx.mainRoot, s.wt)
  } catch (err) {
    return {
      pr,
      link,
      verdict: 'occupied',
      detail: `occupancy re-check failed — ${errText(err)}`,
    }
  }
  try {
    const fresh = freshOccupancy(ctx.mainRoot, s.known)
    const occ = occupied({
      agents: fresh.agents,
      fixerBead: s.fixer?.id,
      branch: s.branch,
      worktree: s.wt,
      workDetails: fresh.workDetails,
      scanProc: agentProcessesIn,
      pr,
      watches: fresh.watches,
    })
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    // same-head dedup: a clean-exit fixer already ran this class's work
    // order on this head — replaying it is deterministic burn. Read
    // inside the lock so a respawn that landed during the wait can't
    // be mislabeled (the spawn write below clears `cause`, so this
    // read must precede it). The caller may have pre-checked with
    // fixerSpent — same verdict either way.
    if (s.attempt !== undefined && s.fixer !== undefined) {
      const entry = readAgentRegistry(ctx.mainRoot)[s.fixer.id]
      if (fixerAttemptSpent(entry, s.attempt.head, s.attempt.cls)) {
        return {
          pr,
          link,
          verdict: 'fixer-spent',
          detail:
            `${s.attempt.cls} fixer already exited clean on this head — ` +
            'a pushed head earns a fresh round',
        }
      }
    }
    const bead = s.fixer ?? ensureFixerBead(ctx.store, pr, link, s.branch)
    try {
      const info = await spawnStepAgent(ctx.mainRoot, ctx.env, {
        molStep: bead.id,
        worktree: s.wt,
        prompt: s.prompt,
        connector: ctx.connector,
        env: { BRO_PR: String(pr), BRO_PR_URL: link },
      })
      if (s.attempt !== undefined) {
        recordFixerAttempt(ctx.mainRoot, bead.id, s.attempt.head, s.attempt.cls)
      }
      const pid = info.pid === undefined ? '' : ` pid ${info.pid}`
      const tag = s.tag ?? ''
      return { pr, link, verdict: 'spawned', detail: `${tag}${bead.id} → ${info.id}${pid}` }
    } catch (err) {
      return {
        pr,
        link,
        verdict: err instanceof SpawnError ? 'spawn-refused' : 'spawn-failed',
        detail: errText(err),
      }
    }
  } finally {
    release()
  }
}

/** The conflict fixer — mergeable=CONFLICTING on an orphaned PR gets
 *  the same fixer spawn with a rebase work order (bro-glkes). The
 *  prMeta probe doubles as the still-conflicted re-check: a conflict
 *  that evaporated between the gate fetch and now must not burn a
 *  spawn, and a settled PR never gets a worker. UNKNOWN still counts
 *  as conflicted — the host is recomputing the same state, not
 *  cleared. Runs BEFORE the worktree checkout: a settled conflict
 *  never pays create+retire. */
async function spawnRebaseFixer(
  ctx: Ctx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  known: AgentInfo[]
): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let meta: PrMeta
  try {
    meta = await metaOf(ctx, pr)
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) }
  }
  if (meta.state !== 'OPEN') {
    return { pr, link, verdict: 'settled', detail: meta.state.toLowerCase() }
  }
  if (meta.mergeable === 'MERGEABLE') {
    return { pr, link, verdict: 'conflict-resolved' }
  }
  const spent = fixerSpent(ctx, pr, meta.headSha, fixer, 'rebase')
  if (spent !== undefined) {
    return spent
  }
  let wt = worktree
  if (wt === undefined) {
    const ensured = ensureFixerWorktree(ctx.mainRoot, state.headRef)
    if (ensured.path === undefined) {
      return { pr, link, verdict: 'no-worktree', detail: ensured.err }
    }
    wt = ensured.path
  }
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    known,
    prompt: buildRebaseFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      base: meta.baseRef,
      worktree: wt,
    }),
    tag: 'rebase ',
    attempt: { head: meta.headSha, cls: 'rebase' },
  })
}

/** Fresh prMeta for the spawn-path re-probes — the gate's state snapshot
 *  is stale by the time a fixer spawns, so a settle or a moved head
 *  between the two reads is caught here, never assumed away. */
function metaOf(ctx: Ctx, pr: number): Promise<PrMeta> {
  const t = { repo: ctx.repo, pr }
  return ctx.rev.prMetaAsync === undefined
    ? Promise.resolve().then(() => ctx.rev.prMeta(t))
    : ctx.rev.prMetaAsync(t)
}

// --- ci-fail / sast fixers (bro-atb2g) -----------------------------------------

/** Facade reads that may be sync-only — the same orSync discipline
 *  fetchPrActState uses: defer the sync call through .then so a throw
 *  becomes a rejection the caller's .catch sees. */
function checksOf(ctx: Ctx, pr: number): Promise<CheckInfo[]> {
  const t = { repo: ctx.repo, pr }
  return ctx.rev.checksAsync === undefined
    ? Promise.resolve().then(() => ctx.rev.checks(t))
    : ctx.rev.checksAsync(t)
}

function annotationsOf(
  ctx: Ctx,
  headSha: string,
  names: ReadonlySet<string>
): Promise<Map<string, number | null>> {
  return ctx.rev.checkAnnotationsAsync === undefined
    ? Promise.resolve().then(() => ctx.rev.checkAnnotations(ctx.repo, headSha, names))
    : ctx.rev.checkAnnotationsAsync(ctx.repo, headSha, names)
}

/** The gate's effective check set — advisory-ignored names dropped the
 *  same way advisoryFilter removes them, so a work order never names a
 *  check the gate didn't count. */
function gatedChecks(ctx: Ctx, checks: CheckInfo[]): CheckInfo[] {
  const rules = ctx.act.ignoreChecks
  if (rules.length === 0) {
    return checks
  }
  return checks.filter(
    (c) => !rules.some((r) => c.name.toLowerCase().includes(r.name.toLowerCase()))
  )
}

/** The ci-fail fixer's work order — the failing check list at spawn
 *  (the prompt tells it to re-read the live list). A SAST-named run is
 *  flagged: its blocking findings are annotations, not log lines. The
 *  inspect commands name the review host's own CLI — `host` is the
 *  reviews connector's name, so a GitLab-backed repo gets `glab api`
 *  lines a fixer can actually run. */
export function buildCiFixerPrompt(opts: {
  pr: number
  link: string
  branch: string
  worktree: string
  repo: string
  host: string
  failing: CheckInfo[]
}): string {
  const gitlab = opts.host === 'gitlab'
  const encRepo = encodeURIComponent(opts.repo)
  const checksCmd = gitlab
    ? `glab api projects/${encRepo}/merge_requests/${opts.pr}/pipelines`
    : `gh pr checks ${opts.pr}`
  const sastNote = gitlab
    ? " — a SAST check: its findings live in the scanner's report (the job's links), not log lines"
    : ' — a SAST check: its blocking findings are check-run annotations, not log lines'
  const list = opts.failing
    .map(
      (c) =>
        `- ${c.name}${c.bucket === 'cancel' ? ' (cancelled)' : ''}` +
        (isSast(c.name) ? sastNote : '')
    )
    .join('\n')
  const inspect = gitlab
    ? [
        `- \`glab api projects/${encRepo}/merge_requests/${opts.pr}/pipelines\` —`,
        "  the MR's pipelines; the head pipeline is the live check list.",
        `- \`glab api projects/${encRepo}/pipelines/<pipeline-id>/jobs\` names`,
        '  the failing jobs and their links.',
        `- \`glab api projects/${encRepo}/jobs/<job-id>/trace\` is a job's own`,
        "  failure record — read the failing job's log before touching code.",
      ]
    : [
        `- \`gh pr checks ${opts.pr}\` names the failing runs and their links.`,
        "- `gh run view --log-failed <run-id>` is a run's own failure record —",
        "  read the failing job's log before touching code.",
        `- For a SAST-named run the findings are annotations:`,
        `  \`gh api repos/${opts.repo}/check-runs/<run-id>/annotations\`.`,
      ]
  return [
    `# CI fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    `This PR has ${opts.failing.length} failing check(s) on its head. The live`,
    `list is \`${checksCmd}\` — more may settle or appear while you`,
    'work. Failing at spawn:',
    '',
    list,
    '',
    'Investigate before editing:',
    ...inspect,
    "- Reproduce the failure in this worktree (the repo's build/test",
    '  contract), fix, commit, push — the push is the verdict.',
    '',
    'Rules:',
    '- NEVER merge — `bro drive` owns the merge on green.',
    '- A failure no code change remediates (infra outage, quota, a check a',
    '  human owns) is still a verdict: say so as your final message and stop',
    '  — a clean exit without a push marks this head as attempted, not',
    '  retried.',
    '',
  ].join('\n')
}

/** The sast fixer's work order — failure-level annotation counts per
 *  check at spawn. `count` null means the run's annotations couldn't be
 *  fetched — reported as unreadable, not as zero findings. */
export function buildSastFixerPrompt(opts: {
  pr: number
  link: string
  branch: string
  worktree: string
  repo: string
  host: string
  headSha: string
  findings: { name: string; count: number | null }[]
}): string {
  const gitlab = opts.host === 'gitlab'
  const encRepo = encodeURIComponent(opts.repo)
  const list = opts.findings
    .map(
      (f) =>
        `- ${f.name}: ` +
        (f.count === null ? 'annotations unreadable — re-probe or use the dashboard link' : `${f.count} finding(s)`)
    )
    .join('\n')
  const inspect = gitlab
    ? [
        'Read the findings before editing — this host has no check-run',
        "  annotations endpoint; the findings are the scanner's report:",
        `- \`glab api projects/${encRepo}/merge_requests/${opts.pr}/pipelines\` —`,
        "  the MR's pipelines; the head pipeline's jobs name the SAST run.",
        `- \`glab api projects/${encRepo}/jobs/<job-id>/trace\` is the job's`,
        "  record; the scanner dashboard the job links to carries findings.",
      ]
    : [
        'Read the findings before editing — they are check-run annotations:',
        `- \`gh api repos/${opts.repo}/commits/${opts.headSha}/check-runs\` names`,
        "  each run's id;",
        `- \`gh api repos/${opts.repo}/check-runs/<run-id>/annotations\` lists`,
        '  path, line, message, level — the failure-level rows are the blockers.',
        "- The scanner's own dashboard (the check's details link) carries the",
        '  same findings.',
      ]
  return [
    `# SAST fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    "This PR's SAST checks carry failure-level annotation(s) on its head —",
    'the gate counts annotations, not conclusions, so a GREEN check can',
    'still block. At spawn:',
    '',
    list,
    '',
    ...inspect,
    '',
    'Rules:',
    '- Fix valid findings on this branch; a false positive goes through the',
    "  scanner's own suppression path the repo already uses — never a",
    '  silent ignore.',
    "- Re-verify per the repo's contract, commit, push — the push is the",
    '  verdict.',
    '- Findings no code change remediates (scanner config a human owns, a',
    '  disputed severity gate) — say so as your final message and stop; a',
    '  clean exit without a push marks this head as attempted, not retried.',
    '- NEVER merge — `bro drive` owns the merge on green.',
    '',
  ].join('\n')
}

/** The ci-fail fixer — settled-red non-reviewer checks on an orphaned
 *  PR (bro-atb2g). The meta+checks re-probe doubles as the still-open /
 *  still-failing re-check: a PR that settled or a run that went green
 *  between the gate fetch and now must not burn a spawn, and the same
 *  reads name the failing set + live head for the work order. Runs
 *  BEFORE the worktree checkout for the same reason the conflict probe
 *  does. */
async function spawnCiFixer(
  ctx: Ctx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  known: AgentInfo[]
): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let meta: PrMeta
  let checks: CheckInfo[]
  try {
    ;[meta, checks] = await Promise.all([metaOf(ctx, pr), checksOf(ctx, pr)])
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) }
  }
  if (meta.state !== 'OPEN') {
    return { pr, link, verdict: 'settled', detail: meta.state.toLowerCase() }
  }
  const failing = failingCiChecks(gatedChecks(ctx, checks))
  if (failing.length === 0) {
    return { pr, link, verdict: 'ci-resolved' }
  }
  const spent = fixerSpent(ctx, pr, meta.headSha, fixer, 'ci')
  if (spent !== undefined) {
    return spent
  }
  let wt = worktree
  if (wt === undefined) {
    const ensured = ensureFixerWorktree(ctx.mainRoot, state.headRef)
    if (ensured.path === undefined) {
      return { pr, link, verdict: 'no-worktree', detail: ensured.err }
    }
    wt = ensured.path
  }
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    known,
    prompt: buildCiFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      worktree: wt,
      repo: ctx.repo,
      host: ctx.host,
      failing,
    }),
    tag: 'ci ',
    attempt: { head: meta.headSha, cls: 'ci' },
  })
}

/** The sast fixer — failure-level annotations on a live SAST check's
 *  head run (bro-atb2g). A green run can carry them: the gate counts
 *  annotations, not conclusions. The meta+checks+annotations re-probe
 *  is the still-open / still-present re-check — a settled PR, a moved
 *  head, or findings fixed between the gate fetch and now must not
 *  burn a spawn (and a moved head's annotations are fetched at the
 *  live sha, never the gate's stale one). */
async function spawnSastFixer(
  ctx: Ctx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  known: AgentInfo[]
): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let meta: PrMeta
  let checks: CheckInfo[]
  try {
    ;[meta, checks] = await Promise.all([metaOf(ctx, pr), checksOf(ctx, pr)])
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) }
  }
  if (meta.state !== 'OPEN') {
    return { pr, link, verdict: 'settled', detail: meta.state.toLowerCase() }
  }
  const names = liveSastChecks(gatedChecks(ctx, checks)).map((c) => c.name)
  if (names.length === 0) {
    return { pr, link, verdict: 'sast-resolved' }
  }
  let annotations: Map<string, number | null>
  try {
    annotations = await annotationsOf(ctx, meta.headSha, new Set(names))
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) }
  }
  const findings = names
    .map((name) => ({ name, count: annotations.get(name) }))
    .filter((f): f is { name: string; count: number | null } => f.count !== undefined)
  // only positive counts spawn — a null (unreadable annotations) is the
  // gate's sast_unknown shape: infra, retried by the next pass's own
  // probe, never an agent's work order
  if (!findings.some((f) => f.count !== null && f.count > 0)) {
    return { pr, link, verdict: 'sast-resolved' }
  }
  const spent = fixerSpent(ctx, pr, meta.headSha, fixer, 'sast')
  if (spent !== undefined) {
    return spent
  }
  let wt = worktree
  if (wt === undefined) {
    const ensured = ensureFixerWorktree(ctx.mainRoot, state.headRef)
    if (ensured.path === undefined) {
      return { pr, link, verdict: 'no-worktree', detail: ensured.err }
    }
    wt = ensured.path
  }
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    known,
    prompt: buildSastFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      worktree: wt,
      repo: ctx.repo,
      host: ctx.host,
      headSha: meta.headSha,
      // the work order lists the runs that carry (or might carry)
      // findings — clean runs are noise on it
      findings: findings.filter((f) => f.count === null || f.count > 0),
    }),
    tag: 'sast ',
    attempt: { head: meta.headSha, cls: 'sast' },
  })
}

/** The merge side of a green gate: `act merge`, then prove the merge
 *  landed — a merge-queue acceptance exits 0 without a landed head, so
 *  only a MERGED re-probe entitles retirement. Anything else keeps the
 *  PR for the next pass instead of retiring its worktree early. */
async function mergeAndRetire(
  ctx: Ctx,
  pr: number,
  link: string,
  worktree: string | undefined,
  fixer: TaskRow | undefined
): Promise<PrVerdict> {
  if (!(await mergeGreen(ctx, pr))) {
    return { pr, link, verdict: 'merge-refused' }
  }
  const after = await fetchPrActState(
    ctx.rev,
    { repo: ctx.repo, pr },
    {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.mainRoot),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
      }
  ).catch(() => undefined)
  // exit-0 + OPEN IS the enqueue contract — act merge exits 0 only on a
  // landed merge or a queue acceptance (every refusal sets exit 1).
  // Parked, never a failure: no retirement, no fixer close; the next
  // pass re-attempts and merge-async resumes the same uuid.
  if (after?.state === 'OPEN') {
    return { pr, link, verdict: 'enqueued', detail: 'a merge queue owns it' }
  }
  if (after?.state !== 'MERGED') {
    return {
      pr,
      link,
      verdict: 'merge-unverified',
      detail: after === undefined ? 'state re-probe failed' : `state ${after.state.toLowerCase()}`,
    }
  }
  retireLanding(ctx, after, worktree)
  if (fixer) {
    closeFixer(ctx.store, fixer.id, `merged via ${link}`)
  }
  return { pr, link, verdict: 'merged' }
}

/** The post-green verdict ladder — everything the non-green branches
 *  need, bundled so the helpers stay under the parameter cap. */
interface BlockedWork {
  pr: number
  link: string
  state: PrActState
  gate: ExitGate
  occ: string | undefined
  worktree: string | undefined
  fixer: TaskRow | undefined
  work: PassWork
}

/** Non-green verdicts: threads preempt (same order as the loop's
 *  memberAction), then each settled blocker class earns its fixer —
 *  conflicted → rebase, ci-fail → run-log fixer, sast → annotations
 *  fixer (bro-atb2g) — all bounded by the fixRounds cap. Whatever no
 *  class covers (pending checks, draft, UNKNOWN, BEHIND, sast_unknown)
 *  is plain 'blocked'. Extracted so drivePr stays under the
 *  cognitive-complexity cap. */
async function blockedVerdict(ctx: Ctx, b: BlockedWork): Promise<PrVerdict> {
  const { pr, link, state, gate, occ, worktree, fixer, work } = b
  if (gate.open_threads > 0) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    return spawnFixer(ctx, pr, state, worktree, fixer, work.agents, work.judgeBudget)
  }
  // a conflicted orphan stalls exactly like an open-thread one did
  // before the fixer existed — 'blocked — merge conflicts' used to be
  // logged and skipped forever (bro-glkes). The bound is the act gate's
  // own round cap — reviewed pushes past maxRounds read as plain
  // 'blocked', not another rebase round. The same cap bounds the
  // ci/sast rounds below: every fixer push that gets reviewed spends
  // from it.
  const capHit = state.maxRounds > 0 && state.fixRounds > state.maxRounds
  if (state.mergeable === 'CONFLICTING') {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    if (!capHit) {
      return spawnRebaseFixer(ctx, pr, state, worktree, fixer, work.agents)
    }
  }
  // settled-red checks on an orphaned PR used to be terminal 'blocked'
  // — the classes below each get a remediation start instead
  // (bro-atb2g). Occupied still wins over every spawn. A class that
  // owes no spawn on this head (dedup-spent or resolved at the
  // re-probe) doesn't preempt the next one — the classes are
  // independent, so a spent ci attempt on a head that also carries
  // SAST findings must not starve the sast fixer forever.
  let declined: PrVerdict | undefined
  if (gate.ci_failing > 0) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    if (!capHit) {
      const v = await spawnCiFixer(ctx, pr, state, worktree, fixer, work.agents)
      if (v.verdict !== 'fixer-spent' && v.verdict !== 'ci-resolved') {
        return v
      }
      declined = v
    }
  }
  if (gate.sast_pending > 0) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    if (!capHit) {
      return spawnSastFixer(ctx, pr, state, worktree, fixer, work.agents)
    }
  }
  return declined ?? { pr, link, verdict: 'blocked', detail: gate.blockers.join('; ') }
}

async function drivePr(ctx: Ctx, pr: number, work: PassWork): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let state: PrActState
  try {
    state = await fetchPrActState(
      ctx.rev,
      { repo: ctx.repo, pr },
      {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.mainRoot),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
      }
    )
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) }
  }
  const fixer = fixerBeadFor(ctx.store, pr)
  if (state.state !== 'OPEN') {
    if (fixer) {
      closeFixer(ctx.store, fixer.id, `${link} ${state.state.toLowerCase()} — fixer done`)
    }
    return { pr, link, verdict: 'settled', detail: state.state.toLowerCase() }
  }
  const gate = evaluateExitGate(state)
  const worktree = work.worktreeByBranch.get(state.headRef)
  const occ = occupied({
    agents: work.agents,
    fixerBead: fixer?.id,
    branch: state.headRef,
    worktree,
    workDetails: work.workDetails,
    scanProc: agentProcessesIn,
    pr,
    watches: work.watches,
  })
  if (gate.ok) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'green-occupied', detail: occ }
    }
    if (!ctx.merge) {
      return { pr, link, verdict: 'green' }
    }
    // the pass's watch snapshot predates the gate fetch — a supervisor
    // marker published mid-pass (a loop arming its member) must still
    // veto the merge, so supervision is re-read as mergeGreen's last
    // input. The marker plane isn't lock-serialized; a fresh read is
    // the tightest sync point there is.
    const sup = supervisedBy(listWatches(ctx.mainRoot), pr)
    if (sup !== undefined) {
      return {
        pr,
        link,
        verdict: 'green-occupied',
        detail: `supervised by ${watchMarkerKind(sup.file, sup.watch)} pid ${sup.watch.pid}`,
      }
    }
    return mergeAndRetire(ctx, pr, link, worktree, fixer)
  }
  return blockedVerdict(ctx, { pr, link, state, gate, occ, worktree, fixer, work })
}

/** branch → worktree path across every checkout. */
function worktreeMap(root: string): Map<string, string> {
  const map = new Map<string, string>()
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain'])
  if (wt.code === 0) {
    for (const w of parseWorktreePorcelain(wt.out)) {
      if (w.branch) {
        map.set(w.branch, w.path)
      }
    }
  }
  return map
}

/** Open PR numbers across every candidate branch — a failed listing or
 *  lookup on one source is a warning, never a dead pass. `complete` is
 *  false when the branch listing or any lookup failed: the set then
 *  under-counts open PRs, so consumers must not use it to conclude a
 *  PR is gone. */
function openFleetPrs(ctx: Ctx): { prs: Set<number>; complete: boolean } {
  const prs = new Set<number>()
  const candidates = candidateBranches(ctx.mainRoot)
  let complete = candidates.complete
  if (!complete) {
    say(ctx, 'warning: branch enumeration failed — the open-PR set may under-count')
  }
  for (const branch of candidates.branches) {
    try {
      for (const pr of ctx.rev.prsForBranch(branch)) {
        prs.add(pr)
      }
    } catch (err) {
      complete = false
      say(ctx, `warning: PR lookup failed for ${branch} — ${errText(err)}`)
    }
  }
  return { prs, complete }
}

/** A settled PR drops out of prsForBranch entirely — without this sweep
 *  its fixer bead hangs open forever after the merge/close. */
async function sweepSettledFixers(ctx: Ctx, prs: Set<number>): Promise<void> {
  for (const row of ctx.store.list({ labels: [FIXER_LABEL], all: true })) {
    const m = /^drive:pr:(\d+)$/.exec(row.external_ref ?? '')
    if (m === null || row.status === 'closed' || prs.has(Number(m[1]))) {
      continue
    }
    const pr = Number(m[1])
    const link = ctx.rev.prLink(ctx.repo, pr)
    try {
      const st = await fetchPrActState(
        ctx.rev,
        { repo: ctx.repo, pr },
        {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.mainRoot),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
      }
      )
      if (st.state !== 'OPEN') {
        closeFixer(ctx.store, row.id, `${link} ${st.state.toLowerCase()} — fixer done`)
        say(ctx, `drive ${link} settled (${st.state.toLowerCase()}) — fixer ${row.id} closed`)
      }
    } catch (err) {
      say(ctx, `warning: fixer sweep probe failed for ${link} — ${errText(err)}`)
    }
  }
}

/** Heartbeat per supervised PR — deterministic name per drive pid, so
 *  each pass rewrites the same marker and a dead drive leaves exactly
 *  the stale-supervision flag the session-start hook reports. The TTL
 *  covers the sweep interval so a live drive's marker can't age out
 *  between passes. Also retires this drive's markers for PRs that left
 *  the open set — a live marker on a merged PR would keep reporting
 *  "watch active". Skipped on an incomplete enumeration: a failed
 *  lookup must not delete the marker of a PR that is still open.
 *  PRs a live foreign marker already supervises (a `loop` heartbeat,
 *  `act wait`, convoy) are excluded both ways — claiming "watch active"
 *  for a PR this drive will skip is a lie, and a stale own-marker on
 *  one would keep saying it. */
function emitWatchHeartbeats(
  ctx: Ctx,
  prs: Set<number>,
  supervised: Set<number>,
  complete: boolean
): void {
  for (const pr of prs) {
    if (supervised.has(pr)) {
      continue
    }
    watchHeartbeat(
      ctx.mainRoot,
      {
        pr,
        link: ctx.rev.prLink(ctx.repo, pr),
        merge: ctx.merge,
        timeoutMin: Math.ceil(ctx.everySec! / 60) + 1,
      },
      'drive'
    )
  }
  if (!complete) {
    return
  }
  for (const l of listWatches(ctx.mainRoot)) {
    if (
      l.alive &&
      l.watch.pid === process.pid &&
      basename(l.file).endsWith(`-drive-${process.pid}.json`) &&
      (!prs.has(l.watch.pr) || supervised.has(l.watch.pr))
    ) {
      watchEnd(l.file)
    }
  }
}

/** One pass: enumerate, probe every open PR, act per verdict. */
async function driveOnce(ctx: Ctx): Promise<void> {
  const { byStep, degraded } = await collectAgents(ctx.mainRoot)
  for (const d of degraded) {
    say(ctx, `warning: backend degraded — ${d}`)
  }
  const hooks = hooksDirOf(ctx.mainRoot)
  const work: PassWork = {
    worktreeByBranch: worktreeMap(ctx.mainRoot),
    agents: [...byStep.values()],
    workDetails: hooks === null ? [] : liveWorkDetails(hooks),
    watches: listWatches(ctx.mainRoot),
    judgeBudget: { remaining: judgeConfig(ctx.mainRoot).judge.maxDecisionsPerRun },
  }
  const { prs, complete } = openFleetPrs(ctx)
  if (ctx.everySec !== undefined) {
    const supervised = new Set(
      [...prs].filter((pr) => supervisedBy(work.watches, pr) !== undefined)
    )
    emitWatchHeartbeats(ctx, prs, supervised, complete)
  }
  for (const pr of prs) {
    // a throwing probe on one PR must not kill the pass — in --every
    // mode an unhandled throw would end the driver entirely
    const v = await drivePr(ctx, pr, work).catch((err) => ({
      pr,
      link: ctx.rev.prLink(ctx.repo, pr),
      verdict: 'error',
      detail: errText(err),
    }))
    if (ctx.json) {
      console.log(JSON.stringify(v))
    } else {
      say(ctx, `drive ${v.link} ${v.verdict}${v.detail === undefined ? '' : ` — ${v.detail}`}`)
    }
  }
  if (prs.size === 0) {
    say(ctx, 'drive: no open PRs on fleet branches')
  }
  await sweepSettledFixers(ctx, prs)
}

/** `<git-common>/bro/drive.lock` — the one-supervisor-per-repo hold
 *  (spec bro-2duu9). Null when git can't name a common dir: the guard
 *  degrades away rather than blocking a run on a missing state dir. */
export function driveLockPath(root: string): string | null {
  const common = gitCommonDir(root)
  return common === null ? null : join(common, 'bro', 'drive.lock')
}

export async function runDriveCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  checkBeads()
  const main = mainWorktree()
  const broCfg = loadBroConfig(main.path)
  const drive = ((broCfg as Record<string, unknown>).drive as DriveConfig | undefined) ??
    driveSection(undefined)
  let args: DriveArgs
  try {
    args = driveArgs(argv, drive.intervalSec)
  } catch (err) {
    console.error(`error: ${errText(err)}`)
    process.exit(2)
  }
  // GUARD (bro-killn): spawned workers pin BRO_AGENT_ID — they must
  // never arm a supervisor cadence; the orchestrator session owns it
  // and runs single passes on its pulse window end.
  if (args.everySec !== undefined && !isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm supervisors; ' +
        'the orchestrator session owns the cadence'
    )
    process.exit(2)
  }
  // One drive per repo: a respawn wrapper's duplicate stands by behind
  // the incumbent's hold and supervises once it exits — two drives on
  // the same PRs raced fixer spawns and merge probes overnight
  // (retro bro-l63ji). Taken before auth/facade planes so a standby
  // stays a cheap local wait.
  const driveLock = driveLockPath(main.path)
  const releaseSupervisor =
    driveLock === null
      ? () => {}
      : await awaitFileLock(driveLock, {
          label: 'drive supervisor lock',
          onStandby: (pid) =>
            console.error(
              `bro drive: already supervised${pid === null ? '' : ` by pid ${pid}`} — standing by`
            ),
        })
  try {
    await runDrive(main.path, broCfg, drive, args)
  } finally {
    releaseSupervisor()
  }
}

async function runDrive(
  mainPath: string,
  broCfg: ReturnType<typeof loadBroConfig>,
  drive: DriveConfig,
  args: DriveArgs
): Promise<void> {
  // same gate as `bro act` — without it an unauthenticated pass catches
  // every lookup's auth error per-branch and reports "no open PRs"
  ensureAuth('reviews', { dir: mainPath }, { prefer: broCfg.connectors })
  const rev = reviewHost(mainPath, broCfg.connectors)
  const ctx: Ctx = {
    mainRoot: mainPath,
    rev,
    // same pick reviewHost already memoized — the name only decides
    // which CLI syntax the fixer prompts write
    host: facadeName('reviews', { dir: mainPath }, { prefer: broCfg.connectors }),
    repo: rev.resolveRepo([]),
    act: broCfg.act,
    merge: args.merge && drive.merge === 'auto',
    json: args.json,
    connector: args.connector,
    everySec: args.everySec,
    env: loadAgentEnv(mainPath),
    store: facade('tasks', { dir: mainPath }, { prefer: broCfg.connectors }),
  }

  await driveOnce(ctx)
  if (args.everySec === undefined) {
    return
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, args.everySec! * 1000))
    try {
      await driveOnce(ctx)
    } catch (err) {
      say(ctx, `drive: pass failed — ${errText(err)}`)
    }
  }
}

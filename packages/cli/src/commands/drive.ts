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
 *   green, occupied        → report; the owner's merge step lands it
 *   green, orphaned        → bro act merge (unless --no-merge /
 *                            drive.merge:'never'), then retire the
 *                            worktree and close the fixer bead
 *   PR settled             → close a dangling fixer bead
 *
 * Occupancy is the guard bro-pywx hardens: never spawn into a worktree
 * a live session works in. Planes: the agents facade, the worktree's own
 * claim marker, fresh .work markers, and a /proc cwd scan that follows a
 * process's ancestry to an agent-shaped root — occupied is always the
 * safe verdict (a skipped pass, never double-work).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  acquireAgentRegistryLock,
  acquireFileLock,
  agentEntryBlocked,
  agentRegistryPath,
  checkBeads,
  ensureAuth,
  gitTry,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  SpawnError,
  taskStore,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type IgnoreCheckRule,
  type ReviewFacade,
  type ReviewThread,
  type TaskRow,
  type TaskStore,
} from '@broject/core'
import {
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  listWatches,
  watchEnd,
  watchHeartbeat,
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
 *  plus local fleet-prefixed branches. */
export function candidateBranches(root: string): string[] {
  const branches = new Set<string>()
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain'])
  if (wt.code === 0) {
    for (const w of parseWorktreePorcelain(wt.out)) {
      if (w.branch) {
        branches.add(w.branch)
      }
    }
  }
  for (const prefix of FLEET_BRANCH_PREFIXES) {
    const res = gitTry(['-C', root, 'branch', '--list', `${prefix}*`, '--format=%(refname:short)'])
    if (res.code === 0) {
      for (const b of res.out.split('\n').filter((s) => s !== '')) {
        branches.add(b)
      }
    }
  }
  return [...branches]
}

/** work/bro-x → bro-x; stack/name/3-bro-x → 3-bro-x. */
export function branchSlug(branch: string): string {
  return branch.split('/').pop() ?? branch
}

// --- occupancy --------------------------------------------------------------------

/** A `.work` marker's detail may be a bead id, a slug, a worktree path
 *  or basename. Match conservatively — an over-match costs a skipped
 *  pass; an under-match costs a raced owner. */
export function detailMatches(
  detail: string,
  ctx: { branch: string; slug: string; worktree?: string }
): boolean {
  if (detail === ctx.branch || detail === ctx.slug) {
    return true
  }
  if (ctx.worktree === undefined) {
    return false
  }
  const base = basename(ctx.worktree)
  return (
    detail === base || base.endsWith(`--${detail}`) || detail.endsWith(`/${base}`)
  )
}

/** Every detail line of every live `.work` marker — a session claiming
 *  two beads keeps both, so occupancy reads them all (otherLiveWork's
 *  first-line peek would miss the second). Liveness is owner-pid first
 *  (bro-b87b: a dead session's marker is residue even when fresh),
 *  mtime-window fallback for ownerless markers. */
export function liveWorkDetails(dir: string, now: number = Date.now()): string[] {
  const details: string[] = []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return details
  }
  for (const f of files) {
    if (!f.endsWith('.work')) {
      continue
    }
    try {
      const path = join(dir, f)
      const lines = readFileSync(path, 'utf8').split('\n')
      if (!markerLive(lines[0], statSync(path).mtimeMs, LIVE_MARKER_MS, now)) {
        continue
      }
      for (const line of lines.slice(1)) {
        const d = line.trim()
        if (d !== '') {
          details.push(d)
        }
      }
    } catch {
      // unreadable marker — skip
    }
  }
  return details
}

import { agentProcessesIn, markerLive, type ProcHit } from './proc-owner.ts'
export { agentProcessesIn }
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
  if (opts.worktree !== undefined) {
    const wt = resolve(opts.worktree)
    const agent = live.find(
      (a) => typeof a.worktree === 'string' && resolve(a.worktree) === wt
    )
    if (agent) {
      return `agent ${agent.id} live in ${basename(opts.worktree)}`
    }
    const claim = (opts.scanClaim ?? worktreeClaim)(opts.worktree)
    if (claim !== undefined) {
      return `worktree ${basename(opts.worktree)} claimed${claim === '' ? '' : ` by ${claim}`}`
    }
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
        `Spawned by \`bro drive\` — resolve review threads on ${link} ` +
        `(branch \`${branch}\`), push, never merge.`,
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
    }
  } catch (err) {
    console.error(`drive: could not close fixer bead ${id} — ${errText(err)}`)
  }
}

// --- fixer worktree + prompt ---------------------------------------------------------

/** The PR's fixer checkout: the branch's existing worktree, else a fresh
 *  `<repo>--<slug>` on it — `created` marks a dir this call added so the
 *  caller can retire it when the work evaporates. A dir standing on
 *  another branch is never clobbered: distinct branches sharing the
 *  final slug (work/x vs loop/x) fall back to the branch-namespaced
 *  `<repo>--work-x` path instead of refusing as foreign. */
export function ensureFixerWorktree(
  mainRoot: string,
  branch: string
): { path?: string; created?: boolean; err?: string } {
  for (const name of new Set([branchSlug(branch), branch.replaceAll('/', '-')])) {
    const dir = worktreePathFor(mainRoot, name)
    if (existsSync(dir)) {
      const on = gitTry(['-C', dir, 'branch', '--show-current']).out.trim()
      if (on === branch) {
        return { path: dir }
      }
      continue
    }
    // fetch first — an orphaned PR's remote head may be newer than ours
    gitTry(['-C', mainRoot, 'fetch', 'origin', branch, '--quiet'])
    const add = gitTry(['-C', mainRoot, 'worktree', 'add', dir, branch])
    if (add.code === 0) {
      // the fetch refreshed origin/<branch>, not the local ref the
      // worktree just checked out — ff or the fixer works a stale tip
      gitTry(['-C', dir, 'merge', '--ff-only', `origin/${branch}`, '--quiet'])
      return { path: dir, created: true }
    }
    const retry = gitTry(['-C', mainRoot, 'worktree', 'add', '-b', branch, dir, `origin/${branch}`])
    if (retry.code === 0) {
      return { path: dir, created: true }
    }
    return { err: retry.err || add.err }
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

/** Agent liveness derived from the registry entry alone — no backend
 *  list() probes. A live pid is running; a recorded or on-disk death is
 *  terminal; anything unproven counts as live ('spawned') — occupied is
 *  always the safe verdict, and a false-occupied only costs a skipped
 *  pass. */
export function registryEntryState(
  home: string | null,
  e: AgentRegistryEntry
): AgentState {
  const pid = typeof e.pid === 'number' ? e.pid : undefined
  // '' pidStart is unverified identity, not reuse proof — pidAlive('')
  // can never match a real starttime and would read a live agent dead
  const start = typeof e.pidStart === 'string' && e.pidStart !== '' ? e.pidStart : undefined
  if (pid !== undefined && pidAlive(pid, start)) {
    return 'running'
  }
  if (e.stopped === true) {
    return 'stopped'
  }
  if (e.exitStatus !== undefined) {
    // recorded cause decides — a budget-walled entry reads 'blocked'
    // here the same as in the connector ladder (bro-7xgk.2)
    return agentEntryBlocked(e) ? 'blocked' : 'exited'
  }
  if (exitFileProves(home, e)) {
    return 'exited'
  }
  // a dead pid is proven — 'lost' keeps the fixer respawn-able; a
  // pid-less entry (remote backend) is unproven → conservative live
  return pid !== undefined ? 'lost' : 'spawned'
}

/** An .exit file not yet harvested into the registry is death proof too
 *  — basename-only ids: '../' must never escape the agents home. */
function exitFileProves(home: string | null, e: AgentRegistryEntry): boolean {
  if (home === null || typeof e.agentId !== 'string' || basename(e.agentId) !== e.agentId) {
    return false
  }
  try {
    const v = readFileSync(join(home, `${e.agentId}.exit`), 'utf8').trim()
    return v !== '' && Number.isInteger(Number(v))
  } catch {
    // no exit file — not proof
    return false
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
): Pick<PassWork, 'agents' | 'workDetails'> {
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
    })
    if (occ !== undefined) {
      return occ
    }
    // the work evaporated after we checked out — retire the dir we
    // just added or it lingers as an orphaned fixer worktree
    gitTry(['-C', ctx.mainRoot, 'worktree', 'remove', wt])
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
      const retire = await retireIfOrphaned(ctx, wt, state.headRef, fixer, known)
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
  // a last occupancy read right before the spawn — the gap since the
  // pass-level check covered the worktree create + thread refetch,
  // long enough for another owner to arm this branch. Both occupancy
  // locks are held across refresh→probe→spawn (see acquireOccupancyLocks)
  // so a `bro work enter` or a competing spawn can't land a claim
  // between — the refresh itself must come after the acquire, or the
  // lock wait is one more stale-input window
  let release: () => void
  try {
    release = acquireOccupancyLocks(ctx.mainRoot, wt)
  } catch (err) {
    return {
      pr,
      link,
      verdict: 'occupied',
      detail: `occupancy re-check failed — ${errText(err)}`,
    }
  }
  try {
    const fresh = freshOccupancy(ctx.mainRoot, known)
    const occ = occupied({
      agents: fresh.agents,
      fixerBead: fixer?.id,
      branch: state.headRef,
      worktree: wt,
      workDetails: fresh.workDetails,
      scanProc: agentProcessesIn,
    })
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    const bead = fixer ?? ensureFixerBead(ctx.store, pr, link, state.headRef)
    const prompt = buildFixerPrompt({
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
    })
    try {
      const info = await spawnStepAgent(ctx.mainRoot, ctx.env, {
        molStep: bead.id,
        worktree: wt,
        prompt,
        connector: ctx.connector,
        env: { BRO_PR: String(pr), BRO_PR_URL: link },
      })
      const pid = info.pid === undefined ? '' : ` pid ${info.pid}`
      return { pr, link, verdict: 'spawned', detail: `${bead.id} → ${info.id}${pid}` }
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
  })
  if (gate.ok) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'green-occupied', detail: occ }
    }
    if (!ctx.merge) {
      return { pr, link, verdict: 'green' }
    }
    return mergeAndRetire(ctx, pr, link, worktree, fixer)
  }
  if (gate.open_threads > 0) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    return spawnFixer(ctx, pr, state, worktree, fixer, work.agents, work.judgeBudget)
  }
  return { pr, link, verdict: 'blocked', detail: gate.blockers.join('; ') }
}

/** `<git-common-dir>/bro/hooks` — the .work marker dir. */
function hooksDirOf(root: string): string | null {
  const r = gitTry(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'hooks')
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

/** Open PR numbers across every candidate branch — a failed lookup on
 *  one branch is a warning, never a dead pass. `complete` is false when
 *  any lookup failed: the set then under-counts open PRs, so consumers
 *  must not use it to conclude a PR is gone. */
function openFleetPrs(ctx: Ctx): { prs: Set<number>; complete: boolean } {
  const prs = new Set<number>()
  let complete = true
  for (const branch of candidateBranches(ctx.mainRoot)) {
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
 *  lookup must not delete the marker of a PR that is still open. */
function emitWatchHeartbeats(ctx: Ctx, prs: Set<number>, complete: boolean): void {
  for (const pr of prs) {
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
      !prs.has(l.watch.pr)
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
    judgeBudget: { remaining: judgeConfig(ctx.mainRoot).judge.maxDecisionsPerRun },
  }
  const { prs, complete } = openFleetPrs(ctx)
  if (ctx.everySec !== undefined) {
    emitWatchHeartbeats(ctx, prs, complete)
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
  // same gate as `bro act` — without it an unauthenticated pass catches
  // every lookup's auth error per-branch and reports "no open PRs"
  ensureAuth('reviews', { dir: main.path }, { prefer: broCfg.connectors })
  const rev = reviewHost(main.path, broCfg.connectors)
  const ctx: Ctx = {
    mainRoot: main.path,
    rev,
    repo: rev.resolveRepo([]),
    act: broCfg.act,
    merge: args.merge && drive.merge === 'auto',
    json: args.json,
    connector: args.connector,
    everySec: args.everySec,
    env: loadAgentEnv(main.path),
    store: taskStore(main.path),
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

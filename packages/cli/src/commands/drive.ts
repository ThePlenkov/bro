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
 * a live session works in. Planes: the agents facade, fresh .work
 * markers, and a /proc cwd scan for agent-shaped processes — occupied
 * is always the safe verdict (a skipped pass, never double-work).
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import {
  checkBeads,
  gitTry,
  reviewHost,
  SpawnError,
  taskStore,
  type AgentInfo,
  type ReviewFacade,
  type TaskRow,
  type TaskStore,
} from '@broject/core'
import { evaluateExitGate, fetchPrActState, type PrActState } from '@broject/act'
import { loadAgentEnv, type AgentConnectorEnv } from '../agent-connectors.ts'
import { flag } from './args.ts'
import { deleteMergedLocalBranch, removeMergedWorktree, runActCommand } from './act.ts'
import { spawnStepAgent } from './agents.ts'
import { collectAgents } from './fleet.ts'
import { driveSection, type DriveConfig } from './drive-config.ts'
import { loadBroConfig } from '../plugins.ts'
import { mainWorktree, parseWorktreePorcelain, worktreePathFor } from './work.ts'

function usage(): never {
  console.error(`Usage: bro drive [--once] [--every SEC] [--no-merge] [--connector <name>] [--json]`)
  process.exit(2)
}

// --- args ------------------------------------------------------------------------

export interface DriveArgs {
  everySec?: number
  merge: boolean
  json: boolean
  connector?: string
}

export function driveArgs(argv: string[]): DriveArgs {
  const base: DriveArgs = {
    json: argv.includes('--json'),
    merge: !argv.includes('--no-merge'),
    connector: flag(argv, '--connector'),
  }
  const everyRaw = flag(argv, '--every')
  if (everyRaw === undefined) {
    return base
  }
  const everySec = Number(everyRaw)
  if (!Number.isFinite(everySec) || everySec <= 0 || everySec * 1000 > 0x7fffffff) {
    throw new Error(
      `--every needs a positive seconds value up to ${0x7fffffff / 1000}s, got "${everyRaw}"`
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

/** The freshness horizon for `.work` markers — same as hooks.ts's
 *  LIVE_SESSION_MS: a marker younger than this names a live session. */
export const LIVE_MARKER_MS = 24 * 60 * 60 * 1000

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

/** Every detail line of every fresh `.work` marker — a session claiming
 *  two beads keeps both, so occupancy reads them all (otherLiveWork's
 *  first-line peek would miss the second). */
export function liveWorkDetails(dir: string, now: number = Date.now()): string[] {
  const cutoff = now - LIVE_MARKER_MS
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
      if (statSync(path).mtimeMs < cutoff) {
        continue
      }
      for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
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

interface ProcHit {
  pid: number
  cmd: string
}

/** Agent-shaped cmdline — the fallback for sessions that never armed a
 *  marker. Deliberately a small allowlist: counting ANY process would
 *  let a leftover `tsc --watch` or dev server occupy a worktree forever. */
const AGENT_CMD_RE = /(?:^|[\s/])(devin|claude|codex|gemini|aider|opencode|amp)(?:\s|$)/

function readProcText(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), 'utf8')
  } catch {
    return ''
  }
}

/** Live agent-shaped processes with cwd inside `worktree` — Linux-only
 *  layer; a missing /proc is "no data", not "occupied" (the facade and
 *  marker planes still apply). `procDir` is injectable for tests. */
export function agentProcessesIn(worktree: string, procDir = '/proc'): ProcHit[] {
  const hits: ProcHit[] = []
  let names: string[]
  try {
    names = readdirSync(procDir)
  } catch {
    return hits
  }
  const root = resolve(worktree)
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue
    }
    const dir = join(procDir, name)
    let cwd: string
    try {
      cwd = readlinkSync(join(dir, 'cwd'))
    } catch {
      continue
    }
    if (cwd !== root && !cwd.startsWith(root + sep)) {
      continue
    }
    const cmd = readProcText(dir, 'cmdline').replaceAll('\0', ' ').trim()
    const env = readProcText(dir, 'environ')
    if (AGENT_CMD_RE.test(cmd) || env.includes('BRO_AGENT_ID=')) {
      hits.push({ pid: Number(name), cmd })
    }
  }
  return hits
}

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
 *  tells it to re-fetch; more may land while it works). */
export function buildFixerPrompt(opts: {
  pr: number
  link: string
  branch: string
  worktree: string
  threads: { path?: string | null; line?: number | null; author?: string; body?: string }[]
}): string {
  const list = opts.threads
    .map(
      (t) => `- ${t.path ?? ''}:${t.line ?? ''} [${t.author ?? '?'}] ${(t.body ?? '').trim()}`
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

// --- the pass -------------------------------------------------------------------------

interface Ctx {
  mainRoot: string
  rev: ReviewFacade
  repo: string
  act: { ignoreChecks: string[]; maxRounds: number }
  merge: boolean
  json: boolean
  connector?: string
  env: AgentConnectorEnv
  store: TaskStore
}

interface PassWork {
  worktreeByBranch: Map<string, string>
  agents: AgentInfo[]
  workDetails: string[]
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
      }
    }
    deleteMergedLocalBranch(state.headRef, state.headSha)
  } catch (err) {
    say(ctx, `drive: post-merge cleanup failed — ${errText(err)}`)
  }
}

async function spawnFixer(
  ctx: Ctx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  work: PassWork
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
      // the work evaporated after we checked out — retire the dir we
      // just added or it lingers as an orphaned fixer worktree
      gitTry(['-C', ctx.mainRoot, 'worktree', 'remove', wt])
    }
    return { pr, link, verdict: 'threads-resolved' }
  }
  // a last occupancy read right before the spawn — the gap since the
  // pass-level check covered the worktree create + thread refetch,
  // long enough for another owner to arm this branch
  const occ = occupied({
    agents: work.agents,
    fixerBead: fixer?.id,
    branch: state.headRef,
    worktree: wt,
    workDetails: work.workDetails,
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
}

async function drivePr(ctx: Ctx, pr: number, work: PassWork): Promise<PrVerdict> {
  const link = ctx.rev.prLink(ctx.repo, pr)
  let state: PrActState
  try {
    state = await fetchPrActState(
      ctx.rev,
      { repo: ctx.repo, pr },
      { ignoreChecks: ctx.act.ignoreChecks, maxRounds: ctx.act.maxRounds }
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
    if (!(await mergeGreen(ctx, pr))) {
      return { pr, link, verdict: 'merge-refused' }
    }
    retireLanding(ctx, state, worktree)
    if (fixer) {
      closeFixer(ctx.store, fixer.id, `merged via ${link}`)
    }
    return { pr, link, verdict: 'merged' }
  }
  if (gate.open_threads > 0) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ }
    }
    return spawnFixer(ctx, pr, state, worktree, fixer, work)
  }
  return { pr, link, verdict: 'blocked', detail: gate.blockers.join('; ') }
}

/** `<git-common-dir>/bro/hooks` — the .work marker dir. */
function hooksDirOf(root: string): string | null {
  const r = gitTry(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'hooks')
}

/** One pass: enumerate, probe every open PR, act per verdict. */
async function driveOnce(ctx: Ctx): Promise<void> {
  const wt = gitTry(['-C', ctx.mainRoot, 'worktree', 'list', '--porcelain'])
  const worktreeByBranch = new Map<string, string>()
  if (wt.code === 0) {
    for (const w of parseWorktreePorcelain(wt.out)) {
      if (w.branch) {
        worktreeByBranch.set(w.branch, w.path)
      }
    }
  }
  const { byStep, degraded } = await collectAgents(ctx.mainRoot)
  for (const d of degraded) {
    say(ctx, `warning: backend degraded — ${d}`)
  }
  const hooks = hooksDirOf(ctx.mainRoot)
  const workDetails = hooks === null ? [] : liveWorkDetails(hooks)

  const prs = new Set<number>()
  for (const branch of candidateBranches(ctx.mainRoot)) {
    try {
      for (const pr of ctx.rev.prsForBranch(branch)) {
        prs.add(pr)
      }
    } catch (err) {
      say(ctx, `warning: PR lookup failed for ${branch} — ${errText(err)}`)
    }
  }
  const work: PassWork = {
    worktreeByBranch,
    agents: [...byStep.values()],
    workDetails,
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
}

export async function runDriveCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  let args: DriveArgs
  try {
    args = driveArgs(argv)
  } catch (err) {
    console.error(`error: ${errText(err)}`)
    process.exit(2)
  }
  checkBeads()
  const main = mainWorktree()
  const broCfg = loadBroConfig(main.path)
  const drive = ((broCfg as Record<string, unknown>).drive as DriveConfig | undefined) ??
    driveSection(undefined)
  const rev = reviewHost(main.path, broCfg.connectors)
  const ctx: Ctx = {
    mainRoot: main.path,
    rev,
    repo: rev.resolveRepo([]),
    act: broCfg.act,
    merge: args.merge && drive.merge === 'auto',
    json: args.json,
    connector: args.connector,
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

/**
 * `bro fleet` — the read-only fleet view: open molecules × steps ×
 * agents × worktrees × PRs. Spec: specs/sessions/bro-f4ot/spec.md,
 * specs/sessions/bro-f4ot/bro-n54z.md (--live).
 *
 *   bro fleet                 one-shot table
 *   bro fleet --json          machine-readable rows + degraded backends
 *   bro fleet --live          full-screen dashboard, repaint every 2s
 *   bro fleet --live --every N  repaint every N seconds
 *
 * State the table must surface honestly:
 *  - an agent dead while its step stays claimed → `lost — respawn?`
 *    (the respawn decision surface — `bro agents` owns it later);
 *  - a backend whose list() degraded → `unknown`, never `lost` —
 *    a failed read must not look like a dead fleet;
 *  - a claimed step with no agent → `claimed — <assignee>` (interactive
 *    sessions and foreign backends hold claims too).
 *
 * --live is the human at the terminal: same rows, alternate screen,
 * chained setTimeout ticks (a slow backend stretches the interval, it
 * never stacks collects), q/Esc/Ctrl-C quits. Non-TTY is a usage
 * error — `bro watch --every N` is the non-interactive heartbeat.
 * The site route over `bro serve` is bro-1rir.
 */
import { basename } from 'node:path'
import {
  git,
  gitTry,
  reviewHost,
  wallText,
  type AgentInfo,
  type ProviderWall,
  type ReviewFacade,
} from '@broject/core'
import { listMolecules, loadMolecule, stepsOf, type ConvoyStep } from '@broject/convoy'
import {
  budgetSnapshotFor,
  eachAgentConnector,
  loadAgentEnv,
  providerWallsFor,
  type AgentConnectorEnv,
  type BudgetSnapshot,
} from '../agent-connectors.ts'
import { occupancyLine, type FleetOccupancy } from './agents.ts'
import { flag } from './args.ts'
import { parseWorktreePorcelain, worktreePathFor, type WorktreeInfo } from './work.ts'

export interface FleetRow {
  mol: string
  step: string
  title: string
  kind: string
  state: string
  /** Rendered agent cell — states, `lost — respawn?`, `claimed — <a>`,
   *  `unknown` on a degraded backend read, `—` when nothing holds it. */
  agent: string
  /** Provider provenance — the providers.<name> + effective model the
   *  spawn resolved to; absent on legacy template spawns (the column
   *  says '—' by omission, honestly). */
  provider?: string
  model?: string
  worktree?: string
  pr?: string
  /** The PR's number — `pr` is the rendered link; watch feeds the number
   *  to the act gate instead of re-parsing the link. */
  prNum?: number
  /** Every open PR on the branch — `prNum` is `[0]` for display, but a
   *  branch with several open PRs still needs each one gated. */
  prNums?: number[]
}

/** The fleet's agent plane — merged across every registered backend.
 *  A throwing connector — factory or list() — is degrade-equivalent:
 *  it contributes no agents and one `degraded` note, never a hard
 *  failure of the whole view. Two backends reporting the same step is a
 *  `conflict`: registry order decides (same precedence as connector
 *  resolution) and the loser is reported, not silently overwritten. */
export async function collectAgents(
  dir: string,
  env: AgentConnectorEnv = loadAgentEnv(dir)
): Promise<{
  byStep: Map<string, AgentInfo>
  degraded: string[]
  conflicts: string[]
}> {
  const byStep = new Map<string, AgentInfo>()
  const degraded: string[] = []
  const conflicts: string[] = []
  for (const conn of eachAgentConnector({ dir }, env, (name, err) => {
    degraded.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
  })) {
    try {
      const res = await conn.list()
      if (res.degraded) {
        degraded.push(`${conn.name}: ${res.degraded}`)
      }
      for (const a of res.agents) {
        if (byStep.has(a.molStep)) {
          conflicts.push(
            `${a.molStep}: ${conn.name} agent ${a.id} ignored — ${byStep.get(a.molStep)!.backend} holds the step`
          )
          continue
        }
        byStep.set(a.molStep, a)
      }
    } catch (err) {
      degraded.push(`${conn.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { byStep, degraded, conflicts }
}

/** The worktree column: the agent's recorded worktree wins; otherwise
 *  the step's own `bro work` checkout — `worktreePathFor(main, step)`,
 *  an exact sibling path, not a basename suffix that could borrow
 *  another repo's `…--<step>` directory. Returns the absolute path —
 *  the row renders its basename, but the PR lookup needs the path
 *  itself (two worktrees can share a basename). */
export function worktreeOf(
  stepId: string,
  agent: AgentInfo | undefined,
  worktrees: WorktreeInfo[]
): string | undefined {
  if (agent?.worktree) {
    return agent.worktree
  }
  const main = worktrees[0]?.path // porcelain lists the main checkout first
  if (main === undefined) {
    return undefined
  }
  const expected = worktreePathFor(main, stepId)
  return worktrees.find((w) => w.path === expected)?.path
}

/** `work/x` branch name for a worktree path — '' when unreadable. */
function branchOf(path: string): string {
  return gitTry(['-C', path, 'branch', '--show-current']).out.trim()
}

/** PR number for a worktree's branch — one failed lookup must not
 *  blank the row, but it is reported into `errors` when given: a
 *  silent miss would let the snapshot claim no PRs exist. */
function prNumsForWorktree(
  rev: ReviewFacade,
  abs: string | undefined,
  errors?: string[]
): number[] {
  if (abs === undefined) {
    return []
  }
  const branch = branchOf(abs)
  if (branch === '') {
    return []
  }
  try {
    return rev.prsForBranch(branch)
  } catch (err) {
    errors?.push(`${branch}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/** Rows across open molecules — the agent cell, a `<repo>--<step>`
 *  worktree match, and a best-effort PR per step. Exported for `bro
 *  watch`, which composes the same rows into its snapshot. */
export function fleetRows(
  byStep: Map<string, AgentInfo>,
  degradedAny: boolean,
  rev: ReviewFacade | undefined,
  repo: string,
  worktrees: WorktreeInfo[],
  prErrors?: string[]
): FleetRow[] {
  const rows: FleetRow[] = []
  for (const m of listMolecules()) {
    const mol = loadMolecule(m.id)
    for (const s of stepsOf(mol)) {
      const agent = byStep.get(s.id)
      const issue = mol.issues.find((i) => i.id === s.id) as
        | { assignee?: string }
        | undefined
      const wt = worktreeOf(s.id, agent, worktrees)
      const prNums = rev === undefined ? [] : prNumsForWorktree(rev, wt, prErrors)
      const prNum = prNums[0]
      rows.push({
        mol: m.id,
        step: s.id,
        title: s.title,
        kind: s.kind,
        state: s.state,
        agent: agentCell(s, agent, issue?.assignee, degradedAny),
        provider: agent?.provider,
        model: agent?.model,
        worktree: wt === undefined ? undefined : basename(wt),
        pr: rev === undefined || prNum === undefined ? undefined : rev.prLink(repo, prNum),
        prNum,
        prNums: prNums.length > 1 ? prNums : undefined,
      })
    }
  }
  return rows
}

/** The fleet table as lines — `bro watch` embeds the same rendering in
 *  its snapshot text (mailbox drops carry the whole frame). */
export function fleetTableLines(rows: FleetRow[]): string[] {
  const cols: [keyof FleetRow, string][] = [
    ['mol', 'mol'],
    ['step', 'step'],
    ['state', 'state'],
    ['agent', 'agent'],
    ['provider', 'provider'],
    ['model', 'model'],
    ['worktree', 'worktree'],
    ['pr', 'pr'],
  ]
  const cells = rows.map((r) => cols.map(([k]) => String(r[k] ?? '—')))
  const widths = cols.map(([, h], i) =>
    Math.max(h.length, ...cells.map((c) => c[i]!.length))
  )
  const line = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(cols.map(([, h]) => h)), ...cells.map((c) => line(c))]
}

export function printFleetTable(
  rows: FleetRow[],
  degraded: string[],
  conflicts: string[],
  prErrors: string[] = [],
  walls: ProviderWall[] = [],
  wallsError?: string
): void {
  if (rows.length > 0) {
    for (const l of fleetTableLines(rows)) {
      console.log(l)
    }
  }
  for (const w of walls) {
    // spec bro-1x7p: a walled provider renders `walled — <cause>[ til
    //    <resetAt>]` — operational state like occupancy, never a warning
    console.log(wallText(w))
  }
  if (wallsError !== undefined) {
    console.error(`warning: provider walls unreadable — ${wallsError}`)
  }
  for (const d of degraded) {
    console.error(`warning: backend degraded — ${d}`)
  }
  for (const c of conflicts) {
    console.error(`warning: agent conflict — ${c}`)
  }
  for (const e of prErrors) {
    console.error(`warning: PR lookup failed — ${e}`)
  }
}

/** Agent cell — see the module doc for the state table. */
export function agentCell(
  step: ConvoyStep,
  agent: AgentInfo | undefined,
  assignee: string | undefined,
  degraded: boolean
): string {
  if (agent === undefined) {
    if (step.state === 'in_progress') {
      return degraded ? 'unknown' : `claimed — ${assignee ?? '?'}`
    }
    return '—'
  }
  const pid = agent.pid !== undefined ? ` (pid ${agent.pid})` : ''
  // a budget-walled agent is waiting on its provider's reset, not lost —
  // the respawn decision surface is for corpses, and this spawn would be
  // refused anyway (bro-7xgk.2)
  if (agent.state === 'blocked') {
    const reset = agent.resetAt !== undefined ? ` til ${agent.resetAt}` : ''
    return `blocked — ${agent.cause ?? '?'}${reset}`
  }
  // a clean exit while the step stays claimed is the same respawn
  // decision as a lost worker — the claim outlived its agent either way
  if ((agent.state === 'lost' || agent.state === 'exited') && step.state === 'in_progress') {
    return 'lost — respawn?'
  }
  return `${agent.state}${pid}`
}

/** One collect pass — the rows plus every warning plane. Shared by the
 *  one-shot table and the --live repaint loop. Exported: `liveFrame`'s
 *  signature names it. */
export interface FleetPayload {
  rows: FleetRow[]
  degraded: string[]
  conflicts: string[]
  prErrors: string[]
  /** Fleet slot accounting — the cap plus the registry-based,
   *  fail-closed occupancy admission enforces: an unverifiable or
   *  degraded backend's entries still occupy, so the number never
   *  under-reports what a spawn would count. */
  occupancy: FleetOccupancy
  /** The local-estimate budget picture (specs/bro-7xgk.3.md) — one
   *  registry walk, the same walk occupancy derives from. */
  budget: BudgetSnapshot
  /** Provider walls derived from the registry's classified deaths
   *  (spec bro-1x7p) — a walled provider renders here, never silently. */
  walls: ProviderWall[]
  /** the wall derivation itself threw (corrupt registry) — additive
   *  data failed, never the rows; renders as a warning */
  wallsError?: string
}

async function collectFleet(dir: string): Promise<FleetPayload> {
  const env = loadAgentEnv(dir)
  const { byStep, degraded, conflicts } = await collectAgents(dir, env)

  const worktrees = (() => {
    try {
      return parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
    } catch {
      return [] as WorktreeInfo[]
    }
  })()

  // PR resolution is best-effort — no review host (or a dead one) must
  // not break the table; the column just goes quiet.
  let rev: ReviewFacade | undefined
  let repo = ''
  try {
    rev = reviewHost(dir)
    repo = rev.resolveRepo([])
  } catch {
    rev = undefined
  }

  const prErrors: string[] = []
  const rows = fleetRows(byStep, degraded.length > 0, rev, repo, worktrees, prErrors)
  // one registry walk produces both planes — occupancy.occupied IS
  // budget.live, so the table line and the budget section can never
  // disagree about how much of the fleet is up
  const budget = budgetSnapshotFor(dir, env)
  // walls are additive data — a failed derivation (corrupt registry)
  // degrades this one datum, never the rows/budget already collected
  let walls: ProviderWall[] = []
  let wallsError: string | undefined
  try {
    walls = providerWallsFor(dir)
  } catch (err) {
    wallsError = err instanceof Error ? err.message : String(err)
  }
  return {
    rows,
    degraded,
    conflicts,
    prErrors,
    occupancy: { occupied: budget.live, maxConcurrent: budget.maxConcurrent },
    budget,
    walls,
    wallsError,
  }
}

export interface FleetArgs {
  json: boolean
  live: boolean
  everySec: number
}

export const LIVE_DEFAULT_SEC = 2
/** setTimeout clamps sub-ms delays to ~1ms — anything below this floor
 *  is a busy collect/repaint loop, not a cadence. */
export const LIVE_MIN_SEC = 0.1

/** Parsed fleet flags. `--every` implies `--live` — a repaint cadence
 *  only means something on the dashboard; `--live --json` is refused
 *  (a repaint loop can't emit one JSON document). Throws on bad input;
 *  `flag()` itself exits on a missing/duplicated `--every` value. */
export function fleetArgs(argv: string[]): FleetArgs {
  const everyRaw = flag(argv, '--every')
  const live = argv.includes('--live') || everyRaw !== undefined
  let everySec = LIVE_DEFAULT_SEC
  if (everyRaw !== undefined) {
    everySec = Number(everyRaw)
    // setTimeout clamps delays over 2^31-1 ms to ~1ms — a huge --every
    // would busy-repaint instead of waiting, so it fails closed here.
    if (!Number.isFinite(everySec) || everySec <= 0 || everySec * 1000 > 0x7fffffff) {
      throw new Error(
        `--every needs a positive seconds value up to ${0x7fffffff / 1000}s, got "${everyRaw}"`
      )
    }
    if (everySec < LIVE_MIN_SEC) {
      throw new Error(
        `--every needs at least ${LIVE_MIN_SEC}s between repaints, got "${everyRaw}"`
      )
    }
  }
  const json = argv.includes('--json')
  if (live && json) {
    throw new Error('--live is a TTY dashboard — it does not combine with --json')
  }
  return { json, live, everySec }
}

const ALT_SCREEN_ON = '\u001b[?1049h'
const ALT_SCREEN_OFF = '\u001b[?1049l'
const CURSOR_HIDE = '\u001b[?25l'
const CURSOR_SHOW = '\u001b[?25h'
/** Cursor home + repaint + clear-to-end: the frame is rewritten in
 *  place; a shorter frame never leaves stale rows behind. */
const REPAINT = '\u001b[H'
const CLEAR_REST = '\u001b[J'

/** The live frame as one string — header, the one-shot table, warnings
 *  in-frame (stderr would scroll under the repaint), footer. Pure so
 *  the test sees exactly what the TTY gets. */
export function liveFrame(payload: FleetPayload, ts: Date, everySec: number): string {
  const lines = [
    `bro fleet — live · ${ts.toISOString()} · every ${everySec}s`,
    occupancyLine(payload.occupancy),
    '',
    ...(payload.rows.length === 0
      ? ['no open molecules — nothing in the fleet']
      : fleetTableLines(payload.rows)),
    ...payload.walls.map((w) => wallText(w)),
  ]
  const warnings = [
    ...payload.degraded.map((d) => `warning: backend degraded — ${d}`),
    ...payload.conflicts.map((c) => `warning: agent conflict — ${c}`),
    ...payload.prErrors.map((e) => `warning: PR lookup failed — ${e}`),
    ...(payload.wallsError === undefined
      ? []
      : [`warning: provider walls unreadable — ${payload.wallsError}`]),
  ]
  if (warnings.length > 0) {
    lines.push('', ...warnings)
  }
  lines.push('', 'q quit')
  return lines.join('\n')
}

/** The repaint loop — alt screen + raw keys, chained setTimeout (never
 *  setInterval: a slow collect stretches the cadence instead of
 *  stacking), repaint on resize, restore on every exit path. */
async function runFleetLive(dir: string, everySec: number): Promise<void> {
  const out = process.stdout
  const input = process.stdin
  if (!out.isTTY || !input.isTTY) {
    console.error(
      'error: --live needs a TTY — for a non-interactive ticker use `bro watch --every N`'
    )
    process.exit(2)
  }

  let timer: NodeJS.Timeout | undefined
  let lastFrame = ''
  const paint = (frame: string): void => {
    lastFrame = frame
    out.write(REPAINT + frame + CLEAR_REST)
  }
  const repaint = (): void => {
    if (lastFrame !== '') {
      paint(lastFrame)
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let escTimer: NodeJS.Timeout | undefined
    // settle + teardown: drops every listener and restores the primary
    // screen. Returns false when already settled.
    const teardown = (): boolean => {
      if (settled) {
        return false
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (escTimer !== undefined) {
        clearTimeout(escTimer)
      }
      input.removeListener('data', onKey)
      out.removeListener('resize', repaint)
      // an unused `once` handler would still swallow a later real
      // signal as a no-op quit — drop them on every exit path
      process.removeListener('SIGINT', quit)
      process.removeListener('SIGTERM', quit)
      // restore the screen first — a destroyed stdin throws on
      // setRawMode (kill/session teardown) and must not skip it
      out.write(CURSOR_SHOW + ALT_SCREEN_OFF)
      try {
        input.setRawMode(false)
        input.pause()
      } catch {
        // stdin already closed/destroyed
      }
      return true
    }
    const quit = (): void => {
      if (teardown()) {
        resolve()
      }
    }
    const onKey = (buf: Buffer): void => {
      const k = buf.toString()
      if (k === '\x1b') {
        // a lone ESC may be the head of a split escape sequence (arrow,
        // Alt+key) — quit only when no continuation arrives shortly
        escTimer = setTimeout(quit, 50)
        return
      }
      if (escTimer !== undefined) {
        clearTimeout(escTimer)
        escTimer = undefined
      }
      // raw mode delivers Ctrl-C as \x03 (no SIGINT); an arrow key
      // arrives as a multi-byte \x1b[… sequence and is ignored, not
      // a quit
      if (k === 'q' || k === '\x03') {
        quit()
      }
    }
    try {
      out.write(ALT_SCREEN_ON + CURSOR_HIDE)
      input.setRawMode(true)
      input.resume()
      input.on('data', onKey)
      out.on('resize', repaint)
      // Ctrl-C is data under raw mode, but a stray SIGINT/SIGTERM (kill,
      // session teardown) must still restore the screen
      process.once('SIGINT', quit)
      process.once('SIGTERM', quit)
    } catch (err) {
      // a half-set-up terminal still gets restored before the
      // failure propagates
      teardown()
      reject(err)
      return
    }

    const tick = async (): Promise<void> => {
      // a quit that landed mid-collect already restored the primary
      // screen — painting now would corrupt it, so both paths check
      try {
        const frame = liveFrame(await collectFleet(dir), new Date(), everySec)
        if (!settled) {
          paint(frame)
        }
      } catch (err) {
        // a throwing collect (e.g. a mid-write beads read) degrades the
        // frame, never kills the dashboard — the next tick retries
        if (!settled) {
          paint(
            `bro fleet — live · ${new Date().toISOString()}\n\ncollection failed — ${err instanceof Error ? err.message : String(err)}\n\nq quit`
          )
        }
      }
      if (!settled) {
        timer = setTimeout(() => void tick(), everySec * 1000)
      }
    }
    void tick()
  })
}

export async function runFleetCommand(argv: string[]): Promise<void> {
  let args: FleetArgs
  try {
    args = fleetArgs(argv)
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  const dir = process.cwd()

  if (args.live) {
    await runFleetLive(dir, args.everySec)
    return
  }

  const { rows, degraded, conflicts, prErrors, occupancy, budget, walls, wallsError } =
    await collectFleet(dir)

  if (args.json) {
    console.log(
      JSON.stringify(
        { rows, degraded, conflicts, prErrors, occupancy, budget, walls, wallsError },
        null,
        2
      )
    )
    return
  }
  console.log(occupancyLine(occupancy))
  if (rows.length === 0 && walls.length === 0 && wallsError === undefined) {
    console.log('no open molecules — nothing in the fleet')
    return
  }
  printFleetTable(rows, degraded, conflicts, prErrors, walls, wallsError)
}

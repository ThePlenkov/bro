/**
 * `bro fleet` — the read-only one-shot fleet view: open molecules ×
 * steps × agents × worktrees × PRs. Spec: specs/sessions/bro-f4ot/spec.md.
 *
 *   bro fleet            table
 *   bro fleet --json     machine-readable rows + degraded backends
 *
 * State the table must surface honestly:
 *  - an agent dead while its step stays claimed → `lost — respawn?`
 *    (the respawn decision surface — `bro agents` owns it later);
 *  - a backend whose list() degraded → `unknown`, never `lost` —
 *    a failed read must not look like a dead fleet;
 *  - a claimed step with no agent → `claimed — <assignee>` (interactive
 *    sessions and foreign backends hold claims too).
 *
 *   --live TUI / site route are later milestones (bro-n54z, bro-1rir).
 */
import { basename } from 'node:path'
import { git, gitTry, reviewHost, type AgentInfo, type ReviewFacade } from '@broject/core'
import { listMolecules, loadMolecule, stepsOf, type ConvoyStep } from '@broject/convoy'
import { eachAgentConnector, loadAgentEnv } from '../agent-connectors.ts'
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
  worktree?: string
  pr?: string
  /** The PR's number — `pr` is the rendered link; watch feeds the number
   *  to the act gate instead of re-parsing the link. */
  prNum?: number
}

/** The fleet's agent plane — merged across every registered backend.
 *  A throwing connector — factory or list() — is degrade-equivalent:
 *  it contributes no agents and one `degraded` note, never a hard
 *  failure of the whole view. Two backends reporting the same step is a
 *  `conflict`: registry order decides (same precedence as connector
 *  resolution) and the loser is reported, not silently overwritten. */
export async function collectAgents(dir: string): Promise<{
  byStep: Map<string, AgentInfo>
  degraded: string[]
  conflicts: string[]
}> {
  const byStep = new Map<string, AgentInfo>()
  const degraded: string[] = []
  const conflicts: string[] = []
  const env = loadAgentEnv(dir)
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
function prNumForWorktree(
  rev: ReviewFacade,
  abs: string | undefined,
  errors?: string[]
): number | undefined {
  if (abs === undefined) {
    return undefined
  }
  const branch = branchOf(abs)
  if (branch === '') {
    return undefined
  }
  try {
    return rev.prsForBranch(branch)[0]
  } catch (err) {
    errors?.push(`${branch}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
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
      const prNum = rev === undefined ? undefined : prNumForWorktree(rev, wt, prErrors)
      rows.push({
        mol: m.id,
        step: s.id,
        title: s.title,
        kind: s.kind,
        state: s.state,
        agent: agentCell(s, agent, issue?.assignee, degradedAny),
        worktree: wt === undefined ? undefined : basename(wt),
        pr: rev === undefined || prNum === undefined ? undefined : rev.prLink(repo, prNum),
        prNum,
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
  prErrors: string[] = []
): void {
  for (const l of fleetTableLines(rows)) {
    console.log(l)
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
  // a clean exit while the step stays claimed is the same respawn
  // decision as a lost worker — the claim outlived its agent either way
  if ((agent.state === 'lost' || agent.state === 'exited') && step.state === 'in_progress') {
    return 'lost — respawn?'
  }
  return `${agent.state}${pid}`
}

export async function runFleetCommand(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const dir = process.cwd()

  const { byStep, degraded, conflicts } = await collectAgents(dir)

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

  if (json) {
    console.log(JSON.stringify({ rows, degraded, conflicts, prErrors }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('no open molecules — nothing in the fleet')
    return
  }
  printFleetTable(rows, degraded, conflicts, prErrors)
}

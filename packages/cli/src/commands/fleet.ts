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
import { parseWorktreePorcelain, type WorktreeInfo } from './work.ts'

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
}

/** The fleet's agent plane — merged across every registered backend.
 *  A throwing connector is degrade-equivalent: it contributes no agents
 *  and one `degraded` note, never a hard failure of the whole view. */
async function collectAgents(dir: string): Promise<{
  byStep: Map<string, AgentInfo>
  degraded: string[]
}> {
  const byStep = new Map<string, AgentInfo>()
  const degraded: string[] = []
  const env = loadAgentEnv(dir)
  for (const conn of eachAgentConnector({ dir }, env)) {
    try {
      const res = await conn.list()
      if (res.degraded) {
        degraded.push(`${conn.name}: ${res.degraded}`)
      }
      for (const a of res.agents) {
        byStep.set(a.molStep, a)
      }
    } catch (err) {
      degraded.push(`${conn.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { byStep, degraded }
}

/** The worktree column: the agent's recorded worktree wins; otherwise a
 *  `<repo>--<step>` sibling counts as that step's checkout. */
function worktreeOf(
  stepId: string,
  agent: AgentInfo | undefined,
  worktrees: WorktreeInfo[]
): string | undefined {
  if (agent?.worktree) {
    return basename(agent.worktree)
  }
  const hit = worktrees.find((w) => basename(w.path).endsWith(`--${stepId}`))
  return hit ? basename(hit.path) : undefined
}

/** `work/x` branch name for a worktree path — '' when unreadable. */
function branchOf(path: string): string {
  return gitTry(['-C', path, 'branch', '--show-current']).out.trim()
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
  if (agent.state === 'lost' && step.state === 'in_progress') {
    return 'lost — respawn?'
  }
  return `${agent.state}${pid}`
}

export async function runFleetCommand(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const dir = process.cwd()

  const { byStep, degraded } = await collectAgents(dir)
  const degradedAny = degraded.length > 0

  const worktrees = (() => {
    try {
      return parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
    } catch {
      return [] as WorktreeInfo[]
    }
  })()
  const fullPath = (name: string | undefined) =>
    name === undefined ? undefined : (worktrees.find((w) => basename(w.path) === name)?.path ?? name)

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

  const rows: FleetRow[] = []
  const mols = listMolecules()
  for (const m of mols) {
    const mol = loadMolecule(m.id)
    for (const s of stepsOf(mol)) {
      const agent = byStep.get(s.id)
      const issue = mol.issues.find((i) => i.id === s.id) as
        | { assignee?: string }
        | undefined
      const wt = worktreeOf(s.id, agent, worktrees)
      const abs = fullPath(wt)
      let pr: string | undefined
      if (rev && abs) {
        const branch = branchOf(abs)
        if (branch !== '') {
          try {
            const n = rev.prsForBranch(branch)[0]
            if (n !== undefined) {
              pr = rev.prLink(repo, n)
            }
          } catch {
            // one failed lookup must not blank the row
          }
        }
      }
      rows.push({
        mol: m.id,
        step: s.id,
        title: s.title,
        kind: s.kind,
        state: s.state,
        agent: agentCell(s, agent, issue?.assignee as string | undefined, degradedAny),
        worktree: wt,
        pr,
      })
    }
  }

  if (json) {
    console.log(JSON.stringify({ rows, degraded }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('no open molecules — nothing in the fleet')
    return
  }
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
  console.log(line(cols.map(([, h]) => h)))
  for (const c of cells) {
    console.log(line(c))
  }
  for (const d of degraded) {
    console.error(`warning: backend degraded — ${d}`)
  }
}

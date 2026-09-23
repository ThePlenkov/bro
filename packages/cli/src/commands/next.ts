/**
 * `bro next` — the flat backlog scheduler. bd owns the queue; bro owns
 * picking: top ready bead, claimed atomically, emitted as a work order.
 * The agent loop is one line: next → implement → PR → merge → repeat.
 *
 *   bro next            claim + emit the top ready bead
 *   bro next --list     the queue without claiming
 *   bro next --json     machine output
 *   bro run next.toml   the same selection driven by a validated plan
 *                       (filters, limit, ordering, gates — next-plan.ts)
 *
 * Human gates (title "HUMAN GATE"), epics, and molecule steps (parent
 * set — convoy owns those) are never auto-claimed; they surface as
 * gates/skipped so the agent knows what it's NOT doing. A plan may
 * opt gates into the queue via gates = "allow".
 */
import { bd, bdJson, checkBeads } from '@bro/core'
import type { NextFilters, NextOrder, NextPlan } from './next-plan.ts'

export interface ReadyBead {
  id: string
  title: string
  description?: string
  status: string
  priority: number
  issue_type: string
  created_at: string
  parent?: string
}

interface NextResult {
  state: 'task' | 'gated' | 'idle'
  /** first pick — the single-bead form argv callers expect */
  bead?: ReadyBead
  /** every pick, in order — plans can claim more than one */
  beads: ReadyBead[]
  queue: number
  /** claimable beads the plan's filters excluded — idle must not
   *  pretend the backlog is empty while these remain */
  filtered: number
  gates: Array<{ id: string; title: string }>
  epics: Array<{ id: string; title: string }>
  moleculeSteps: number
}

const HUMAN_GATE = /human.?gate/i

const claimable = (b: ReadyBead, gates: NextPlan['gates']): boolean =>
  (gates === 'allow' || !HUMAN_GATE.test(b.title)) &&
  b.issue_type !== 'epic' &&
  !b.parent

/** Plan filters narrow the claimable queue — they can never re-include
 *  what classify excludes (epics, molecule steps, forbidden gates). */
function applyFilters(queue: ReadyBead[], f: NextFilters): ReadyBead[] {
  let q = queue
  if (f.types?.length) {
    q = q.filter((b) => f.types!.includes(b.issue_type))
  }
  if (f.maxPriority !== undefined) {
    q = q.filter((b) => b.priority <= f.maxPriority!)
  }
  if (f.match) {
    q = q.filter((b) => f.match!.test(b.title))
  }
  return q
}

const ORDERERS: Record<NextOrder, (a: ReadyBead, b: ReadyBead) => number> = {
  priority: (a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at),
  oldest: (a, b) => a.created_at.localeCompare(b.created_at),
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
}

/** The argv `bro next` selection — plan defaults. */
const DEFAULT_SELECTION = {
  filters: {},
  gates: 'forbid',
  order: 'priority',
} as const satisfies Pick<NextPlan, 'filters' | 'gates' | 'order'>

/** Split the ready queue into claimable work and things we never claim. */
export function classify(
  ready: ReadyBead[],
  plan: Pick<NextPlan, 'filters' | 'gates' | 'order'> = DEFAULT_SELECTION
) {
  const claimableAll = ready.filter((b) => claimable(b, plan.gates))
  const queue = applyFilters(claimableAll, plan.filters)
  queue.sort(ORDERERS[plan.order])
  return {
    queue,
    filtered: claimableAll.length - queue.length,
    gates: ready.filter((b) => HUMAN_GATE.test(b.title)),
    epics: ready.filter((b) => b.issue_type === 'epic'),
    moleculeSteps: ready.filter((b) => b.parent).length,
  }
}

/** A failed claim is a race only when the bead actually moved on
 *  (claimed/closed elsewhere); a bd outage must surface, not silently
 *  drain the queue into a fake idle. */
function racedAway(b: ReadyBead): boolean {
  try {
    const cur = bdJson<Array<{ status?: string }>>(['show', b.id])
    const status = cur[0]?.status
    return typeof status === 'string' && status !== 'open'
  } catch {
    return false // show failed too — bd is down; the claim error is the diagnostic
  }
}

/** Claim up to `limit` beads — concurrent `bro next` runs race on the
 *  same items; a raced-away claim falls through to the next candidate. */
export function claimUpTo(queue: ReadyBead[], limit: number): ReadyBead[] {
  const picked: ReadyBead[] = []
  for (const b of queue) {
    if (picked.length >= limit) {
      break
    }
    try {
      bd(['update', b.id, '--claim'])
      picked.push(b)
    } catch (err) {
      if (racedAway(b)) {
        continue // genuinely raced away — try the next candidate
      }
      throw err
    }
  }
  return picked
}

function printResult(result: NextResult, list: boolean): void {
  for (const b of result.beads) {
    console.log(`→ ${b.id}${list ? '' : ' (claimed)'} P${b.priority} ${b.issue_type}`)
    console.log(`  ${b.title}`)
    if (b.description?.trim()) {
      console.log(`  ${b.description.trim().split('\n')[0]}`)
    }
    console.log('  loop: implement → PR → bro act merge → bd close → bro next')
  }
  if (result.beads.length === 0) {
    if (result.state === 'gated') {
      console.log('next: nothing claimable — filters, gates, epics, or molecule steps remain')
    } else {
      console.log('next: backlog empty — nothing ready')
    }
  }
  if (result.filtered > 0) {
    console.log(`  filtered: ${result.filtered} claimable bead(s) excluded by plan filters`)
  }
  for (const g of result.gates) {
    console.log(`  gate: ${g.id} — ${g.title} (human decision needed)`)
  }
  for (const e of result.epics) {
    console.log(`  epic: ${e.id} — ${e.title} (decompose, don't claim)`)
  }
  if (result.moleculeSteps > 0) {
    console.log(`  convoy: ${result.moleculeSteps} molecule step(s) — owned by bro convoy`)
  }
}

/** The shared execution path — argv `bro next` and `bro run next.toml`
 *  differ only in how the plan is populated. */
export function applyNextPlan(plan: NextPlan): void {
  checkBeads()
  let ready: ReadyBead[]
  try {
    ready = bdJson<ReadyBead[]>(['ready', '--json'])
  } catch (err) {
    console.error(`error: bd ready failed — ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const c = classify(ready, plan)
  const beads = plan.claim ? claimUpTo(c.queue, plan.limit) : c.queue.slice(0, plan.limit)
  const picked = new Set(beads.map((b) => b.id))
  let state: NextResult['state'] = 'idle'
  if (beads.length > 0) {
    state = 'task'
  } else if (c.filtered + c.gates.length + c.epics.length + c.moleculeSteps > 0) {
    // ready beads remain but none are claimable under this plan —
    // 'idle' would falsely tell the loop the backlog is empty
    state = 'gated'
  }
  const result: NextResult = {
    state,
    bead: beads.length > 0 ? beads[0] : undefined,
    beads,
    queue: c.queue.length,
    filtered: c.filtered,
    // a claimed gate is already reported as a pick — don't double-count it
    gates: c.gates.filter((b) => !picked.has(b.id)).map((b) => ({ id: b.id, title: b.title })),
    epics: c.epics.map((b) => ({ id: b.id, title: b.title })),
    moleculeSteps: c.moleculeSteps,
  }

  if (plan.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  printResult(result, !plan.claim)
}

export async function runNextCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(`Usage: bro next [--list] [--json]

  Claims the top ready bead and prints the work order. Human gates,
  epics, and molecule steps are surfaced, never claimed. Filters,
  limit, ordering, and gate policy are plan-only — see
  \`bro run next.toml\` (kind = "next").

  state: task  — a bead was emitted (claimed unless --list)
         gated — nothing claimable; gates/epics/mol steps remain
         idle  — backlog empty`)
    process.exit(0)
  }
  applyNextPlan({
    limit: 1,
    order: 'priority',
    claim: !argv.includes('--list'),
    gates: 'forbid',
    json: argv.includes('--json'),
    filters: {},
  })
}

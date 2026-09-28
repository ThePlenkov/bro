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
 * set AND parent not an epic — bd reuses `parent` for epic children,
 * which are regular claimable work) are never auto-claimed; they
 * surface as gates/skipped so the agent knows what it's NOT doing. A
 * plan may opt gates into the queue via gates = "allow".
 *
 * Project scoping: a shared/federated bd can serve several repos, so
 * `ready` is filtered bd-side (--exclude-label) against coordination
 * primitives (gt:slot merge-queue semaphores and friends), then the
 * queue is scoped to this checkout's issue_prefix — foreign-prefix
 * beads are reported, never claimed. scope = "all" opts out in plans.
 */
import { bd, bdJson, bdTry, checkBeads } from '@bro/core'
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
  /** ready beads under another issue_prefix — a shared db serves
   *  several repos; they are reported, never claimed here */
  foreign: number
  gates: Array<{ id: string; title: string }>
  epics: Array<{ id: string; title: string }>
  moleculeSteps: number
}

const HUMAN_GATE = /human.?gate/i

/** Labels that mark coordination primitives, not work — excluded bd-side
 *  so a shared queue's semaphores can never look claimable. Gas Town's
 *  merge-slot bead (<prefix>-merge-slot) is the known instance. */
export const NEVER_CLAIM_LABELS = ['gt:slot']

/** The single `bd ready` contract for next and loop: coordination
 *  primitives are filtered out by bd itself, before classification. */
export function readyBeads(): ReadyBead[] {
  return bdJson<ReadyBead[]>([
    'ready',
    ...NEVER_CLAIM_LABELS.flatMap((l) => ['--exclude-label', l]),
  ])
}

/** This checkout's bead id scope — what `bd init` recorded as
 *  issue_prefix. An explicitly unset prefix means the db cannot tell
 *  scopes apart — fail open rather than hide real work. A FAILED
 *  lookup is the opposite: on a shared db it would silently reopen
 *  cross-repo claiming, so it throws (fail closed). */
export function projectPrefix(): string | undefined {
  const res = bdTry(['config', 'get', 'issue_prefix'])
  if (res.code !== 0) {
    throw new Error(
      `bd config get issue_prefix failed — ${res.err || 'bd error'} ` +
        '(refusing to schedule without a verified project scope)'
    )
  }
  const line = res.out.trim().split('\n').pop()?.trim() ?? ''
  if (line === '' || /not set/i.test(line)) {
    return undefined
  }
  const eq = line.indexOf('=')
  const v = (eq >= 0 ? line.slice(eq + 1) : line).trim().replace(/^['"]|['"]$/g, '')
  return v === '' ? undefined : v
}

/** Resolve a plan's scope policy to the scope classify applies:
 *  `all` opts out entirely; `project` filters to issue_prefix. */
export function nextScope(scope: NextPlan['scope']): { prefix?: string } {
  return { prefix: scope === 'all' ? undefined : projectPrefix() }
}

/** bd reuses `parent` for both molecule steps and epic children — only
 *  a parent that IS an epic makes the child regular work. Looked up
 *  once per unique parent id; an unreadable parent stays a mol step. */
export function epicParentIds(ready: ReadyBead[]): Set<string> {
  const ids = [
    ...new Set(ready.map((b) => b.parent).filter((p): p is string => !!p)),
  ]
  const epic = new Set<string>()
  for (const id of ids) {
    try {
      const [row] = bdJson<Array<{ issue_type?: string }>>(['show', id])
      if (row?.issue_type === 'epic') {
        epic.add(id)
      }
    } catch { /* a parent we can't inspect stays a molecule step */ }
  }
  return epic
}

const claimable = (
  b: ReadyBead,
  gates: NextPlan['gates'],
  epicParents: ReadonlySet<string>
): boolean =>
  (gates === 'allow' || !HUMAN_GATE.test(b.title)) &&
  b.issue_type !== 'epic' &&
  (!b.parent || epicParents.has(b.parent))

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

/** Split the ready queue into claimable work and things we never claim.
 *  scope.prefix restricts claimable AND reporting to this project's
 *  beads — foreign-prefix beads only appear in the `foreign` count. */
export function classify(
  ready: ReadyBead[],
  plan: Pick<NextPlan, 'filters' | 'gates' | 'order'> = DEFAULT_SELECTION,
  scope: { prefix?: string } = {},
  epicParents: ReadonlySet<string> = new Set()
) {
  const local =
    scope.prefix === undefined
      ? ready
      : ready.filter((b) => b.id.startsWith(`${scope.prefix}-`))
  const claimableAll = local.filter((b) => claimable(b, plan.gates, epicParents))
  const queue = applyFilters(claimableAll, plan.filters)
  queue.sort(ORDERERS[plan.order])
  return {
    queue,
    filtered: claimableAll.length - queue.length,
    foreign: ready.length - local.length,
    gates: local.filter((b) => HUMAN_GATE.test(b.title)),
    epics: local.filter((b) => b.issue_type === 'epic'),
    moleculeSteps: local.filter((b) => b.parent && !epicParents.has(b.parent)).length,
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
  if (result.foreign > 0) {
    console.log(
      `  foreign: ${result.foreign} bead(s) outside this project's issue_prefix — not claimable here`
    )
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
    ready = readyBeads()
  } catch (err) {
    console.error(`error: bd ready failed — ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  let c: ReturnType<typeof classify>
  try {
    c = classify(ready, plan, nextScope(plan.scope), epicParentIds(ready))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const beads = plan.claim ? claimUpTo(c.queue, plan.limit) : c.queue.slice(0, plan.limit)
  const picked = new Set(beads.map((b) => b.id))
  let state: NextResult['state'] = 'idle'
  if (beads.length > 0) {
    state = 'task'
  } else if (c.filtered + c.foreign + c.gates.length + c.epics.length + c.moleculeSteps > 0) {
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
    foreign: c.foreign,
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
         gated — nothing claimable; gates/epics/mol steps/foreign remain
         idle  — backlog empty

  Scope: only beads under this checkout's issue_prefix are claimable;
  gt:slot coordination primitives are never surfaced. Plans may set
  scope = "all" to opt out.`)
    process.exit(0)
  }
  applyNextPlan({
    limit: 1,
    order: 'priority',
    claim: !argv.includes('--list'),
    gates: 'forbid',
    json: argv.includes('--json'),
    scope: 'project',
    filters: {},
  })
}

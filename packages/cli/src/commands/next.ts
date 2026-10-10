/**
 * `bro next` — the flat backlog scheduler. bd owns the queue; bro owns
 * picking: top ready bead, claimed atomically, emitted as a work order.
 * The agent loop is one line: next → implement → PR → merge → repeat.
 *
 *   bro next            claim + emit the top ready bead
 *   bro next --list     the queue without claiming
 *   bro next --json     machine output
 *   bro next --global   the user-level store (`bro store init --global`) — same
 *                       pipeline run with cwd = the global beads dir
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
import { emitLifecycle, ensureTasksBackend, facade, gitTry, type FacadeOpts, type TaskStore } from '@broject/core'
import { flag } from './args.ts'
import type { NextFilters, NextOrder, NextPlan } from './next-plan.ts'
import { requireGlobalStore } from '../doctypes/store.ts'
import { loadBroConfig } from '../plugins.ts'

/** The serving tasks backend for `dir` — `connectors.tasks` in
 *  bro.config selects it (beads by default, github when pinned). The
 *  config lookup anchors at the git root so a run from a subdirectory
 *  resolves the same backend; the global store is beads-only by
 *  construction — its dir carries no bro.config, so resolution falls
 *  to the registry default anyway. */
function storeFor(dir?: string, opts?: FacadeOpts): TaskStore {
  const root =
    dir ?? (gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd())
  return facade('tasks', { dir: root }, opts ?? { prefer: loadBroConfig(root).connectors })
}

export interface ReadyBead {
  id: string
  title: string
  description?: string
  status: string
  priority: number
  issue_type: string
  created_at: string
  parent?: string
  /** bd labels — present on `bd ready --json` rows; the labels scope
   *  filter in plans/argv only claims beads carrying a declared label. */
  labels?: string[]
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
 *  primitives are filtered out by bd itself, before classification.
 *  `dir` retargets the query at another store — `bro next --global`. */
export function readyBeads(dir?: string, opts?: FacadeOpts): ReadyBead[] {
  return storeFor(dir, opts).ready<ReadyBead>({ excludeLabels: NEVER_CLAIM_LABELS })
}

/** This checkout's bead id scope — what `bd init` recorded as
 *  issue_prefix. An explicitly unset prefix means the db cannot tell
 *  scopes apart — fail open rather than hide real work. A FAILED
 *  lookup is the opposite: on a shared db it would silently reopen
 *  cross-repo claiming, so it throws (fail closed). */
export function projectPrefix(dir?: string, opts?: FacadeOpts): string | undefined {
  try {
    return storeFor(dir, opts).prefix()
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} ` +
        '(refusing to schedule without a verified project scope)'
    )
  }
}

/** Resolve a plan's scope policy to the scope classify applies:
 *  `all` opts out entirely; `project`/`global` filter to the queried
 *  store's issue_prefix (the global store has its own). */
export function nextScope(
  scope: NextPlan['scope'],
  dir?: string,
  opts?: FacadeOpts
): { prefix?: string } {
  return { prefix: scope === 'all' ? undefined : projectPrefix(dir, opts) }
}

/** A parent's issue_type rarely changes mid-process — `bro loop`
 *  re-classifies every iteration, so each unique parent resolves once
 *  per process instead of spawning `bd show` per iteration. Only
 *  positives are cached: a parent promoted to epic mid-loop must start
 *  un-gating its children on the next iteration, not stay mol-stepped
 *  for the process lifetime. */
const parentEpicCache = new Map<string, boolean>()

/** bd reuses `parent` for both molecule steps and epic children — only
 *  a parent that IS an epic makes the child regular work. Looked up
 *  once per unique parent id; an unreadable parent stays a mol step. */
export function epicParentIds(ready: ReadyBead[], dir?: string, opts?: FacadeOpts): Set<string> {
  const ids = [
    ...new Set(ready.map((b) => b.parent).filter((p): p is string => !!p)),
  ]
  const epic = new Set<string>()
  for (const id of ids) {
    // cwd namespaces callers that share the same dir arg — without it a
    // project caller inherits another project's classification
    const key = `${process.cwd()}:${dir ?? ''}:${id}`
    const cached = parentEpicCache.get(key)
    if (cached === true) {
      epic.add(id)
      continue
    }
    try {
      if (storeFor(dir, opts).get(id)?.issue_type === 'epic') {
        parentEpicCache.set(key, true)
        epic.add(id)
      }
    } catch { /* a parent we can't inspect stays a molecule step — never cached */ }
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
  if (f.labels?.length) {
    // declared scope: any-of — the bead must carry at least one of the
    // labels the run was pointed at; unlabeled beads are out of scope
    q = q.filter((b) => b.labels?.some((l) => f.labels!.includes(l)))
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
function racedAway(b: ReadyBead, dir?: string, opts?: FacadeOpts): boolean {
  try {
    const status = storeFor(dir, opts).get(b.id)?.status
    return typeof status === 'string' && status !== 'open'
  } catch {
    return false // show failed too — bd is down; the claim error is the diagnostic
  }
}

/** Claim up to `limit` beads — concurrent `bro next` runs race on the
 *  same items; a raced-away claim falls through to the next candidate. */
export function claimUpTo(
  queue: ReadyBead[],
  limit: number,
  dir?: string,
  opts?: FacadeOpts
): ReadyBead[] {
  const picked: ReadyBead[] = []
  for (const b of queue) {
    if (picked.length >= limit) {
      break
    }
    try {
      storeFor(dir, opts).claim(b.id)
      // lifecycle — the claim transition (specs/telemetry/bro-ub91h.md).
      // The journal anchors at the run's repo (cwd), not the store dir:
      // --global's repo-less store would drop the row even inside a
      // project; a run outside any repo still journals nowhere
      emitLifecycle(process.cwd(), {
        kind: 'claim',
        bead: b.id,
        from: 'open',
        to: 'in_progress',
        detail: { via: 'next' },
      })
      picked.push(b)
    } catch (err) {
      if (racedAway(b, dir, opts)) {
        continue // genuinely raced away — try the next candidate
      }
      throw err
    }
  }
  return picked
}

function printPick(b: ReadyBead, list: boolean, backend: string): void {
  console.log(`→ ${b.id}${list ? '' : ' (claimed)'} P${b.priority} ${b.issue_type}`)
  console.log(`  ${b.title}`)
  if (b.description?.trim()) {
    console.log(`  ${b.description.trim().split('\n')[0]}`)
  }
  const closeVerb = backend === 'beads' ? 'bd close' : 'bro task close'
  console.log(`  loop: implement → PR → bro act merge → ${closeVerb} → bro next`)
}

function printResult(result: NextResult, list: boolean, backend: string): void {
  for (const b of result.beads) {
    printPick(b, list, backend)
  }
  if (result.beads.length === 0) {
    console.log(
      result.state === 'gated'
        ? 'next: nothing claimable — filters, gates, epics, or molecule steps remain'
        : 'next: backlog empty — nothing ready'
    )
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

/** readyBeads with a diagnostic — a missing backend CLI is an install
 *  problem, not a queue failure, and the global path must report it
 *  the same way the backend gate does for the project path. */
function readyOrDie(dir?: string, opts?: FacadeOpts): ReadyBead[] {
  try {
    return readyBeads(dir, opts)
  } catch (err) {
    const enoent = err != null && (err as NodeJS.ErrnoException).code === 'ENOENT'
    const detail = err instanceof Error ? err.message : String(err)
    console.error(
      enoent
        ? "error: task backend's CLI not found — install it or point connectors.tasks elsewhere"
        : `error: task store ready failed — ${detail}`
    )
    process.exit(1)
  }
}

/** The shared execution path — argv `bro next` and `bro run next.toml`
 *  differ only in how the plan is populated. */
export function applyNextPlan(plan: NextPlan): void {
  // scope = "global" retargets every bd call at the user-level store —
  // the pipeline is identical, only the queue's home dir differs, and
  // the project store is not required at all (global works repo-less)
  const dir = plan.scope === 'global' ? requireGlobalStore() : undefined
  // the global store is beads by construction — gate AND reads/claims
  // must pin it, or a merged `connectors.tasks` preference could point
  // the global queue at a project backend the gate never checked
  const storeOpts: FacadeOpts | undefined = dir === undefined ? undefined : { connector: 'beads' }
  let backend: string
  if (dir === undefined) {
    // gate on the serving backend — beads gets the compat probe, a
    // pinned connector gets its own auth check
    const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd()
    backend = ensureTasksBackend(root, loadBroConfig(root).connectors)
  } else {
    // the global store is beads by construction
    backend = ensureTasksBackend(dir, {})
  }
  const ready = readyOrDie(dir, storeOpts)
  let c: ReturnType<typeof classify>
  try {
    c = classify(ready, plan, nextScope(plan.scope, dir, storeOpts), epicParentIds(ready, dir, storeOpts))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const beads = plan.claim ? claimUpTo(c.queue, plan.limit, dir, storeOpts) : c.queue.slice(0, plan.limit)
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
  printResult(result, !plan.claim, backend)
}

export async function runNextCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(`Usage: bro next [--list] [--json] [--global] [--label a,b]

  Claims the top ready bead and prints the work order. Human gates,
  epics, and molecule steps are surfaced, never claimed. --label
  declares the run's scope — only beads carrying one of those labels
  are claimable (unlabeled work is out of scope). Other filters,
  limit, ordering, and gate policy are plan-only — see
  \`bro run next.toml\` (kind = "next").

  state: task  — a bead was emitted (claimed unless --list)
         gated — nothing claimable; gates/epics/mol steps/foreign remain
         idle  — backlog empty

  Scope: only beads under this checkout's issue_prefix are claimable;
  gt:slot coordination primitives are never surfaced. Plans may set
  scope = "all" to opt out. --global reads the user-level store
  instead (\`bro store init --global\`) — same pipeline, different home.`)
    process.exit(0)
  }
  // flag() owns both spellings (--label v / --label=v) and rejects repeats —
  // gating on argv.includes('--label') would miss the = form entirely
  const labelArg = flag(argv, '--label')
  const labels = labelArg?.split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (labelArg !== undefined && (labels === undefined || labels.length === 0)) {
    console.error('error: --label requires a comma-separated value, e.g. --label debt,ui')
    process.exit(2)
  }
  applyNextPlan({
    limit: 1,
    order: 'priority',
    claim: !argv.includes('--list'),
    gates: 'forbid',
    json: argv.includes('--json'),
    scope: argv.includes('--global') ? 'global' : 'project',
    filters: labels !== undefined ? { labels } : {},
  })
}

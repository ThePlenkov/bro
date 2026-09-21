/**
 * `bro next` — the flat backlog scheduler. bd owns the queue; bro owns
 * picking: top ready bead, claimed atomically, emitted as a work order.
 * The agent loop is one line: next → implement → PR → merge → repeat.
 *
 *   bro next            claim + emit the top ready bead
 *   bro next --list     the queue without claiming
 *   bro next --json     machine output
 *
 * Human gates (title "HUMAN GATE"), epics, and molecule steps (parent
 * set — convoy owns those) are never auto-claimed; they surface as
 * gates/skipped so the agent knows what it's NOT doing.
 */
import { bd, bdJson, checkBeads } from '@bro/core'

interface ReadyBead {
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
  bead?: ReadyBead
  queue: number
  gates: Array<{ id: string; title: string }>
  epics: Array<{ id: string; title: string }>
  moleculeSteps: number
}

const HUMAN_GATE = /human.?gate/i

const claimable = (b: ReadyBead): boolean =>
  !HUMAN_GATE.test(b.title) && b.issue_type !== 'epic' && !b.parent

/** Split the ready queue into claimable work and things we never claim. */
function classify(ready: ReadyBead[]) {
  const queue = ready.filter(claimable)
  queue.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at))
  return {
    queue,
    gates: ready.filter((b) => HUMAN_GATE.test(b.title)),
    epics: ready.filter((b) => b.issue_type === 'epic'),
    moleculeSteps: ready.filter((b) => b.parent).length,
  }
}

/** Claim the first still-free bead — concurrent `bro next` runs race on
 *  the same top item; the loser takes the next candidate, not an exit. */
function claimFirst(queue: ReadyBead[]): ReadyBead | undefined {
  for (const b of queue) {
    try {
      bd(['update', b.id, '--claim'])
      return b
    } catch {
      // raced away — try the next candidate
    }
  }
  return undefined
}

function printResult(result: NextResult, list: boolean): void {
  if (result.bead) {
    const b = result.bead
    console.log(`→ ${b.id}${list ? '' : ' (claimed)'} P${b.priority} ${b.issue_type}`)
    console.log(`  ${b.title}`)
    if (b.description?.trim()) {
      console.log(`  ${b.description.trim().split('\n')[0]}`)
    }
    console.log('  loop: implement → PR → bro act merge → bd close → bro next')
  } else if (result.state === 'gated') {
    console.log('next: nothing claimable — gates, epics, or molecule steps remain')
  } else {
    console.log('next: backlog empty — nothing ready')
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

export async function runNextCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(`Usage: bro next [--list] [--json]

  Claims the top ready bead and prints the work order. Human gates,
  epics, and molecule steps are surfaced, never claimed.

  state: task  — a bead was emitted (claimed unless --list)
         gated — nothing claimable; gates/epics/mol steps remain
         idle  — backlog empty`)
    process.exit(0)
  }
  checkBeads()
  let ready: ReadyBead[]
  try {
    ready = bdJson<ReadyBead[]>(['ready', '--json'])
  } catch (err) {
    console.error(`error: bd ready failed — ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const list = argv.includes('--list')
  const c = classify(ready)
  const bead = list ? c.queue[0] : claimFirst(c.queue)
  const result: NextResult = {
    state: bead ? 'task' : c.gates.length + c.epics.length + c.moleculeSteps > 0 ? 'gated' : 'idle',
    bead,
    queue: c.queue.length,
    gates: c.gates.map((b) => ({ id: b.id, title: b.title })),
    epics: c.epics.map((b) => ({ id: b.id, title: b.title })),
    moleculeSteps: c.moleculeSteps,
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  printResult(result, list)
}

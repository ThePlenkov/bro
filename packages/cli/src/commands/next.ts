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
  state: 'task' | 'idle'
  bead?: ReadyBead
  queue: number
  gates: Array<{ id: string; title: string }>
  epics: Array<{ id: string; title: string }>
}

const HUMAN_GATE = /human.?gate/i

function pick(ready: ReadyBead[]): NextResult {
  const gates = ready.filter((b) => HUMAN_GATE.test(b.title))
  const epics = ready.filter((b) => b.issue_type === 'epic')
  const queue = ready.filter(
    (b) => !HUMAN_GATE.test(b.title) && b.issue_type !== 'epic' && !b.parent
  )
  queue.sort(
    (a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at)
  )
  return {
    state: queue.length > 0 ? 'task' : 'idle',
    bead: queue[0],
    queue: queue.length,
    gates: gates.map((b) => ({ id: b.id, title: b.title })),
    epics: epics.map((b) => ({ id: b.id, title: b.title })),
  }
}

export async function runNextCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(`Usage: bro next [--list] [--json]

  Claims the top ready bead and prints the work order. Human gates,
  epics, and molecule steps are surfaced, never claimed.`)
    process.exit(0)
  }
  checkBeads()
  const ready = bdJson<ReadyBead[]>(['ready', '--json'])
  const result = pick(ready)
  const json = argv.includes('--json')

  if (!argv.includes('--list') && result.bead) {
    // atomic claim — do this before the agent starts work
    bd(['update', result.bead.id, '--claim'])
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.state === 'idle') {
    console.log('next: backlog empty — nothing ready')
  } else {
    const b = result.bead!
    const claimed = argv.includes('--list') ? '' : ' (claimed)'
    console.log(`→ ${b.id}${claimed} P${b.priority} ${b.issue_type}`)
    console.log(`  ${b.title}`)
    if (b.description?.trim()) {
      console.log(`  ${b.description.trim().split('\n')[0]}`)
    }
    console.log('  loop: implement → PR → bro act merge → bd close → bro next')
  }
  for (const g of result.gates) {
    console.log(`  gate: ${g.id} — ${g.title} (human decision needed)`)
  }
  for (const e of result.epics) {
    console.log(`  epic: ${e.id} — ${e.title} (decompose, don't claim)`)
  }
}

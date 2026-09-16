/**
 * `bro drill <sub>` — scoped descent over beads. Frames are issues labeled
 * `drill`; bd owns storage, bro owns the invariants (mandatory result +
 * prevention memo on the way up).
 *
 *   down <title> [--under ID] [--ephemeral]   descend into a narrower frame
 *   up --result T [--prevent T]… [--evidence R]…   ascend, hand result to parent
 *   current                                   active leaf frame
 *   tree                                      all drill trees
 *   list                                      open frames
 *   distill ID                                bd mol distill: tree → proto
 */
import {
  checkBeads,
  currentFrame,
  drillDown,
  drillTree,
  drillUp,
  listDrills,
  bd,
} from '@bro/drill'

function usage(): never {
  console.error(`Usage: bro drill <command> [args…]

Commands:
  down <title> [--under ID] [--ephemeral]        New child frame under current leaf (or root)
  up --result T [--prevent T]… [--evidence R]…   Close current frame, memo goes to beads
  current                                        Show the active leaf frame
  tree                                           Render all drill hierarchies
  list                                           Open drill frames
  distill ID                                     Extract a reusable proto from a drill epic

  bro unwind …                                   alias for \`bro drill up\``)
  process.exit(1)
}

/** A value flag's argument must exist and not look like another option. */
function flagValue(argv: string[], i: number, name: string): string {
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    console.error(`error: ${name} requires a value`)
    process.exit(2)
  }
  return v
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? flagValue(argv, i, name) : undefined
}

function flagAll(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      out.push(flagValue(argv, i, name))
      i += 1
    }
  }
  return out
}

function positionals(argv: string[]): string[] {
  const valueFlags = new Set([
    '--under',
    '--result',
    '--prevent',
    '--evidence',
    '--type',
    '--priority',
    '--description',
    '--id',
  ])
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg)) {
        i += 1
      }
      continue
    }
    out.push(arg)
  }
  return out
}

export async function runDrillCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') {
    usage()
  }
  checkBeads()

  switch (sub) {
    case 'down': {
      const title = positionals(rest).join(' ')
      if (!title) {
        console.error('error: drill down requires a title')
        process.exit(2)
      }
      const priorityRaw = flag(rest, '--priority')
      const priority = priorityRaw !== undefined ? Number(priorityRaw) : undefined
      if (priority !== undefined && !Number.isInteger(priority)) {
        console.error(`error: --priority must be an integer, got "${priorityRaw}"`)
        process.exit(2)
      }
      const row = drillDown(title, {
        under: flag(rest, '--under'),
        ephemeral: rest.includes('--ephemeral'),
        type: flag(rest, '--type'),
        priority,
        description: flag(rest, '--description'),
      })
      console.log(`drill ↓ ${row.id} ${row.title}`)
      return
    }
    case 'up': {
      const result = flag(rest, '--result')
      if (!result) {
        console.error('error: drill up requires --result — a frame must return a curated finding')
        process.exit(2)
      }
      const res = drillUp({
        id: flag(rest, '--id'),
        result,
        prevent: flagAll(rest, '--prevent'),
        evidence: flagAll(rest, '--evidence'),
      })
      console.log(`drill ↑ ${res.closed} closed`)
      for (const id of res.preventionIds) {
        console.log(`  prevention → ${id}`)
      }
      return
    }
    case 'current': {
      const frame = currentFrame()
      if (!frame) {
        console.log('no open drill frame')
        process.exitCode = 1
        return
      }
      console.log(
        `${frame.id} ${frame.title} [depth=${frame.depth}${frame.parentId ? ` parent=${frame.parentId}` : ''}]`
      )
      return
    }
    case 'tree': {
      console.log(drillTree())
      return
    }
    case 'list': {
      const rows = listDrills().filter((r) => r.status !== 'closed' && r.status !== 'done')
      if (rows.length === 0) {
        console.log('no open drill frames')
        return
      }
      for (const row of rows) {
        console.log(`${row.id}\t${row.status}\t${row.title}`)
      }
      return
    }
    case 'distill': {
      const id = positionals(rest)[0]
      if (!id) {
        console.error('error: drill distill requires an epic/bead id')
        process.exit(2)
      }
      process.stdout.write(bd(['mol', 'distill', id]))
      return
    }
    default:
      usage()
  }
}

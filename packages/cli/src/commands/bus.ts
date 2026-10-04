/**
 * `bro bus <verb>` — the local event broker's command surface.
 *
 * Verbs: `serve` (run the broker), `publish` (one event, connect-write-
 * exit), `subscribe` (stream matching events), `status` (liveness and
 * counters). The broker itself lives in `@broject/core` so the protocol
 * has one owner and is testable without a repository; this module is
 * argv parsing and the daemon lifecycle.
 *
 * Exit codes are a contract: 2 for a usage error, 1 for a real runtime
 * failure. `status` deliberately exits 0 when the broker is down — a
 * repo where nobody started one is a normal state, not a fault, and
 * `status` is meant to be safe to call from a hook or a doctor walk.
 */
import {
  busPublish,
  busSocketPath,
  busStatus,
  busSubscribe,
  startBusBroker,
  type BusEnvelope,
  type BusFilter,
} from '@broject/core'
import { flag, flagAll, positionals } from './args.ts'

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--topic',
  '--kind',
  '--key',
  '--source',
  '--cause',
  '--ref',
  '--since',
  '--payload',
])

/** Options each verb accepts — a `--name=value` spelling counts as the
 *  same option (flag() honors it; flagAll's gap is bro-mzb9 debt). */
const KNOWN_FLAGS: Record<string, ReadonlySet<string>> = {
  serve: new Set(['--json']),
  publish: new Set(['--topic', '--kind', '--key', '--source', '--cause', '--ref', '--payload', '--json']),
  subscribe: new Set(['--topic', '--kind', '--since', '--json']),
  status: new Set(['--json']),
}

// a function declaration, not a const arrow — tsc only treats calls to
// never-returning function declarations as terminating the control flow,
// so the call sites below narrow correctly
function usage(): never {
  console.error(`usage: bro bus <serve|publish|subscribe|status> [options]

  serve                       run the broker (SIGINT/SIGTERM to stop)
  publish                     publish one event and exit — connect, write, close
    --topic T --kind K        required; topic accepts a trailing-* glob for subscribers
    --key K --source S        optional identity fields
    --cause C --ref R        what this event answers (a prior seq, a bead
                              id) and an opaque handle to an artifact
    --payload JSON            optional payload, parsed as JSON
  subscribe                   stream events until interrupted
    --topic T (repeatable)    subscriber-side filter; default: everything
    --kind K (repeatable)      subscriber-side filter; default: every kind
    --since N                 replay from seq N; a cursor outside the
                              broker's window reports a gap
  status                      liveness and counters (exit 0 even when down)`)
  process.exit(2)
}

// Same reason as agents.ts's die(): declared so tsc narrows.
function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** A misspelled option is a typo, not input — writes fail closed. */
function rejectUnknownFlags(sub: string, rest: string[]): void {
  const known = KNOWN_FLAGS[sub] ?? new Set<string>()
  for (const arg of rest) {
    if (!arg.startsWith('--')) {
      continue
    }
    const name = arg.split('=')[0] ?? arg
    // A `--bool=value` spelling must not pass as `--bool`: it validates
    // and then silently reads as absent downstream (`--json=true` would
    // emit human output). `=` is legal only for value flags.
    if (!known.has(name) || (arg !== name && !VALUE_FLAGS.has(name))) {
      usage()
    }
  }
}

/** The repo's broker socket — null outside a repository, which is a
 *  usage error rather than a runtime one. */
function socketOrDie(): string {
  const path = busSocketPath(process.cwd())
  if (path === null) {
    die('bro bus: not inside a git repository')
  }
  return path
}

/** One line per event for a human reader: `[seq] topic/kind key`. */
function formatEvent(event: BusEnvelope): string {
  const head = `[${String(event.seq)}] ${event.topic}/${event.kind}`
  return event.key === undefined || event.key === '' ? head : `${head} ${event.key}`
}

function filterFrom(rest: string[]): BusFilter {
  const topics = flagAll(rest, '--topic')
  const kinds = flagAll(rest, '--kind')
  return {
    ...(topics.length > 0 ? { topics } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
  }
}

async function cmdServe(rest: string[]): Promise<void> {
  const json = rest.includes('--json')
  let broker
  try {
    broker = await startBusBroker(process.cwd())
  } catch (err) {
    die(err instanceof Error ? err.message : String(err))
  }
  const payload = { socketPath: broker.socketPath, pid: process.pid, seq: broker.seq }
  if (json) {
    console.log(JSON.stringify(payload))
  } else {
    console.log(`bus listening ${broker.socketPath}`)
    console.log(`  pid ${String(broker.pid)}`)
    console.log(`  subscribe: bro bus subscribe --topic 'agent:*'`)
  }
  // Resolve on a signal; the broker's close() is what unlinks the socket
  // and clears discovery state, so a plain process.exit() would strand both.
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  await broker.close()
}

async function cmdPublish(rest: string[]): Promise<void> {
  const topic = flag(rest, '--topic')
  const kind = flag(rest, '--kind')
  if (topic === undefined || topic === '' || kind === undefined || kind === '') {
    usage()
  }
  const key = flag(rest, '--key')
  const source = flag(rest, '--source')
  const cause = flag(rest, '--cause')
  const ref = flag(rest, '--ref')
  const payloadRaw = flag(rest, '--payload')
  let payload: unknown
  if (payloadRaw !== undefined) {
    try {
      payload = JSON.parse(payloadRaw)
    } catch {
      die(`--payload is not valid JSON: ${payloadRaw}`)
    }
  }
  const result = await busPublish(socketOrDie(), {
    topic,
    kind,
    ...(key !== undefined ? { key } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(payload !== undefined ? { payload } : {}),
  })
  const json = rest.includes('--json')
  if (!result.published) {
    // Not a failure: the broker being down is a routine state, and a
    // publisher that made it here explicitly is reporting, not erroring.
    if (json) {
      console.log(JSON.stringify(result))
    } else {
      console.log(`not published (${result.reason ?? 'unknown'}) — start one with bro bus serve`)
    }
    return
  }
  if (json) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`published seq ${String(result.seq)}`)
  }
}

async function cmdSubscribe(rest: string[]): Promise<void> {
  const socketPath = socketOrDie()
  const sinceRaw = flag(rest, '--since')
  // Absent `--since` stays absent: the stream is live-only, and passing
  // 0 would replay the entire backlog into the subscriber.
  let since: number | undefined
  if (sinceRaw !== undefined) {
    const parsed = Number(sinceRaw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      usage()
    }
    since = Math.floor(parsed)
  }
  const json = rest.includes('--json')
  let sub
  try {
    sub = await busSubscribe(socketPath, filterFrom(rest), {
      onEvent: (event) => {
        console.log(json ? JSON.stringify(event) : formatEvent(event))
      },
      onGap: (seq) => {
        // An honest hole beats silent loss: the cursor fell outside the
        // broker's replay window, so state must be re-derived. In --json
        // mode the gap is part of the event stream — stderr would drop
        // it from a consumer that only parses stdout.
        if (json) {
          console.log(JSON.stringify({ gap: true, seq }))
        } else {
          console.error(`gap: cursor older than the replay window (broker at ${String(seq)}) — re-derive state`)
        }
      },
    }, since !== undefined ? { since } : {})
  } catch (err) {
    die(err instanceof Error ? err.message : String(err))
  }
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  sub.close()
}

async function cmdStatus(rest: string[]): Promise<void> {
  const socketPath = socketOrDie()
  const status = await busStatus(socketPath)
  if (rest.includes('--json')) {
    console.log(JSON.stringify(status))
    return
  }
  if (!status.running) {
    console.log(`down (${status.reason ?? 'unknown'}) — socket ${socketPath}`)
    return
  }
  console.log(`up ${socketPath}`)
  console.log(`  seq        ${String(status.seq ?? 0)}`)
  console.log(`  subscribers ${String(status.subscribers ?? 0)}`)
  console.log(`  ring       ${String(status.ring ?? 0)}`)
}

export async function runBusCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    usage()
  }
  // own-key lookup — an inherited key like `toString` is not a subcommand
  if (!Object.hasOwn(KNOWN_FLAGS, cmd)) {
    usage()
  }
  // validate the verb's own input before touching the broker: a missing
  // flag must report itself, not a transport error
  rejectUnknownFlags(cmd, rest)
  const positional = positionals(rest, VALUE_FLAGS)
  if (positional.length > 0) {
    usage()
  }
  switch (cmd) {
    case 'serve': {
      await cmdServe(rest)
      return
    }
    case 'publish': {
      await cmdPublish(rest)
      return
    }
    case 'subscribe': {
      await cmdSubscribe(rest)
      return
    }
    default: {
      await cmdStatus(rest)
    }
  }
}

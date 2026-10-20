/**
 * `bro wait external:<ref>…` — the dep-plane watcher
 * (specs/cross-repo/bro-y5zcw). A bounded poll over the dep's two
 * stores: the posting store's request bead and the peer plane's
 * `provides:` ship predicate, plus `bro mesh wait`'s reduction for
 * the thread annotation. The exit code IS the verdict:
 *
 *   0 free        — closed provides:<capability> on the peer plane
 *   1 unreadable  — a store the dep names could not be read
 *                   (3 consecutive failures — one bd blip is not a verdict)
 *   2 unresolved  — bad ref, <id> absent on its posting store, or no
 *                   peer binding for the rig — loud, immediate
 *   3 actionable  — the dep will not clear on its own: the request
 *                   bead closed without provides: (closed-unshipped),
 *                   or the thread carries a reject envelope
 *   4 timeout     — still open at the deadline; the ref rides out in
 *                   the summary for re-arming
 *
 * Armed like `act wait` — a session never parks on a wait; the
 * between-turn point check stays `bro mesh wait`. stdout carries one
 * line or one JSON object; progress goes to stderr.
 */
import { gitCommonDir } from '@broject/core'
import {
  meshThread,
  parseExternalRef,
  readDepState,
  resolveWaitPlane,
  type ExternalRef,
  type WaitPlane,
} from '@broject/mesh'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'
import { flagValue, meshPeers } from './mesh.ts'

const USAGE = `Usage: bro wait external:<rig>:<id>… [--every SEC] [--timeout SEC] [--json]

Bounded dep-plane watcher over an external:<rig>:<id> edge. The ref is
the argument — \`bro request\` prints the one it wired. Thread-plane
point checks stay \`bro mesh wait <thread>\`.

Exit verdicts: 0 free · 1 unreadable · 2 unresolved · 3 actionable · 4 timeout.
--timeout defaults to 2700s (45m); 0 waits unbounded.
`

const DEFAULT_TIMEOUT_SEC = 45 * 60
const DEFAULT_EVERY_SEC = 30
const MAX_FETCH_ERRORS = 3

interface Watch {
  /** the arg verbatim — verdicts and re-arm summaries carry it */
  arg: string
  ref: ExternalRef
  plane: WaitPlane
  errors: number
  settled?: Verdict
}

interface Verdict {
  verdict: 'free' | 'actionable'
  reason?: string
  stage?: string
  turn?: string
  source: 'live' | 'replica'
  replicaAgeMs?: number
}

function fmtAge(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) {
    return 'just now'
  }
  if (m < 60) {
    return `${m}m`
  }
  return `${Math.round(m / 60)}h`
}

function parseArgs(args: string[]): {
  refs: string[]
  every: number
  timeout: number
  json: boolean
} {
  const refs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--every' || a === '--timeout') {
      i++
      continue
    }
    if (a === '--json') {
      continue
    }
    if (a.startsWith('--')) {
      console.error(`error: unknown flag "${a}"`)
      console.error(USAGE)
      process.exit(2)
    }
    refs.push(a)
  }
  if (refs.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }
  const everyRaw = flagValue(args, '--every') ?? String(DEFAULT_EVERY_SEC)
  const timeoutRaw = flagValue(args, '--timeout') ?? String(DEFAULT_TIMEOUT_SEC)
  const every = Number(everyRaw)
  const timeout = Number(timeoutRaw)
  // a NaN --every spins the timer at ~0ms — a busy loop, not a poll
  if (!Number.isFinite(every) || every < MIN_INTERVAL_SEC || every > MAX_INTERVAL_SEC) {
    console.error(`error: --every needs ${MIN_INTERVAL_SEC}..${MAX_INTERVAL_SEC}s, got "${everyRaw}"`)
    process.exit(2)
  }
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(timeout * 1000)) {
    console.error(`error: --timeout needs a finite non-negative seconds value, got "${timeoutRaw}"`)
    process.exit(2)
  }
  return { refs, every, timeout, json: args.includes('--json') }
}

/** A verdict line/object — `free` and `actionable` outrank the
 *  deadline, so emit happens mid-loop, never only at the end. */
function emit(
  json: boolean,
  code: number,
  verdict: string,
  watches: Watch[],
  extra: Record<string, unknown> = {},
): void {
  const refs = Object.fromEntries(
    watches.map((w) => [
      w.arg,
      {
        verdict: w.settled?.verdict ?? 'waiting',
        ...(w.settled?.reason !== undefined ? { reason: w.settled.reason } : {}),
        ...(w.settled?.stage !== undefined ? { stage: w.settled.stage } : {}),
        ...(w.settled?.turn !== undefined ? { turn: w.settled.turn } : {}),
        source: w.plane.replica ? 'replica' : 'live',
        ...(w.settled?.replicaAgeMs !== undefined ? { replicaAgeMs: w.settled.replicaAgeMs } : {}),
      },
    ]),
  )
  if (json) {
    console.log(JSON.stringify({ verdict, refs, ...extra }))
  } else {
    const detail = watches
      .filter((w) => w.settled !== undefined)
      .map((w) => {
        const v = w.settled!
        const src =
          v.source === 'replica'
            ? ` — replica ${w.plane.peer.alias}` +
              (v.replicaAgeMs !== undefined ? `, synced ${fmtAge(v.replicaAgeMs)} ago` : ', never synced')
            : ''
        return `${w.arg}: ${v.verdict}${v.reason !== undefined ? ` (${v.reason})` : ''}${src}`
      })
      .join('; ')
    const unsettled = watches.filter((w) => w.settled === undefined).map((w) => w.arg)
    console.log(
      `wait: ${verdict}` +
        (detail !== '' ? ` — ${detail}` : '') +
        (unsettled.length > 0 ? ` (unsettled: ${unsettled.join(' ')})` : ''),
    )
  }
  process.exitCode = code
}

export async function runWaitCommand(argv: string[]): Promise<void> {
  const dir = process.cwd()
  const { refs, every, timeout, json } = parseArgs(argv)

  const common = gitCommonDir(dir)
  if (common === null) {
    console.error('bro wait: not inside a git repository')
    process.exit(2)
  }
  const peers = meshPeers(dir)

  // refs + planes resolve once, before the loop — a bad ref or an
  // unbound rig is a config verdict, not something a poll can outwait
  const watches: Watch[] = []
  for (const arg of refs) {
    const ref = parseExternalRef(arg)
    if (ref === null) {
      console.error(
        `error: "${arg}" is not an external:<rig>:<id> dep ref — ` +
          'the thread-plane read is `bro mesh wait <thread>`',
      )
      process.exit(2)
    }
    const plane = resolveWaitPlane(dir, peers, ref.rig, common)
    if (plane === undefined) {
      console.error(
        `error: no peer binding for ${ref.rig} — ` +
          '`bro mesh peers add <alias> <rig> <remote>` binds one',
      )
      process.exit(2)
    }
    watches.push({ arg, ref, plane, errors: 0 })
  }

  // monotonic clock for the bound — a wall-clock step must not stretch
  // a --timeout past its elapsed budget
  const deadline = timeout > 0 ? performance.now() + timeout * 1000 : Number.POSITIVE_INFINITY
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  for (;;) {
    for (const w of watches) {
      if (w.settled !== undefined) {
        continue
      }
      const read = readDepState(w.plane, w.ref.id)
      // a failed read is a different answer from a read that found
      // nothing — tolerate blips, settle `unreadable` on a streak
      if (read.errors.length > 0) {
        w.errors += 1
        for (const e of read.errors) {
          console.error(`! wait ${w.arg}: ${e}`)
        }
        if (w.errors >= MAX_FETCH_ERRORS) {
          emit(json, 1, 'unreadable', watches)
          return
        }
        continue
      }
      w.errors = 0

      // absent on the posting store is a bad ref, not a transient —
      // the transport says where the bead must land, and it is not there
      if (read.request === null) {
        console.error(`error: ${w.arg} — ${w.ref.id} is absent on its posting store`)
        emit(json, 2, 'unresolved', watches)
        return
      }

      const source = w.plane.replica ? 'replica' : 'live'
      if (read.shipped === true) {
        w.settled = { verdict: 'free', source, replicaAgeMs: read.replicaAgeMs }
        continue
      }

      if (read.request!.status === 'closed') {
        w.settled = {
          verdict: 'actionable',
          reason:
            `closed-unshipped — ${w.ref.id} closed without provides:${w.ref.id}; ` +
            `the dep will not release on its own`,
          source,
          replicaAgeMs: read.replicaAgeMs,
        }
        continue
      }

      // the thread read annotates progress and carries the one
      // actionable lifecycle fact: a reject envelope means re-post
      const thread = meshThread(dir, peers, w.ref.id, common, { pull: false })
      for (const e of thread.errors) {
        console.error(`! wait ${w.arg}: ${e}`)
      }
      if (thread.envelopes.some((e) => e.kind === 'reject')) {
        w.settled = {
          verdict: 'actionable',
          reason: `rejected — re-post the request`,
          stage: thread.stage,
          source,
          replicaAgeMs: read.replicaAgeMs,
        }
        continue
      }
      console.error(
        `wait ${w.arg}: stage=${thread.stage ?? 'none'} shipped=no` +
          (thread.turn !== undefined ? ` — ${thread.turn}'s move` : ''),
      )
    }

    const actionable = watches.find((w) => w.settled?.verdict === 'actionable')
    if (actionable !== undefined) {
      emit(json, 3, 'actionable', watches)
      return
    }
    if (watches.every((w) => w.settled !== undefined)) {
      emit(json, 0, 'free', watches)
      return
    }
    if (performance.now() >= deadline) {
      emit(json, 4, 'timeout', watches, {
        unsettled: watches.filter((w) => w.settled === undefined).map((w) => w.arg),
      })
      return
    }
    // cap the poll sleep at the remaining budget — a short --timeout
    // exits on its boundary, not one full interval late
    await sleep(Math.min(every * 1000, deadline - performance.now()))
  }
}

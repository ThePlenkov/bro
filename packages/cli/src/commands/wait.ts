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
  type DepRead,
  type ExternalRef,
  type MeshPeer,
  type WaitPlane,
} from '@broject/mesh'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'
import { meshPeers } from './mesh.ts'

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
/** close→ship is the normal completion order (`bd ship` needs the
 *  bead closed first), so closed-without-provides is a transient for
 *  one poll — the verdict requires it to persist */
const CLOSED_UNSHIPPED_GRACE = 3

type VerdictKind = 'free' | 'actionable' | 'unresolved' | 'unreadable'

interface Verdict {
  verdict: VerdictKind
  reason?: string
  stage?: string
  turn?: string
  source: 'live' | 'replica'
  replicaAgeMs?: number
}

interface Watch {
  /** the arg verbatim — verdicts and re-arm summaries carry it */
  arg: string
  ref: ExternalRef
  plane: WaitPlane
  errors: number
  /** consecutive closed-without-provides sightings — the grace
   *  counter the close→ship transient has to outlast */
  closedUnshipped: number
  settled?: Verdict
}

/** poll-time context — the requester's own repo the thread read
 *  and the posting-store split both key off */
interface WaitCtx {
  dir: string
  peers: MeshPeer[]
  common: string
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(2)
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

/** `--every SEC` / `--timeout SEC` — a missing or non-numeric value is
 *  a usage error, not a silent default (a swallowed flag would wait
 *  on bounds the operator never set) */
function secondsArg(args: string[], i: number): number {
  const raw = args[i + 1]
  if (raw === undefined || raw.startsWith('--')) {
    fail(`${args[i]} needs a seconds value`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    fail(`${args[i]} needs a numeric seconds value, got "${raw}"`)
  }
  return n
}

interface WaitArgs {
  refs: string[]
  every: number
  timeout: number
  json: boolean
}

/** one argv word: a flag (consuming its value when it takes one) or
 *  a ref — returns the index of the last word it ate */
function applyArg(out: WaitArgs, args: string[], i: number): number {
  const a = args[i]!
  if (a === '--json') {
    out.json = true
    return i
  }
  if (a === '--every') {
    out.every = secondsArg(args, i)
    return i + 1
  }
  if (a === '--timeout') {
    out.timeout = secondsArg(args, i)
    return i + 1
  }
  if (a.startsWith('--')) {
    console.error(`error: unknown flag "${a}"`)
    console.error(USAGE)
    process.exit(2)
  }
  out.refs.push(a)
  return i
}

function validateBounds(out: WaitArgs): void {
  if (out.refs.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }
  // a sub-floor --every spins the timer at ~0ms — a busy loop, not a poll
  if (out.every < MIN_INTERVAL_SEC || out.every > MAX_INTERVAL_SEC) {
    fail(`--every needs ${MIN_INTERVAL_SEC}..${MAX_INTERVAL_SEC}s, got ${out.every}`)
  }
  if (out.timeout < 0 || !Number.isFinite(out.timeout * 1000)) {
    fail(`--timeout needs a finite non-negative seconds value, got ${out.timeout}`)
  }
}

function parseArgs(args: string[]): WaitArgs {
  const out: WaitArgs = {
    refs: [],
    every: DEFAULT_EVERY_SEC,
    timeout: DEFAULT_TIMEOUT_SEC,
    json: false,
  }
  for (let i = 0; i < args.length; i++) {
    i = applyArg(out, args, i)
  }
  validateBounds(out)
  return out
}

/** the per-ref JSON shape — settled verdicts carry reason and stage
 *  annotation; waiting refs read as 'waiting' */
function refEntry(w: Watch): Record<string, unknown> {
  const out: Record<string, unknown> = {
    verdict: w.settled?.verdict ?? 'waiting',
    source: w.plane.replica ? 'replica' : 'live',
  }
  for (const k of ['reason', 'stage', 'turn', 'replicaAgeMs'] as const) {
    const v = w.settled?.[k]
    if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/** `arg: verdict (reason) — replica <alias>, synced <age> ago` — the
 *  human line's per-ref detail; live sources carry no annotation */
function detailLine(w: Watch): string {
  const v = w.settled!
  const src =
    v.source === 'replica'
      ? ` — replica ${w.plane.peer.alias}` +
        (v.replicaAgeMs !== undefined ? `, synced ${fmtAge(v.replicaAgeMs)} ago` : ', never synced')
      : ''
  return `${w.arg}: ${v.verdict}${v.reason !== undefined ? ` (${v.reason})` : ''}${src}`
}

interface EmitOpts {
  code: number
  verdict: string
  json: boolean
  extra?: Record<string, unknown>
}

/** A verdict line/object — terminal verdicts outrank the deadline,
 *  so emit happens mid-loop, never only at the end. */
function emit(watches: Watch[], o: EmitOpts): void {
  if (o.json) {
    const refs = Object.fromEntries(watches.map((w) => [w.arg, refEntry(w)]))
    console.log(JSON.stringify({ verdict: o.verdict, refs, ...o.extra }))
  } else {
    const detail = watches
      .filter((w) => w.settled !== undefined)
      .map(detailLine)
      .join('; ')
    const unsettled = watches.filter((w) => w.settled === undefined).map((w) => w.arg)
    console.log(
      `wait: ${o.verdict}` +
        (detail !== '' ? ` — ${detail}` : '') +
        (unsettled.length > 0 ? ` (unsettled: ${unsettled.join(' ')})` : ''),
    )
  }
  process.exitCode = o.code
}

/** refs + planes resolve once, before the loop — a bad ref or an
 *  unbound rig is a config verdict, not something a poll can outwait */
function resolveWatches(refs: string[], ctx: WaitCtx): Watch[] {
  return refs.map((arg) => {
    const ref = parseExternalRef(arg)
    if (ref === null) {
      fail(
        `"${arg}" is not an external:<rig>:<id> dep ref — ` +
          'the thread-plane read is `bro mesh wait <thread>`',
      )
    }
    const plane = resolveWaitPlane(ctx.dir, ctx.peers, ref.rig, ctx.common)
    if (plane === undefined) {
      fail(`no peer binding for ${ref.rig} — ` + '`bro mesh peers add <alias> <rig> <remote>` binds one')
    }
    return { arg, ref, plane, errors: 0, closedUnshipped: 0 }
  })
}

function srcOf(w: Watch): 'live' | 'replica' {
  return w.plane.replica ? 'replica' : 'live'
}

/** a failed read is a different answer from a read that found
 *  nothing — tolerate blips, settle `unreadable` on a streak */
function noteReadErrors(w: Watch, errors: string[]): void {
  for (const e of errors) {
    console.error(`! wait ${w.arg}: ${e}`)
  }
  if (++w.errors >= MAX_FETCH_ERRORS) {
    w.settled = {
      verdict: 'unreadable',
      reason: `${w.plane.peer.alias} unreadable ${MAX_FETCH_ERRORS} polls running`,
      source: srcOf(w),
    }
  }
}

/** absent on the posting store is a bad ref, not a transient —
 *  the transport says where the bead must land, and it is not there */
function settleAbsent(w: Watch, read: DepRead): void {
  console.error(`error: ${w.arg} — ${w.ref.id} is absent on its posting store`)
  w.settled = {
    verdict: 'unresolved',
    reason: 'absent on its posting store',
    source: srcOf(w),
    replicaAgeMs: read.replicaAgeMs,
  }
}

/** the thread read annotates progress and carries the one actionable
 *  lifecycle fact: a reject envelope means re-post. The verdict is
 *  the envelope SET, not the reduced stage — a ship followed by a
 *  reject is contradictory lifecycle history, not a free dep. */
function threadOf(w: Watch, ctx: WaitCtx): ReturnType<typeof meshThread> {
  const thread = meshThread(ctx.dir, ctx.peers, w.ref.id, ctx.common, { pull: false })
  for (const e of thread.errors) {
    console.error(`! wait ${w.arg}: ${e}`)
  }
  return thread
}

function rejected(w: Watch, read: DepRead, thread: ReturnType<typeof meshThread>): boolean {
  if (!thread.envelopes.some((e) => e.kind === 'reject')) {
    return false
  }
  w.settled = {
    verdict: 'actionable',
    reason: 'rejected — re-post the request',
    stage: thread.stage,
    source: srcOf(w),
    replicaAgeMs: read.replicaAgeMs,
  }
  return true
}

/** could the peer plane have observed a ship that already landed?
 *  A replica materialized before the request's close stamp literally
 *  cannot carry the provides: row — waiting for a fresher pull is the
 *  honest verdict (the stamp is best-effort; absent or unparseable it
 *  falls back to the poll grace). */
function shipCouldBeVisible(w: Watch, read: DepRead): boolean {
  if (!w.plane.replica || read.replicaAgeMs === undefined) {
    return true
  }
  const stamp = read.request?.closed_at ?? read.request?.updated_at
  const closeMs = stamp === undefined || stamp === null ? Number.NaN : Date.parse(stamp)
  if (Number.isNaN(closeMs)) {
    return true
  }
  return Date.now() - read.replicaAgeMs > closeMs
}

/** closed-without-provides — the dep's own release rule failed. Not a
 *  one-poll verdict: close→ship passes through this state normally,
 *  and a stale replica can hide a landed ship. */
function closedUnshipped(w: Watch, read: DepRead): boolean {
  if (!shipCouldBeVisible(w, read)) {
    console.error(
      `wait ${w.arg}: closed — replica predates the close, ` +
        'a landed ship would be invisible; `bro mesh pull` refreshes',
    )
    return false
  }
  w.closedUnshipped += 1
  if (w.closedUnshipped < CLOSED_UNSHIPPED_GRACE) {
    console.error(
      `wait ${w.arg}: closed — ship pending (${w.closedUnshipped}/${CLOSED_UNSHIPPED_GRACE})`,
    )
    return false
  }
  w.settled = {
    verdict: 'actionable',
    reason:
      `closed-unshipped — ${w.ref.id} closed without provides:${w.ref.id}; ` +
      'the dep will not release on its own',
    source: srcOf(w),
    replicaAgeMs: read.replicaAgeMs,
  }
  return true
}

/** closed provides:<id> on the peer plane — the dep's own release
 *  rule fired, the wait is over */
function shipped(w: Watch, read: DepRead): boolean {
  if (read.shipped !== true) {
    return false
  }
  w.settled = { verdict: 'free', source: srcOf(w), replicaAgeMs: read.replicaAgeMs }
  return true
}

/** posting store read clean — thread verdicts outrank ship ones
 *  (reject beats free), the still-open case is just a progress line */
function settleFromPlanes(w: Watch, ctx: WaitCtx, read: DepRead): void {
  const thread = threadOf(w, ctx)
  if (rejected(w, read, thread) || shipped(w, read)) {
    return
  }
  if (read.request!.status === 'closed') {
    closedUnshipped(w, read)
    return
  }
  console.error(
    `wait ${w.arg}: stage=${thread.stage ?? 'none'} shipped=no` +
      (thread.turn !== undefined ? ` — ${thread.turn}'s move` : ''),
  )
}

/** one poll of one unsettled watch — records a verdict or bumps the
 *  blip counter; the watch carries the state */
function pollWatch(w: Watch, ctx: WaitCtx): void {
  const read = readDepState(w.plane, w.ref.id)
  if (read.errors.length > 0) {
    noteReadErrors(w, read.errors)
    return
  }
  w.errors = 0
  if (read.request === null) {
    settleAbsent(w, read)
    return
  }
  settleFromPlanes(w, ctx, read)
}

/** terminal verdicts by precedence — a bad ref (2) outranks a dead
 *  plane (1), which outranks a lifecycle verdict (3). All-settled is
 *  the only free exit; anything still waiting returns undefined and
 *  the loop turns again. */
function aggregate(watches: Watch[]): { code: number; verdict: string } | undefined {
  const precedence: [VerdictKind, number][] = [
    ['unresolved', 2],
    ['unreadable', 1],
    ['actionable', 3],
  ]
  for (const [kind, code] of precedence) {
    if (watches.some((w) => w.settled?.verdict === kind)) {
      return { code, verdict: kind }
    }
  }
  return watches.every((w) => w.settled !== undefined) ? { code: 0, verdict: 'free' } : undefined
}

/** the bounded poll — each turn polls every unsettled watch, emits
 *  a terminal verdict, or sleeps until the next tick/deadline */
async function watchLoop(
  watches: Watch[],
  ctx: WaitCtx,
  o: { every: number; timeout: number; json: boolean },
): Promise<void> {
  // monotonic clock for the bound — a wall-clock step must not stretch
  // a --timeout past its elapsed budget
  const deadline = o.timeout > 0 ? performance.now() + o.timeout * 1000 : Number.POSITIVE_INFINITY
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  for (;;) {
    for (const w of watches) {
      if (w.settled === undefined) {
        pollWatch(w, ctx)
      }
    }
    const out = aggregate(watches)
    if (out !== undefined) {
      emit(watches, { ...out, json: o.json })
      return
    }
    if (performance.now() >= deadline) {
      emit(watches, {
        code: 4,
        verdict: 'timeout',
        json: o.json,
        extra: { unsettled: watches.filter((w) => w.settled === undefined).map((w) => w.arg) },
      })
      return
    }
    // cap the poll sleep at the remaining budget — a short --timeout
    // exits on its boundary, not one full interval late
    await sleep(Math.min(o.every * 1000, deadline - performance.now()))
  }
}

export async function runWaitCommand(argv: string[]): Promise<void> {
  const dir = process.cwd()
  const args = parseArgs(argv)
  const common = gitCommonDir(dir)
  if (common === null) {
    fail('bro wait: not inside a git repository')
  }
  const ctx: WaitCtx = { dir, peers: meshPeers(dir), common }
  await watchLoop(resolveWatches(args.refs, ctx), ctx, args)
}

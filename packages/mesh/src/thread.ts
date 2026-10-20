/**
 * Thread state — the lifecycle view of one request across every
 * store we can read: our own (the requester's or the worker's) plus
 * each peer's replica. Sovereignty stays intact: every record is read
 * where its owner wrote it; the reduction only ever happens here.
 *
 * Lifecycle (specs/mesh):
 *   posted → claimed → submitted ─┬─ accepted
 *                                 └─ rejected
 */
import { gitTry, taskStore } from '@broject/core'
import { envelopeFromBead, type BeadLike, type MeshEnvelope, type MeshKind } from './envelope.ts'
import { selfRig } from './identity.ts'
import type { MeshPeer } from './peers.ts'
import { meshScan, type PeerRecord } from './inbox.ts'
import {
  githubProvenance,
  issueComments,
  issueKey,
  parseGithubRemote,
  selfLogin as ghSelfLogin,
  type GhRecord,
} from './github.ts'

export type ThreadStage = 'posted' | 'claimed' | 'submitted' | 'accepted' | 'rejected'

export interface ThreadState {
  /** the request envelope — thread anchor; absent when the request is
   *  on a store we cannot read */
  request?: MeshEnvelope
  /** all lifecycle envelopes seen for the thread */
  envelopes: MeshEnvelope[]
  /** envelope id → the bound peer rig the record arrived over. The
   *  binding is the authoritative sender for replies; a record with
   *  no entry came from our own store. On a `local` peer the entry
   *  is the envelope's `from` — the binding attests the store, not
   *  the author (delivered threads carry the requester's records). */
  provenance: Record<string, string>
  /** the peer that produced the REQUEST envelope — a `local` peer
   *  means the thread's anchor store is that checkout; lifecycle
   *  writes land there, not in our own store. */
  requestPeer?: MeshPeer
  /** the thread names this reduction merged — the asked thread plus
   *  aliases recovered from own-store mirror beads' `external_ref`
   *  (a github mirror names the issue url; a wasteland one the
   *  `w-<hash>`). Callers that write to a non-beads plane pick the
   *  canonical thread from this list. */
  threads: string[]
  stage?: ThreadStage
  /** the side that owes the next move — absent on a terminal verdict */
  turn?: 'requester' | 'worker'
  errors: string[]
}

const STAGE_OF: Record<MeshKind, ThreadStage> = {
  request: 'posted',
  claim: 'claimed',
  result: 'submitted',
  accept: 'accepted',
  reject: 'rejected',
}

const STAGE_RANK: Record<ThreadStage, number> = {
  posted: 0,
  claimed: 1,
  submitted: 2,
  rejected: 3,
  accepted: 3,
}

function ownBeads(dir: string): { rows: BeadLike[]; error?: string } {
  try {
    return {
      rows: taskStore(dir).list<BeadLike>({ labels: ['mesh:v:1'], all: true }),
    }
  } catch (err) {
    return {
      rows: [],
      error: `store list failed — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** One scanned record → the thread, if it belongs. A peer can only
 *  author envelopes as itself — a record whose `from` doesn't match
 *  its binding is impersonation, and letting it into the reduction
 *  would let a peer forge lifecycle moves. On `local` peers the
 *  binding attests the *store*, not the author: a delivered thread
 *  carries the requester's records, so `from` ∈ {binding rig, own
 *  rig} is admitted with provenance = `from`; anything else still
 *  drops and flags.
 *
 *  github: provenance is the authenticated comment AUTHOR — a record
 *  is admitted only when its author is the binding's `login` (the
 *  peer's account → provenance = peer rig) or this account (self →
 *  provenance = own rig). A binding with no `login` admits nothing
 *  and says so — never a fallback to the advisory `from`.
 *  wasteland: the binding attests the BOARD — a row in the commons
 *  carries its own poster (`posted_by`/`claimed_by`), so `from` is
 *  the record's real field and provenance is `from`. */
/** The transport's say on who a record is from — a provenance rig, or
 *  the error explaining why the record is dropped. */
function peerProvenance(
  r: PeerRecord,
  ctx: ReduceCtx,
): { provenance?: string; error?: string } {
  if (r.transport === 'github') {
    const v = githubProvenance({
      author: r.author ?? '',
      peer: ctx.peers.find((p) => p.alias === r.peer),
      selfLogin: ctx.login.get(),
      ownRig: ctx.ownRig,
    })
    return v.provenance === undefined
      ? { error: v.error ?? 'unauthenticated' }
      : { provenance: v.provenance }
  }
  if (r.transport === 'wasteland') {
    return { provenance: r.envelope.from }
  }
  return ownRecordAdmits(r, ctx)
}

/** beads-remote and local peers — the `from` attests the binding rig;
 *  on `local` checkouts the store can carry OUR records too. */
function admitsFrom(r: PeerRecord, ownRig: string | null): boolean {
  if (r.envelope.from === r.peerRig) {
    return true
  }
  const localSelf = r.transport === 'local' && ownRig !== null
  return localSelf && r.envelope.from === ownRig
}

function ownRecordAdmits(r: PeerRecord, ctx: ReduceCtx): { provenance?: string; error?: string } {
  return admitsFrom(r, ctx.ownRig)
    ? { provenance: r.transport === 'local' ? r.envelope.from : r.peerRig }
    : { error: `from ${r.envelope.from} doesn't match peer rig ${r.peerRig}` }
}

/** The shared admit tail — dedupe id, keep the envelope, pin who
 *  sent it. */
function markAdmitted(env: MeshEnvelope, provenance: string, ctx: ReduceCtx): void {
  ctx.seen.add(env.id)
  ctx.state.envelopes.push(env)
  ctx.state.provenance[env.id] = provenance
}

function admitPeerRecord(r: PeerRecord, ctx: ReduceCtx): void {
  if (!ctx.threads.has(r.envelope.thread) || ctx.seen.has(r.envelope.id)) {
    return
  }
  const v = peerProvenance(r, ctx)
  if (v.provenance === undefined) {
    ctx.state.errors.push(
      `${r.peer}: ignoring ${r.envelope.kind} ${r.envelope.id} — ${v.error}`
    )
    return
  }
  markAdmitted(r.envelope, v.provenance, ctx)
  if (r.envelope.kind === 'request') {
    ctx.state.requestPeer = ctx.peers.find((p) => p.alias === r.peer)
  }
}

/** github admission needs this account's login — `gh api user` is a
 *  network call, so it runs once per reduction at most, and only when
 *  a github record actually needs it. */
/** The reduction's working set — every admit leg shares it; one record
 *  keeps each helper's arg list under the repo's max-4 ceiling. */
interface ReduceCtx {
  threads: Set<string>
  seen: Set<string>
  state: ThreadState
  ownRig: string | null
  peers: MeshPeer[]
  login: { get: () => string | undefined }
}

function lazyLogin(): ReduceCtx['login'] {
  let ready = false
  let login: string | undefined
  const get = (): string | undefined => {
    if (!ready) {
      ready = true
      login = ghSelfLogin().login
    }
    return login
  }
  return { get }
}

/** Own-store leg: mirror beads carry the remote thread in
 *  `external_ref` — the asked thread aliases both ways (wait on the
 *  bead id and the issue's comments still join; wait on the issue url
 *  and the mirror still anchors it). Admits every own envelope whose
 *  thread or alias is in the set. */
function aliasOf(row: BeadLike): string | null {
  return typeof row.external_ref === 'string' && row.external_ref !== ''
    ? row.external_ref
    : null
}

/** The alias direction an own bead adds: its external_ref when the
 *  bead IS the asked thread, its own thread when the ref names it. */
function aliasThread(env: MeshEnvelope | null, ext: string | null, thread: string): string | null {
  if (env === null) {
    return null
  }
  if (env.thread === thread && ext !== null) {
    return ext
  }
  return ext === thread ? env.thread : null
}

/** First pass over own beads — alias recovery only (the asked thread
 *  names both directions through `external_ref`). */
function collectAliases(
  ownEnvs: { row: BeadLike; env: MeshEnvelope | null }[],
  thread: string,
  ctx: ReduceCtx,
): void {
  for (const { row, env } of ownEnvs) {
    const alias = aliasThread(env, aliasOf(row), thread)
    if (alias !== null) {
      ctx.threads.add(alias)
    }
  }
}

/** The envelope joins the reduction when its thread OR its
 *  `external_ref` alias is in the asked set. */
function ownAdmits(env: MeshEnvelope, ext: string | null, ctx: ReduceCtx): boolean {
  if (ctx.threads.has(env.thread)) {
    return true
  }
  return ext !== null && ctx.threads.has(ext)
}

function admitOwnBeads(rows: BeadLike[], thread: string, ctx: ReduceCtx): void {
  const ownEnvs = rows.map((row) => ({ row, env: envelopeFromBead(row) }))
  collectAliases(ownEnvs, thread, ctx)
  for (const { row, env } of ownEnvs) {
    if (env !== null && ownAdmits(env, aliasOf(row), ctx)) {
      ctx.seen.add(env.id)
      ctx.state.envelopes.push(env)
    }
  }
}

/** github's own-repo half — a request to THIS rig is an issue on MY
 *  repo; nothing pulled it into a store, so a thread alias naming a
 *  url on the repo origin points at gets its comments read directly.
 *  Same provenance rule as the peer scan: a bound login attests the
 *  peer, this account attests us, anything else drops flagged. */
function admitSelfRepoGithub(dir: string, ctx: ReduceCtx): void {
  const origin = gitTry(['-C', dir, 'remote', 'get-url', 'origin'])
  const selfRepo = origin.code === 0 ? parseGithubRemote({ remote: origin.out }) : null
  if (selfRepo === null) {
    return
  }
  for (const t of ctx.threads) {
    admitIssueComments(t, selfRepo, ctx)
  }
}

/** One thread alias → its issue comments, admitted when they name the
 *  origin's repo. */
function admitIssueComments(t: string, selfRepo: { owner: string; repo: string }, ctx: ReduceCtx): void {
  const k = issueKey({ thread: t })
  if (k.repo === null || k.n === null) {
    return
  }
  const { repo, n } = k
  if (repo.owner !== selfRepo.owner || repo.repo !== selfRepo.repo) {
    return
  }
  const cs = issueComments(repo, { number: n })
  for (const e of cs.errors) {
    ctx.state.errors.push(`self: ${e}`)
  }
  for (const r of cs.records) {
    admitSelfRepoRecord(r, ctx)
  }
}

function admitSelfRepoRecord(r: GhRecord, ctx: ReduceCtx): void {
  if (!ctx.threads.has(r.envelope.thread) || ctx.seen.has(r.envelope.id)) {
    return
  }
  const bound = ctx.peers.find((p) => p.login !== undefined && p.login === r.author)
  const v = githubProvenance({
    author: r.author,
    peer: bound,
    selfLogin: ctx.login.get(),
    ownRig: ctx.ownRig,
  })
  if (v.provenance === undefined) {
    ctx.state.errors.push(
      `self: ignoring ${r.envelope.kind} ${r.envelope.id} — ${v.error ?? 'unauthenticated'}`
    )
    return
  }
  markAdmitted(r.envelope, v.provenance, ctx)
  if (r.envelope.kind === 'request' && bound !== undefined) {
    ctx.state.requestPeer = bound
  }
}

/** The furthest stage any admitted envelope reached. */
function highestStage(envelopes: MeshEnvelope[]): ThreadStage | undefined {
  let stage: ThreadStage | undefined
  for (const e of envelopes) {
    const s = STAGE_OF[e.kind]
    if (stage === undefined || STAGE_RANK[s] > STAGE_RANK[stage]) {
      stage = s
    }
  }
  return stage
}

/** Highest-stage envelope wins; the turn is the side that owes the
 *  next move — both verdicts are terminal (a revised result re-opens
 *  as a new request thread, not a turn). */
function reduceStage(state: ThreadState): void {
  state.request = state.envelopes.find((e) => e.kind === 'request')
  state.stage = highestStage(state.envelopes)
  if (state.stage === 'posted' || state.stage === 'claimed') {
    state.turn = 'worker'
  } else if (state.stage === 'submitted') {
    state.turn = 'requester'
  }
}

/** Every mesh envelope for `thread` visible from here — own store plus
 *  the peer scans. `pull:false` keeps it a pure read of what was
 *  already synced. */
export function meshThread(
  dir: string,
  peers: MeshPeer[],
  thread: string,
  call: { gitCommon: string; pull?: boolean },
): ThreadState {
  const state: ThreadState = { envelopes: [], provenance: {}, threads: [], errors: [] }
  const ownRig = selfRig(dir)
  const ctx: ReduceCtx = {
    threads: new Set([thread]),
    seen: new Set(),
    state,
    ownRig,
    peers,
    login: lazyLogin(),
  }

  const own = ownBeads(dir)
  if (own.error !== undefined) {
    state.errors.push(`self: ${own.error}`)
  }
  admitOwnBeads(own.rows, thread, ctx)
  state.threads = [...ctx.threads]

  // `closedLocal` — the request anchor's `bd close` is `done`'s ship
  // precondition, so a closed request bead is a healthy thread's
  // terminal state, not absence; an open-only scan loses the anchor
  // the moment `done` lands
  const scan = meshScan(dir, peers, call.gitCommon, {
    pull: call.pull,
    closedLocal: true,
    selfRig: ownRig ?? undefined,
  })
  state.errors.push(...scan.errors)
  for (const r of scan.records) {
    admitPeerRecord(r, ctx)
  }

  admitSelfRepoGithub(dir, ctx)
  reduceStage(state)
  return state
}

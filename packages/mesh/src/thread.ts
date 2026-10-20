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
  issueNumber,
  issueRepo,
  parseGithubRemote,
  selfLogin as ghSelfLogin,
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
function admitPeerRecord(
  r: PeerRecord,
  threads: Set<string>,
  seen: Set<string>,
  state: ThreadState,
  own: string | null,
  peers: MeshPeer[],
  selfLogin: string | undefined,
): void {
  if (!threads.has(r.envelope.thread)) {
    return
  }
  let provenance: string
  if (r.transport === 'github') {
    const v = githubProvenance(
      r.author ?? '',
      peers.find((p) => p.alias === r.peer),
      selfLogin,
      own,
    )
    if (v.provenance === undefined) {
      state.errors.push(
        `${r.peer}: ignoring ${r.envelope.kind} ${r.envelope.id} — ${v.error ?? 'unauthenticated'}`
      )
      return
    }
    provenance = v.provenance
  } else if (r.transport === 'wasteland') {
    provenance = r.envelope.from
  } else {
    const admitted =
      r.envelope.from === r.peerRig ||
      (r.transport === 'local' && own !== null && r.envelope.from === own)
    if (!admitted) {
      state.errors.push(
        `${r.peer}: ignoring ${r.envelope.kind} ${r.envelope.id} — from ${r.envelope.from} doesn't match peer rig ${r.peerRig}`
      )
      return
    }
    provenance = r.transport === 'local' ? r.envelope.from : r.peerRig
  }
  if (!seen.has(r.envelope.id)) {
    seen.add(r.envelope.id)
    state.envelopes.push(r.envelope)
    state.provenance[r.envelope.id] = provenance
    if (r.envelope.kind === 'request') {
      state.requestPeer = peers.find((p) => p.alias === r.peer)
    }
  }
}

/** Every mesh envelope for `thread` visible from here — own store plus
 *  the peer scans. `pull:false` keeps it a pure read of what was
 *  already synced. */
export function meshThread(
  dir: string,
  peers: MeshPeer[],
  thread: string,
  gitCommon: string,
  opts: { pull?: boolean } = {},
): ThreadState {
  const state: ThreadState = { envelopes: [], provenance: {}, threads: [], errors: [] }
  const seen = new Set<string>()

  const own = ownBeads(dir)
  if (own.error !== undefined) {
    state.errors.push(`self: ${own.error}`)
  }
  // mirror beads carry the remote thread in `external_ref` — the
  // asked thread aliases both ways: wait on the bead id and the
  // issue's comments still join the reduction; wait on the issue url
  // and the mirror still anchors it
  const threads = new Set([thread])
  const ownEnvs = own.rows.map((row) => ({ row, env: envelopeFromBead(row) }))
  for (const { row, env } of ownEnvs) {
    const ext = typeof row.external_ref === 'string' && row.external_ref !== '' ? row.external_ref : null
    if (env !== null && env.thread === thread && ext !== null) {
      threads.add(ext)
    }
    if (env !== null && ext === thread) {
      threads.add(env.thread)
    }
  }
  for (const { row, env } of ownEnvs) {
    const ext = typeof row.external_ref === 'string' ? row.external_ref : null
    if (env !== null && (threads.has(env.thread) || (ext !== null && threads.has(ext)))) {
      seen.add(env.id)
      state.envelopes.push(env)
    }
  }
  state.threads = [...threads]

  // `closedLocal` — the request anchor's `bd close` is `done`'s ship
  // precondition, so a closed request bead is a healthy thread's
  // terminal state, not absence; an open-only scan loses the anchor
  // the moment `done` lands
  const ownRig = selfRig(dir)
  const scan = meshScan(dir, peers, gitCommon, {
    pull: opts.pull,
    closedLocal: true,
    selfRig: ownRig ?? undefined,
  })
  state.errors.push(...scan.errors)
  // github admission needs this account's login — `gh api user` is a
  // network call, so it runs once per reduction at most, and only
  // when a github record actually needs it
  let ghLogin: string | undefined
  let ghLoginReady = false
  const loginOnce = (): string | undefined => {
    if (!ghLoginReady) {
      ghLoginReady = true
      ghLogin = ghSelfLogin().login
    }
    return ghLogin
  }
  const self = scan.records.some((r) => r.transport === 'github') ? loginOnce() : undefined
  for (const r of scan.records) {
    admitPeerRecord(r, threads, seen, state, ownRig, peers, self)
  }

  // github's own-repo half — a request to THIS rig is an issue on MY
  // repo; nothing pulled it into a store, so a thread alias naming a
  // url on the repo origin points at gets its comments read directly.
  // Same provenance rule as the peer scan: a bound login attests the
  // peer, this account attests us, anything else drops flagged.
  const origin = gitTry(['-C', dir, 'remote', 'get-url', 'origin'])
  const selfRepo = origin.code === 0 ? parseGithubRemote(origin.out) : null
  if (selfRepo !== null) {
    for (const t of threads) {
      const ri = issueRepo(t)
      const n = issueNumber(t)
      if (
        ri === null ||
        n === null ||
        ri.owner !== selfRepo.owner ||
        ri.repo !== selfRepo.repo
      ) {
        continue
      }
      const cs = issueComments(ri, { number: Number(n), html_url: t })
      for (const e of cs.errors) {
        state.errors.push(`self: ${e}`)
      }
      const self2 = self ?? loginOnce()
      for (const r of cs.records) {
        if (!threads.has(r.envelope.thread) || seen.has(r.envelope.id)) {
          continue
        }
        const bound = peers.find((p) => p.login !== undefined && p.login === r.author)
        const v = githubProvenance(r.author, bound, self2, ownRig)
        if (v.provenance === undefined) {
          state.errors.push(
            `self: ignoring ${r.envelope.kind} ${r.envelope.id} — ${v.error ?? 'unauthenticated'}`
          )
          continue
        }
        seen.add(r.envelope.id)
        state.envelopes.push(r.envelope)
        state.provenance[r.envelope.id] = v.provenance
        if (r.envelope.kind === 'request' && bound !== undefined) {
          state.requestPeer = bound
        }
      }
    }
  }

  state.request = state.envelopes.find((e) => e.kind === 'request')
  let stage: ThreadStage | undefined
  for (const e of state.envelopes) {
    const s = STAGE_OF[e.kind]
    if (stage === undefined || STAGE_RANK[s] > STAGE_RANK[stage]) {
      stage = s
    }
  }
  state.stage = stage
  // both verdicts are terminal — a rejected thread is done, not the
  // worker's turn; a revised result re-opens as a new request thread
  if (stage === 'posted' || stage === 'claimed') {
    state.turn = 'worker'
  } else if (stage === 'submitted') {
    state.turn = 'requester'
  }
  return state
}

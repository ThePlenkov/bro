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
import { spawnSync } from 'node:child_process'
import { envelopeFromBead, type BeadLike, type MeshEnvelope, type MeshKind } from './envelope.ts'
import type { MeshPeer } from './peers.ts'
import { meshScan } from './inbox.ts'

export type ThreadStage = 'posted' | 'claimed' | 'submitted' | 'accepted' | 'rejected'

export interface ThreadState {
  /** the request envelope — thread anchor; absent when the request is
   *  on a store we cannot read */
  request?: MeshEnvelope
  /** all lifecycle envelopes seen for the thread */
  envelopes: MeshEnvelope[]
  /** envelope id → the bound peer rig the record arrived over. The
   *  binding is the authoritative sender for replies; a record with
   *  no entry came from our own store. */
  provenance: Record<string, string>
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
  const p = spawnSync('bd', ['-C', dir, 'list', '--label', 'mesh:v:1', '--json', '--all'], {  // NOSONAR — PATH lookup is the contract (same as core/git.ts)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (p.status !== 0) {
    return { rows: [], error: `bd list failed — ${(p.stderr ?? '').trim() || 'exit ' + p.status}` }
  }
  try {
    return { rows: JSON.parse(p.stdout ?? '[]') as BeadLike[] }
  } catch {
    return { rows: [], error: 'bd list returned unparseable json' }
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
  const state: ThreadState = { envelopes: [], provenance: {}, errors: [] }
  const seen = new Set<string>()

  const own = ownBeads(dir)
  if (own.error !== undefined) {
    state.errors.push(`self: ${own.error}`)
  }
  for (const row of own.rows) {
    const env = envelopeFromBead(row)
    if (env?.thread === thread) {
      seen.add(env.id)
      state.envelopes.push(env)
    }
  }

  const scan = meshScan(dir, peers, gitCommon, { pull: opts.pull })
  state.errors.push(...scan.errors)
  for (const r of scan.records) {
    if (r.envelope.thread === thread && !seen.has(r.envelope.id)) {
      seen.add(r.envelope.id)
      state.envelopes.push(r.envelope)
      state.provenance[r.envelope.id] = r.peerRig
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

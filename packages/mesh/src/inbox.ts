/**
 * mesh inbox — requests addressed to this rig across peers. Trust
 * (spec): the peer binding is provenance — a request surfaced from
 * remote alias X counts as coming from X's declared rig; the
 * envelope's `from` is display metadata, and a mismatch is flagged,
 * never trusted.
 *
 * `meshScan` is the unfiltered read — every mesh envelope a peer
 * store holds, with provenance. `meshInbox` is the request filter on
 * top; thread tracking (thread.ts) consumes the scan directly.
 */
import { taskStore } from '@broject/core'
import { envelopeFromBead, type BeadLike, type MeshEnvelope } from './envelope.ts'
import { existsSync } from 'node:fs'
import { localCheckout, type MeshPeer, type MeshTransport } from './peers.ts'
import { issueLabels, meshIssues, replicaDir, syncReplica } from './pull.ts'

export interface PeerRecord {
  /** The peer alias the record arrived over — the provenance. */
  peer: string
  /** The rig the binding declares for that alias. */
  peerRig: string
  /** The binding's transport — 'local' attests the STORE, not the
   *  author: delivered envelopes carry the requester's `from` in a
   *  store the binding names (specs/cross-repo/bro-oam4). */
  transport: MeshTransport
  envelope: MeshEnvelope
  beadId: string
}

export interface InboundRequest extends PeerRecord {
  /** envelope.from !== peer.rig — flagged, never trusted (spec Trust). */
  mismatch: boolean
  /** own-store row whose `from` matches no peer binding — surfaced
   *  like `mismatch`, never silently dropped. */
  unbound?: boolean
}

export interface ScanResult {
  records: PeerRecord[]
  errors: string[]
}

export interface InboxResult {
  requests: InboundRequest[]
  errors: string[]
}

function rowToBead(row: { id: string; title: string; description?: string; notes?: string; priority?: number; external_ref?: string | null }, labels: string[]): BeadLike {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    notes: row.notes,
    priority: row.priority,
    external_ref: row.external_ref,
    labels,
  }
}

function admitRow(peer: MeshPeer, bead: BeadLike, out: PeerRecord[]): void {
  const env = envelopeFromBead(bead)
  if (env !== null) {
    out.push({ peer: peer.alias, peerRig: peer.rig, transport: peer.transport, envelope: env, beadId: bead.id })
  }
}

function scanReplica(dir: string, peer: MeshPeer, out: PeerRecord[], errors: string[]): void {
  const found = meshIssues(dir)
  if (found.error !== undefined) {
    errors.push(`${peer.alias}: ${found.error}`)
    return
  }
  for (const row of found.rows) {
    if (row.status === 'closed') {
      continue
    }
    const labels = issueLabels(dir, row.id)
    if (labels.error !== undefined) {
      errors.push(`${peer.alias}: labels for ${row.id} failed — ${labels.error}`)
      continue
    }
    admitRow(peer, rowToBead(row, labels.labels), out)
  }
}

/** beads-remote: sync the replica (clone||pull), query mesh-labelled
 *  issues, emit every envelope found. */
function scanRemote(gitCommon: string, peer: MeshPeer, out: PeerRecord[], errors: string[]): void {
  const synced = syncReplica(gitCommon, peer.alias, peer.remote)
  if (synced.path === undefined) {
    errors.push(synced.error ?? `${peer.alias}: replica sync failed`)
    return
  }
  scanReplica(synced.path, peer, out, errors)
}

/** local: read the peer's live store read-only — `bd -C <checkout>
 *  list --json` carries labels inline. A `local` peer needs no publish
 *  step — its working store is the source. `closedLocal` admits
 *  closed rows for the thread reduction (a closed request bead is a
 *  healthy anchored thread's terminal state — `done`'s ship needs the
 *  close as precondition); the inbox keeps the open-only filter. */
function scanLocal(
  peer: MeshPeer,
  out: PeerRecord[],
  errors: string[],
  closedLocal: boolean,
): void {
  const dir = localCheckout(peer.remote)
  if (dir === null) {
    errors.push(`${peer.alias}: local checkout ${peer.remote} does not resolve`)
    return
  }
  let rows: (BeadLike & { status?: string })[]
  try {
    // closedLocal needs the store's own all-filter off too — the
    // backend drops closed rows before this loop ever sees them
    rows = taskStore(dir).list<BeadLike & { status?: string }>({ all: closedLocal || undefined })
  } catch (err) {
    errors.push(
      `${peer.alias}: store list failed — ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }
  for (const row of rows) {
    if (row.status === 'closed' && !closedLocal) {
      continue
    }
    admitRow(peer, row, out)
  }
}

/** Pull + scan every configured peer — every mesh envelope, every
 *  kind. `pull:false` serves replica contents as they stand.
 *  `closedLocal:true` admits closed rows on `local` peers — the
 *  thread path needs the anchor past the worker's `bd close`. */
export function meshScan(
  dir: string,
  peers: MeshPeer[],
  gitCommon: string,
  opts: { pull?: boolean; closedLocal?: boolean } = {},
): ScanResult {
  const out: PeerRecord[] = []
  const errors: string[] = []
  for (const peer of peers) {
    if (peer.transport === 'local') {
      scanLocal(peer, out, errors, opts.closedLocal === true)
    } else if (opts.pull === false) {
      // serve the existing replica — an absent one is simply empty
      const dir = replicaDir(gitCommon, peer.alias)
      if (existsSync(dir)) {
        scanReplica(dir, peer, out, errors)
      }
    } else {
      scanRemote(gitCommon, peer, out, errors)
    }
  }
  return { records: out, errors }
}

/** The request filter over the scan — pending requests addressed to
 *  selfRig, provenance attached, from≠binding flagged. A thread the
 *  requester already verdicted is terminal, not pending; a verdict
 *  counts only when its from matches the peer binding — the same
 *  impersonation rule the thread reduction applies, so a forged
 *  accept can't quietly close somebody else's request. */
export function meshInbox(
  dir: string,
  peers: MeshPeer[],
  selfRig: string,
  gitCommon: string,
  opts: { pull?: boolean } = {},
): InboxResult {
  const { records, errors } = meshScan(dir, peers, gitCommon, opts)

  // own-store pass — `bro request` delivers the bead straight into the
  // recipient's store; no peer transport carries it, so a `from`
  // matching no binding is surfaced flagged `unbound`, like mismatch
  const bound = new Set(peers.map((p) => p.rig))
  try {
    const rows = taskStore(dir).list<BeadLike & { status?: string }>()
    for (const row of rows) {
      if (row.status === 'closed') {
        continue
      }
      const env = envelopeFromBead(row)
      if (env === null) {
        continue
      }
      records.push({
        peer: 'self',
        peerRig: env.from,
        transport: 'local',
        envelope: env,
        beadId: row.id,
      })
    }
  } catch (err) {
    errors.push(`self: store list failed — ${err instanceof Error ? err.message : String(err)}`)
  }

  const terminal = new Set<string>()
  for (const r of records) {
    if (
      (r.envelope.kind === 'accept' || r.envelope.kind === 'reject') &&
      r.envelope.from === r.peerRig
    ) {
      // thread ids are per-store — a verdict only closes requests that
      // arrived over the same binding, never a same-id thread on a peer
      terminal.add(`${r.peer}:${r.envelope.thread}`)
    }
  }
  const requests = records
    .filter(
      (r) =>
        r.envelope.kind === 'request' &&
        r.envelope.to === selfRig &&
        !terminal.has(`${r.peer}:${r.envelope.thread}`),
    )
    .map((r) => ({
      ...r,
      mismatch: r.peer !== 'self' && r.envelope.from !== r.peerRig,
      unbound: r.peer === 'self' && !bound.has(r.envelope.from) ? true : undefined,
    }))
  return { requests, errors }
}

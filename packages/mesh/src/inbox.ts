/**
 * mesh inbox — requests addressed to this rig across peers. Trust
 * (spec): the peer binding is provenance — a request surfaced from
 * remote alias X counts as coming from X's declared rig; the
 * envelope's `from` is display metadata, and a mismatch is flagged,
 * never trusted.
 */
import { spawnSync } from 'node:child_process'
import { envelopeFromBead, type BeadLike, type MeshEnvelope } from './envelope.ts'
import { existsSync } from 'node:fs'
import { localCheckout, type MeshPeer } from './peers.ts'
import { issueLabels, meshIssues, replicaDir, syncReplica } from './pull.ts'

export interface InboundRequest {
  /** The peer alias the request arrived over — the provenance. */
  peer: string
  /** The rig the binding declares for that alias. */
  peerRig: string
  envelope: MeshEnvelope
  /** envelope.from !== peer.rig — flagged, never trusted (spec Trust). */
  mismatch: boolean
  beadId: string
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

function admit(peer: MeshPeer, bead: BeadLike, selfRig: string, out: InboundRequest[]): void {
  const env = envelopeFromBead(bead)
  if (env === null || env.kind !== 'request' || env.to !== selfRig) {
    return
  }
  out.push({ peer: peer.alias, peerRig: peer.rig, envelope: env, mismatch: env.from !== peer.rig, beadId: bead.id })
}

function scanReplica(dir: string, peer: MeshPeer, selfRig: string, out: InboundRequest[], errors: string[]): void {
  const found = meshIssues(dir)
  if (found.error !== undefined) {
    errors.push(`${peer.alias}: ${found.error}`)
    return
  }
  for (const row of found.rows) {
    if (row.status === 'closed') {
      continue
    }
    admit(peer, rowToBead(row, issueLabels(dir, row.id)), selfRig, out)
  }
}

/** beads-remote: sync the replica (clone||pull), query mesh-labelled
 *  issues, admit those addressed to selfRig. */
function inboxReplica(gitCommon: string, peer: MeshPeer, selfRig: string, out: InboundRequest[], errors: string[]): void {
  const synced = syncReplica(gitCommon, peer.alias, peer.remote)
  if (synced.path === undefined) {
    errors.push(synced.error ?? `${peer.alias}: replica sync failed`)
    return
  }
  scanReplica(synced.path, peer, selfRig, out, errors)
}

/** local: read the peer's live store read-only — `bd -C <checkout>
 *  list --json` carries labels inline. A `local` peer needs no publish
 *  step — its working store is the source. */
function inboxLocal(peer: MeshPeer, selfRig: string, out: InboundRequest[], errors: string[]): void {
  const dir = localCheckout(peer.remote)
  if (dir === null) {
    errors.push(`${peer.alias}: local checkout ${peer.remote} does not resolve`)
    return
  }
  const p = spawnSync('bd', ['-C', dir, 'list', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (p.status !== 0) {
    errors.push(`${peer.alias}: bd list failed — ${(p.stderr ?? '').trim() || 'exit ' + p.status}`)
    return
  }
  let rows: (BeadLike & { status?: string })[]
  try {
    rows = JSON.parse(p.stdout ?? '[]') as typeof rows
  } catch {
    errors.push(`${peer.alias}: bd list returned unparseable json`)
    return
  }
  for (const row of rows) {
    if (row.status === 'closed') {
      continue
    }
    admit(peer, row, selfRig, out)
  }
}

/** Pull + scan every configured peer. `pull:false` serves replica
 *  contents as they stand — the offline/inbox-only read. */
export function meshInbox(
  dir: string,
  peers: MeshPeer[],
  selfRig: string,
  gitCommon: string,
  opts: { pull?: boolean } = {},
): InboxResult {
  const out: InboundRequest[] = []
  const errors: string[] = []
  for (const peer of peers) {
    if (peer.transport === 'local') {
      inboxLocal(peer, selfRig, out, errors)
    } else if (opts.pull === false) {
      // serve the existing replica — an absent one is simply empty
      const dir = replicaDir(gitCommon, peer.alias)
      if (existsSync(dir)) {
        scanReplica(dir, peer, selfRig, out, errors)
      }
    } else {
      inboxReplica(gitCommon, peer, selfRig, out, errors)
    }
  }
  return { requests: out, errors }
}

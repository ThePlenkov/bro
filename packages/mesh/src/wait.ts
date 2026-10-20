/**
 * Dep-plane wait reads (specs/cross-repo/bro-y5zcw) — the state an
 * `external:<rig>:<id>` dep's watcher polls. Read-only by
 * construction: no claim, no close, no ship — a write into the peer
 * plane would be a sovereignty violation on top of the read contract.
 *
 * Three stores matter and they are deliberately not one path:
 *   posting store — where the transport put the request bead: the
 *     peer's live checkout on a `local` binding, the requester's own
 *     store on `beads-remote` (the peer pulls it; the replica never
 *     carries it)
 *   peer plane — the foreign store the dep names, where `bd ship`'s
 *     closed `provides:<capability>` lands: the same checkout on
 *     `local`, the dolt replica on `beads-remote`
 *   thread plane — `bro mesh wait`'s reduction, reused for the
 *     stage/turn annotation and the reject-verdict check
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { taskStore } from '@broject/core'
import { formatRigUri, parseRigUri } from './identity.ts'
import { type MeshPeer } from './peers.ts'
import { storeFor } from './post.ts'
import { CAPABILITY_RE, replicaAgeMs, replicaDir, shippedIssues } from './pull.ts'

export interface ExternalRef {
  /** the dep's project slot — a canonical mesh:// rig uri */
  rig: string
  /** the capability — the request bead id the dep names */
  id: string
}

/** `external:<project>:<capability>` — the rig uri carries its own
 *  colon, so the split is on the LAST colon after the `external:`
 *  prefix and the project half must `parseRigUri`. Anything else is
 *  not an external dep ref — `bro mesh wait <thread>` is the
 *  thread-plane read the caller is holding instead. */
export function parseExternalRef(arg: string): ExternalRef | null {
  if (!arg.startsWith('external:')) {
    return null
  }
  const rest = arg.slice('external:'.length)
  const colon = rest.lastIndexOf(':')
  if (colon <= 0 || colon === rest.length - 1) {
    return null
  }
  const rig = parseRigUri(rest.slice(0, colon))
  const id = rest.slice(colon + 1)
  // the capability interpolates into replica SQL (shippedIssues) — a
  // token charset keeps the ref honest at the boundary: anything
  // wilder is a bad ref, not something a poll could ever settle
  if (rig === null || !CAPABILITY_RE.test(id)) {
    return null
  }
  return { rig: formatRigUri(rig), id }
}

export interface WaitPlane {
  /** the binding the dep's rig resolved through */
  peer: MeshPeer
  /** the directory the request bead is read from — the peer's
   *  checkout path on `local`, our own dir on `beads-remote` */
  postDir: string
  /** true when postDir is a foreign checkout — the read must pin its
   *  `.beads` over any ambient BEADS_DIR (storeFor) */
  postForeign: boolean
  /** the peer plane — the foreign store the dep's ship rule reads */
  peerDir: string
  /** true when the peer plane is a dolt replica: best-effort (its
   *  verdicts carry the source and the replica's age), never synced
   *  here — sync is not the watcher's job */
  replica: boolean
}

/** `file://` unwrap without localCheckout's existence check — a gone
 *  checkout is a poll-time read failure (unreadable), not a binding
 *  failure. */
function peerPath(remote: string): string {
  return remote.startsWith('file://') ? remote.slice('file://'.length) : remote
}

/** The dep's rig → the plane it reads. No binding for the rig is a
 *  config error, not a wait: polling a plane that cannot exist would
 *  report "still waiting" forever — the caller exits 2 naming it. */
export function resolveWaitPlane(
  dir: string,
  peers: MeshPeer[],
  rig: string,
  gitCommon: string,
): WaitPlane | undefined {
  const peer = peers.find((p) => p.rig === rig)
  if (peer === undefined) {
    return undefined
  }
  if (peer.transport === 'local') {
    const checkout = peerPath(peer.remote)
    return { peer, postDir: checkout, postForeign: true, peerDir: checkout, replica: false }
  }
  return {
    peer,
    postDir: dir,
    postForeign: false,
    peerDir: replicaDir(gitCommon, peer.alias),
    replica: true,
  }
}

export interface DepRead {
  /** the request bead on the posting store: a row, `null` when absent
   *  (a bad ref — the transport says where it must land and it is not
   *  there), `undefined` when the store itself could not be read */
  request?: { id: string; status?: string; labels?: string[] } | null
  /** closed `provides:<id>` on the peer plane — undefined when the
   *  plane could not be read */
  shipped?: boolean
  /** the replica's age — set only on replica planes, undefined when
   *  the replica is absent entirely */
  replicaAgeMs?: number
  /** every read failure this pass observed — transient by verdict:
   *  the wait tolerates consecutive failures before settling
   *  `unreadable` */
  errors: string[]
}

/** The ship rule on a `local` peer: `bd -C <checkout>` answers the
 *  closed `provides:<id>` row the inbox scan structurally cannot
 *  return (it drops closed rows). */
function shippedOnCheckout(checkout: string, id: string): { shipped?: boolean; error?: string } {
  if (!existsSync(checkout)) {
    return { error: `local checkout ${checkout} does not resolve` }
  }
  try {
    const rows = storeFor(checkout).list<{ id: string; status?: string }>({
      labels: [`provides:${id}`],
      all: true,
      limit: 0,
    })
    return { shipped: rows.some((r) => r.status === 'closed') }
  } catch (err) {
    return { error: `store list failed — ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** One poll over the dep's two stores — the posting store's request
 *  bead (status/labels) and the peer plane's ship predicate. Errors
 *  collect into `errors`; a failed read never fakes a row. */
export function readDepState(plane: WaitPlane, id: string): DepRead {
  const out: DepRead = { errors: [] }

  try {
    const store = plane.postForeign ? storeFor(plane.postDir) : taskStore(plane.postDir)
    out.request =
      store.get<{ id: string; status?: string; labels?: string[] }>(id) ?? null
  } catch (err) {
    out.errors.push(
      `${plane.peer.alias}: posting store unreadable — ` +
        (err instanceof Error ? err.message : String(err)),
    )
  }

  const shipped = plane.replica
    ? existsSync(join(plane.peerDir, '.dolt'))
      ? shippedIssues(plane.peerDir, id)
      : { error: `replica ${plane.peerDir} absent — \`bro mesh pull\` materializes it` }
    : shippedOnCheckout(plane.peerDir, id)
  if (shipped.error !== undefined) {
    out.errors.push(`${plane.peer.alias}: ${shipped.error}`)
  } else {
    out.shipped = shipped.shipped === true
  }
  if (plane.replica) {
    out.replicaAgeMs = replicaAgeMs(plane.peerDir)
  }
  return out
}

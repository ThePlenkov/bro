/**
 * Remote-plane delivery (specs/cross-repo/bro-kim1e) — `bro request`
 * to a `github` or `wasteland` peer posts the record over the
 * transport's own channel AND mirrors a request bead into the
 * requester's own store. The mirror is what bd tracks locally; its
 * `external_ref` is the remote thread (issue url / `w-<hash>`) — the
 * single field the thread is recovered through.
 *
 * No `external:` dep is wired on either plane: bd 1.3.1 has no
 * query-time resolution for external refs, an `external:` ref whose
 * project slot carries a `mesh://` uri mis-parses into project=`mesh`
 * (bd splits on the first colon), and a github issue / wasteland row
 * is not a beads store the resolver could open anyway. The mirror is
 * tracked, the thread is waited on — `bro mesh wait <thread>`.
 */
import { postRequest } from './github.ts'
import { postWanted } from './wasteland.ts'
import { postEnvelope } from './post.ts'
import type { MeshPeer } from './peers.ts'
import type { MeshRef } from './envelope.ts'

export interface RemoteDeliverInput {
  from: string
  title: string
  body?: string
  refs?: MeshRef[]
  priority?: number
}

export interface RemoteDeliverResult {
  /** the remote thread id — issue url on github, `w-<hash>` on
   *  wasteland — what `bro mesh wait` reduces */
  thread?: string
  /** the mirror bead in the requester's own store */
  mirror?: string
  error?: string
}

function mirror(dir: string, input: RemoteDeliverInput & { to: string }, externalRef: string): { id?: string; error?: string } {
  return postEnvelope({
    dir,
    kind: 'request',
    thread: '',
    from: input.from,
    to: input.to,
    title: input.title,
    body: input.body,
    refs: input.refs,
    priority: input.priority,
    externalRef,
  })
}

/** github: prose issue + `request` record comment on the peer's repo,
 *  mirror bead in ours. */
export function deliverGithub(
  dir: string,
  peer: MeshPeer,
  input: RemoteDeliverInput,
): RemoteDeliverResult {
  const posted = postRequest(peer.remote, { ...input, to: peer.rig })
  if (posted.error !== undefined || posted.issueHtmlUrl === undefined) {
    return { error: posted.error ?? 'issue posted but returned no url' }
  }
  const m = mirror(dir, { ...input, to: peer.rig }, posted.issueHtmlUrl)
  if (m.error !== undefined) {
    return { error: `issue ${posted.issueHtmlUrl} posted but the mirror bead failed — ${m.error}` }
  }
  return { thread: posted.issueHtmlUrl, mirror: m.id }
}

/** wasteland: `wl post` onto the commons board (fork-and-propose),
 *  mirror bead in ours. */
export function deliverWasteland(
  dir: string,
  peer: MeshPeer,
  input: RemoteDeliverInput,
): RemoteDeliverResult {
  const posted = postWanted(peer.remote, input)
  if (posted.error !== undefined || posted.id === undefined) {
    return { error: posted.error ?? 'wanted posted but returned no id' }
  }
  const m = mirror(dir, { ...input, to: peer.rig }, posted.id)
  if (m.error !== undefined) {
    return { error: `wanted ${posted.id} posted but the mirror bead failed — ${m.error}` }
  }
  return { thread: posted.id, mirror: m.id }
}

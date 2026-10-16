/**
 * Envelope publishing — every mesh record is a task on the LOCAL
 * store. Sovereignty is structural: the write path only ever targets
 * the store `dir` resolves; a foreign store is reached by the peer
 * pulling our refs/dolt/data, never by us writing it.
 *
 * The task id is assigned by `create`, and a request's thread IS that
 * id — so labels land in a follow-up `update` once the id exists.
 */
import { taskStore } from '@broject/core'
import { envelopeLabels, type MeshEnvelope, type MeshKind, type MeshRef } from './envelope.ts'
import { beadUri } from './envelope.ts'

export interface PostInput {
  dir: string
  kind: MeshKind
  thread: string
  from: string
  to: string
  title: string
  body?: string
  refs?: MeshRef[]
  priority?: number
  evidence?: MeshRef[]
  /** labels beyond the envelope set — delivery pins `export:<id>` so a
   *  later `bd ship` finds the bead; resolved after create, when the
   *  id exists, so entries may interpolate `{id}`. */
  extraLabels?: string[]
  /** rig the external_ref URI names — defaults to `from`, the author =
   *  store owner case. Delivery overrides it with the target rig: the
   *  bead lives in the TARGET's store, so its beads:// address is the
   *  target's, not the requester's. */
  beadRig?: string
}

export interface PostResult {
  id?: string
  error?: string
}

/** Create the task, then pin the mesh label set + the beads:// uri as
 *  its external_ref. The second step failing leaves a plain task — an
 *  incomplete record, so the error is reported, not swallowed. */
export function postEnvelope(input: PostInput): PostResult {
  const store = taskStore(input.dir)
  let id: string
  try {
    id = store
      .create({
        title: input.title,
        description: input.body ?? '',
        type: 'task',
        priority: input.priority ?? 2,
      })
      .id
  } catch (err) {
    return { error: `store create failed — ${err instanceof Error ? err.message : String(err)}` }
  }

  const env: MeshEnvelope = {
    v: 'mesh/1',
    id,
    kind: input.kind,
    // a request threads to itself — its task id IS the thread
    thread: input.kind === 'request' ? id : input.thread,
    from: input.from,
    to: input.to,
    title: input.title,
    body: input.body ?? '',
    refs: input.refs ?? [],
    terms: {},
    evidence: input.evidence ?? [],
  }
  const labels = [
    ...envelopeLabels(env),
    ...(input.extraLabels ?? []).map((l) => l.replaceAll('{id}', id)),
  ]
  try {
    store.update(id, {
      'set-labels': labels.join(','),
      'external-ref': beadUri(input.beadRig ?? input.from, id),
    })
  } catch (err) {
    return {
      error:
        `task ${id} created but label pin failed — ` +
        (err instanceof Error ? err.message : String(err)),
    }
  }
  return { id }
}

/** Block a local task on a posted request: `link(waiting,
 *  external:<rig>:<id>, 'blocked')` — the rig URI goes into the
 *  project slot verbatim; the store keeps external edges as-is and
 *  resolves them at query time. Returns an error message, undefined
 *  on success. */
export function wireDep(
  dir: string,
  waiting: string,
  toRig: string,
  requestId: string
): string | undefined {
  try {
    taskStore(dir).link(waiting, `external:${toRig}:${requestId}`, 'blocked')
    return undefined
  } catch (err) {
    return `store link failed — ${err instanceof Error ? err.message : String(err)}`
  }
}

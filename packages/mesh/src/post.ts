/**
 * Envelope publishing — every mesh record is a bead on the LOCAL
 * store. Sovereignty is structural: the write path only ever targets
 * `bd -C <ownDir>`; a foreign store is reached by the peer pulling our
 * refs/dolt/data, never by us writing it.
 *
 * The bead id is assigned by `bd create`, and a request's thread IS
 * that id — so labels land in a follow-up `bd update --set-labels`
 * once the id exists.
 */
import { spawnSync } from 'node:child_process'
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
}

export interface PostResult {
  id?: string
  error?: string
}

function bd(dir: string, args: string[]): { code: number; out: string; err: string } {
  const p = spawnSync('bd', ['-C', dir, ...args], {  // NOSONAR — PATH lookup is the contract (same as core/git.ts)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return { code: p.status ?? 1, out: p.stdout ?? '', err: (p.stderr ?? '').trim() }
}

/** Create the bead, then pin the mesh label set + the beads:// uri as
 *  its external_ref. The second step failing leaves a plain bead — an
 *  incomplete record, so the error is reported, not swallowed. */
export function postEnvelope(input: PostInput): PostResult {
  const create = bd(input.dir, [
    'create',
    '--title', input.title,
    '--description', input.body ?? '',
    '--type', 'task',
    '--priority', String(input.priority ?? 2),
    '--json',
  ])
  if (create.code !== 0) {
    return { error: `bd create failed — ${create.err || create.out}` }
  }
  let id: string
  try {
    id = (JSON.parse(create.out) as { id: string }).id
  } catch {
    return { error: `bd create returned unparseable json` }
  }

  const env: MeshEnvelope = {
    v: 'mesh/1',
    id,
    kind: input.kind,
    // a request threads to itself — its bead id IS the thread
    thread: input.kind === 'request' ? id : input.thread,
    from: input.from,
    to: input.to,
    title: input.title,
    body: input.body ?? '',
    refs: input.refs ?? [],
    terms: {},
    evidence: input.evidence ?? [],
  }
  const labels = envelopeLabels(env)
  const upd = bd(input.dir, [
    'update', id,
    '--set-labels', labels.join(','),
    '--external-ref', beadUri(input.from, id),
  ])
  if (upd.code !== 0) {
    return { error: `bead ${id} created but label pin failed — ${upd.err || upd.out}` }
  }
  return { id }
}

/** Block a local bead on a posted request: `bd dep add <waiting>
 *  external:<rig>:<id>` — the rig URI goes into the project slot
 *  verbatim; bd stores external edges as-is and resolves them at
 *  query time. Returns an error message, undefined on success. */
export function wireDep(dir: string, waiting: string, toRig: string, requestId: string): string | undefined {
  const dep = bd(dir, ['dep', 'add', waiting, `external:${toRig}:${requestId}`])
  return dep.code === 0 ? undefined : `bd dep add failed — ${dep.err || dep.out}`
}

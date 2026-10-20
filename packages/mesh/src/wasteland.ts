/**
 * wasteland transport — adapter over the `wl` CLI
 * (specs/cross-repo/bro-kim1e). The commons board is the queue and the
 * `wanted.id` (`w-<hash>`) is the thread id — board-native, never a
 * translation of the requester-side bead id. A rig joins by forking;
 * reads ALWAYS come from the commons database (`--remote-base`), never
 * from the rig's own fork — a fork read reports the claim you already
 * made.
 *
 * `wl` is absent on most machines: every call degrades to an error
 * line naming the binary — the fail-open policy `syncReplica` uses
 * for an unfetchable peer. The adapter is a projection, not a
 * translation: reputation stamps and the board's own vocabulary
 * (project / type / effort / tags) stay board-local.
 */
import { spawnSync } from 'node:child_process'
import { MESH_VERSION, type MeshEnvelope, type MeshRef } from './envelope.ts'
import { formatRigUri, parseRigUri } from './identity.ts'

export interface WlResult {
  code: number
  out: string
  err: string
}

function wl(args: string[]): WlResult {
  const p = spawnSync('wl', args, { // NOSONAR — PATH lookup is the contract (same as pull.ts's dolt)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const err = (p.stderr ?? p.error?.message ?? '').trim()
  return {
    code: p.status ?? 1,
    out: p.stdout ?? '',
    err: p.error !== undefined ? `wl unreachable — ${err || 'binary not found'}` : err,
  }
}

/** `wl` takes the commons address through `--remote-base`; the peer
 *  remote is configured as `wl://<org>/<commons>` (or `wasteland://`)
 *  and the scheme is what the transport derivation keys on. A bare
 *  remote passes verbatim. */
function remoteBase(remote: string): string {
  return remote.replace(/^(?:wl|wasteland):\/\//, '')
}

function remoteArgs(remote: string): string[] {
  const base = remoteBase(remote)
  return base === '' ? [] : ['--remote-base', base]
}

/** terms.priority `pN` ↔ the board's 0–4 integer column — same scale,
 *  different dress. */
export function boardPriority(term: string | undefined): number | undefined {
  const m = /^p([0-4])$/.exec(term ?? '')
  return m === null ? undefined : Number(m[1])
}

export function termPriority(priority: number | undefined): string | undefined {
  return priority === undefined ? undefined : `p${Math.max(0, Math.min(4, Math.trunc(priority)))}`
}

/** `posted_by`/`claimed_by` are wasteland rig handles — `org/name`
 *  form maps straight to `mesh://org/name`; a bare handle lives in the
 *  commons namespace as `mesh://wasteland/<handle>`. Anything else is
 *  unprojectable — the caller reports the row, never invents a rig. */
export function handleToRig(handle: string | undefined): string | null {
  if (typeof handle !== 'string' || handle === '') {
    return null
  }
  const direct = parseRigUri(`mesh://${handle}`)
  if (direct !== null) {
    return formatRigUri(direct)
  }
  return /^[A-Za-z0-9_.-]+$/.test(handle) ? `mesh://wasteland/${handle.toLowerCase()}` : null
}

/** The board's `wanted` row — a superset of the fields the projection
 *  reads; board-local vocabulary (project / type / effort / tags) is
 *  carried through untouched. */
export interface WantedRow {
  id: string
  title: string
  description?: string
  priority?: number
  posted_by?: string
  status?: string
  claimed_by?: string
  project?: string
  type?: string
  effort_level?: string
  tags?: string[]
  completions?: { evidence?: string; state?: string }[]
}

/** Board row → the mesh records its state implies: a request always,
 *  a claim when `claimed_by` is set, a result when a completion row
 *  carries evidence, and the verdict when the board marks it accepted
 *  or rejected. `to` is the projection's only judgement — an open row
 *  is addressed to the reader (selfRig, the claimable-work surface);
 *  anything past open is addressed back to the poster, who owes the
 *  verdict. */
export function projectWanted(row: WantedRow, selfRig: string | undefined): { envelopes: MeshEnvelope[]; errors: string[] } {
  const envelopes: MeshEnvelope[] = []
  const errors: string[] = []
  const poster = handleToRig(row.posted_by)
  if (poster === null) {
    errors.push(`${row.id}: posted_by "${row.posted_by ?? ''}" is not a rig handle`)
    return { envelopes, errors }
  }
  const open = row.status === undefined || row.status === 'open'
  const addressedTo = open && selfRig !== undefined ? selfRig : poster
  const base = {
    v: MESH_VERSION,
    thread: row.id,
    title: row.title,
    body: row.description ?? '',
    refs: [] as MeshRef[],
    evidence: [] as MeshRef[],
  }
  envelopes.push({
    ...base,
    id: row.id,
    kind: 'request',
    from: poster,
    to: addressedTo,
    terms: termPriority(row.priority) === undefined ? {} : { priority: termPriority(row.priority) },
  })
  const claimer = handleToRig(row.claimed_by)
  if (row.claimed_by !== undefined && row.claimed_by !== '') {
    if (claimer === null) {
      errors.push(`${row.id}: claimed_by "${row.claimed_by}" is not a rig handle`)
    } else {
      envelopes.push({ ...base, id: `${row.id}#claim`, kind: 'claim', from: claimer, to: poster, terms: {} })
    }
  }
  const done = (row.completions ?? []).find((c) => c.evidence !== undefined)
  const verdict = (row.completions ?? []).find((c) => c.state === 'accepted' || c.state === 'rejected')
  if (done !== undefined && claimer !== null) {
    envelopes.push({
      ...base,
      id: `${row.id}#result`,
      kind: 'result',
      from: claimer!,
      to: poster,
      terms: {},
      evidence: [{ kind: 'url', ref: done.evidence! }],
    })
  }
  if (verdict !== undefined) {
    envelopes.push({
      ...base,
      id: `${row.id}#${verdict.state === 'accepted' ? 'accept' : 'reject'}`,
      kind: verdict.state === 'accepted' ? 'accept' : 'reject',
      from: poster,
      to: claimer ?? poster,
      terms: {},
    })
  } else if (row.status === 'completed' && claimer !== null) {
    envelopes.push({ ...base, id: `${row.id}#accept`, kind: 'accept', from: poster, to: claimer!, terms: {} })
  }
  return { envelopes, errors }
}

function wlJson<T>(args: string[]): { data?: T; error?: string } {
  const r = wl(args)
  if (r.code !== 0) {
    return { error: r.err || r.out }
  }
  try {
    return { data: JSON.parse(r.out) as T }
  } catch {
    return { error: 'wl returned unparseable json' }
  }
}

/** Post a wanted item — `wl post` goes to the fork and proposes
 *  (PR mode); the returned `w-<hash>` is the thread id. */
export function postWanted(
  remote: string,
  input: { title: string; body?: string; priority?: number },
): { id?: string; error?: string } {
  const args = [...remoteArgs(remote), 'post', '--title', input.title]
  if (input.body !== undefined && input.body !== '') {
    args.push('--description', input.body)
  }
  if (input.priority !== undefined) {
    args.push('--priority', String(input.priority))
  }
  args.push('--json')
  const r = wlJson<{ id?: string }>(args)
  if (r.error !== undefined) {
    return { error: `wl post failed — ${r.error}` }
  }
  const id = r.data?.id
  return typeof id === 'string' && id !== '' ? { id } : { error: 'wl post returned no wanted id' }
}

export function claimWanted(remote: string, id: string): { error?: string } {
  const r = wl([...remoteArgs(remote), 'claim', id])
  return r.code === 0 ? {} : { error: `wl claim ${id} failed — ${r.err || r.out}` }
}

export function completeWanted(remote: string, id: string, evidence?: MeshRef[]): { error?: string } {
  const args = [...remoteArgs(remote), 'done', id]
  const ev = evidence?.find((e) => e.kind === 'url' || e.kind === 'pr')?.ref
  if (ev !== undefined) {
    args.push('--evidence', ev)
  }
  const r = wl(args)
  return r.code === 0 ? {} : { error: `wl done ${id} failed — ${r.err || r.out}` }
}

export function acceptWanted(remote: string, id: string): { error?: string } {
  const r = wl([...remoteArgs(remote), 'accept', id])
  return r.code === 0 ? {} : { error: `wl accept ${id} failed — ${r.err || r.out}` }
}

export function rejectWanted(remote: string, id: string, body?: string): { error?: string } {
  const args = [...remoteArgs(remote), 'reject', id]
  if (body !== undefined && body !== '') {
    args.push('--reason', body)
  }
  const r = wl(args)
  return r.code === 0 ? {} : { error: `wl reject ${id} failed — ${r.err || r.out}` }
}

/** The open board — `wl browse --json` over the commons, never the
 *  fork. Rows are returned raw; `projectWanted` turns them into the
 *  records the thread reduction reads. */
export function browseWanted(remote: string): { rows: WantedRow[]; error?: string } {
  const r = wlJson<WantedRow[] | { rows?: WantedRow[] }>([...remoteArgs(remote), 'browse', '--json', '--limit', '500'])
  if (r.error !== undefined) {
    return { rows: [], error: `wl browse failed — ${r.error}` }
  }
  const rows = Array.isArray(r.data) ? r.data : (r.data?.rows ?? [])
  return { rows: rows.filter((w) => typeof w.id === 'string' && typeof w.title === 'string') }
}

/** One thread's board row — `wl status <id> --json` over the commons. */
export function wantedStatus(remote: string, id: string): { row?: WantedRow; error?: string } {
  const r = wlJson<WantedRow>([...remoteArgs(remote), 'status', id, '--json'])
  if (r.error !== undefined) {
    return { error: `wl status ${id} failed — ${r.error}` }
  }
  return typeof r.data?.id === 'string' ? { row: r.data } : { error: `wl status ${id} returned no row` }
}

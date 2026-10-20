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
import { MESH_VERSION, priorityTerm, type MeshEnvelope, type MeshRef } from './envelope.ts'
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
  const stdout: unknown = p.stdout
  const stderr: unknown = p.stderr
  const err = (p.error !== undefined ? p.error.message : typeof stderr === 'string' ? stderr : '').trim()
  return {
    code: p.status ?? 1,
    out: typeof stdout === 'string' ? stdout : '',
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
  return priority === undefined ? undefined : priorityTerm(priority)
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
  const poster = handleToRig(row.posted_by)
  if (poster === null) {
    return { envelopes: [], errors: [`${row.id}: posted_by "${row.posted_by ?? ''}" is not a rig handle`] }
  }
  const claimer = handleToRig(row.claimed_by)
  const errors =
    row.claimed_by !== undefined && row.claimed_by !== '' && claimer === null
      ? [`${row.id}: claimed_by "${row.claimed_by}" is not a rig handle`]
      : []
  const ctx: BoardCtx = {
    base: {
      v: MESH_VERSION,
      thread: row.id,
      title: row.title,
      body: row.description ?? '',
      refs: [] as MeshRef[],
      evidence: [] as MeshRef[],
    },
    poster,
    claimer,
  }
  return {
    envelopes: [
      projectRequest(row, ctx, selfRig),
      ...projectClaim(row, ctx),
      ...projectCompletion(row, ctx),
    ],
    errors,
  }
}

type BoardBase = Pick<MeshEnvelope, 'v' | 'thread' | 'title' | 'body' | 'refs' | 'evidence'>

interface BoardCtx {
  base: BoardBase
  poster: string
  claimer: string | null
}

/** The open-row request — `to` is the projection's only judgement:
 *  an open row is addressed to the reader (selfRig, the claimable-work
 *  surface); anything past open is addressed back to the poster. */
function projectRequest(row: WantedRow, ctx: BoardCtx, selfRig: string | undefined): MeshEnvelope {
  const priority = termPriority(row.priority)
  const open = row.status === undefined || row.status === 'open'
  return {
    ...ctx.base,
    id: row.id,
    kind: 'request',
    from: ctx.poster,
    to: open && selfRig !== undefined ? selfRig : ctx.poster,
    terms: priority === undefined ? {} : { priority },
  }
}

function projectClaim(row: WantedRow, ctx: BoardCtx): MeshEnvelope[] {
  return ctx.claimer === null
    ? []
    : [{ ...ctx.base, id: `${row.id}#claim`, kind: 'claim' as const, from: ctx.claimer, to: ctx.poster, terms: {} }]
}

/** The post-claim rows: a completion carrying evidence is the result
 *  record; an accepted/rejected completion row is the verdict; a
 *  completed board status with no verdict row reads as the accept. */
function projectCompletion(row: WantedRow, ctx: BoardCtx): MeshEnvelope[] {
  const evidence = (row.completions ?? [])
    .flatMap((c) => (typeof c.evidence === 'string' && c.evidence !== '' ? [c.evidence] : []))
    .at(0)
  const result =
    evidence !== undefined && ctx.claimer !== null
      ? [{
          ...ctx.base,
          id: `${row.id}#result`,
          kind: 'result' as const,
          from: ctx.claimer,
          to: ctx.poster,
          terms: {},
          evidence: [{ kind: 'url' as const, ref: evidence }],
        }]
      : []
  return [...result, ...projectVerdict(row, ctx)]
}

/** The verdict row: an accepted/rejected completion is it; a
 *  `completed` status with none still reads as the accept. */
function projectVerdict(row: WantedRow, ctx: BoardCtx): MeshEnvelope[] {
  const verdict = (row.completions ?? []).find((c) => c.state === 'accepted' || c.state === 'rejected')
  if (verdict !== undefined) {
    const kind = verdict.state === 'accepted' ? 'accept' : 'reject'
    return [{ ...ctx.base, id: `${row.id}#${kind}`, kind, from: ctx.poster, to: ctx.claimer ?? ctx.poster, terms: {} }]
  }
  return row.status === 'completed' && ctx.claimer !== null
    ? [{ ...ctx.base, id: `${row.id}#accept`, kind: 'accept' as const, from: ctx.poster, to: ctx.claimer, terms: {} }]
    : []
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

/** A wanted item's coordinate — board remote + `w-<hash>` id; the two
 *  ride every lifecycle verb together, so they travel as one record. */
export interface WlTarget {
  remote: string
  id: string
}

/** Post a wanted item — `wl post` goes to the fork and proposes
 *  (PR mode); the returned `w-<hash>` is the thread id. */
export function postWanted(
  input: { remote: string; title: string; body?: string; priority?: number },
): { id?: string; error?: string } {
  const args = [
    ...remoteArgs(input.remote),
    'post',
    '--title',
    input.title,
    ...(input.body !== undefined && input.body !== '' ? ['--description', input.body] : []),
    ...(input.priority === undefined
      ? []
      : ['--priority', String(Math.max(0, Math.min(4, Math.trunc(input.priority))))]),
    '--json',
  ]
  const r = wlJson<{ id?: string }>(args)
  if (r.error !== undefined) {
    return { error: `wl post failed — ${r.error}` }
  }
  const id = r.data?.id
  return typeof id === 'string' && id !== '' ? { id } : { error: 'wl post returned no wanted id' }
}

export function claimWanted(t: WlTarget): { error?: string } {
  const r = wl([...remoteArgs(t.remote), 'claim', t.id])
  return r.code === 0 ? {} : { error: `wl claim ${t.id} failed — ${r.err || r.out}` }
}

export function completeWanted(t: WlTarget & { evidence?: MeshRef[] }): { error?: string } {
  const args = [...remoteArgs(t.remote), 'done', t.id]
  const ev = t.evidence?.find((e) => e.kind === 'url' || e.kind === 'pr')?.ref
  if (ev !== undefined) {
    args.push('--evidence', ev)
  }
  const r = wl(args)
  return r.code === 0 ? {} : { error: `wl done ${t.id} failed — ${r.err || r.out}` }
}

export function acceptWanted(t: WlTarget): { error?: string } {
  const r = wl([...remoteArgs(t.remote), 'accept', t.id])
  return r.code === 0 ? {} : { error: `wl accept ${t.id} failed — ${r.err || r.out}` }
}

export function rejectWanted(t: WlTarget & { body?: string }): { error?: string } {
  const args = [...remoteArgs(t.remote), 'reject', t.id]
  if (t.body !== undefined && t.body !== '') {
    args.push('--reason', t.body)
  }
  const r = wl(args)
  return r.code === 0 ? {} : { error: `wl reject ${t.id} failed — ${r.err || r.out}` }
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
export function wantedStatus(t: WlTarget): { row?: WantedRow; error?: string } {
  const r = wlJson<WantedRow>([...remoteArgs(t.remote), 'status', t.id, '--json'])
  if (r.error !== undefined) {
    return { error: `wl status ${t.id} failed — ${r.error}` }
  }
  return typeof r.data?.id === 'string' ? { row: r.data } : { error: `wl status ${t.id} returned no row` }
}

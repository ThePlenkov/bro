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
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import {
  MESH_VERSION,
  type MeshEnvelope,
  type MeshKind,
  type MeshRef,
  priorityTerm,
} from './envelope.ts';
import { formatRigUri, parseRigUri } from './identity.ts';

export interface WlResult {
  code: number;
  out: string;
  err: string;
}

function getSpawnError(p: ReturnType<typeof spawnSync>): string {
  if (p.error !== undefined) {
    return typeof p.error.message === 'string' ? p.error.message : '';
  }
  const stderr: unknown = p.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

function getSpawnOutput(p: ReturnType<typeof spawnSync>): string {
  const stdout: unknown = p.stdout;
  return typeof stdout === 'string' ? stdout : '';
}

function wl(call: { args: string[] }): WlResult {
  const opts: SpawnSyncOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  };
  // PATH lookup is the contract (same as pull.ts's dolt)
  const p = spawnSync('wl', call.args, opts); // NOSONAR
  const err = getSpawnError(p).trim();
  const out = getSpawnOutput(p);
  if (p.error !== undefined) {
    return {
      code: p.status ?? 1,
      out,
      err: `wl unreachable — ${err || 'binary not found'}`,
    };
  }
  return {
    code: p.status ?? 1,
    out,
    err,
  };
}

/** `wl` takes the commons address through `--remote-base`; the peer
 *  remote is configured as `wl://<org>/<commons>` (or `wasteland://`)
 *  and the scheme is what the transport derivation keys on. A bare
 *  remote passes verbatim. */
function remoteBase(remote: string): string {
  return remote.replace(/^(?:wl|wasteland):\/\//, '');
}

function remoteArgs(remote: string): string[] {
  const base = remoteBase(remote);
  return base === '' ? [] : ['--remote-base', base];
}

/** terms.priority `pN` ↔ the board's 0–4 integer column — same scale,
 *  different dress. */
export function boardPriority(term: string | undefined): number | undefined {
  const m = /^p([0-4])$/.exec(term ?? '');
  return m === null ? undefined : Number(m[1]);
}

export function termPriority(priority: number | undefined): string | undefined {
  return priority === undefined ? undefined : priorityTerm(priority);
}

function isHandleString(handle: string | undefined): handle is string {
  return typeof handle === 'string' && handle !== '';
}

function tryDirectMeshHandle(handle: string): string | null {
  const direct = parseRigUri(`mesh://${handle}`);
  return direct === null ? null : formatRigUri(direct);
}

function isBareHandle(handle: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(handle);
}

/** `posted_by`/`claimed_by` are wasteland rig handles — `org/name`
 *  form maps straight to `mesh://org/name`; a bare handle lives in the
 *  commons namespace as `mesh://wasteland/<handle>`. Anything else is
 *  unprojectable — the caller reports the row, never invents a rig. */
export function handleToRig(handle: string | undefined): string | null {
  if (!isHandleString(handle)) {
    return null;
  }
  const direct = tryDirectMeshHandle(handle);
  if (direct !== null) {
    return direct;
  }
  return isBareHandle(handle) ? `mesh://wasteland/${handle.toLowerCase()}` : null;
}

/** The board's `wanted` row — a superset of the fields the projection
 *  reads; board-local vocabulary (project / type / effort / tags) is
 *  carried through untouched. */
export interface WantedRow {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  posted_by?: string;
  status?: string;
  claimed_by?: string;
  project?: string;
  type?: string;
  effort_level?: string;
  tags?: string[];
  completions?: { evidence?: string; state?: string }[];
}

function missingPosterError(row: WantedRow): string[] {
  return [`${row.id}: posted_by "${row.posted_by ?? ''}" is not a rig handle`];
}

function claimerError(row: WantedRow, claimer: string | null): string[] {
  const hasClaimed = row.claimed_by !== undefined && row.claimed_by !== '';
  if (hasClaimed && claimer === null) {
    return [`${row.id}: claimed_by "${row.claimed_by}" is not a rig handle`];
  }
  return [];
}

function makeBoardBase(row: WantedRow): BoardBase {
  const { body, refs } = splitEmbeddedRefs(row.description);
  return {
    v: MESH_VERSION,
    thread: row.id,
    title: row.title,
    body,
    refs,
    evidence: [] as MeshRef[],
  };
}

/** Board row → the mesh records its state implies: a request always,
 *  a claim when `claimed_by` is set, a result when a completion row
 *  carries evidence, and the verdict when the board marks it accepted
 *  or rejected. `to` is the projection's only judgement — an open row
 *  is addressed to the reader (selfRig, the claimable-work surface);
 *  anything past open is addressed back to the poster, who owes the
 *  verdict. */
export function projectWanted(input: { row: WantedRow; selfRig?: string }): {
  envelopes: MeshEnvelope[];
  errors: string[];
} {
  const row = input.row;
  const self = input.selfRig;
  const poster = handleToRig(row.posted_by);
  if (poster === null) {
    return { envelopes: [], errors: missingPosterError(row) };
  }
  const claimer = handleToRig(row.claimed_by);
  const errors = claimerError(row, claimer);
  const ctx: BoardCtx = {
    base: makeBoardBase(row),
    poster,
    claimer,
  };
  return {
    envelopes: [
      projectRequest({ row, ctx, selfRig: self }),
      ...projectClaim({ ctx }),
      ...projectCompletion({ row, ctx }),
    ],
    errors,
  };
}

type BoardBase = Pick<MeshEnvelope, 'v' | 'thread' | 'title' | 'body' | 'refs' | 'evidence'>;

interface BoardCtx {
  base: BoardBase;
  poster: string;
  claimer: string | null;
}

/** Every record past the request shares the row's base — the id gains
 *  a `#<suffix>` and only kind / parties / evidence differ. */
function ctxRecord(input: {
  ctx: BoardCtx;
  suffix: string;
  kind: MeshKind;
  from: string;
  to: string;
  evidence?: MeshRef[];
}): MeshEnvelope {
  const { ctx, suffix, kind, from, to, evidence } = input;
  const env: MeshEnvelope = {
    ...ctx.base,
    id: `${ctx.base.thread}#${suffix}`,
    kind,
    from,
    to,
    terms: {},
  };
  return evidence === undefined ? env : { ...env, evidence };
}

/** The open-row request — `to` is the projection's only judgement:
 *  an open row is addressed to the reader (selfRig, the claimable-work
 *  surface); anything past open is addressed back to the poster. */
function projectRequest(input: { row: WantedRow; ctx: BoardCtx; selfRig?: string }): MeshEnvelope {
  const { row, ctx, selfRig } = input;
  const priority = termPriority(row.priority);
  const open = row.status === undefined || row.status === 'open';
  return {
    ...ctx.base,
    id: row.id,
    kind: 'request',
    from: ctx.poster,
    to: open && selfRig !== undefined ? selfRig : ctx.poster,
    terms: priority === undefined ? {} : { priority },
  };
}

function projectClaim(input: { ctx: BoardCtx }): MeshEnvelope[] {
  const { ctx } = input;
  if (ctx.claimer === null) {
    return [];
  }
  return [ctxRecord({ ctx, suffix: 'claim', kind: 'claim', from: ctx.claimer, to: ctx.poster })];
}

function hasEvidence(c: { evidence?: string }): boolean {
  return typeof c.evidence === 'string' && c.evidence !== '';
}

function firstEvidence(completions: NonNullable<WantedRow['completions']>): string | undefined {
  return completions.find(hasEvidence)?.evidence;
}

function projectResult(input: { ctx: BoardCtx; evidence: string | undefined }): MeshEnvelope[] {
  const { ctx, evidence } = input;
  if (evidence === undefined || ctx.claimer === null) {
    return [];
  }
  return [
    ctxRecord({
      ctx,
      suffix: 'result',
      kind: 'result',
      from: ctx.claimer,
      to: ctx.poster,
      evidence: [{ kind: 'url', ref: evidence }],
    }),
  ];
}

function projectExplicitVerdict(input: {
  ctx: BoardCtx;
  verdict: NonNullable<WantedRow['completions']>[number];
}): MeshEnvelope[] {
  const { ctx, verdict } = input;
  const kind = verdict.state === 'accepted' ? 'accept' : 'reject';
  return [ctxRecord({ ctx, suffix: kind, kind, from: ctx.poster, to: ctx.claimer ?? ctx.poster })];
}

function projectImplicitAccept(input: { row: WantedRow; ctx: BoardCtx }): MeshEnvelope[] {
  const { row, ctx } = input;
  if (row.status !== 'completed' || ctx.claimer === null) {
    return [];
  }
  return [ctxRecord({ ctx, suffix: 'accept', kind: 'accept', from: ctx.poster, to: ctx.claimer })];
}

/** The post-claim rows: a completion carrying evidence is the result
 *  record; an accepted/rejected completion row is the verdict; a
 *  completed board status with no verdict row reads as the accept. */
function projectCompletion(input: { row: WantedRow; ctx: BoardCtx }): MeshEnvelope[] {
  const { row, ctx } = input;
  const evidence = firstEvidence(row.completions ?? []);
  const result = projectResult({ ctx, evidence });
  return [...result, ...projectVerdict({ row, ctx })];
}

/** The verdict row: an accepted/rejected completion is it; a
 *  `completed` status with none still reads as the accept. */
function projectVerdict(input: { row: WantedRow; ctx: BoardCtx }): MeshEnvelope[] {
  const { row, ctx } = input;
  const verdict = (row.completions ?? []).find(
    c => c.state === 'accepted' || c.state === 'rejected'
  );
  if (verdict !== undefined) {
    return projectExplicitVerdict({ ctx, verdict });
  }
  return projectImplicitAccept({ row, ctx });
}

function wlJson<T>(call: { args: string[] }): { data?: T; error?: string } {
  const r = wl(call);
  if (r.code !== 0) {
    return { error: r.err || r.out };
  }
  try {
    return { data: JSON.parse(r.out) as T };
  } catch {
    return { error: 'wl returned unparseable json' };
  }
}

/** A wanted item's coordinate — board remote + `w-<hash>` id; the two
 *  ride every lifecycle verb together, so they travel as one record. */
export interface WlTarget {
  remote: string;
  id: string;
}

const REFS_SENTINEL = '<!-- mesh/1 refs -->';

/** one marker line per ref — a ref carrying a line break would split
 *  into extra marker lines and come back as different refs, so an
 *  unembeddable value is rejected rather than serialized */
function embeddableRefs(refs: MeshRef[] | undefined): MeshRef[] {
  return (refs ?? []).filter(r => r.ref !== '' && !/[\r\n]/.test(r.ref));
}

function refsTrailer(refs: MeshRef[]): string[] {
  return refs.length === 0
    ? []
    : ['', REFS_SENTINEL, ...refs.map(r => `mesh:ref:${r.kind}:${r.ref}`)];
}

function embedRefs(body: string | undefined, refs: MeshRef[] | undefined): string | undefined {
  const parts: string[] = [];
  if (body !== undefined && body !== '') {
    parts.push(body);
  }
  parts.push(...refsTrailer(embeddableRefs(refs)));
  return parts.length === 0 ? undefined : parts.join('\n');
}

/** Marker line tri-state: a parsed ref, `'skip'` for a marker with an
 *  empty ref (dropped, the block continues), or `'end'` for a
 *  non-marker line — the first of those ends the metadata block. */
function parseRefLine(line: string): MeshRef | 'skip' | 'end' {
  const m = /^mesh:ref:(bead|url|pr):(.*)$/.exec(line);
  if (m === null) {
    return 'end';
  }
  return (m[2] ?? '') === '' ? 'skip' : { kind: m[1] as MeshRef['kind'], ref: m[2] as string };
}

function parseRefBlock(lines: string[]): MeshRef[] {
  const refs: MeshRef[] = [];
  for (const line of lines) {
    // trimEnd eats the CR a CRLF-stored row leaves on the marker —
    // a bare capture would keep it and the ref would never match
    const l = line.trimEnd();
    if (l === '') {
      continue;
    }
    const parsed = parseRefLine(l);
    if (parsed === 'end') {
      break; // the first non-marker line ends the metadata block
    }
    if (parsed !== 'skip') {
      refs.push(parsed);
    }
  }
  return refs;
}

/** A board description splits at the refs sentinel — only `mesh:ref:`
 *  lines under `<!-- mesh/1 refs -->` are transport metadata; a
 *  marker-looking line in ordinary prose stays content. Returns the
 *  prose body with the whole trailer lifted back out, so the envelope
 *  round-trips the posted body instead of leaking the markers. */
function splitEmbeddedRefs(text: string | undefined): { body: string; refs: MeshRef[] } {
  if (typeof text !== 'string' || text === '') {
    return { body: text ?? '', refs: [] };
  }
  const idx = text.indexOf(REFS_SENTINEL);
  if (idx === -1) {
    return { body: text, refs: [] };
  }
  const refs = parseRefBlock(text.slice(idx + REFS_SENTINEL.length).split('\n'));
  // the emitter pads exactly one blank line before the sentinel — lift
  // the separator back out so the body round-trips verbatim
  const body = text.slice(0, idx).replace(/(?:\r?\n){1,2}$/, '');
  return { body, refs };
}

/** Post a wanted item — `wl post` goes to the fork and proposes
 *  (PR mode); the returned `w-<hash>` is the thread id. */
function addPostDescription(args: string[], body: string | undefined): void {
  if (body !== undefined && body !== '') {
    args.push('--description', body);
  }
}

function addPostPriority(args: string[], priority: number | undefined): void {
  if (priority === undefined) {
    return;
  }
  const p = Math.max(0, Math.min(4, Math.trunc(priority)));
  args.push('--priority', String(p));
}

function parsePostId(data: { id?: string } | undefined): string | undefined {
  const id = data?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

export function postWanted(input: {
  remote: string;
  title: string;
  body?: string;
  priority?: number;
  refs?: MeshRef[];
}): { id?: string; error?: string } {
  const args = [...remoteArgs(input.remote), 'post', '--title', input.title];
  addPostDescription(args, embedRefs(input.body, input.refs));
  addPostPriority(args, input.priority);
  args.push('--json');
  const r = wlJson<{ id?: string }>({ args });
  if (r.error !== undefined) {
    return { error: `wl post failed — ${r.error}` };
  }
  const id = parsePostId(r.data);
  return id !== undefined ? { id } : { error: 'wl post returned no wanted id' };
}

/** Every lifecycle verb is `wl <verb> <id>` plus at most one flag —
 *  the runner owns the args and the shared error line. */
function runVerb(verb: string, t: WlTarget, extra: string[] = []): { error?: string } {
  const r = wl({ args: [...remoteArgs(t.remote), verb, t.id, ...extra] });
  return r.code === 0 ? {} : { error: `wl ${verb} ${t.id} failed — ${r.err || r.out}` };
}

export function claimWanted(t: WlTarget): { error?: string } {
  return runVerb('claim', t);
}

function isUsableEvidence(e: MeshRef): boolean {
  return (e.kind === 'url' || e.kind === 'pr') && typeof e.ref === 'string' && e.ref !== '';
}

function findEvidenceRef(evidence: MeshRef[] | undefined): string | undefined {
  return Array.isArray(evidence) ? evidence.find(isUsableEvidence)?.ref : undefined;
}

export function completeWanted(t: WlTarget & { evidence?: MeshRef[] }): { error?: string } {
  const ev = findEvidenceRef(t.evidence);
  return runVerb('done', t, ev === undefined ? [] : ['--evidence', ev]);
}

export function acceptWanted(t: WlTarget): { error?: string } {
  return runVerb('accept', t);
}

export function rejectWanted(t: WlTarget & { body?: string }): { error?: string } {
  const extra = t.body !== undefined && t.body !== '' ? ['--reason', t.body] : [];
  return runVerb('reject', t, extra);
}

function extractWantedRows(data: WantedRow[] | { rows?: WantedRow[] } | undefined): WantedRow[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.rows)) {
    return data.rows;
  }
  return [];
}

function isValidWantedRow(w: unknown): w is WantedRow {
  return (
    typeof w === 'object' &&
    w !== null &&
    typeof (w as WantedRow).id === 'string' &&
    (w as WantedRow).id.trim() !== '' &&
    typeof (w as WantedRow).title === 'string' &&
    (w as WantedRow).title.trim() !== ''
  );
}

/** The open board — `wl browse --json` over the commons, never the
 *  fork. Rows are returned raw; `projectWanted` turns them into the
 *  records the thread reduction reads. */
export function browseWanted(remote: string): { rows: WantedRow[]; error?: string } {
  const r = wlJson<WantedRow[] | { rows?: WantedRow[] }>({
    args: [...remoteArgs(remote), 'browse', '--json', '--limit', '500'],
  });
  if (r.error !== undefined) {
    return { rows: [], error: `wl browse failed — ${r.error}` };
  }
  const rows = extractWantedRows(r.data);
  return { rows: rows.filter(w => isValidWantedRow(w)) };
}

function isValidWantedData(data: WantedRow | undefined): data is WantedRow {
  return typeof data?.id === 'string' && data.id !== '';
}

/** One thread's board row — `wl status <id> --json` over the commons. */
export function wantedStatus(t: WlTarget): { row?: WantedRow; error?: string } {
  const r = wlJson<WantedRow>({ args: [...remoteArgs(t.remote), 'status', t.id, '--json'] });
  if (r.error !== undefined) {
    return { error: `wl status ${t.id} failed — ${r.error}` };
  }
  return isValidWantedData(r.data)
    ? { row: r.data }
    : { error: `wl status ${t.id} returned no row` };
}

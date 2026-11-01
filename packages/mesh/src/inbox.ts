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
import { taskStore, gitTry } from '@broject/core';
import { storeFor } from './post.ts';
import { envelopeFromBead, type BeadLike, type MeshEnvelope } from './envelope.ts';
import { existsSync } from 'node:fs';
import { localCheckout, type MeshPeer, type MeshTransport } from './peers.ts';
import { issueLabels, meshIssues, replicaDir, syncReplica } from './pull.ts';
import { parseGithubRemote, scanGithub, selfLogin } from './github.ts';
import { browseWanted, projectWanted } from './wasteland.ts';

export interface PeerRecord {
  /** The peer alias the record arrived over — the provenance. */
  peer: string;
  /** The rig the binding declares for that alias. */
  peerRig: string;
  /** The binding's transport — 'local' attests the STORE, not the
   *  author: delivered envelopes carry the requester's `from` in a
   *  store the binding names (specs/cross-repo/bro-oam4). */
  transport: MeshTransport;
  envelope: MeshEnvelope;
  beadId: string;
  /** the authenticated account that authored the record — github
   *  comments only; the binding's `login` is what it's checked
   *  against (specs/cross-repo/bro-kim1e Trust). */
  author?: string;
  /** the record's author matched no peer binding's `login` and is not
   *  this account — surfaced flagged, never silently dropped */
  unbound?: boolean;
}

export interface InboundRequest extends PeerRecord {
  /** envelope.from !== peer.rig — flagged, never trusted (spec Trust). */
  mismatch: boolean;
  /** own-store row whose `from` matches no peer binding — surfaced
   *  like `mismatch`, never silently dropped. */
  unbound?: boolean;
}

export interface ScanResult {
  records: PeerRecord[];
  errors: string[];
}

export interface InboxResult {
  requests: InboundRequest[];
  errors: string[];
}

function rowToBead(
  row: {
    id: string;
    title: string;
    description?: string;
    notes?: string;
    priority?: number;
    external_ref?: string | null;
  },
  labels: string[]
): BeadLike {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    notes: row.notes,
    priority: row.priority,
    external_ref: row.external_ref,
    labels,
  };
}

function admitRow(peer: MeshPeer, bead: BeadLike, out: PeerRecord[]): void {
  const env = envelopeFromBead(bead);
  if (env !== null) {
    out.push({
      peer: peer.alias,
      peerRig: peer.rig,
      transport: peer.transport,
      envelope: env,
      beadId: bead.id,
    });
  }
}

function scanReplica(
  dir: string,
  peer: MeshPeer,
  out: PeerRecord[],
  errors: string[],
  timeoutMs?: number
): void {
  const found = meshIssues(dir, timeoutMs);
  if (found.error !== undefined) {
    errors.push(`${peer.alias}: ${found.error}`);
    return;
  }
  for (const row of found.rows) {
    if (row.status === 'closed') {
      continue;
    }
    const labels = issueLabels(dir, row.id, timeoutMs);
    if (labels.error !== undefined) {
      errors.push(`${peer.alias}: labels for ${row.id} failed — ${labels.error}`);
      continue;
    }
    admitRow(peer, rowToBead(row, labels.labels), out);
  }
}

/** beads-remote: sync the replica (clone||pull), query mesh-labelled
 *  issues, emit every envelope found. */
function scanRemote(
  gitCommon: string,
  peer: MeshPeer,
  out: PeerRecord[],
  errors: string[],
  timeoutMs?: number
): void {
  const synced = syncReplica(gitCommon, peer.alias, peer.remote);
  if (synced.path === undefined) {
    errors.push(synced.error ?? `${peer.alias}: replica sync failed`);
    return;
  }
  scanReplica(synced.path, peer, out, errors, timeoutMs);
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
  closedLocal: boolean
): void {
  const dir = localCheckout(peer.remote);
  if (dir === null) {
    errors.push(`${peer.alias}: local checkout ${peer.remote} does not resolve`);
    return;
  }
  let rows: (BeadLike & { status?: string })[];
  try {
    // closedLocal needs the store's own all-filter off too — the
    // backend drops closed rows before this loop ever sees them.
    // limit:0 likewise — a configured page must not hide envelopes
    rows = storeFor(dir).list<BeadLike & { status?: string }>({
      all: closedLocal || undefined,
      limit: 0,
    });
  } catch (err) {
    errors.push(
      `${peer.alias}: store list failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  for (const row of rows) {
    if (row.status === 'closed' && !closedLocal) {
      continue;
    }
    admitRow(peer, row, out);
  }
}

/** github: every mesh record across the request-labelled issues on
 *  the peer's repo — the comment author IS the provenance material
 *  (thread.ts checks it against the binding's `login`). There is no
 *  replica to pull — every read is a live `gh` call, `pull:false`
 *  changes nothing. */
function scanGithubPeer(peer: MeshPeer, out: PeerRecord[], errors: string[]): void {
  const scan = scanGithub({ remote: peer.remote });
  for (const e of scan.errors) {
    errors.push(`${peer.alias}: ${e}`);
  }
  for (const r of scan.records) {
    out.push({
      peer: peer.alias,
      peerRig: peer.rig,
      transport: 'github',
      envelope: r.envelope,
      beadId: r.issue,
      author: r.author,
    });
  }
}

/** wasteland: the open board over the commons — a row projects to the
 *  records its state implies (request + lifecycle). `selfRig` feeds
 *  the projection's `to` — an open row is addressed to the reader. */
function scanWastelandPeer(
  peer: MeshPeer,
  selfRig: string | undefined,
  out: PeerRecord[],
  errors: string[]
): void {
  const board = browseWanted(peer.remote);
  if (board.error !== undefined) {
    errors.push(`${peer.alias}: ${board.error}`);
    return;
  }
  for (const row of board.rows) {
    const projected = projectWanted(row, selfRig);
    for (const e of projected.errors) {
      errors.push(`${peer.alias}: ${e}`);
    }
    for (const env of projected.envelopes) {
      out.push({
        peer: peer.alias,
        peerRig: peer.rig,
        transport: 'wasteland',
        envelope: env,
        beadId: row.id,
      });
    }
  }
}

/** github's own-repo half: inbound requests are issues filed on MY
 *  repo — nothing pulls them into a store, so the inbox scans the
 *  repo the rig's origin names (when it is github-hosted). Author →
 *  rig attribution runs through bound `login`s first, then this
 *  account; anything left is surfaced flagged `unbound`. */
/** One own-repo github record → the inbound row it earns. A bound
 *  `login` attests its peer; this account attests us; anything else
 *  lands flagged `unbound`. */
function admitOwnGithubRecord(
  r: { issue: string; author: string; envelope: PeerRecord['envelope'] },
  ctx: { peers: MeshPeer[]; selfRig: string; selfLogin: string | undefined },
  out: PeerRecord[]
): void {
  const bound = ctx.peers.find(
    p => p.login !== undefined && p.login.toLowerCase() === r.author.toLowerCase()
  );
  // verdicts land as comments on the request's own issue — they count
  // only from an authenticated bound author, and they feed the
  // terminal set so a verdicted github request leaves the inbox
  const isVerdict = r.envelope.kind === 'accept' || r.envelope.kind === 'reject';
  if (r.envelope.kind !== 'request' && !isVerdict) {
    return;
  }
  if (bound !== undefined) {
    out.push({
      peer: bound.alias,
      peerRig: bound.rig,
      transport: 'github',
      envelope: r.envelope,
      beadId: r.issue,
      author: r.author,
    });
    return;
  }
  if (isVerdict) {
    return;
  }
  out.push(unboundGithubRow(r, ctx));
}

/** An unattributed request: ours when the authenticated author is this
 *  account (github logins match case-insensitively), else flagged
 *  `unbound` and attributed to the envelope's claimed origin. */
function unboundGithubRow(
  r: { issue: string; author: string; envelope: PeerRecord['envelope'] },
  ctx: { selfRig: string; selfLogin: string | undefined }
): PeerRecord {
  const self =
    ctx.selfLogin !== undefined && r.author.toLowerCase() === ctx.selfLogin.toLowerCase();
  return {
    peer: 'github',
    peerRig: self ? ctx.selfRig : r.envelope.from,
    transport: 'github',
    envelope: r.envelope,
    beadId: r.issue,
    author: r.author,
    unbound: self ? undefined : true,
  };
}

function scanOwnGithub(
  ctx: { dir: string; peers: MeshPeer[]; selfRig: string },
  out: PeerRecord[],
  errors: string[]
): void {
  const origin = gitTry(['-C', ctx.dir, 'remote', 'get-url', 'origin']);
  const repo = origin.code === 0 ? parseGithubRemote({ remote: origin.out }) : null;
  if (repo === null) {
    return;
  }
  const scan = scanGithub({ remote: `https://github.com/${repo.owner}/${repo.repo}` });
  for (const e of scan.errors) {
    errors.push(`self: ${e}`);
  }
  const admission = { peers: ctx.peers, selfRig: ctx.selfRig, selfLogin: selfLogin().login };
  for (const r of scan.records) {
    admitOwnGithubRecord(r, admission, out);
  }
}

/** One peer → its scan leg. Pull topology peers read their replica;
 *  `pull:false` serves replica contents as they stand — an absent
 *  replica is simply empty. */
function scanPeer(
  peer: MeshPeer,
  ctx: {
    gitCommon: string;
    pull?: boolean;
    closedLocal?: boolean;
    selfRig?: string;
    timeoutMs?: number;
  },
  out: PeerRecord[],
  errors: string[]
): void {
  if (peer.transport === 'local') {
    scanLocal(peer, out, errors, ctx.closedLocal === true);
    return;
  }
  if (peer.transport === 'github') {
    scanGithubPeer(peer, out, errors);
    return;
  }
  if (peer.transport === 'wasteland') {
    scanWastelandPeer(peer, ctx.selfRig, out, errors);
    return;
  }
  if (ctx.pull === false) {
    const dir = replicaDir(ctx.gitCommon, peer.alias);
    if (existsSync(dir)) {
      scanReplica(dir, peer, out, errors, ctx.timeoutMs);
    }
    return;
  }
  scanRemote(ctx.gitCommon, peer, out, errors, ctx.timeoutMs);
}

/** Pull + scan every configured peer — every mesh envelope, every
 *  kind. `pull:false` serves replica contents as they stand.
 *  `closedLocal:true` admits closed rows on `local` peers — the
 *  thread path needs the anchor past the worker's `bd close`.
 *  `selfRig` feeds the wasteland projection's `to`. */
export function meshScan(
  dir: string,
  peers: MeshPeer[],
  gitCommon: string,
  opts: { pull?: boolean; closedLocal?: boolean; selfRig?: string; timeoutMs?: number } = {}
): ScanResult {
  const out: PeerRecord[] = [];
  const errors: string[] = [];
  for (const peer of peers) {
    scanPeer(
      peer,
      {
        gitCommon,
        pull: opts.pull,
        closedLocal: opts.closedLocal,
        selfRig: opts.selfRig,
        timeoutMs: opts.timeoutMs,
      },
      out,
      errors
    );
  }
  return { records: out, errors };
}

/** The request filter over the scan — pending requests addressed to
 *  selfRig, provenance attached, from≠binding flagged. A thread the
 *  requester already verdicted is terminal, not pending; a verdict
 *  counts only when its from matches the peer binding — the same
 *  impersonation rule the thread reduction applies, so a forged
 *  accept can't quietly close somebody else's request. */
/** Own-store pass — `bro request` delivers the bead straight into the
 *  recipient's store; no peer transport carries it. Only INBOUND-shaped
 *  envelopes count — requests delivered to me and verdicts addressed
 *  back to me. My own outbound posts live in the same store but are
 *  not inbox material — and must never feed the terminal set. */
function scanOwnStore(dir: string, selfRig: string, records: PeerRecord[], errors: string[]): void {
  try {
    const rows = taskStore(dir).list<BeadLike & { status?: string }>({ limit: 0 });
    for (const row of rows) {
      if (row.status === 'closed') {
        continue;
      }
      const env = envelopeFromBead(row);
      if (env?.to !== selfRig) {
        continue;
      }
      records.push({
        peer: 'self',
        peerRig: env.from,
        transport: 'local',
        envelope: env,
        beadId: row.id,
      });
    }
  } catch (err) {
    errors.push(`self: store list failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Verdict threads → the terminal set. own-store records carry
 *  peerRig=env.from — `from === peerRig` is vacuous there, so an
 *  unbound inbound verdict would close any same-id thread it names;
 *  only peer-bound verdicts count. Thread ids are per-store — a
 *  verdict only closes requests that arrived over the same binding. */
function isBoundVerdict(r: PeerRecord): boolean {
  if (r.peer === 'self' || r.envelope.from !== r.peerRig) {
    return false;
  }
  return r.envelope.kind === 'accept' || r.envelope.kind === 'reject';
}

function terminalThreads(records: PeerRecord[]): Set<string> {
  const terminal = new Set<string>();
  for (const r of records) {
    if (isBoundVerdict(r)) {
      terminal.add(`${r.peer}:${r.envelope.thread}`);
    }
  }
  return terminal;
}

/** kind=request, addressed to me, and no bound verdict already
 *  closed the thread on this binding. */
function isPendingRequest(r: PeerRecord, selfRig: string, terminal: Set<string>): boolean {
  if (r.envelope.kind !== 'request' || r.envelope.to !== selfRig) {
    return false;
  }
  return !terminal.has(`${r.peer}:${r.envelope.thread}`);
}

/** `mismatch` flags from≠binding (wasteland rows carry their own
 *  poster — that shape is not impersonation); `unbound` flags
 *  own-store rows matching no peer rig. */
function inboundFlags(r: PeerRecord, bound: Set<string>): { mismatch: boolean; unbound?: boolean } {
  const attested = r.peer !== 'self' && r.transport !== 'wasteland';
  const unbound = r.unbound === true || (r.peer === 'self' && !bound.has(r.envelope.from));
  return {
    mismatch: attested && r.envelope.from !== r.peerRig,
    unbound: unbound ? true : undefined,
  };
}

/** Pending requests, verdict-filtered, with provenance flags. */
function reduceInbox(records: PeerRecord[], selfRig: string, bound: Set<string>): InboundRequest[] {
  const terminal = terminalThreads(records);
  return records
    .filter(r => isPendingRequest(r, selfRig, terminal))
    .map(r => ({ ...r, ...inboundFlags(r, bound) }));
}

export function meshInbox(
  dir: string,
  peers: MeshPeer[],
  ctx: { selfRig: string; gitCommon: string; pull?: boolean }
): InboxResult {
  const { selfRig, gitCommon } = ctx;
  const { records, errors } = meshScan(dir, peers, gitCommon, { pull: ctx.pull, selfRig });
  // a `from` matching no binding is surfaced flagged `unbound`, like mismatch
  const bound = new Set(peers.map(p => p.rig));
  scanOwnStore(dir, selfRig, records, errors);
  // the github plane's inbound half — issues filed on MY repo; `to`
  //  filtering below keeps only what was actually addressed to me
  scanOwnGithub({ dir, peers, selfRig }, records, errors);
  return { requests: reduceInbox(records, selfRig, bound), errors };
}

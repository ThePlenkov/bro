/**
 * Notify mailbox — the child→parent event plane (bro-d8zo). Writers
 * (`bro notify`, `bro watch --notify`, fixers, convoy sessions) drop one
 * atomic file per event; the notify connector's postTool probe drains
 * the mailbox and injects the drops into session context — real-time
 * events with no tokens spent waiting.
 *
 * Location: `<git-common-dir>/bro/notify/` inside a repo (shared across
 * linked worktrees — the common dir is the coordination plane), the XDG
 * state dir (`$XDG_STATE_HOME`, default `~/.local/state`) outside one.
 *
 * Delivery is broadcast, not first-consumer-wins: each session carries
 * its cursor inside the mailbox's single `.cursors` file, so a drop
 * reaches every live session exactly once — the writer's own postTool
 * echoing it back cannot eat it before the parent sees it. A drain
 * stats the dir first: an unchanged mtime+ctime means nothing new, so
 * the common post-tool probe costs one stat plus one small read instead
 * of a full mailbox scan. Drops expire after DROP_TTL_MS and cursors
 * after SEEN_TTL_MS.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ConnectorCtx } from './connectors.ts';
import { isEventInput, type EventEnvelope, type EventInput } from './events.ts';
import { GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDir } from './git.ts';

/** The repo mailbox — `<git-common>/bro/notify`; null outside a repo.
 *  Bounded lookup + in-process cache — hook drains call this on every
 *  postTool/sessionStart, so a wedged git must fail fast, not stall. */
export function mailboxDir(dir: string): string | null {
  const common = gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return common === null ? null : join(common, 'bro', 'notify');
}

/** The user-level mailbox — the "(or XDG state)" fallback for writers
 *  running outside any repo. An *empty* XDG_STATE_HOME is unset, not a
 *  path — `||` not `??`. */
export function userMailboxDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'bro', 'notify');
}

/** Where `bro notify` writes — the repo mailbox when there is one, the
 *  user-level mailbox otherwise. */
export function notifyDir(dir: string): string {
  return mailboxDir(dir) ?? userMailboxDir();
}

/** Every mailbox a session drains — the repo mailbox plus the
 *  user-level one (drops written outside a repo land there and still
 *  belong to whoever is live to see them). */
export function drainDirs(dir: string): string[] {
  return [...new Set([mailboxDir(dir), userMailboxDir()])].filter((d): d is string => d !== null);
}

/** One atomic mailbox drop — tmp+rename so a draining reader never sees
 *  a half-written event. `prefix` namespaces the file (`watch-`, `note-`)
 *  so the filename says which writer produced it. Returns the dropped
 *  file's path. */
export function dropMailbox(dir: string, text: string, prefix: string): string {
  mkdirSync(dir, { recursive: true });
  const name = `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, join(dir, name));
  } catch (err) {
    // a failed rename strands the tmp file — remove it so retries
    // don't accumulate debris in the mailbox
    rmSync(tmp, { force: true });
    throw err;
  }
  return join(dir, name);
}

/** What a verbatim mailbox drop is: a `notify` note. The write side
 *  only stores plain text for exactly that event, and a foreign file
 *  in the notify dir is a notify drop by definition — decoding it as
 *  a 'mailbox' topic would lose the identity the publisher chose and
 *  hide the drop from every `topics: ['notify']` subscription. */
const MAILBOX_TOPIC = 'notify';
const MAILBOX_KIND = 'note';

/**
 * The mailbox text for an event. A plain note is written verbatim, because
 * drops are injected as-is and a heartbeat's formatting is part of the
 * event — that is `bro notify` today and its bytes must not move.
 * Anything with identity beyond topic/kind is JSON, or the
 * topic would be dropped on the floor and the event could never be
 * filtered on the way back out.
 */
export function mailboxText(event: EventInput): string {
  const plainNote =
    event.topic === 'notify' &&
    event.kind === 'note' &&
    event.key === undefined &&
    event.to === undefined &&
    event.cause === undefined &&
    event.ref === undefined &&
    event.source === undefined;
  // A verbatim note whose text parses as an event would come back out of
  // the drain as that event — a different topic and a lost payload — so
  // JSON-shaped notes go through the envelope like everything else.
  if (plainNote && typeof event.payload === 'string' && parseEvent(event.payload) === undefined) {
    return event.payload;
  }
  return JSON.stringify(event);
}

/** The one place a drop's text is asked "are you an event?" — shared by
 *  the write side (to keep raw notes distinguishable), the drain side
 *  (addressing checks the envelope), and coalescing (superseded drops
 *  are found by key). */
export function parseEvent(text: string): EventInput | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isEventInput(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Drops are text — a drain recovers only what the writer encoded. A
 *  verbatim drop is reported as the notify note it was published as; a
 *  JSON drop is parsed back into the exact event. */
export function mailboxEvent(text: string, locator: string | undefined): EventEnvelope {
  const parsed = parseEvent(text);
  if (parsed !== undefined) {
    return {
      ...parsed,
      ts: new Date().toISOString(),
      ...(locator !== undefined ? { locator } : {}),
    };
  }
  return {
    topic: MAILBOX_TOPIC,
    kind: MAILBOX_KIND,
    payload: text,
    ts: new Date().toISOString(),
    ...(locator !== undefined ? { locator } : {}),
  };
}

/** A drop older than this is residue, not an event — a session that
 *  was idle past the TTL never sees it. */
export const DROP_TTL_MS = 60 * 60 * 1000;

/** Session cursors outlive drops — entries idle past this are dropped
 *  on the next cursor write (the marker TTL scale the old `.seen-*`
 *  file prune used). */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The one cursor file per mailbox dir — every session's seen-set plus
 *  the dir stat its last drain scanned against, in a single JSON
 *  document. It is written IN PLACE only: a tmp+rename would add and
 *  remove dir entries, bumping the mailbox's own mtime — the signal
 *  the drain fast path reads. */
const CURSOR_FILE = '.cursors';

function cursorPath(mb: string): string {
  return join(mb, CURSOR_FILE);
}

/** The `.cursors` map key — the raw session id. JSON keys need no
 *  filename sanitization, so two distinct sids can no longer collide
 *  onto one cursor the way `.seen-<sid>`'s `[\w.-]` mangling could;
 *  '' keeps the old `.seen-unknown` shared bucket. */
function sessionKey(sessionId: string): string {
  return sessionId === '' ? 'unknown' : sessionId;
}

/** One session's cursor row — `seen` is the drop names it has been
 *  shown (pruned to names still on disk on every write), `touched` the
 *  GC clock, `sig`+`dirMtimeMs`+`dirCtimeMs` the fast-path baseline. */
interface CursorEntry {
  seen: string[];
  touched: number;
  sig: string;
  dirMtimeMs: number;
  dirCtimeMs: number;
}

interface CursorState {
  sessions: Record<string, CursorEntry>;
}

/** The `.cursors` document — absent or unreadable means first drain,
 *  everything is new. Rows are shape-checked: a corrupt entry degrades
 *  to absent (rescan + rewrite), never a crash. */
function readCursorState(mb: string): CursorState {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(mb), 'utf8')) as {
      sessions?: unknown;
    } | null;
    const sessions: Record<string, CursorEntry> = {};
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.sessions !== null &&
      typeof parsed.sessions === 'object'
    ) {
      for (const [sid, raw] of Object.entries(parsed.sessions as Record<string, unknown>)) {
        const e = raw as Partial<CursorEntry> | null;
        if (
          e === null ||
          typeof e !== 'object' ||
          !Array.isArray(e.seen) ||
          typeof e.touched !== 'number'
        ) {
          continue;
        }
        sessions[sid] = {
          seen: e.seen.filter((s): s is string => typeof s === 'string'),
          touched: e.touched,
          sig: typeof e.sig === 'string' ? e.sig : '',
          dirMtimeMs: typeof e.dirMtimeMs === 'number' ? e.dirMtimeMs : Number.NaN,
          dirCtimeMs: typeof e.dirCtimeMs === 'number' ? e.dirCtimeMs : Number.NaN,
        };
      }
    }
    return { sessions };
  } catch {
    return { sessions: {} };
  }
}

/** Persist this session's cursor row. Re-reads first so a concurrent
 *  drain's session entries merge rather than clobber, then drops
 *  entries idle past SEEN_TTL_MS — the single file's answer to the old
 *  per-file cursor prune. This session's `seen` unions with the
 *  freshest row's before the live-name prune: parallel post-tool hooks
 *  share a sessionId, and a racing drain may have marked drops seen
 *  that this scan predated — union loses nothing and never resurrects
 *  a pruned name. Fail-open: a lost write just redelivers next drain. */
function writeCursorState(
  mb: string,
  key: string,
  entry: CursorEntry,
  now: number,
  live: Set<string>
): void {
  try {
    const state = readCursorState(mb);
    for (const [sid, e] of Object.entries(state.sessions)) {
      if (now - e.touched > SEEN_TTL_MS) {
        delete state.sessions[sid];
      }
    }
    const prev = state.sessions[key];
    const seen = prev === undefined ? entry.seen : [...new Set([...prev.seen, ...entry.seen])];
    state.sessions[key] = { ...entry, seen: seen.filter(f => live.has(f)) };
    writeFileSync(cursorPath(mb), JSON.stringify(state));
  } catch {
    // best-effort
  }
}

/** The pre-`.cursors` per-session cursor filename — `.seen-<sid>`.
 *  Read only, to migrate a session's first post-upgrade drain. */
function seenPath(mb: string, sessionId: string): string {
  const sid = sessionId.replace(/[^\w.-]/g, '_') || 'unknown';
  return join(mb, `.seen-${sid}`);
}

/** The legacy `.seen-<sid>` cursor — `existed` distinguishes "no file"
 *  from "empty file" so the caller removes it only when there was a
 *  cursor to migrate. */
function readLegacySeen(cursor: string): { names: Set<string>; existed: boolean } {
  try {
    return {
      names: new Set(readFileSync(cursor, 'utf8').split('\n').filter(Boolean)),
      existed: true,
    };
  } catch {
    return { names: new Set(), existed: false };
  }
}

/** Epoch-ms embedded in a drop name (`<prefix>-<ms>-<rand>.txt`) — the
 *  chronological key a filename sort can't see: `note-*` sorts before
 *  `watch-*` regardless of drop time. */
const dropTime = (name: string): number => Number(/-(\d+)-/.exec(name)?.[1] ?? 0);

/** The fast-path key for a drain's delivery semantics. Only a
 *  keep-less drain (`opts.keep === undefined` — the notify connector's
 *  hook path) may skip the scan, and only against a baseline an
 *  identically-addressed keep-less drain recorded: `for` serializes
 *  the addressing identity. A `keep`-filtered drain (the events
 *  plane's subscribe/probe) can leave drops pending that a keep-less
 *  drain must deliver, so it always scans and records 'k' — which can
 *  never equal a 'u:' signature. */
function drainSignature(opts?: DrainOpts): string | null {
  if (opts?.keep !== undefined) {
    return null;
  }
  return `u:${JSON.stringify(opts?.for ?? null)}`;
}

/** Who is draining. A consumer's addresses: its session id (always
 *  known on the hook path), its `BRO_AGENT_ID` (spawned workers carry
 *  it — interactive sessions don't), and the reserved role
 *  `orchestrator`, which a session with no agentId answers to — that
 *  is the session a spawned child reports to. */
export interface MailboxIdentity {
  sessionId?: string;
  agentId?: string;
}

/** The env-derived half of the identity — spawned workers pin
 *  BRO_AGENT_ID at spawn; a session without it drains as an
 *  orchestrator. */
export function mailboxIdentity(sessionId?: string): MailboxIdentity {
  const agentId = process.env.BRO_AGENT_ID;
  return { sessionId, agentId: agentId === undefined || agentId === '' ? undefined : agentId };
}

/** `to` names exactly one recipient: an agentId, a sessionId, or the
 *  `orchestrator` role. Anything else is broadcast. Exported so
 *  read-only surfaces (the events plane) apply the drain's addressing
 *  rule without consuming drops. */
export function addressedTo(to: string, identity: MailboxIdentity): boolean {
  if (identity.agentId !== undefined && to === identity.agentId) {
    return true;
  }
  if (identity.sessionId !== undefined && to === identity.sessionId) {
    return true;
  }
  return to === 'orchestrator' && identity.agentId === undefined;
}

/** Coalescing (bro-22jd): pending drops carrying the same
 *  {key, source, topic, to} are superseded — the writer that repeats a
 *  key has fresher news. The identity is EXACT equality: a same-key
 *  drop on another topic, to another recipient (or broadcast where the
 *  pending drop was addressed), or from a different source is an
 *  independent note — a keyed publish must never delete a drop it does
 *  not replace. An anonymous publish (no `source`) supersedes nothing:
 *  `undefined` is the absence of an identity, not a shared one — two
 *  sourceless sessions are not the same writer. */
export function coalesceDrops(
  dir: string,
  key: string,
  identity: { source?: string; topic: string; to?: string },
  exclude?: string
): void {
  if (identity.source === undefined) {
    return;
  }
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files.filter(
    f => f.endsWith('.txt') && !f.startsWith('.') && join(dir, f) !== exclude
  )) {
    const path = join(dir, f);
    try {
      if (!lstatSync(path).isFile()) {
        continue;
      }
      const ev = parseEvent(readFileSync(path, 'utf8'));
      if (
        ev !== undefined &&
        ev.key === key &&
        ev.source === identity.source &&
        ev.topic === identity.topic &&
        ev.to === identity.to
      ) {
        rmSync(path, { force: true });
      }
    } catch {
      // unreadable drop — leave it; TTL is the sweeper of last resort
    }
  }
}

/** The context line for a drained drop — typed envelopes render their
 *  addressing (`[ask fixer-7 → orchestrator] …`), plain notes stay
 *  verbatim (a heartbeat's formatting is part of the event). `kind` is
 *  a label, never a grant — a `block` or `ask` carries no authority. */
export function renderDrop(text: string): string {
  const ev = parseEvent(text);
  if (ev === undefined || typeof ev.payload !== 'string') {
    return text;
  }
  const kind = ev.kind === MAILBOX_KIND ? '' : `${ev.kind} `;
  const route =
    ev.source === undefined && ev.to === undefined
      ? ''
      : `${ev.source ?? 'unknown'}${ev.to === undefined ? '' : ` → ${ev.to}`}`;
  const re = ev.cause === undefined ? '' : ` ↳${ev.cause}`;
  const head = kind + route;
  return head === '' ? ev.payload : `[${head}] ${ev.payload}${re}`;
}

/** Drain options — `keep` selects which drops count as seen; `for` is
 *  the consumer's identity for `to`-addressed drops. */
export interface DrainOpts {
  keep?: (text: string) => boolean;
  for?: MailboxIdentity;
}

/** One drop: reap when expired, deliver into `out` when unseen,
 *  addressed-to-us, and wanted. `keep` is the drain-side filter — a
 *  drop it rejects is left unseen, so a filtered consumer cannot eat
 *  drops a later, different consumer was due (they expire on TTL like
 *  any other residue). An addressed drop expires *on read* by its
 *  recipient — single-consumer, not broadcast. Broadcast drops stay
 *  for other sessions until the TTL takes them, so a crash mid-drain
 *  loses nothing — the unwritten cursor redelivers. */
function drainDrop(
  mb: string,
  f: string,
  seen: Set<string>,
  out: string[],
  now: number,
  opts?: DrainOpts
): void {
  const path = join(mb, f);
  try {
    // lstat, not stat — a `.txt` symlink is debris, not a drop: a
    // writable mailbox must never be read through to a foreign file
    const st = lstatSync(path);
    if (now - st.mtimeMs > DROP_TTL_MS) {
      rmSync(path, { force: true }); // expired — reap, never deliver
      return;
    }
    if (!st.isFile()) {
      return; // symlink/FIFO — expires on its own lstat mtime, never delivered
    }
    if (seen.has(f)) {
      return;
    }
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') {
      seen.add(f); // an empty drop is noise, not an event — consume it
      return;
    }
    const ev = parseEvent(text);
    const addressed = typeof ev?.to === 'string' && ev.to !== '';
    if (addressed && !addressedTo(ev!.to!, opts?.for ?? {})) {
      return; // not ours — stays pending for the addressed consumer
    }
    if (opts?.keep !== undefined && !opts.keep(text)) {
      return;
    }
    seen.add(f);
    out.push(text);
    if (addressed) {
      // expire-after-read: an addressed drop is single-consumer, the
      // delivered copy is the only copy
      rmSync(path, { force: true });
    }
  } catch {
    // unreadable drop — skip; the next drain retries
  }
}

/** Drain one mailbox dir for a session, oldest-first by embedded drop
 *  time. Drops are injected verbatim — a heartbeat's formatting is
 *  part of the event. */
function drainDir(mb: string, sessionId: string, now: number, opts?: DrainOpts): string[] {
  // One stat is the whole fast path: a dir's mtime+ctime move on every
  // entry create/remove/rename, drops are immutable once renamed (the
  // tmp+rename write protocol), and `.cursors` is only ever rewritten
  // in place — so an unchanged stat means nothing deliverable can
  // exist for a session whose last identical drain recorded it.
  let dst: { isDirectory(): boolean; mtimeMs: number; ctimeMs: number };
  try {
    dst = statSync(mb);
  } catch {
    return []; // no mailbox yet — nothing to drain
  }
  if (!dst.isDirectory()) {
    return [];
  }
  const key = sessionKey(sessionId);
  const entry = readCursorState(mb).sessions[key];
  const sig = drainSignature(opts);
  if (
    sig !== null &&
    entry !== undefined &&
    entry.sig === sig &&
    entry.dirMtimeMs === dst.mtimeMs &&
    entry.dirCtimeMs === dst.ctimeMs
  ) {
    return [];
  }

  let files: string[];
  try {
    files = readdirSync(mb);
  } catch {
    return []; // vanished or unreadable between stat and readdir
  }
  const filesSet = new Set(files);
  const seen = new Set<string>(entry?.seen ?? []);
  // The session's first post-upgrade drain migrates its legacy
  // `.seen-<sid>` cursor into `.cursors`, then removes it — dedup
  // survives the move and the orphaned-cursor pattern stops growing.
  // Other sessions' legacy files stay for their own drains or the
  // janitor's `.seen-*` sweep.
  const legacyPath = seenPath(mb, sessionId);
  const legacy = readLegacySeen(legacyPath);
  if (legacy.existed) {
    for (const n of legacy.names) {
      seen.add(n);
    }
    rmSync(legacyPath, { force: true });
  }
  const out: string[] = [];
  for (const f of files
    .filter(f => f.endsWith('.txt') && !f.startsWith('.'))
    .sort((a, b) => dropTime(a) - dropTime(b) || a.localeCompare(b))) {
    drainDrop(mb, f, seen, out, now, opts);
  }
  // The baseline is the PRE-scan stat: a drop landing between stat and
  // readdir was scanned yet leaves the recorded stat stale, so the next
  // drain rescans once — the conservative direction, never a miss.
  writeCursorState(
    mb,
    key,
    {
      seen: [...seen],
      touched: now,
      sig: sig ?? 'k',
      dirMtimeMs: dst.mtimeMs,
      dirCtimeMs: dst.ctimeMs,
    },
    now,
    filesSet
  );
  return out;
}

/** Every pending drop this session hasn't seen, oldest-first by the
 *  embedded drop time. `opts.keep` selects which drops count as seen —
 *  a rejected drop stays pending for this session's later drains.
 *  `opts.for` is the consumer's identity: drops `to` another address
 *  stay pending, drops `to` this consumer delete on delivery. */
export function drainMailbox(dir: string, sessionId: string, opts?: DrainOpts): string[] {
  const now = Date.now();
  return drainDirs(dir).flatMap(mb => drainDir(mb, sessionId, now, opts));
}

/** One pending drop as a read-only tail sees it. `ts` is the drop
 *  time embedded in the name (mtime fallback for nameless drops) —
 *  the sort key for newest-first boards. `text` is the rendered line. */
export interface MailboxPeek {
  name: string;
  ts: number;
  text: string;
}

/** One drop read for the tail — null for expired, non-file, empty, or
 *  raced-away drops; a peek skips anything it cannot trust rather than
 *  surfacing it on the read-only board. */
function peekDrop(mb: string, f: string, now: number): MailboxPeek | null {
  const path = join(mb, f);
  try {
    // O_NOFOLLOW + fstat on the same fd — a swapped-in symlink's
    // bytes must never cross onto the unauthenticated
    // /api/v1/mailbox surface (lstat→read races open to the target);
    // O_NONBLOCK keeps a fifo named *.txt from stalling the tail —
    // the fstat isFile() check below still skips it unread
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (now - st.mtimeMs > DROP_TTL_MS || !st.isFile()) {
        return null;
      }
      const raw = readFileSync(fd, 'utf8');
      if (raw.trim() === '') {
        return null;
      }
      const t = dropTime(f);
      return { name: f, ts: t > 0 ? t : Math.round(st.mtimeMs), text: renderDrop(raw) };
    } finally {
      closeSync(fd);
    }
  } catch {
    // raced removal or a symlink swap mid-read — skip the drop
    return null;
  }
}

/** A read-only tail over the pending drops — the /fleet mailbox board's
 *  view. Unlike drainMailbox a peek consumes nothing: no seen cursor
 *  moves, no expiry sweep runs — reads never mutate the plane they
 *  report. Expired drops are skipped from the output but left in place
 *  for the next drain to reap; a drop that vanishes mid-read (a real
 *  drain racing in another process) is skipped, never fatal. Addressed
 *  drops are included — a tail reports the mailbox's state, not one
 *  consumer's share. Newest first by drop time, capped at `limit`. */
export function peekMailbox(dir: string, limit = 25): MailboxPeek[] {
  const now = Date.now();
  const out: MailboxPeek[] = [];
  for (const mb of drainDirs(dir)) {
    let files: string[];
    try {
      files = readdirSync(mb);
    } catch {
      continue; // unreadable mailbox — not this plane's error to raise
    }
    for (const f of files.filter(f => f.endsWith('.txt') && !f.startsWith('.'))) {
      const drop = peekDrop(mb, f, now);
      if (drop !== null) {
        out.push(drop);
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, Math.max(0, limit));
}

/** The notify connector — the read side of the mailbox. Its postTool
 *  probe delivers unseen drops into session context, so a child event
 *  reaches the session mid-turn instead of waiting for a session-end
 *  summary. Probes are fail-open like every connector. */
export const notifyConnector: Connector = {
  name: 'notify',
  hooks: () => {
    const drain = (ctx: ConnectorCtx): string[] => {
      try {
        const msgs = drainMailbox(ctx.dir, ctx.sessionId ?? '', {
          for: mailboxIdentity(ctx.sessionId),
        }).map(renderDrop);
        return msgs.length > 0 ? [`bro notify — ${msgs.length} mailbox message(s):`, ...msgs] : [];
      } catch {
        return [];
      }
    };
    return {
      postTool: drain,
      // a drop that landed after the last mid-turn drain — a detached
      // writer's, or a dead session's — still reaches the next session
      // at start, the same slot the goal reminder uses (bro-q4iq0)
      sessionStart: drain,
    };
  },
};

/**
 * `bro msg` / `bro task give` — the F4 session-messaging core
 * (specs/sessions/bro-izpyk.md "Messages and tasks"; impl
 * specs/bro-izpyk.4.md).
 *
 * Target grammar, shared by every fleet-addressed command:
 *
 *   <host>:<sid>   exact session key — a ledger row must exist
 *   <sid>          exact sid, else a unique sid-prefix (>= 4 chars)
 *   <agentId>      ledger rows whose spawnedBy is the agentId
 *   orchestrator   the role — ledger rows with no spawnedBy
 *
 * A target that resolves to nothing still publishes — through the
 * mailbox vocabulary (`to: <sid>`/`<agentId>`/`orchestrator`) so a
 * session the ledger cannot see yet (a plugin host that never spooled,
 * a worker whose first hook has not landed) is still reachable. That
 * fallback is also the ONLY channel for ledger rows on hosts run.sh
 * cannot name ('unknown') and for `ended` sessions' event record.
 *
 * Delivery per resolved session picks exactly ONE live channel:
 *
 *   inbox-capable host (claude|codex|cursor|devin — the hosts
 *   hookHostOf can prove, the same set run.sh writes `$HOOK_INBOX`
 *   for) + state != 'ended'  →  appendSessionInbox + an events publish
 *   `to: '<host>:<sid>'` (a record the default mailbox transport can
 *   never match — `addressedTo` knows agentId/sessionId/orchestrator,
 *   never a session key — so the drop is ledger-visible but is NOT a
 *   second copy in the recipient's context; bus subscribers still see
 *   it).
 *
 *   everything else →  events publish `to:` the mailbox vocabulary —
 *   the notify drain delivers it on the session's next hook exactly
 *   like `bro notify --to`.
 */
import {
  appendSessionInbox,
  type EventsFacade,
  type LedgerFacade,
  type SessionInboxEntry,
  type SessionState,
} from '@broject/core';
import { deriveSessionState, sessionBootTimeMs } from './sessions.ts';

/** The hosts run.sh can prove — hookHostOf's non-'unknown' answers.
 *  Only these get `$HOOK_INBOX`/`$HOOK_MODE_FILE` stems, so only these
 *  can drain a per-session inbox file. Kept in lockstep with
 *  modes.ts's hookHostOf by comment, not by import: core cannot name
 *  the set without inverting env detection. */
const INBOX_HOSTS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor', 'devin']);

/** Sid prefixes shorter than this are too collision-prone to resolve
 *  against — an exact sid or a longer prefix is required. */
const MIN_SID_PREFIX = 4;

/** One ledger session, reduced to what messaging/resume need — the
 *  derived display state included (an 'ended' session's inbox file
 *  would sit forever: its hooks never fire again). */
export interface MsgSessionRow {
  host: string;
  sid: string;
  project: string | null;
  cwd: string | null;
  state: SessionState;
  lastSeen: number;
  spawnedBy: string | null;
}

export interface SessionRowsResult {
  rows: MsgSessionRow[];
  warnings: string[];
}

/** Ledger rows → messaging rows: state derived at read time (the same
 *  rule `bro sessions` applies — lastSeen older than this boot means
 *  `interrupted`). Bead resolution is deliberately absent: it costs a
 *  git probe per cwd and messaging never displays it. */
export async function sessionMsgRows(
  ledger: LedgerFacade,
  opts: { now?: number; bootTimeMs?: number } = {}
): Promise<SessionRowsResult> {
  const now = opts.now ?? Date.now();
  const boot = opts.bootTimeMs ?? sessionBootTimeMs(now);
  const warnings: string[] = [];
  const stored = await ledger.sessions();
  const drain = ledger.drainWarning?.();
  if (drain !== undefined) {
    warnings.push(`spool drain failed — the session list may be stale (${drain})`);
  }
  const rows: MsgSessionRow[] = stored.map(s => ({
    host: s.host,
    sid: s.sid,
    project: s.project,
    cwd: s.cwd,
    state: deriveSessionState(s, boot),
    lastSeen: s.lastSeen,
    spawnedBy: s.spawnedBy,
  }));
  return { rows, warnings };
}

/** Where one resolved target delivers. `session` is set when the
 *  target matched a ledger row; `to` is the events address — the
 *  session key for inbox-channel rows (record-only in the mailbox),
 *  the mailbox vocabulary otherwise. `inbox` says the send path should
 *  append the session's inbox file. */
export interface TargetDelivery {
  session?: MsgSessionRow;
  to: string;
  inbox: boolean;
  /** Human label for output — 'claude:abc…' or the raw address. */
  label: string;
  /** A caveat the sender must see — today only the ended-session
   *  report (spec: ended sessions are skipped AND reported — their
   *  hooks never fire again, so nothing here is live delivery). */
  note?: string;
}

export interface TargetResolution {
  deliveries: TargetDelivery[];
  warnings: string[];
  /** Set when the target was ambiguous — callers surface it as a
   *  usage error, never a silent no-op. */
  error?: string;
}

const key = (r: MsgSessionRow): string => `${r.host}:${r.sid}`;

/** Does this row take an inbox file? Inbox-capable host AND a session
 *  whose hooks can still fire — 'ended' is terminal, its file would
 *  sit forever (inbox entries carry no TTL). */
function inboxCapable(r: MsgSessionRow): boolean {
  return INBOX_HOSTS.has(r.host) && r.state !== 'ended';
}

function deliveryFor(r: MsgSessionRow): TargetDelivery {
  const inbox = inboxCapable(r);
  // The events `to` picks the ONE channel that can deliver:
  //   inbox row        → the session KEY ('host:sid') — a record the
  //                      mailbox's addressedTo can never match, so the
  //                      drop is ledger/bus-visible but never a second
  //                      copy in the recipient's context
  //   'unknown' host   → the raw sid — the drain matches session_id
  //                      regardless of host, so the mailbox is the only
  //                      live channel for a host run.sh cannot prove
  //   'ended' row      → the session key — nothing can deliver to a
  //                      finished session; the record still names it
  const to = inbox ? key(r) : r.host === 'unknown' && r.state !== 'ended' ? r.sid : key(r);
  return {
    session: r,
    to,
    inbox,
    label: key(r),
    ...(r.state === 'ended'
      ? { note: 'session ended — recorded only, its hooks will never fire' }
      : {}),
  };
}

/** Match `target` against the session rows. Pure — the send path owns
 *  facades and env. Ambiguity is an error candidate list, never a
 *  guess; zero matches degrade to a mailbox-address delivery. */
export function resolveMsgTarget(rows: MsgSessionRow[], target: string): TargetResolution {
  const warnings: string[] = [];
  const t = target.trim();

  const deliver = (matched: MsgSessionRow[]): TargetDelivery[] => {
    const seen = new Set<string>();
    const out: TargetDelivery[] = [];
    for (const r of matched) {
      const k = key(r);
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      out.push(deliveryFor(r));
    }
    return out;
  };

  // <host>:<sid> — the session key. Exact only: a prefix of a key is
  // not a key.
  const colon = t.indexOf(':');
  if (colon > 0) {
    const host = t.slice(0, colon);
    const sid = t.slice(colon + 1);
    const matched = rows.filter(r => r.host === host && r.sid === sid);
    if (matched.length === 0) {
      // The ledger may simply not know this session yet (plugin hosts
      // never spool). The sid still names a mailbox address — degrade
      // honestly rather than erroring on a reachable session.
      warnings.push(
        `no ledger session matches ${host}:${sid} — publishing to mailbox address ${sid}`
      );
      return {
        deliveries: [{ to: sid, inbox: false, label: `${host}:${sid} → ${sid}` }],
        warnings,
      };
    }
    return { deliveries: deliver(matched), warnings };
  }

  if (t === 'orchestrator') {
    const matched = rows.filter(r => r.spawnedBy === null || r.spawnedBy === '');
    if (matched.length === 0) {
      // no wired orchestrator — the mailbox role address still works
      // for sessions the ledger has not seen
      return {
        deliveries: [{ to: 'orchestrator', inbox: false, label: 'orchestrator' }],
        warnings,
      };
    }
    return { deliveries: deliver(matched), warnings };
  }

  // Bare token — sid (exact, then unique-prefix) ∪ agentId. Both
  // grammars are live; the union is the honest answer, and zero
  // matches means "mailbox address" (an agentId the ledger has not
  // seen, or a plugin-host sid).
  const exactSid = rows.filter(r => r.sid === t);
  const agentRows = rows.filter(r => r.spawnedBy === t);
  let matched = [...exactSid, ...agentRows];
  if (matched.length === 0 && t.length >= MIN_SID_PREFIX) {
    const prefix = rows.filter(r => r.sid.startsWith(t));
    // prefix ambiguity is measured on distinct SIDS, not rows — the
    // same sid on two hosts is one session identity, not two answers
    const sids = new Set(prefix.map(r => r.sid));
    if (sids.size === 1) {
      matched = prefix;
    } else if (sids.size > 1) {
      const candidates = [...sids].sort().map(s => {
        const r = prefix.find(p => p.sid === s)!;
        return `${r.host}:${s}`;
      });
      return {
        deliveries: [],
        warnings,
        error: `ambiguous session "${t}" — matches ${candidates.join(', ')}; use <host>:<sid>`,
      };
    }
  }
  if (matched.length === 0) {
    return {
      deliveries: [{ to: t, inbox: false, label: t }],
      warnings,
    };
  }
  return { deliveries: deliver(matched), warnings };
}

export interface SendSessionMessageOpts {
  dir: string;
  target: string;
  text: string;
  kind?: string;
  /** What the message answers — a bead id, drop ref, step (event `cause`). */
  inReplyTo?: string;
  /** Coalescing key — a pending same-key drop from this source is superseded. */
  key?: string;
  /** Inbox/state-dir env — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  ledger?: LedgerFacade;
  events?: EventsFacade;
  now?: number;
  bootTimeMs?: number;
}

export interface SentDelivery {
  to: string;
  label: string;
  /** 'inbox' — the session file carries it (publish may still have
   *  failed; the record is best-effort). 'mailbox' — the events
   *  transport is the only channel. 'inbox+record' — both landed. */
  channel: 'inbox' | 'mailbox' | 'inbox+record';
  inboxPath?: string;
  locator?: string;
  published: boolean;
  reason?: string;
}

export interface SendSessionMessageResult {
  deliveries: SentDelivery[];
  warnings: string[];
  /** Ambiguous-target detail from resolveMsgTarget — a usage error,
   *  never a silent no-op. */
  error?: string;
}

/** The writer side of `bro msg`: resolve the target against the
 *  ledger, append inbox entries for inbox-channel sessions, and publish
 *  one event per delivery through the events facade. Every leg is
 *  fail-open in the notify tradition — a transport or ledger failure
 *  degrades to warnings, never a thrown command (the caller is often a
 *  detached worker that must keep going). */
export async function sendSessionMessage(
  opts: SendSessionMessageOpts
): Promise<SendSessionMessageResult> {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];
  const kind = opts.kind ?? 'note';
  const now = opts.now ?? Date.now();

  let rows: MsgSessionRow[] = [];
  if (opts.ledger !== undefined) {
    try {
      const res = await sessionMsgRows(opts.ledger, {
        now,
        ...(opts.bootTimeMs !== undefined ? { bootTimeMs: opts.bootTimeMs } : {}),
      });
      rows = res.rows;
      warnings.push(...res.warnings);
    } catch (err) {
      warnings.push(
        `session ledger unreadable — resolving by mailbox address only (${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
  }

  const resolution = resolveMsgTarget(rows, opts.target);
  warnings.push(...resolution.warnings);

  const agentId = env.BRO_AGENT_ID;
  const sessionId = env.BRO_SESSION_ID;
  const source =
    agentId !== undefined && agentId !== ''
      ? agentId
      : sessionId !== undefined && sessionId !== ''
        ? sessionId
        : undefined;

  const deliveries: SentDelivery[] = [];
  for (const d of resolution.deliveries) {
    const sent: SentDelivery = {
      to: d.to,
      label: d.label,
      channel: 'mailbox',
      published: false,
    };
    if (d.session !== undefined && d.inbox) {
      const entry: SessionInboxEntry = {
        ts: now,
        ...(source !== undefined ? { from: source } : {}),
        kind,
        ...(opts.inReplyTo !== undefined ? { cause: opts.inReplyTo } : {}),
        text: opts.text,
      };
      const inboxPath = appendSessionInbox(env, d.session.host, d.session.sid, entry);
      if (inboxPath !== null) {
        sent.inboxPath = inboxPath;
        sent.channel = 'inbox';
      } else {
        warnings.push(`inbox unavailable for ${d.label} — events record only`);
      }
    }
    if (opts.events !== undefined) {
      const res = await opts.events.publish({
        topic: 'msg',
        kind,
        payload: opts.text,
        to: d.to,
        ...(opts.inReplyTo !== undefined ? { cause: opts.inReplyTo } : {}),
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(source !== undefined ? { source } : {}),
      });
      sent.published = res.published;
      if (res.locator !== undefined) {
        sent.locator = res.locator;
      }
      if (sent.channel === 'inbox' && res.published) {
        sent.channel = 'inbox+record';
      }
      if (!res.published) {
        sent.reason = res.reason;
        warnings.push(`events publish failed for ${d.label} — ${res.reason ?? 'unknown reason'}`);
      }
    }
    if (d.note !== undefined) {
      warnings.push(`${d.label}: ${d.note}`);
    }
    deliveries.push(sent);
  }
  return {
    deliveries,
    warnings,
    ...(resolution.error !== undefined ? { error: resolution.error } : {}),
  };
}

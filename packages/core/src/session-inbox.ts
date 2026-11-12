/**
 * Session inbox — the F4 per-session drop file from the fleet epic
 * (specs/sessions/bro-izpyk.md "Messages and tasks"; impl
 * specs/bro-izpyk.4.md).
 *
 * `bro msg <session|role> <text>` appends one JSONL entry per message
 * to `inbox/<host>-<sid>` under the machine state dir — the same path
 * `hooks/run.sh` computes as `$HOOK_INBOX` and wakes Node on with its
 * `[ -s ]` Tier-0 check. There is no resident worker to render the
 * file (the ledger drains on read, F1's choice), so the writer plays
 * the worker's role inline: the entry IS the render.
 *
 * Delivery is claim-once: the notify connector's hook probes rename
 * the file aside, parse the JSONL, render the entries into session
 * context and unlink the claim. An append racing the drain recreates
 * the path, so a message published mid-drain is never lost — it waits
 * for the next hook. Entries carry no TTL: a dead session's file sits
 * until the session resumes or an operator removes it (writers skip
 * `ended` sessions for exactly this reason).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { broStateDir, inboxPath } from './modes.ts';

/** One inbox line — the writer's render of a `bro msg` delivery.
 *  `from`/`kind`/`cause` are optional so a foreign line still parses
 *  into a deliverable entry (its raw text survives verbatim). */
export interface SessionInboxEntry {
  /** Epoch ms the writer stamped. */
  ts: number;
  /** Who sent it — agentId/sessionId/`bro`, when known. */
  from?: string;
  /** The notify vocabulary label — note|info|ask|result|block. */
  kind?: string;
  /** What this answers — a bead id, drop ref, step. */
  cause?: string;
  text: string;
}

/** `inbox/` under the state dir — null when no state dir resolves. */
export function sessionInboxDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = broStateDir(env);
  return dir === null ? null : join(dir, 'inbox');
}

/** Append one entry — `O_APPEND` one line, the same atomicity contract
 *  the spool uses (a line is written in a single write call; readers
 *  claim by rename so a torn tail line can only come from a crashed
 *  writer, and it degrades to a verbatim passthrough entry). Returns
 *  the file path, or null when the (host, sid) pair cannot name one —
 *  an empty host or sid has no inbox. */
export function appendSessionInbox(
  env: NodeJS.ProcessEnv,
  host: string,
  sid: string,
  entry: SessionInboxEntry
): string | null {
  if (host === '' || sid === '') {
    return null;
  }
  const path = inboxPath(env, host, sid);
  if (path === null) {
    return null;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return path;
}

/** Parse one JSONL line into an entry. A line that is not a JSON
 *  object with a string `text` degrades to a verbatim passthrough —
 *  foreign content in the file still reaches the session rather than
 *  being silently eaten. */
function parseInboxLine(line: string): SessionInboxEntry {
  const trimmed = line.trim();
  if (trimmed === '') {
    return { ts: 0, text: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<SessionInboxEntry> | null;
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
      const entry: SessionInboxEntry = {
        ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
        text: parsed.text,
      };
      if (typeof parsed.from === 'string' && parsed.from !== '') {
        entry.from = parsed.from;
      }
      if (typeof parsed.kind === 'string' && parsed.kind !== '') {
        entry.kind = parsed.kind;
      }
      if (typeof parsed.cause === 'string' && parsed.cause !== '') {
        entry.cause = parsed.cause;
      }
      return entry;
    }
  } catch {
    // not JSON — fall through to passthrough
  }
  return { ts: 0, text: trimmed };
}

/** Claim and read the inbox — rename the file aside FIRST so a
 *  concurrent `bro msg` append recreates a fresh path instead of
 *  writing into a file mid-parse, then parse the claimed lines and
 *  unlink the claim. Returns null when there is nothing to drain
 *  (absent path, empty file, unreadable). The returned `path` is the
 *  ORIGINAL inbox path — callers render "delivered from <path>". */
export function drainSessionInbox(
  env: NodeJS.ProcessEnv,
  host: string,
  sid: string
): { path: string; entries: SessionInboxEntry[] } | null {
  if (host === '' || sid === '') {
    return null;
  }
  const path = inboxPath(env, host, sid);
  if (path === null || !existsSync(path)) {
    return null;
  }
  const claim = `${path}.drain-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, claim);
  } catch {
    // raced another drain or the file vanished — nothing to deliver
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(claim, 'utf8');
  } catch {
    raw = '';
  } finally {
    rmSync(claim, { force: true });
  }
  const entries = raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(parseInboxLine);
  if (entries.length === 0) {
    return null;
  }
  return { path, entries };
}

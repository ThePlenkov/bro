/**
 * claimsFacade — the first ClaimFacade provider (epic spec
 * specs/sessions/bro-izpyk.md "Claims and conflicts"; impl spec
 * specs/bro-izpyk.3.md). Every non-`task:*` resource URI is a lease row
 * in the sqlite ledger's `claims` table; `task:*` delegates to the
 * tasks facade so the bd claim stays the source of truth.
 *
 * Lease semantics (spec):
 *  - TTL + heartbeat — any hook event from the holder renews its leases
 *    (the ingest path does this in ledger-store); `ttlMs` defaults to
 *    CLAIM_DEFAULT_TTL_MS, 0 means no time expiry.
 *  - Release — the session ends (state `ended` or derived
 *    `interrupted`, the same rule `bro sessions` applies), the holder
 *    pid is provably dead, or the TTL expired and the pid-less holder's
 *    session has gone silent.
 *  - Conflict — a different live session already holds the resource and
 *    either side is exclusive → `{ ok:false, conflict }`. Shared+shared
 *    coexist. `role:*` URIs default exclusive.
 *
 * Liveness deliberately lives HERE, not in the store: the SQL layer
 *  never learns pid/session semantics, and tests inject `now`,
 *  `pidAlive`, and `bootTimeMs` without touching /proc or the clock.
 */
import { uptime } from 'node:os';
import { resolveHookSpoolPath } from './hook-spool.ts';
import {
  drainIntoStore,
  ledgerDbPath,
  openLedgerStore,
  type ClaimDbRow,
  type LedgerStore,
} from './ledger-store.ts';
import { pidAlive } from './proc.ts';
import { taskStore, type TaskRow, type TaskStore } from './tasks.ts';
import {
  CLAIM_DEFAULT_TTL_MS,
  type ClaimFacade,
  type ClaimOptions,
  type ClaimQuery,
  type ClaimResult,
  type ClaimRow,
  type ResourceUri,
} from './claims.ts';
import type { SessionKey, SessionRow } from './ledger.ts';

/** A pid-less claim whose TTL expired dies only when its session has
 *  been silent this long — the same freshness horizon the `.work`
 *  marker liveness window uses (proc-owner LIVE_MARKER_MS). */
const CLAIM_SESSION_FRESH_MS = 24 * 60 * 60 * 1000;

export interface ClaimsFacadeOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  /** `task:*` delegation — dir → TaskStore. Defaults to taskStore(dir). */
  tasksForDir?: (dir: string) => TaskStore;
  /** Test seams — production reads the wall clock, /proc, and boot time. */
  now?: () => number;
  pidAliveFn?: (pid: number, pidStart?: string) => boolean;
  bootTimeMs?: () => number;
}

interface LiveCtx {
  now: number;
  bootTimeMs: number;
  sessions: Map<string, SessionRow>;
  pidAliveFn: (pid: number, pidStart?: string) => boolean;
}

function sessKey(host: string, sid: string): string {
  return `${host}\0${sid}`;
}

/** The session row's death verdict — `ended` stored, or `live` whose
 *  last event predates this boot (the derived `interrupted` rule from
 *  `bro sessions`; the store never writes `interrupted` itself). */
function sessionDead(s: SessionRow | undefined, bootTimeMs: number): boolean {
  if (s === undefined) {
    return false;
  }
  if (s.state === 'ended') {
    return true;
  }
  return s.state === 'live' && s.lastSeen < bootTimeMs;
}

/** Is this claim row still a live lease? Order matters: session death
 *  releases first (spec: "released when the session ends"), then the
 *  holder pid is the definitive liveness proof when present, and only
 *  pid-less rows fall back to the TTL×session-freshness rule. */
function claimDead(row: ClaimDbRow, ctx: LiveCtx): boolean {
  const sess = ctx.sessions.get(sessKey(row.host, row.sid));
  if (sessionDead(sess, ctx.bootTimeMs)) {
    return true;
  }
  if (row.pid !== null) {
    // provable holder death releases immediately — stricter than the
    // spec's "TTL expires and the pid is dead" on purpose: pidAlive
    // fail-opens (unverifiable reads alive), so a false here is a real
    // corpse, and a dead orchestrator must free its role promptly.
    return !ctx.pidAliveFn(row.pid, row.pidStart ?? undefined);
  }
  if (row.leaseUntil !== null && row.leaseUntil <= ctx.now) {
    // TTL expired with no pid proof — dead unless the session is
    // provably fresh (a live session's heartbeat would have renewed).
    return sess === undefined || sess.lastSeen < ctx.now - CLAIM_SESSION_FRESH_MS;
  }
  return false;
}

function toClaimRow(row: ClaimDbRow): ClaimRow {
  return {
    resource: row.resource,
    host: row.host,
    sid: row.sid,
    project: row.project,
    exclusive: row.exclusive,
    leaseUntil: row.leaseUntil,
    claimedAt: row.claimedAt,
    pid: row.pid,
    pidStart: row.pidStart,
    ttlMs: row.ttlMs,
    detail: row.detail,
  };
}

/** `@<project>` suffix of a `role:<name>@<project>` URI — the project
 *  fallback when neither opts.project nor the session row names one. */
function roleProjectSuffix(resource: string): string | null {
  if (!resource.startsWith('role:')) {
    return null;
  }
  const at = resource.lastIndexOf('@');
  return at > 'role:'.length ? resource.slice(at + 1) : null;
}

const TASK_PREFIX = 'task:';

/** A `task:*` conflict row — the standing claim is a bd assignee, not a
 *  ledger row; the synthesized shape keeps ClaimResult honest without
 *  pretending the tasks store is the claims table. */
function taskConflict(resource: string, assignee: string): ClaimRow {
  return {
    resource,
    host: 'tasks',
    sid: assignee,
    project: null,
    exclusive: true,
    leaseUntil: null,
    claimedAt: 0,
  };
}

function isClosedStatus(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'closed' || s === 'done' || s === 'cancelled' || s === 'canceled';
}

/** claimsFacade — lazy sqlite handle like ledgerFacade: the store
 *  opens on first use and caches for the process; every read drains
 *  pending spool rows first (best-effort) so session liveness is fresh.
 *  Machine-scoped: ctx.dir only matters as the `task:*` fallback. */
export function claimsFacade(opts: ClaimsFacadeOptions = {}): ClaimFacade {
  const env = opts.env ?? process.env;
  const dbPath = opts.dbPath ?? ledgerDbPath(env);
  const now = opts.now ?? (() => Date.now());
  const pidAliveFn = opts.pidAliveFn ?? pidAlive;
  const bootTimeMs = opts.bootTimeMs ?? (() => Date.now() - Math.floor(uptime() * 1000));
  const tasksForDir = opts.tasksForDir ?? ((dir: string) => taskStore(dir));

  let opening: Promise<LedgerStore> | undefined;
  const store = async (): Promise<LedgerStore> => {
    opening ??= (async () => {
      const h = await openLedgerStore(dbPath);
      if (!h.ok) {
        throw new Error(`claims store unavailable at ${h.path}: ${h.reason}`);
      }
      return h.store;
    })();
    return opening;
  };
  /** Same opportunistic drain the ledger facade runs — a failed drain
   *  costs freshness, never the call. */
  const fresh = (s: LedgerStore): void => {
    const spoolPath = resolveHookSpoolPath(env);
    if (spoolPath === null) {
      return;
    }
    try {
      drainIntoStore(s, spoolPath);
    } catch {
      // stale reads beat no reads — claims degrade like the ledger
    }
  };

  /** Liveness context — one sessions scan per call; the claims table
   *  is small (per-session resource leases) so a full scan is honest. */
  const liveCtx = async (s: LedgerStore): Promise<LiveCtx> => {
    const stored = await s.sessions({});
    const sessions = new Map<string, SessionRow>();
    for (const row of stored) {
      sessions.set(sessKey(row.host, row.sid), row);
    }
    return { now: now(), bootTimeMs: bootTimeMs(), sessions, pidAliveFn };
  };

  const sweep = (s: LedgerStore, rows: ClaimDbRow[], ctx: LiveCtx): ClaimDbRow[] => {
    const live: ClaimDbRow[] = [];
    for (const row of rows) {
      if (claimDead(row, ctx)) {
        s.claims.remove(row.resource, row.host, row.sid);
      } else {
        live.push(row);
      }
    }
    return live;
  };

  /** `task:*` delegation — the bd claim is the source of truth. The
   *  facade verifies/assigns through the tasks store; it never writes
   *  a claims-table row for these URIs. */
  const taskClaim = async (
    resource: string,
    session: SessionKey,
    o: ClaimOptions
  ): Promise<ClaimResult> => {
    const id = resource.slice(TASK_PREFIX.length).trim();
    if (id === '') {
      throw new Error(`malformed task claim resource: ${JSON.stringify(resource)}`);
    }
    const s = await store();
    fresh(s);
    let dir = o.dir;
    if (dir === undefined) {
      const rows = await s.sessions({ host: session.host, sid: session.sid });
      dir = rows[0]?.cwd ?? undefined;
    }
    if (dir === undefined || dir === '') {
      throw new Error(
        `task claim ${resource} needs a project dir — the session has no ledger cwd; pass opts.dir`
      );
    }
    const ts = tasksForDir(dir);
    const actor = ts.actor?.() ?? '';
    const row = ts.get<TaskRow>(id);
    if (row === undefined) {
      return { ok: false, conflict: null };
    }
    const assignee = (row.assignee ?? '').trim();
    if (assignee === actor) {
      return { ok: true };
    }
    if (assignee !== '') {
      return { ok: false, conflict: taskConflict(resource, assignee) };
    }
    try {
      ts.claim(id);
      return { ok: true };
    } catch {
      // the store refused between our read and its write — re-read the
      // holder so the conflict names who actually won
      const after = ts.get<TaskRow>(id);
      const holder = (after?.assignee ?? '').trim();
      return holder === '' || holder === actor
        ? { ok: false, conflict: null }
        : { ok: false, conflict: taskConflict(resource, holder) };
    }
  };

  const taskRelease = async (resource: string, session: SessionKey): Promise<void> => {
    const id = resource.slice(TASK_PREFIX.length).trim();
    if (id === '') {
      return;
    }
    const s = await store();
    fresh(s);
    let dir: string | undefined;
    const rows = await s.sessions({ host: session.host, sid: session.sid });
    dir = rows[0]?.cwd ?? undefined;
    if (dir === undefined || dir === '') {
      return; // no project to resolve the store against — nothing to release
    }
    const ts = tasksForDir(dir);
    const actor = ts.actor?.() ?? '';
    if (actor === '') {
      return;
    }
    const row = ts.get<TaskRow>(id);
    if (row === undefined || (row.assignee ?? '').trim() !== actor) {
      return; // not ours — never clear a foreign claim
    }
    if (isClosedStatus(row.status)) {
      return; // a closed bead keeps its assignee — release would resurrect it
    }
    try {
      ts.reopen(id);
    } catch {
      // best-effort release — the next `bro claim list`/`bd` read tells the truth
    }
  };

  return {
    async claim(resource, session, o = {}): Promise<ClaimResult> {
      const uri = resource.trim();
      if (uri === '' || session.host === '' || session.sid === '') {
        throw new Error('claim needs a non-empty resource URI and session key');
      }
      if (uri.startsWith(TASK_PREFIX)) {
        return taskClaim(uri, session, o);
      }
      const s = await store();
      fresh(s);
      const ctx = await liveCtx(s);
      const sessRow = ctx.sessions.get(sessKey(session.host, session.sid));
      const exclusive = o.exclusive ?? uri.startsWith('role:');
      const ttlMs = o.ttlMs === undefined ? CLAIM_DEFAULT_TTL_MS : o.ttlMs;
      const nowMs = ctx.now;
      // conflict check + write are one critical section — two sessions
      // racing `role:orchestrator@<project>` must not both read "free"
      let outcome: ClaimResult = { ok: true };
      s.claims.withLock?.(() => {
        const standing = sweep(s, s.claims.resourceRows(uri), ctx);
        const blocker = standing.find(
          r => !(r.host === session.host && r.sid === session.sid) && (exclusive || r.exclusive)
        );
        if (blocker !== undefined) {
          outcome = { ok: false, conflict: toClaimRow(blocker) };
          return;
        }
        s.claims.upsert({
          resource: uri,
          host: session.host,
          sid: session.sid,
          project: o.project ?? sessRow?.project ?? roleProjectSuffix(uri) ?? null,
          exclusive,
          leaseUntil: ttlMs > 0 ? nowMs + ttlMs : null,
          ttlMs: ttlMs > 0 ? ttlMs : null,
          pid: o.pid ?? null,
          pidStart: o.pidStart ?? null,
          detail: o.detail ?? null,
          nowMs,
        });
      });
      return outcome;
    },

    async release(resource, session): Promise<void> {
      const uri = resource.trim();
      if (uri === '') {
        return;
      }
      if (uri.startsWith(TASK_PREFIX)) {
        await taskRelease(uri, session);
        return;
      }
      const s = await store();
      fresh(s);
      s.claims.remove(uri, session.host, session.sid);
    },

    async list(q: ClaimQuery = {}): Promise<ClaimRow[]> {
      const s = await store();
      fresh(s);
      const ctx = await liveCtx(s);
      const rows = sweep(
        s,
        s.claims.rows({
          ...(q.project !== undefined ? { project: q.project } : {}),
          ...(q.session !== undefined ? { host: q.session.host, sid: q.session.sid } : {}),
          ...(q.resource !== undefined ? { resourcePrefix: q.resource } : {}),
        }),
        ctx
      );
      return rows.map(toClaimRow);
    },
  };
}

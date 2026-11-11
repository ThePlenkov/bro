/**
 * Ledger store — the default `LedgerFacade` backend: `node:sqlite`
 * (WAL) at `$XDG_STATE_HOME/bro/ledger.db` (epic spec
 * specs/sessions/bro-izpyk.md "Ledger (default backend)", implementation
 * spec specs/bro-izpyk.1.1.md).
 *
 * LAZY by contract: nothing here is a resident process. `drainHookSpool`
 * runs on invocation (today: `bro hooks status`), and the facade's read
 * methods opportunistically drain pending spool rows first — the
 * inode+offset cursor makes the no-op case a couple of `stat`s.
 *
 * `node:sqlite` is imported dynamically: unflagged on Node ≥23 and on
 * 22.x only behind a flag, so a missing module degrades to
 * `{ ok: false }` — the numbers cost the run, never the hook (same
 * pattern as packages/devin/src/usage.ts).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitTry } from './git.ts';
import {
  hookSpoolFiles,
  parseSpoolLine,
  resolveHookSpoolPath,
  type SpoolRow,
} from './hook-spool.ts';
import type {
  HookStat,
  InstallRow,
  LedgerEventRow,
  LedgerFacade,
  LedgerInstallRow,
  LedgerRow,
  LedgerSessionRow,
  Mode,
  SessionKey,
  SessionQuery,
  SessionRow,
  SessionState,
  StatsQuery,
} from './ledger.ts';
import { isMode } from './ledger.ts';
import { projectId } from './project-id.ts';

/** The sqlite handle — node:sqlite's shape, narrowed to what the store
 *  uses (same narrowing as devin/usage.ts). */
interface SqliteStatement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}
interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

/** `$XDG_STATE_HOME/bro/ledger.db` (`~/.local/state` fallback) — the
 *  machine-wide ledger home, same resolution family as the spool. */
export function ledgerDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(stateHome, 'bro', 'ledger.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS installs(
  host TEXT NOT NULL,
  adapter_version TEXT,
  plugin_root TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(host, plugin_root)
);
CREATE TABLE IF NOT EXISTS sessions(
  host TEXT NOT NULL,
  sid TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  branch TEXT,
  mode TEXT NOT NULL DEFAULT 'observe',
  state TEXT NOT NULL DEFAULT 'live',
  pid INTEGER,
  pid_start TEXT,
  started INTEGER,
  last_seen INTEGER NOT NULL,
  spawned_by TEXT,
  PRIMARY KEY(host, sid)
);
CREATE TABLE IF NOT EXISTS events(
  ts INTEGER NOT NULL,
  host TEXT NOT NULL,
  sid TEXT,
  project TEXT,
  event TEXT NOT NULL,
  phase TEXT NOT NULL,
  ms INTEGER,
  outcome TEXT,
  launcher TEXT,
  detail_json TEXT,
  pair TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_pair ON events(pair);
CREATE INDEX IF NOT EXISTS events_host_event ON events(host, event, ts);
CREATE TABLE IF NOT EXISTS claims(
  resource TEXT NOT NULL,
  host TEXT NOT NULL,
  sid TEXT NOT NULL,
  project TEXT,
  exclusive INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY(resource, host, sid)
);
CREATE TABLE IF NOT EXISTS hook_stats_daily(
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  event TEXT NOT NULL,
  n INTEGER NOT NULL,
  p50 INTEGER,
  p95 INTEGER,
  timeouts INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, host, event)
);
`;

/** Spool outcome → canonical ledger vocabulary (epic spec: `ok |
 *  fastpath | timeout | killed | error | no-cli`). */
const OUTCOME_MAP: Record<string, string> = {
  ok: 'ok',
  fastpath: 'fastpath',
  watchdog: 'timeout',
  timeout: 'timeout',
  nonzero: 'error',
  error: 'error',
  killed: 'killed',
  'no-cli': 'no-cli',
};

const EVENT_RETENTION_MS = 14 * 86_400_000;
const STATS_RETENTION_MS = 180 * 86_400_000;
/** A start with no end this long after launch is a host kill — the same
 *  margin the spool reader uses (watchdog + 5s). */
const KILLED_GRACE_SECONDS = 5;
/** Kill synthesis + stats rollup + retention scan the whole retained
 *  window — on a quiet ledger that would make every facade read pay for
 *  rows that did not change. Maintenance runs when rows landed or the
 *  last pass is older than this; a synthesized kill may lag its horizon
 *  by at most this much, which the +5s grace already treats as noise. */
const LEDGER_MAINTENANCE_MS = 60_000;

export interface IngestContext {
  nowMs: number;
  watchdogSeconds: number;
  /** cwd → {project, branch} resolved once per drain (git calls stay out
   *  of the write transaction). */
  projects: Map<string, { project?: string; branch?: string }>;
  /** pid → process start stamp, best-effort `ps`, once per drain. */
  pidStarts: Map<number, string | undefined>;
}

export interface FileBatch {
  /** Inode key — survives the hooks.spool → hooks.spool.1 rename. */
  ino: string;
  /** Byte offset after the last complete line ingested. */
  offset: number;
  rows: SpoolRow[];
}

export interface IngestResult {
  rows: number;
  events: number;
  sessions: number;
  installs: number;
  killed: number;
  pruned: number;
}

/** What the store exposes — the LedgerFacade contract plus the worker's
 *  ingest/drain surface (not part of the facade: read commands never
 *  see it). */
export interface LedgerStore extends LedgerFacade {
  ingest(batches: FileBatch[], ctx: IngestContext): IngestResult;
  loadCursor(): Record<string, number>;
  /** `PRAGMA wal_checkpoint(TRUNCATE)` — folds the WAL into the main
   *  file after a drain so readers on other connections see a compact
   *  db. Best-effort: a busy checkpoint just defers to the next drain. */
  checkpoint(): void;
  close(): void;
}

export type LedgerStoreResult =
  | { ok: true; store: LedgerStore; close: () => void }
  | { ok: false; path: string; reason: string };

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Project identity per the epic spec — `projectId` (remote hash, else
 *  git-common-dir realpath) with the no-git fallback of the folder's own
 *  realpath. */
export function sessionProject(cwd: string): string | undefined {
  try {
    return projectId(cwd);
  } catch {
    // no remote and no git common dir — the folder itself is the project
  }
  try {
    return digest(realpathSync(cwd));
  } catch {
    return undefined;
  }
}

function sessionBranch(cwd: string): string | undefined {
  const r = gitTry(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], 1000);
  if (r.code !== 0) {
    return undefined;
  }
  const branch = r.out.trim();
  return branch === '' || branch === 'HEAD' ? undefined : branch;
}

/** Best-effort process start stamp for pid-reuse safety (claims, F3).
 *  `ps -o lstart=` is the portable spelling; failure is a missing
 *  fact, not an error. */
function pidStart(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

interface EventInsert {
  ts: number;
  host: string;
  sid?: string;
  project?: string;
  event: string;
  phase: string;
  ms?: number;
  outcome?: string;
  launcher?: string;
  pair?: string;
  detail?: unknown;
}

function insertEvent(db: SqliteDatabase, e: EventInsert): void {
  db.prepare(
    `INSERT INTO events(ts, host, sid, project, event, phase, ms, outcome, launcher, detail_json, pair)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.ts,
    e.host,
    e.sid ?? null,
    e.project ?? null,
    e.event,
    e.phase,
    e.ms ?? null,
    e.outcome ?? null,
    e.launcher ?? null,
    e.detail === undefined ? null : JSON.stringify(e.detail),
    e.pair ?? null
  );
}

function upsertSession(
  db: SqliteDatabase,
  s: {
    host: string;
    sid: string;
    project?: string;
    cwd?: string;
    branch?: string;
    mode?: Mode;
    pid?: number;
    pidStart?: string;
    started?: number;
    lastSeen?: number;
    state?: SessionState;
    spawnedBy?: string;
  }
): void {
  const now = s.lastSeen ?? Date.now();
  db.prepare(
    `INSERT INTO sessions(host, sid, project, cwd, branch, mode, state, pid, pid_start, started, last_seen, spawned_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, sid) DO UPDATE SET
       project = COALESCE(excluded.project, sessions.project),
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       branch = COALESCE(excluded.branch, sessions.branch),
       pid = COALESCE(excluded.pid, sessions.pid),
       pid_start = COALESCE(excluded.pid_start, sessions.pid_start),
       started = CASE
         WHEN sessions.started IS NULL OR excluded.started < sessions.started THEN excluded.started
         ELSE sessions.started END,
       last_seen = MAX(sessions.last_seen, excluded.last_seen),
       spawned_by = COALESCE(excluded.spawned_by, sessions.spawned_by),
       state = CASE WHEN sessions.state = 'ended' THEN sessions.state ELSE excluded.state END`
  ).run(
    s.host,
    s.sid,
    s.project ?? null,
    s.cwd ?? null,
    s.branch ?? null,
    s.mode ?? 'observe',
    s.state ?? 'live',
    s.pid ?? null,
    s.pidStart ?? null,
    s.started ?? null,
    now,
    s.spawnedBy ?? null
  );
}

function upsertInstall(
  db: SqliteDatabase,
  i: {
    host: string;
    adapterVersion?: string;
    pluginRoot?: string;
    seenAt?: number;
  }
): void {
  const seen = i.seenAt ?? Date.now();
  db.prepare(
    `INSERT INTO installs(host, adapter_version, plugin_root, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host, plugin_root) DO UPDATE SET
       adapter_version = COALESCE(excluded.adapter_version, installs.adapter_version),
       first_seen = MIN(installs.first_seen, excluded.first_seen),
       last_seen = MAX(installs.last_seen, excluded.last_seen)`
  ).run(i.host, i.adapterVersion ?? null, i.pluginRoot ?? '', seen, seen);
}

function dayOf(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function percentileOf(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const position = (sorted.length - 1) * fraction;
  const low = sorted[Math.floor(position)];
  const high = sorted[Math.ceil(position)];
  if (low === undefined || high === undefined) {
    return null;
  }
  return Math.round(low + (high - low) * (position - Math.floor(position)));
}

/** Recompute one UTC day's hook_stats_daily row set from the events
 *  table — end-phase rows only (a start is not a completed run). */
function rollupDay(db: SqliteDatabase, day: string): void {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const dayEnd = dayStart + 86_400_000;
  db.prepare(`DELETE FROM hook_stats_daily WHERE day = ?`).run(day);
  const rows = db
    .prepare(
      `SELECT host, event, ms, outcome FROM events
       WHERE phase = 'end' AND ts >= ? AND ts < ?`
    )
    .all(dayStart, dayEnd) as Array<{
    host: string;
    event: string;
    ms: number | null;
    outcome: string | null;
  }>;
  const groups = new Map<
    string,
    { host: string; event: string; n: number; durs: number[]; timeouts: number; errors: number }
  >();
  for (const r of rows) {
    // length-prefixed pair key — a bare `${host}${event}` concat lets
    // ("foo","bar") collide with ("foobar","") and merges distinct
    // host×event stats into one group
    const key = `${r.host.length}:${r.host}${r.event}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { host: r.host, event: r.event, n: 0, durs: [], timeouts: 0, errors: 0 };
      groups.set(key, g);
    }
    g.n += 1;
    if (r.ms !== null) {
      g.durs.push(r.ms);
    }
    if (r.outcome === 'timeout' || r.outcome === 'killed') {
      g.timeouts += 1;
    }
    if (r.outcome === 'error') {
      g.errors += 1;
    }
  }
  const ins = db.prepare(
    `INSERT INTO hook_stats_daily(day, host, event, n, p50, p95, timeouts, errors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const g of groups.values()) {
    const durs = [...g.durs].sort((a, b) => a - b);
    ins.run(
      day,
      g.host,
      g.event,
      g.n,
      percentileOf(durs, 0.5),
      percentileOf(durs, 0.95),
      g.timeouts,
      g.errors
    );
  }
}

/** Per-drain ingest state — the counts the caller returns plus the
 *  in-batch pair map and touched-day set the maintenance pass needs. */
interface IngestState {
  counts: IngestResult;
  /** start ts by pair id — end rows resolve `ms` against it before
   *  falling back to the events table. */
  pairStarts: Map<string, number>;
  /** UTC days touched this drain — stats rollup re-runs per day. */
  days: Set<string>;
}

/** cwd → {project, branch} once per drain. drainIntoStore primes the
 *  ctx cache outside the write transaction; a miss means ingest ran
 *  without that pre-pass, so resolve lazily — still cached either way. */
function recordProjectBranch(
  rec: SpoolRow,
  ctx: IngestContext
): { project?: string; branch?: string } {
  if (rec.cwd === undefined) {
    return {};
  }
  let pc = ctx.projects.get(rec.cwd);
  if (pc === undefined) {
    pc = { project: sessionProject(rec.cwd), branch: sessionBranch(rec.cwd) };
    ctx.projects.set(rec.cwd, pc);
  }
  return pc;
}

/** pid → process start stamp, once per drain (best-effort `ps`). */
function recordPidStart(rec: SpoolRow, ctx: IngestContext): string | undefined {
  if (rec.pid === undefined) {
    return undefined;
  }
  if (!ctx.pidStarts.has(rec.pid)) {
    ctx.pidStarts.set(rec.pid, pidStart(rec.pid));
  }
  return ctx.pidStarts.get(rec.pid);
}

/** `ms` for one record — start rows register their ts in the in-batch
 *  pair map; end rows resolve against it, then the events table for a
 *  start ingested by an earlier drain. */
function pairMs(
  db: SqliteDatabase,
  rec: SpoolRow,
  pairStarts: Map<string, number>,
  tsMs: number
): number | undefined {
  if (rec.phase === 'start') {
    pairStarts.set(rec.id, tsMs);
    return undefined;
  }
  if (rec.phase !== 'end') {
    return undefined;
  }
  let startTs = pairStarts.get(rec.id);
  if (startTs === undefined) {
    const row = db
      .prepare(`SELECT ts FROM events WHERE pair = ? AND phase = 'start' ORDER BY ts LIMIT 1`)
      .get(rec.id) as { ts: number } | undefined;
    startTs = row?.ts;
  }
  return startTs !== undefined && tsMs >= startTs ? tsMs - startTs : undefined;
}

/** One spool record → installs/sessions/events rows. Runs inside the
 *  drain's write transaction; the ctx caches keep the per-record work
 *  to map lookups + prepared inserts. */
function ingestRecord(
  db: SqliteDatabase,
  rec: SpoolRow,
  ctx: IngestContext,
  st: IngestState
): void {
  st.counts.rows += 1;
  const tsMs = rec.ts * 1000;
  st.days.add(dayOf(tsMs));
  // installs — every firing proves the wiring, fields or not
  upsertInstall(db, {
    host: rec.host,
    adapterVersion: rec.adapter,
    pluginRoot: rec.pluginRoot,
    seenAt: tsMs,
  });
  st.counts.installs += 1;
  const { project, branch } = recordProjectBranch(rec, ctx);
  const pidStartStamp = recordPidStart(rec, ctx);
  if (rec.sid !== undefined && rec.sid !== '') {
    upsertSession(db, {
      host: rec.host,
      sid: rec.sid,
      project,
      cwd: rec.cwd,
      branch,
      pid: rec.pid,
      pidStart: pidStartStamp,
      started: tsMs,
      lastSeen: tsMs,
      spawnedBy: rec.agent,
    });
    st.counts.sessions += 1;
  }
  const ms = pairMs(db, rec, st.pairStarts, tsMs);
  const outcome = rec.outcome === undefined ? undefined : (OUTCOME_MAP[rec.outcome] ?? rec.outcome);
  insertEvent(db, {
    ts: tsMs,
    host: rec.host,
    sid: rec.sid,
    project,
    event: rec.event,
    phase: rec.phase,
    ms,
    outcome,
    launcher: rec.launcher,
    pair: rec.id,
    detail: rec.rc === undefined ? undefined : { rc: rec.rc },
  });
  st.counts.events += 1;
}

/** Killed synthesis + per-day stats rollup + retention — the expensive
 *  half of a drain, gated on fresh rows or a stale last pass so an empty
 *  drain stays a couple of stats (see LEDGER_MAINTENANCE_MS). */
function runMaintenance(
  db: SqliteDatabase,
  ctx: IngestContext,
  counts: IngestResult,
  days: Set<string>
): void {
  const maintRow = db.prepare(`SELECT value FROM meta WHERE key = 'ledger_maint_at'`).get() as
    | { value: string }
    | undefined;
  const lastMaintRaw = maintRow === undefined ? 0 : Number(maintRow.value);
  const lastMaint = Number.isFinite(lastMaintRaw) ? lastMaintRaw : 0;
  if (counts.rows === 0 && ctx.nowMs - lastMaint < LEDGER_MAINTENANCE_MS) {
    return;
  }
  counts.killed = synthesizeKilled(db, ctx, days);
  for (const day of days) {
    rollupDay(db, day);
  }
  counts.pruned = prune(db, ctx.nowMs);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES ('ledger_maint_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(ctx.nowMs));
}

function buildStore(db: SqliteDatabase): LedgerStore {
  const loadCursor = (): Record<string, number> => {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'spool_cursor'`).get() as
      | { value: string }
      | undefined;
    if (row === undefined) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
          out[k] = v;
        }
      }
      return out;
    } catch {
      return {};
    }
  };

  const ingest = (batches: FileBatch[], ctx: IngestContext): IngestResult => {
    const counts: IngestResult = {
      rows: 0,
      events: 0,
      sessions: 0,
      installs: 0,
      killed: 0,
      pruned: 0,
    };
    const state: IngestState = { counts, pairStarts: new Map(), days: new Set() };
    const cursor = loadCursor();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const batch of batches) {
        for (const rec of batch.rows) {
          ingestRecord(db, rec, ctx, state);
        }
        cursor[batch.ino] = batch.offset;
      }
      db.prepare(
        `INSERT INTO meta(key, value) VALUES ('spool_cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(JSON.stringify(cursor));
      runMaintenance(db, ctx, counts, state.days);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
    return counts;
  };

  return {
    ingest,
    loadCursor,
    checkpoint: () => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // busy or unsupported — frames stay for the next drain
      }
    },
    close: () => db.close(),
    async append(rows: LedgerRow[]): Promise<void> {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          if (row.kind === 'event') {
            const e = row as LedgerEventRow;
            insertEvent(db, {
              ts: e.ts,
              host: e.host,
              sid: e.sid,
              project: e.project,
              event: e.event,
              phase: e.phase,
              ms: e.ms,
              outcome: e.outcome,
              launcher: e.launcher,
              pair: e.pair,
              detail: e.detail,
            });
          } else if (row.kind === 'session') {
            const s = row as LedgerSessionRow;
            upsertSession(db, {
              host: s.host,
              sid: s.sid,
              project: s.project,
              cwd: s.cwd,
              branch: s.branch,
              mode: s.mode,
              pid: s.pid,
              pidStart: undefined,
              started: s.started,
              lastSeen: s.lastSeen,
              state: s.state,
              spawnedBy: s.spawnedBy,
            });
          } else if (row.kind === 'install') {
            const i = row as LedgerInstallRow;
            upsertInstall(db, {
              host: i.host,
              adapterVersion: i.adapterVersion,
              pluginRoot: i.pluginRoot,
              seenAt: i.seenAt,
            });
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back
        }
        throw err;
      }
    },
    async sessions(q: SessionQuery = {}): Promise<SessionRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.project !== undefined) {
        where.push('project = ?');
        params.push(q.project);
      }
      if (q.host !== undefined) {
        where.push('host = ?');
        params.push(q.host);
      }
      if (q.sid !== undefined) {
        where.push('sid = ?');
        params.push(q.sid);
      }
      if (q.state !== undefined) {
        where.push('state = ?');
        params.push(q.state);
      }
      const sql = `SELECT host, sid, project, cwd, branch, mode, state, pid, pid_start, started, last_seen, spawned_by
         FROM sessions${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY last_seen DESC`;
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map(r => ({
        host: String(r.host),
        sid: String(r.sid),
        project: (r.project as string | null) ?? null,
        cwd: (r.cwd as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        mode: isMode(r.mode) ? r.mode : 'observe',
        state: (r.state as SessionState) ?? 'live',
        pid: (r.pid as number | null) ?? null,
        pidStart: (r.pid_start as string | null) ?? null,
        started: (r.started as number | null) ?? null,
        lastSeen: Number(r.last_seen),
        spawnedBy: (r.spawned_by as string | null) ?? null,
      }));
    },
    async installs(): Promise<InstallRow[]> {
      const rows = db
        .prepare(
          `SELECT host, adapter_version, plugin_root, first_seen, last_seen
           FROM installs ORDER BY host, plugin_root`
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map(r => ({
        host: String(r.host),
        adapterVersion: (r.adapter_version as string | null) ?? null,
        pluginRoot: (r.plugin_root as string | null) ?? null,
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
      }));
    },
    async stats(q: StatsQuery = {}): Promise<HookStat[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.day !== undefined) {
        where.push('day = ?');
        params.push(q.day);
      }
      if (q.host !== undefined) {
        where.push('host = ?');
        params.push(q.host);
      }
      if (q.event !== undefined) {
        where.push('event = ?');
        params.push(q.event);
      }
      const sql = `SELECT day, host, event, n, p50, p95, timeouts, errors
         FROM hook_stats_daily${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY day DESC, host, event`;
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map(r => ({
        day: String(r.day),
        host: String(r.host),
        event: String(r.event),
        n: Number(r.n),
        p50: (r.p50 as number | null) ?? null,
        p95: (r.p95 as number | null) ?? null,
        timeouts: Number(r.timeouts),
        errors: Number(r.errors),
      }));
    },
    async setMode(s: SessionKey, mode: Mode): Promise<void> {
      db.prepare(
        `INSERT INTO sessions(host, sid, mode, state, last_seen)
         VALUES (?, ?, ?, 'live', ?)
         ON CONFLICT(host, sid) DO UPDATE SET mode = excluded.mode`
      ).run(s.host, s.sid, mode, Date.now());
    },
  };
}

/** Start events old enough to be unpaired kills — synthesize the missing
 *  end row so "firing but killed" is ledger data, not a spool-side guess.
 *  Deduped by `pair`: the synthetic row IS the end, so a second drain
 *  finds it and skips. */
function synthesizeKilled(db: SqliteDatabase, ctx: IngestContext, days: Set<string>): number {
  const killBeforeMs = ctx.nowMs - (ctx.watchdogSeconds + KILLED_GRACE_SECONDS) * 1000;
  const horizonMs = ctx.nowMs - EVENT_RETENTION_MS;
  const starts = db
    .prepare(
      `SELECT pair, ts, host, sid, project, event, launcher FROM events
       WHERE phase = 'start' AND pair IS NOT NULL AND ts <= ? AND ts >= ?`
    )
    .all(killBeforeMs, horizonMs) as Array<{
    pair: string;
    ts: number;
    host: string;
    sid: string | null;
    project: string | null;
    event: string;
    launcher: string | null;
  }>;
  const hasEnd = db.prepare(`SELECT 1 FROM events WHERE pair = ? AND phase = 'end' LIMIT 1`);
  const hasKilled = db.prepare(
    `SELECT 1 FROM events WHERE pair = ? AND outcome = 'killed' LIMIT 1`
  );
  const ins = db.prepare(
    `INSERT INTO events(ts, host, sid, project, event, phase, ms, outcome, launcher, detail_json, pair)
     VALUES (?, ?, ?, ?, ?, 'end', ?, 'killed', ?, ?, ?)`
  );
  let n = 0;
  for (const s of starts) {
    if (hasEnd.get(s.pair) !== undefined || hasKilled.get(s.pair) !== undefined) {
      continue;
    }
    const killTs = s.ts + ctx.watchdogSeconds * 1000;
    ins.run(
      killTs,
      s.host,
      s.sid,
      s.project,
      s.event,
      ctx.watchdogSeconds * 1000,
      s.launcher,
      JSON.stringify({ synthesized: 'host-kill', watchdog_s: ctx.watchdogSeconds }),
      s.pair
    );
    // the synthetic end can land on a day no ingested row touched — its
    // stats rollup must run too
    days.add(dayOf(killTs));
    n += 1;
  }
  return n;
}

function prune(db: SqliteDatabase, nowMs: number): number {
  const eventCutoff = nowMs - EVENT_RETENTION_MS;
  const statsCutoff = dayOf(nowMs - STATS_RETENTION_MS);
  const ev = db.prepare(`DELETE FROM events WHERE ts < ?`).run(eventCutoff);
  const st = db.prepare(`DELETE FROM hook_stats_daily WHERE day < ?`).run(statsCutoff);
  return (ev.changes ?? 0) + (st.changes ?? 0);
}

/** Open (or create) the ledger at `path`. Never throws — the caller gets
 *  the reason instead; every write is best-effort like router-store. */
export async function openLedgerStore(path: string): Promise<LedgerStoreResult> {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string) => SqliteDatabase;
    };
    mkdirSync(dirname(path), { recursive: true });
    const client = new mod.DatabaseSync(path);
    client.exec('PRAGMA journal_mode = WAL');
    client.exec('PRAGMA busy_timeout = 3000');
    client.exec(SCHEMA);
    return { ok: true, store: buildStore(client), close: () => client.close() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path, reason: msg };
  }
}

export type DrainResult =
  | ({ ok: true } & IngestResult & { files: number })
  | { ok: false; reason: string };

export interface DrainOptions {
  /** Spool file — defaults to the env-resolved hooks.spool (`.1` + live
   *  are both drained). `BRO_HOOK_SPOOL=0` resolves null → ok/no-op. */
  spoolPath?: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  watchdogSeconds?: number;
}

/** Read new complete lines from each spool file into FileBatches —
 *  inode-keyed offsets, partial-tail holdback. Batches with zero
 *  parseable rows still advance the cursor: consumed garbage must not
 *  be re-read on every drain. */
function readBatches(store: LedgerStore, spoolPath: string): FileBatch[] {
  const cursor = store.loadCursor();
  const batches: FileBatch[] = [];
  for (const path of hookSpoolFiles(spoolPath)) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    const ino = String(st.ino);
    let offset = cursor[ino] ?? 0;
    if (st.size < offset) {
      offset = 0; // truncated/recreated under the same inode
    }
    if (st.size === offset) {
      continue;
    }
    let buf: Buffer;
    try {
      const fd = openSync(path, 'r');
      try {
        buf = Buffer.alloc(st.size - offset);
        readSync(fd, buf, 0, buf.length, offset);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) {
      continue; // no complete line yet — hold the offset
    }
    const complete = text.slice(0, lastNl + 1);
    const rows = complete
      .split('\n')
      .slice(0, -1)
      .map(line => parseSpoolLine(line))
      .filter((r): r is SpoolRow => r !== undefined);
    batches.push({ ino, offset: offset + Buffer.byteLength(complete, 'utf8'), rows });
  }
  return batches;
}

export interface DrainIntoResult extends IngestResult {
  files: number;
}

/** Drain one spool path into an already-open store — the shared core of
 *  `drainHookSpool` (which owns open/close) and the facade's opportunistic
 *  read-path drain. Synchronous: sqlite is sync and the file slice is
 *  bounded by the spool's rotation size. Throws on ingest failure —
 *  callers own the degrade policy. */
export function drainIntoStore(
  store: LedgerStore,
  spoolPath: string,
  opts: { nowMs?: number; watchdogSeconds?: number } = {}
): DrainIntoResult {
  const batches = readBatches(store, spoolPath);
  const ctx: IngestContext = {
    nowMs: opts.nowMs ?? Date.now(),
    watchdogSeconds: opts.watchdogSeconds ?? 8,
    projects: new Map(),
    pidStarts: new Map(),
  };
  // pre-resolve project/branch/pid_start OUTSIDE the write transaction —
  // git/ps spawns must not hold the single-writer lock
  for (const batch of batches) {
    for (const r of batch.rows) {
      if (r.cwd !== undefined && !ctx.projects.has(r.cwd)) {
        ctx.projects.set(r.cwd, { project: sessionProject(r.cwd), branch: sessionBranch(r.cwd) });
      }
      if (r.pid !== undefined && !ctx.pidStarts.has(r.pid)) {
        ctx.pidStarts.set(r.pid, pidStart(r.pid));
      }
    }
  }
  const counts = store.ingest(batches, ctx);
  store.checkpoint();
  return { files: batches.length, ...counts };
}

/** The lazy worker: drain `hooks.spool` → `ledger.db`. On-read cadence —
 *  `bro hooks status` awaits this; F1b read surfaces call it too. Never
 *  throws: a missing sqlite, an unwritable dir, or a malformed spool all
 *  degrade to `{ ok: false }`/`{ ok: true, rows: 0 }`. */
export async function drainHookSpool(opts: DrainOptions = {}): Promise<DrainResult> {
  const env = opts.env ?? process.env;
  const spoolPath = opts.spoolPath ?? resolveHookSpoolPath(env);
  if (spoolPath === null) {
    return {
      ok: true,
      files: 0,
      rows: 0,
      events: 0,
      sessions: 0,
      installs: 0,
      killed: 0,
      pruned: 0,
    };
  }
  const dbPath = opts.dbPath ?? ledgerDbPath(env);
  const opened = await openLedgerStore(dbPath);
  if (!opened.ok) {
    return { ok: false, reason: opened.reason };
  }
  try {
    return { ok: true, ...drainIntoStore(opened.store, spoolPath, opts) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    opened.close();
  }
}

/** The `facade('ledger')` backend — lazily opens the db on first use and
 *  caches the handle for the process. Read methods drain pending spool
 *  rows first (best-effort, never fatal) so a reader always sees a fresh
 *  ledger without a separate worker tick. */
export function ledgerFacade(
  opts: { dbPath?: string; env?: NodeJS.ProcessEnv } = {}
): LedgerFacade {
  const env = opts.env ?? process.env;
  const dbPath = opts.dbPath ?? ledgerDbPath(env);
  let opening: Promise<LedgerStoreResult> | undefined;
  const open = (): Promise<LedgerStoreResult> => (opening ??= openLedgerStore(dbPath));
  const store = async (): Promise<LedgerStore> => {
    const h = await open();
    if (!h.ok) {
      throw new Error(`ledger store unavailable at ${h.path}: ${h.reason}`);
    }
    return h.store;
  };
  /** Opportunistic drain on the same connection — the size/ino cursor
   *  check makes the no-op case a couple of stats. */
  const fresh = (s: LedgerStore): void => {
    const spoolPath = resolveHookSpoolPath(env);
    if (spoolPath === null) {
      return;
    }
    try {
      drainIntoStore(s, spoolPath);
    } catch {
      // the ledger is a record, not a gate — a failed drain costs
      // freshness, never the read
    }
  };
  return {
    append: async rows => (await store()).append(rows),
    sessions: async (q?: SessionQuery) => {
      const s = await store();
      fresh(s);
      return s.sessions(q);
    },
    installs: async () => {
      const s = await store();
      fresh(s);
      return s.installs();
    },
    stats: async (q?: StatsQuery) => {
      const s = await store();
      fresh(s);
      return s.stats(q);
    },
    setMode: async (s: SessionKey, mode: Mode) => (await store()).setMode(s, mode),
  };
}

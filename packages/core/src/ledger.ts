/**
 * LedgerFacade — bro's machine-wide store of installs, sessions, hook
 * events, claims and modes (epic spec specs/sessions/bro-izpyk.md, "Ledger
 * (default backend)"). The hot path (`hooks/run.sh`) never touches a
 * facade — it writes the versioned spool wire format; only the lazy worker
 * and read commands go through this contract, which is why the database
 * can be swapped without touching the hooks.
 *
 * Default backend: `node:sqlite` (WAL) under `$XDG_STATE_HOME/bro/` —
 * `ledger-store.ts`. Swappable for jsonl-only, an OTLP sink, or a remote
 * ledger (mesh, later) behind the same facade.
 */

/** One session's identity — `(host, nativeSessionId)` per the epic
 *  spec's vocabulary. */
export interface SessionKey {
  host: string;
  sid: string;
}

/** Per-session behaviour switch — `observe` is the implicit default. */
export type Mode = 'observe' | 'plan' | 'code' | 'review' | 'orchestrate';

export const MODES: readonly Mode[] = ['observe', 'plan', 'code', 'review', 'orchestrate'];

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** Session lifecycle as the ledger records it. `interrupted` is derived
 *  at read time (last event older than boot, no end/stop) — the worker
 *  only ever writes `live`. */
export type SessionState = 'live' | 'idle' | 'ended' | 'interrupted';

export interface SessionQuery {
  project?: string;
  host?: string;
  sid?: string;
  state?: SessionState;
}

export interface SessionRow {
  host: string;
  sid: string;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  mode: Mode;
  state: SessionState;
  pid: number | null;
  pidStart: string | null;
  /** Epoch ms of the session's first seen event. */
  started: number | null;
  /** Epoch ms of the most recent event. */
  lastSeen: number;
  /** BRO_AGENT_ID when bro spawned the session. */
  spawnedBy: string | null;
}

export interface InstallRow {
  host: string;
  adapterVersion: string | null;
  pluginRoot: string | null;
  /** Epoch ms. */
  firstSeen: number;
  lastSeen: number;
}

export interface StatsQuery {
  /** UTC day `YYYY-MM-DD`; absent = all retained days. */
  day?: string;
  host?: string;
  event?: string;
}

export interface HookStat {
  day: string;
  host: string;
  event: string;
  n: number;
  p50: number | null;
  p95: number | null;
  timeouts: number;
  errors: number;
}

/** One event row — `phase` is the spool's start|end (plus the worker's
 *  synthesized `killed` end), `outcome` the canonical ledger vocabulary
 *  `ok | fastpath | timeout | killed | error | no-cli`. `ms` is the
 *  start→end wall time for paired ends. `pair` is the run.sh launch id. */
export interface LedgerEventRow {
  kind: 'event';
  /** Epoch ms. */
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

export interface LedgerSessionRow {
  kind: 'session';
  host: string;
  sid: string;
  project?: string;
  cwd?: string;
  branch?: string;
  mode?: Mode;
  state?: SessionState;
  pid?: number;
  pidStart?: string;
  /** Epoch ms. */
  started?: number;
  lastSeen?: number;
  spawnedBy?: string;
}

export interface LedgerInstallRow {
  kind: 'install';
  host: string;
  adapterVersion?: string;
  pluginRoot?: string;
  /** Epoch ms. */
  seenAt?: number;
}

/** Worker-side batch insert unit — the `append` contract's row. */
export type LedgerRow = LedgerEventRow | LedgerSessionRow | LedgerInstallRow;

export interface LedgerFacade {
  /** Worker-side batch insert. */
  append(rows: LedgerRow[]): Promise<void>;
  /** `bro sessions` read surface (bro-izpyk.1.2 consumes). */
  sessions(q?: SessionQuery): Promise<SessionRow[]>;
  /** Where bro is wired + firing (bro-izpyk.1.2/.1.3 consume). */
  installs(): Promise<InstallRow[]>;
  /** p50/p95, timeouts, errors per host×event×day. */
  stats(q?: StatsQuery): Promise<HookStat[]>;
  setMode(s: SessionKey, mode: Mode): Promise<void>;
}

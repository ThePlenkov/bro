/** Session planes — the host-wide admission seam.

 *  A plane is one agent ecosystem's notion of "a live session on this
 *  machine": how to recognize a spawn command that starts one, and how
 *  to count the ones already running (lock files, sockets, a local
 *  API — the plane owns its state plane). Core owns only the ABSTRACT
 *  mechanics: the quota config shape, the reservation lifecycle, and
 *  the serialized admit. Vendor names never reach this file — planes
 *  register themselves, callers ask the registry. */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SpawnError } from './agents.ts';
import { LockTimeout, withFileLock } from './filelock.ts';
import { pidAlive, procStat } from './proc.ts';
import {
  DEFAULT_WORK_BUDGET_WINDOW_MINUTES,
  laneBudgetAdmit,
  laneBudgetKey,
} from './lane-budget.ts';

/** A session-kind admission plane. */
export interface SessionPlane {
  /** The kind id — also the config bag key (`agents.<kind>`). */
  readonly kind: string;
  /** Does this CLI identity (basename of the resolved spawn command)
   *  start one of this plane's sessions? Called with the worker's
   *  wrapped cliName for argv workers — never the driver argv[0]. */
  detectsCli(cliName: string): boolean;
  /** How many sessions of this kind does this COMMAND start? The plane
   *  owns its CLI's grammar — one vendor's CLI opens a session with the
   *  bare binary, another's only with a subcommand, a third never (a
   *  read-only listing is not a session). Optional: a plane that does
   *  not implement it never claims a command, so a caller asks the
   *  registry rather than guessing (spec bro-bww9v).
   *
   *  The answer is the START count, not a boolean: one command can open
   *  several sessions (`devin a & devin b`), and the cap is judged
   *  against `live + starts`. */
  startsSessions?(command: string): number;
  /** Live sessions of this kind on the host, per the plane's own state
   *  plane (lock dir, socket listing, local API). `bag` is the
   *  `agents.<kind>` config section — plane-local knobs (like a lockDir
   *  override) ride it; `workerEnv` is the env the spawned child will
   *  run under, so a count can include the state dir the child will
   *  actually write to. Throws SpawnError('unavailable') when the
   *  count can't be established — admission fails closed. */
  countLive(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number;
  /** The spawned-worker subset of countLive — the sessions
   *  `agents.<kind>.maxWorkers` gates. Planes that cannot tell a
   *  spawned worker from an interactive session leave this
   *  unimplemented; arming maxWorkers on such a plane refuses 'config'
   *  at admission, never a silent unguard. Same fail-closed contract
   *  as countLive — a host where the worker split cannot be verified
   *  at all throws SpawnError('unavailable'). A plane that can see
   *  which of its sessions' pids are already counted may also retire
   *  landed `.slot` reservations inside its count — the admission
   *  tally runs after it, so a landed spawn is not counted twice. */
  countWorkers?(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number;
  /** The BATCH subset of countWorkers — the workers the fleet owns
   *  (a drive fixer, a loop member). The split is by the supervisor
   *  marker the spawn's env carries (BRO_PR, BRO_MOL_ID): the marker
   *  rides into the worker process, so a plane that can read its
   *  workers' environment can tell the fleet's workers from the
   *  operator's own sessions. `agents.<kind>.maxBatchWorkers` gates
   *  this population; a plane that cannot split refuses 'config' when
   *  that cap is armed, never silently unguards it (spec bro-9h86l). */
  countBatchWorkers?(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number;
  /** The live sessions as rows — the same lock/scan semantics countLive
   *  runs, kept per-session so a board names the session, not just the
   *  count. Optional: a plane without it contributes counts but no
   *  rows. Same SpawnError('unavailable') contract as countLive — an
   *  unverifiable scan throws, never silently reports "no sessions". */
  listLive?(bag: Record<string, unknown>, workerEnv?: Record<string, string>): DiscoveredSession[];
  /** The host CLI's own resume argv for a native session id —
   *  `claude --resume <id>`, `codex resume <id>` (epic spec
   *  specs/sessions/bro-izpyk.md "Sessions and resume"). `cwd` is the
   *  session's recorded working directory: a host whose resume grammar
   *  scopes to where the session ran reads it here; the launcher also
   *  spawns with it as cwd. Optional and per-host: absent or a null
   *  return means the host has no resume command bro knows — callers
   *  report that instead of guessing (bro-izpyk.4). A plane that only
   *  knows resume (no session counting) still answers here — the
   *  quota paths never reach it because such a plane claims no cli and
   *  counts nothing. */
  resumeArgv?(nativeSessionId: string, cwd: string): string[] | null;
  /** Is this `bro hooks` invocation this host's own direct call? The
   *  in-process adapters (opencode/kilo/pi/omp) spawn `bro hooks`
   *  themselves and bypass hooks/run.sh — they stamp `BRO_HOOK_HOST`
   *  on the spawn env, so the plane's check is env-marker identity
   *  (epic spec SessionPlane sketch, impl specs/bro-izpyk.9.md).
   *  Optional: run.sh hosts never set the marker, so a plane without
   *  it simply never claims a launch — the ledger's adapter emit path
   *  stays off. */
  detectHook?(env: NodeJS.ProcessEnv): boolean;
  /** One hook payload → the canonical fields the ledger cares about —
   *  session id, event, tool, cwd. Every adapter sends `session_id`
   *  today, so `normalizeHookPayload` is the shared answer; the member
   *  exists so a host whose payload spells identity differently owns
   *  its own mapping. */
  normalizeHook?(payload: unknown): CanonicalHookEvent;
}

/** The canonical identity of one hook firing — the fields a
 *  `SessionPlane.normalizeHook` promises out of a host payload (epic
 *  spec SessionPlane sketch: "session id, event, tool, cwd"). All
 *  optional: a payload that carries none of them still parses — the
 *  emit path records what it can prove. */
export interface CanonicalHookEvent {
  /** The host's native session id. */
  sid?: string;
  /** The canonical bro event name when the host sent a raw one. */
  event?: string;
  /** The tool a tool-scoped event names. */
  tool?: string;
  /** The session's working directory when the payload carries it. */
  cwd?: string;
}

/** The shared `normalizeHook` — first string `session_id` /
 *  `conversation_id` / `sessionID` wins, `tool_name`/`toolName` is the
 *  tool, `cwd` is a string cwd. Every in-process adapter already emits
 *  `session_id` (the same key hooks.ts's HookInput reads), so the
 *  common case is one lookup; the extra keys cover hosts whose payload
 *  spells identity differently without a bespoke plane. */
export function normalizeHookPayload(payload: unknown): CanonicalHookEvent {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {};
  }
  const p = payload as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;
  // defined-keys only — the canonical event carries what the payload
  // proved; absent keys stay absent so `ev.sid === undefined` is the
  // probe, never "key exists, value undefined"
  const out: CanonicalHookEvent = {};
  const sid = str(p.session_id) ?? str(p.conversation_id) ?? str(p.sessionID);
  if (sid !== undefined) {
    out.sid = sid;
  }
  const tool = str(p.tool_name) ?? str(p.toolName);
  if (tool !== undefined) {
    out.tool = tool;
  }
  const cwd = str(p.cwd);
  if (cwd !== undefined) {
    out.cwd = cwd;
  }
  return out;
}

/** One live session a session-plane sees — a worker the registry never
 *  spawned (a foreign or interactive session) or the inner process of
 *  a registered agent. `agentId` handles the second case: the worker's
 *  own BRO_AGENT_ID badge, when the plane can read it, so a board
 *  folds the session into its agent row instead of counting the same
 *  work twice. */
export interface DiscoveredSession {
  pid: number;
  /** The plane's name for the session (a lock-name, a socket id) when
   *  the state plane carries one. */
  name?: string;
  /** The session's working directory when the plane can read it —
   *  a same-repo similarity/admission check scopes by it. */
  cwd?: string;
  /** The plane's own worker classification — the same predicate
   *  countWorkers applies. False is "live, but not a worker" (an
   *  interactive session), not "unknown". */
  worker?: boolean;
  /** The worker's BRO_AGENT_ID env badge when readable — the registry
   *  correlation id. */
  agentId?: string;
}

// --- plane registry ------------------------------------------------------------

const planes = new Map<string, SessionPlane>();

/** Register a plane — builtins register at import; external plugins
 *  register through the connector surface. Re-registering a kind the
 *  host already knows replaces it (tests reset via clearSessionPlanes). */
export function registerSessionPlane(plane: SessionPlane): void {
  planes.set(plane.kind, plane);
}

export function sessionPlane(kind: string): SessionPlane | undefined {
  return planes.get(kind);
}

export function sessionPlanes(): SessionPlane[] {
  return [...planes.values()];
}

/** The plane a spawn command belongs to — first registered detector
 *  that claims the cliName wins. */
export function sessionPlaneForCli(cliName: string): SessionPlane | undefined {
  for (const p of planes.values()) {
    if (p.detectsCli(cliName)) {
      return p;
    }
  }
  return undefined;
}

/** Test hook — drop all registrations. */
export function clearSessionPlanes(): void {
  planes.clear();
}

// --- quota config ----------------------------------------------------------------

/** `agents.<kind>` → the admission lanes. `maxSessions`/`maxWorkers`
 *  absent or an explicit 0 mean uncapped (same convention as
 *  fleet.maxConcurrent); a quota exists when EITHER lane is armed. A
 *  present-but-malformed value flags `invalid` with `invalidKey`
 *  naming the bad knob — a typo must refuse loudly at admission, never
 *  silently unguard. `reservationsDir` is a generic override
 *  (reservations are bro's own files); every other key in the bag is
 *  the plane's private config, handed to countLive/countWorkers. */
export interface SessionQuota {
  maxSessions: number;
  maxWorkers?: number;
  /** The BATCH lane's own worker cap — the fleet's share of the worker
   *  budget. The interactive lane keeps the rest of `maxWorkers`. A
   *  batch spawn is one carrying a supervisor marker (BRO_PR for a drive
   *  fixer, BRO_MOL_ID for a loop member) — the marker rides into the
   *  worker process, so the plane can tell the two populations apart.
   *  Unset = one budget for everyone (spec bro-9h86l). */
  maxBatchWorkers?: number;
  /** Worker-minutes of running time per rolling window the batch lane
   *  may spend before the lane parks (spec bro-tdndq). Unlike the
   *  worker caps — concurrency counts — this budgets the account's
   *  actual spend so the lane pauses BEFORE the provider wall. */
  workBudgetMinutes?: number;
  /** The rolling window `workBudgetMinutes` is spent in — default
   *  `DEFAULT_WORK_BUDGET_WINDOW_MINUTES` (60). A modifier, never a
   *  lane of its own: armed without `workBudgetMinutes` it does
   *  nothing. */
  workBudgetWindowMinutes?: number;
  reservationsDir?: string;
  invalid?: boolean;
  invalidKey?: string;
}

/** One admission lane's parsed knob: a count, a malformed marker, or
 *  absent (uncapped). A present-but-malformed value is a config bug —
 *  it flags `invalid` and admission refuses loudly. */
type QuotaLane = { n: number } | { invalid: true } | undefined;

function quotaLane(
  bag: Record<string, unknown>,
  key: 'maxSessions' | 'maxWorkers' | 'maxBatchWorkers'
): QuotaLane {
  const v = bag[key];
  if (v === undefined || v === 0) {
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    return { invalid: true };
  }
  return { n: v };
}

/** A minute-denominated knob — fractional values are valid config
 *  (worker's minutes needn't be whole), everything else is the same
 *  malformed-marker contract as the count lanes. */
function quotaMinutes(
  bag: Record<string, unknown>,
  key: 'workBudgetMinutes' | 'workBudgetWindowMinutes'
): QuotaLane {
  const v = bag[key];
  if (v === undefined || v === 0) {
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    return { invalid: true };
  }
  return { n: v };
}

/** The first malformed lane's knob name — the one admission names when
 *  it refuses a typo. */
function firstBadLane(...lanes: Array<[string, QuotaLane]>): string | undefined {
  for (const [key, lane] of lanes) {
    if (lane !== undefined && 'invalid' in lane) {
      return key;
    }
  }
  return undefined;
}

/** A lane's count — undefined when the knob is absent. */
function laneCount(lane: QuotaLane): number | undefined {
  return lane !== undefined && 'n' in lane ? lane.n : undefined;
}

export function sessionQuotaConfig(
  agents: Record<string, Record<string, unknown>> | undefined,
  kind: string
): SessionQuota | undefined {
  const bag = agents?.[kind];
  if (bag === undefined) {
    return undefined;
  }
  const reservationsDir =
    typeof bag['reservationsDir'] === 'string' ? bag['reservationsDir'] : undefined;
  const sessions = quotaLane(bag, 'maxSessions');
  const workers = quotaLane(bag, 'maxWorkers');
  const batchWorkers = quotaLane(bag, 'maxBatchWorkers');
  const budgetMinutes = quotaMinutes(bag, 'workBudgetMinutes');
  const budgetWindow = quotaMinutes(bag, 'workBudgetWindowMinutes');
  // the window is a modifier, never a lane: it arms the quota only
  // alongside workBudgetMinutes — a present-but-malformed one still
  // counts so the typo refuses loudly instead of reading as absent
  const windowArmed = budgetWindow !== undefined && !('n' in budgetWindow);
  if (
    sessions === undefined &&
    workers === undefined &&
    batchWorkers === undefined &&
    budgetMinutes === undefined &&
    !windowArmed
  ) {
    return undefined;
  }
  const bad = firstBadLane(
    ['maxSessions', sessions],
    ['maxWorkers', workers],
    ['maxBatchWorkers', batchWorkers],
    ['workBudgetMinutes', budgetMinutes],
    ['workBudgetWindowMinutes', budgetWindow]
  );
  if (bad !== undefined) {
    return { maxSessions: 0, reservationsDir, invalid: true, invalidKey: bad };
  }
  const quota: SessionQuota = {
    maxSessions: laneCount(sessions) ?? 0,
    reservationsDir,
  };
  const maxWorkers = laneCount(workers);
  if (maxWorkers !== undefined) {
    quota.maxWorkers = maxWorkers;
  }
  const maxBatchWorkers = laneCount(batchWorkers);
  if (maxBatchWorkers !== undefined) {
    quota.maxBatchWorkers = maxBatchWorkers;
  }
  const workBudgetMinutes = laneCount(budgetMinutes);
  if (workBudgetMinutes !== undefined) {
    quota.workBudgetMinutes = workBudgetMinutes;
    // the window is a modifier of the budget lane — default when absent
    quota.workBudgetWindowMinutes = laneCount(budgetWindow) ?? DEFAULT_WORK_BUDGET_WINDOW_MINUTES;
  }
  return quota;
}

// --- slot reservations -----------------------------------------------------------

/** How long a claimed-but-not-yet-started session counts. The plane's
 *  own session mark lands within seconds of the child starting; 120s
 *  covers that handoff plus failure cleanup, then the file
 *  self-expires — a crashed parent never wedges the quota. */
export const SESSION_SLOT_TTL_MS = 120_000;

/** Host-shared reservation dir per kind — `$XDG_DATA_HOME/bro/
 *  session-slots/<kind>`. Cross-repo by construction: every bro
 *  process on this host admits against the same set, closing the
 *  window between "count says headroom" and "the spawned session wrote
 *  its own mark in the plane's state". */
export function sessionSlotsDir(kind: string, resDir?: string): string {
  if (typeof resDir === 'string' && resDir.trim() !== '') {
    return resDir;
  }
  const xdg = process.env['XDG_DATA_HOME'];
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'bro', 'session-slots', kind);
}

/** The per-kind admission mutex — the file every serialized
 *  check+claim on this kind locks: the spawn's admission AND the
 *  session cap's guard/conductor claims. A non-`.slot` name under the
 *  slots dir, so the reservation tally never reads it as a claim. */
export function sessionAdmissionLock(kind: string, resDir?: string): string {
  return join(sessionSlotsDir(kind, resDir), 'admission.mutex');
}

/** Does this reservation file belong to the asked lane? The fleet's
 *  carry a `.batch` tag, the operator's do not; no lane asks for all of
 *  them. */
function reservationInLane(name: string, lane: ReservationLane | undefined): boolean {
  if (lane === undefined) {
    return true;
  }
  const batch = name.endsWith('.batch.slot');
  return lane === 'batch' ? batch : !batch;
}

/** The claim's self-description — a `.slot` file is JSON
 *  `{at, pid}`: the write time plus the CLAIMING process's pid. The
 *  pid is what lets a claim outlive the TTL (spec bro-x601l): a
 *  retained session — a conductor's held acp conversation, a pooled
 *  `devin acp` peer — keeps its lane while its holder lives, and a
 *  crashed holder's claim reaps instead of wedging the cap forever.
 *  Claims written before this change are bare timestamps; they keep
 *  the TTL-only semantics they were written under. */
interface SessionSlotMeta {
  at?: unknown;
  pid?: unknown;
  /** the holder's start identity (`procStat().start`) — pins the pid
   *  against reuse: a recycled number fails the identity check even
   *  while it stays live */
  start?: unknown;
  /** the claim key — the census's handoff correlation: a claim swept
   *  for a landing is swept on its key, so the key is what proves a
   *  vanished claim's session now sits in the live rows */
  key?: unknown;
}

/** What a claim recorded — `{pid, start, key}` — all undefined for
 *  old-format files (a bare timestamp) and for content that was never
 *  JSON. `start`/`key` are undefined when the claim predates the
 *  identity pin or the writer could not prove them. */
/** The holder facts a claim's CONTENT carries — `undefined` when the
 *  content is not a JSON object (a bare timestamp, `null`, a scalar),
 *  so a malformed-but-fresh claim still counts and a stale one reaps
 *  on the normal no-holder path instead of throwing past the row. */
function slotHolderContent(
  content: string | undefined
): { pid?: number; start?: string; key?: string } | undefined {
  if (content === undefined) {
    return undefined;
  }
  let parsed: SessionSlotMeta | null;
  try {
    parsed = JSON.parse(content) as SessionSlotMeta | null;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const pid = parsed.pid;
  const start = parsed.start;
  const key = parsed.key;
  return {
    ...(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof start === 'string' && start !== '' ? { start } : {}),
    ...(typeof key === 'string' && key !== '' ? { key } : {}),
  };
}

function slotHolder(path: string): { pid?: number; start?: string; key?: string } | undefined {
  let content: string | undefined;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  return slotHolderContent(content);
}

/** Fresh reservations — files younger than the TTL count as claimed
 *  slots; stale files are reaped in passing UNLESS their recorded
 *  holder is still alive: a live holder means the lane it claimed is
 *  still held, so the claim counts until the holder dies (spec
 *  bro-x601l — pid-governed staleness). A missing dir is zero
 *  reservations; other read failures throw 'unavailable' — an
 *  unverifiable count fails closed, never silently admits. */
/** One counted claim's row — the path plus the holder identity the
 *  file recorded (pid, start, key — each undefined on legacy content):
 *  the census's handoff-correlation pair. `batch` is the lane the
 *  claim's filename carries. */
interface SessionClaimRow {
  path: string;
  pid?: number;
  start?: string;
  key?: string;
  batch: boolean;
}

/** The claims a census counts — files younger than the TTL plus stale
 *  files whose recorded holder still lives; stale dead files are
 *  reaped in passing. Same rules as the tally below, returned as rows
 *  so a caller can re-verify a claim that retired mid-scan. Throws
 *  'unavailable' on an unreadable dir (ENOENT is zero), like the
 *  tally. */
function countedSessionReservations(
  resDir: string,
  lane: ReservationLane | undefined,
  alive: (pid: number, pidStart?: string) => boolean
): SessionClaimRow[] {
  let names: string[];
  try {
    names = readdirSync(resDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new SpawnError(
      `cannot verify session reservations — ${resDir}: ${(err as Error).message}`,
      'unavailable'
    );
  }
  const now = Date.now();
  const rows: SessionClaimRow[] = [];
  for (const name of names) {
    // a tombstone a previous sweep orphaned — settle it before the
    // `.slot` filter hides it: its claim is invisible while the name
    // lasts, so it restores while fresh and reaps on its own
    // staleness verdict (spec bro-x601l). The suffix must match the
    // exact `…reap-<pid>-<hex>` a reap writes — a claim whose key
    // merely contains the marker is never mistaken for debris
    const reapMatch = /\.reap-\d+-[0-9a-f]{8}$/.exec(name);
    if (reapMatch !== null) {
      settleTombstone(resDir, name.slice(0, reapMatch.index), name, now);
      continue;
    }
    if (!name.endsWith('.slot') || !reservationInLane(name, lane)) {
      continue;
    }
    const path = join(resDir, name);
    try {
      const batch = name.endsWith('.batch.slot');
      const stale = now - statSync(path).mtimeMs >= SESSION_SLOT_TTL_MS;
      // one read serves both branches — the holder facts AND the
      // identity a reap must match before it deletes
      let content: string | undefined;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        content = undefined;
      }
      const holder = slotHolderContent(content);
      // the start identity rides the check when the claim recorded it —
      // a pid recycled into a stranger fails it instead of holding the
      // lane for the stranger's whole lifetime; legacy claims without a
      // start keep the pid-only verdict
      if (!stale || (holder?.pid !== undefined && alive(holder.pid, holder.start))) {
        rows.push({ path, batch, ...holder });
        continue;
      }
      reapStaleClaim(resDir, name, content);
    } catch {
      // stat raced a reap — ignore
    }
  }
  return rows;
}

export function countSessionReservations(
  resDir: string,
  lane?: ReservationLane,
  opts?: { pidAlive?: (pid: number, pidStart?: string) => boolean }
): number {
  return countedSessionReservations(resDir, lane, opts?.pidAlive ?? pidAlive).length;
}

/** Delete a claim only when the file at the name is STILL the one the
 *  staleness verdict read (spec bro-x601l — reclamation and
 *  replacement share one ownership protocol). A plain `rmSync(path)`
 *  races a deterministic re-claim: two counters can both mark the same
 *  expired claim, the first's delete lets a reserve recreate the name,
 *  and the second's delete drops the FRESH claim — the lane it held
 *  vanishes while its start is still in flight. The rename moves
 *  whatever sits at the name NOW; only the exact content the verdict
 *  read gets deleted, anything else goes back — a hard link, never a
 *  copy, so restoring can never overwrite a claim that retook the
 *  name. A tombstone the verify never finishes (a crash between
 *  rename and check) is settled by the next sweep, never deleted
 *  blind. */
function reapStaleClaim(resDir: string, name: string, verified: string | undefined): void {
  const tombstone = `${name}.reap-${process.pid}-${randomBytes(4).toString('hex')}`;
  const from = join(resDir, name);
  const to = join(resDir, tombstone);
  try {
    renameSync(from, to);
  } catch {
    return; // another reaper took it, or the file is already gone
  }
  let content: string | undefined;
  try {
    content = readFileSync(to, 'utf8');
  } catch {
    content = undefined;
  }
  if (content === verified) {
    rmSync(to, { force: true });
    return;
  }
  // not the file the verdict condemned — a claim landed between the
  // read and the rename. Put it back under its name only when the
  // name is still free; a `wx` create may already hold it again
  try {
    linkSync(to, from);
    rmSync(to, { force: true });
  } catch {
    // the name is held or the dir rejects the restore — the claim
    // stays tombstoned for the next sweep's settle pass
  }
}

/** A tombstone a previous sweep orphaned — a crash between the rename
 *  and the verify leaves a claim outside `.slot` sight: restore it
 *  under its original name while it is still fresh (the link cannot
 *  overwrite a claim that already retook the name), or reap it when
 *  the file itself reads stale on THIS sweep's own verdict — the
 *  tombstone keeps the condemned file's mtime, so its verdict is the
 *  same file's, not the sweep's first guess. */
function settleTombstone(resDir: string, orig: string, name: string, now: number): void {
  const from = join(resDir, name);
  const to = join(resDir, orig);
  let stale: boolean;
  try {
    stale = now - statSync(from).mtimeMs >= SESSION_SLOT_TTL_MS;
  } catch {
    return; // vanished between the listing and the stat — nothing to settle
  }
  if (stale) {
    rmSync(from, { force: true });
    return;
  }
  try {
    linkSync(from, to);
    rmSync(from, { force: true });
  } catch {
    // the original name already holds a claim — that file is the
    // same logical claim (deterministic names), so the tombstone is
    // redundant bookkeeping, safe to drop
    rmSync(from, { force: true });
  }
}

/** A live+claims census that keeps the reservation→live handoff
 *  observable (spec bro-x601l). The claims are snapshotted BEFORE
 *  `countLive` runs and recounted after. A claim retired between the
 *  two reads is either the handoff completing — the landing session
 *  already sits inside `counts`, its claim redundant — or a
 *  concurrent count's sweep on a landing OUR scan never saw, where
 *  the claim is the only trace of a session `counts` missed. The
 *  `rows` `countLive` returns prove the difference: a retired claim
 *  forgiven only when those rows carry its holder pid or claim key,
 *  else it still counts. Rows MUST come from the same observation as
 *  `counts` — enumerate them inside the callback BEFORE the count
 *  reads, so a row the count never saw can only mean the session
 *  died between the two, never that a later scan caught a landing
 *  the count missed (a later scan would forgive a claim for a
 *  session `counts` could not have charged — the under-count this
 *  census exists to prevent). WITHOUT `rows` the census cannot
 *  prove the rarer external sweep apart from the plane's own
 *  in-count one — every count of a landed session retires its claim
 *  — so it keeps the classic post-count tally and over-admits that
 *  residue rather than double-count every landing. `claims` splits
 *  out `batch` for the fleet's own lane tallies.
 *
 *  `countLive` must run EVERY plane count the tally depends on —
 *  countLive, countWorkers, countBatchWorkers alike: a plane's own
 *  in-count sweep retires landed claims inside ANY of them, and the
 *  AFTER tally must see every sweep it made. */
export function sessionLaneCensus<T>(args: {
  /** the census dirs the claims sit in — deduped by the caller */
  dirs: readonly string[];
  /** the plane's own counts taken between the two claim reads, plus
   *  the live rows the SAME observation produced — enumerate rows
   *  inside this callback, before the counts read, or the proof rows
   *  and the counts they justify can disagree about a landing. Omit
   *  `rows` entirely when the plane cannot enumerate sessions:
   *  correlation with no rows could never prove coverage, and every
   *  unproven retirement would ghost-count — the double-count the
   *  ordering exists to prevent */
  countLive: () => { counts: T; rows?: Iterable<DiscoveredSession> };
}): { counts: T; claims: number; batchClaims: number } {
  const before = new Map<string, SessionClaimRow>();
  for (const dir of args.dirs) {
    for (const row of countedSessionReservations(dir, undefined, pidAlive)) {
      before.set(row.path, row);
    }
  }
  const { counts, rows } = args.countLive();
  const after = new Set<string>();
  let claims = 0;
  let batchClaims = 0;
  for (const dir of args.dirs) {
    for (const row of countedSessionReservations(dir, undefined, pidAlive)) {
      after.add(row.path);
      claims++;
      if (row.batch) {
        batchClaims++;
      }
    }
  }
  const { ghosts, batchGhosts } = retiredClaimGhosts(before, after, rows);
  return { counts, claims: claims + ghosts, batchClaims: batchClaims + batchGhosts };
}

/** The pids and claim keys the live rows already carry — the proof a
 *  retired claim's session landed inside `counts`. */
function liveRowIdentities(rows: Iterable<DiscoveredSession>): {
  pids: Set<number>;
  keys: Set<string>;
} {
  const pids = new Set<number>();
  const keys = new Set<string>();
  for (const r of rows) {
    pids.add(r.pid);
    if (r.agentId !== undefined) {
      keys.add(r.agentId);
    }
  }
  return { pids, keys };
}

/** The retired-claim half of the handoff census — the claims `before`
 *  held that `after` no longer does. A retired claim with a provable
 *  identity is forgiven only when OUR live rows already hold its
 *  session: the holder pid a retagged claim carries, or the claim
 *  key a landed sweep matched on — unmatched it ghost-counts, the
 *  conservative keep of a landing OUR scan never saw. A claim with
 *  NO provable identity, or a census with no rows to prove against,
 *  keeps the classic post-count verdict — the plane's own in-count
 *  sweep explains the far likelier retirement (spec bro-x601l). */
function retiredClaimGhosts(
  before: ReadonlyMap<string, SessionClaimRow>,
  after: ReadonlySet<string>,
  rows: Iterable<DiscoveredSession> | undefined
): { ghosts: number; batchGhosts: number } {
  // a claim is PROVABLE only when the census produced rows AND the
  // claim recorded an identity — anything else keeps the classic
  // post-count verdict (the in-count sweep explains its retirement)
  let known: { pids: Set<number>; keys: Set<string> } | undefined;
  const provable = (row: SessionClaimRow): boolean =>
    rows !== undefined && (row.pid !== undefined || row.key !== undefined);
  const proven = (row: SessionClaimRow): boolean => {
    known ??= liveRowIdentities(rows as Iterable<DiscoveredSession>);
    return (
      (row.pid !== undefined && known.pids.has(row.pid)) ||
      (row.key !== undefined && known.keys.has(row.key))
    );
  };
  let ghosts = 0;
  let batchGhosts = 0;
  for (const row of before.values()) {
    if (after.has(row.path) || !provable(row) || proven(row)) {
      continue;
    }
    ghosts++;
    if (row.batch) {
      batchGhosts++;
    }
  }
  return { ghosts, batchGhosts };
}

/** Claim a host-wide slot — `wx` exclusive create plus a random suffix,
 *  so a same-named spawn from another repo never overwrites a live
 *  claim. Returns the reservation path for release on failure. The
 *  content records the claiming pid (`holderPid`, this process by
 *  default) so a stale claim counts while its holder lives. */
export function reserveSessionSlot(
  resDir: string,
  key: string,
  lane: ReservationLane,
  holderPid?: number
): string {
  mkdirSync(resDir, { recursive: true });
  // the lane rides the file name, and it is EXPLICIT: the batch cap
  // counts only the fleet's reservations, so an in-flight interactive
  // spawn never eats the fleet's share — and an untagged reservation
  // (a caller that forgot) would undercount the fleet
  const tag = lane === 'batch' ? '.batch' : '';
  const path = join(resDir, `${key}-${randomBytes(4).toString('hex')}${tag}.slot`);
  writeFileSync(path, slotContent(holderPid ?? process.pid, key), { flag: 'wx' });
  return path;
}

/** The claim's on-disk content — the write time, the claim key, the
 *  holder pid, and the holder's start identity. `start` pins the pid
 *  against reuse: a holder that exits and leaves its number to a
 *  stranger fails the census's identity check instead of holding the
 *  lane for the stranger's lifetime. `key` is the handoff
 *  correlation: a claim a sweep retired for a landing is forgiven by
 *  a live row carrying the same key. Unprovable facts stay absent —
 *  the census then falls back to the pid-only verdict it gives legacy
 *  claims. */
function slotContent(holderPid: number, key?: string): string {
  const start = procStat(holderPid)?.start;
  return JSON.stringify({
    at: Date.now(),
    pid: holderPid,
    ...(start !== undefined && start !== '' ? { start } : {}),
    ...(key !== undefined && key !== '' ? { key } : {}),
  });
}

/** Rebind a claim to the process actually holding its lane — the claim
 *  is written by the SPAWNING process before the worker exists; once
 *  the child's pid lands, the claim follows the child, so a lane
 *  counts exactly as long as its session runs (spec bro-x601l). `r+`
 *  refuses to recreate a claim the census already swept — a gone
 *  claim stays gone. The recorded `at`/`key` carry over — the retag
 *  changes the HOLDER, not the claim's identity. */
export function retagSessionSlot(path: string, holderPid: number): void {
  try {
    // `r+` keeps the gone-stays-gone guard (it never recreates a swept
    // claim), but it does NOT truncate — a shorter holder pid would
    // leave the old tail behind and the claim's JSON would no longer
    // parse. Write then ftruncate to the content's exact length.
    const fd = openSync(path, 'r+');
    try {
      let prior: SessionSlotMeta = {};
      try {
        prior = JSON.parse(readFileSync(fd, 'utf8')) as SessionSlotMeta;
      } catch {
        // unparseable prior content — the retag keeps what it can prove
      }
      const start = procStat(holderPid)?.start;
      const content = JSON.stringify({
        ...prior,
        pid: holderPid,
        // a failed identity lookup must NOT keep the previous holder's
        // `start` — `...prior` would carry it over and the stale-claim
        // check would compare the NEW pid against the OLD identity,
        // reaping the lane while its holder lives. Set it only when
        // proven; absent otherwise.
        ...(start !== undefined && start !== '' ? { start } : { start: undefined }),
      });
      writeSync(fd, content, 0, 'utf8');
      ftruncateSync(fd, Buffer.byteLength(content));
    } finally {
      closeSync(fd);
    }
  } catch {
    // a claim the census reaped or a race swept is nothing to retag
  }
}

/** Every claim this spawn holds, rebound to the landed child's pid. */
export function retagSessionSlots(paths: readonly (string | undefined)[], holderPid: number): void {
  for (const path of paths) {
    if (path !== undefined) {
      retagSessionSlot(path, holderPid);
    }
  }
}

/** Drop a reservation — spawn-failure cleanup; on success the file is
 *  left to expire behind the child's own session mark. */
export function releaseSessionSlot(path: string): void {
  rmSync(path, { force: true });
}

/** Claim a slot ONCE — the same key never claims twice.
 *
 *  The guard plane runs on more than one hook (a client that sends
 *  both a pre-tool and a permission event would otherwise claim the
 *  slot twice, and the budget would read one session as two). The
 *  deterministic name makes the second claim a no-op: the file is
 *  there, the slot is already held. */
/** One component of a deterministic claim name, escaped so a literal
 *  `-` can NEVER appear in it: the filename joins components on bare
 *  `-`, so a `-` inside a kind or key left raw would let two distinct
 *  (kind, key) pairs — `(alpha, beta-x)` and `(alpha-beta, x)` — land
 *  on one filename and the second exclusive create would read the
 *  first's claim as its own. Every char outside the filename-safe set
 *  folds to `%<hex>` — `-` included, `%` first — so the encoding is
 *  injective and the joined name unambiguous. */
function claimComponent(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._]/g, c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** The deterministic claim's filename base — `<kind>-<key>-<i>` with
 *  each component escaped, so the pair it names is unambiguous on a
 *  ledger two planes can share (spec bro-x601l). The claim's CONTENT
 *  keeps the raw kind/key; the encoding is filename-only. */
export function sessionClaimName(kind: string, key: string, index: number): string {
  return `${claimComponent(kind)}-${claimComponent(key)}-${index}`;
}

export function reserveSessionSlotOnce(
  resDir: string,
  key: string,
  lane: ReservationLane,
  holderPid?: number
): { path: string; fresh: boolean } {
  mkdirSync(resDir, { recursive: true });
  const tag = lane === 'batch' ? '.batch' : '';
  const path = join(resDir, `${key}${tag}.slot`);
  try {
    writeFileSync(path, slotContent(holderPid ?? process.pid, key), { flag: 'wx' });
    return { path, fresh: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { path, fresh: false };
    }
    throw err;
  }
}

/** The env var that marks a spawn as the FLEET's. The fleet sets it
 *  on every spawn it owns — a drive fixer, a loop member (root bead or
 *  molecule child) — so the marker does not depend on a molecule
 *  parent existing. An interactive spawn (a person at a terminal) never
 *  carries it. The child's env is `{ ...process.env, ...spec.env }`, so
 *  the marker rides into the worker process and a plane can classify a
 *  live worker from its own environment. */
export const BATCH_MARKER_ENV = 'BRO_BATCH';

/** The BATCH lane — a spawn the fleet owns. */
export function isBatchSpawn(env: Record<string, string> | undefined): boolean {
  if (env === undefined) {
    return false;
  }
  const marker = env[BATCH_MARKER_ENV];
  return marker !== undefined && marker !== '';
}

/** One provider's lane cap — `fleet.providerCaps.<provider>` armed in
 *  the GLOBAL config layer (spec bro-x601l). `provider` is the
 *  `providers.<name>` entry key — a config value, never a vendor fact.
 *  `reservationsDir` is the caller-scoped override for the census dir
 *  (a test seam; the host-shared default is the rule). */
export interface ProviderCapLane {
  provider: string;
  cap: number;
  reservationsDir?: string;
}

/** The census dir a plane's session-start claims land in — the
 *  provider cap's caller-scoped override when one is named (the test
 *  seam every kind shares), else the kind's own ledger
 *  (`agents.<kind>.reservationsDir`, then the host-shared default).
 *  Every admission on a kind must claim and count in the SAME dir or
 *  the ledger splits. */
export function sessionStartCensusDir(
  plane: SessionPlane,
  agents: Record<string, Record<string, unknown>> | undefined,
  providerCap?: ProviderCapLane
): string {
  const bag = agents?.[plane.kind]?.['reservationsDir'];
  const override = providerCap?.reservationsDir ?? (typeof bag === 'string' ? bag : undefined);
  return sessionSlotsDir(plane.kind, override);
}

/** A plane's live count minus the caller-owned pids (spec bro-x601l):
 *  a session MULTIPLEXER — a conductor's pooled `acp` peer — holds
 *  sessions the claim ledger already counts one-for-one, so the
 *  peer's own deduped lock row would charge the same sessions a
 *  second time (a lane capped at 1 would refuse its first request on
 *  a warm peer). `countLive` only sums — the subtraction needs the
 *  per-pid rows `listLive` answers, so a plane without it cannot say
 *  which pids its count covers and the count stands whole: the
 *  residual over-count is the over-refuse direction, never an
 *  over-admit. */
export function planeLiveExcluding(
  plane: SessionPlane,
  bag: Record<string, unknown>,
  workerEnv: Record<string, string> | undefined,
  excludePids: ReadonlySet<number> | undefined,
  /** the live rows already enumerated for this observation — reused
   *  instead of a second `listLive` scan so the exclusion reads the
   *  same rows the caller's census correlates on */
  rows?: Iterable<DiscoveredSession>
): number {
  const live = plane.countLive(bag, workerEnv);
  if (excludePids === undefined || excludePids.size === 0 || plane.listLive === undefined) {
    return live;
  }
  let own = 0;
  for (const row of rows ?? plane.listLive(bag, workerEnv)) {
    if (excludePids.has(row.pid)) {
      own++;
    }
  }
  return Math.max(0, live - own);
}

/** The provider cap's census — the combined count over EVERY plane
 *  the caller's command claims (spec bro-x601l): a multi-plane
 *  command draws one session per plane on the same provider lane, so
 *  a per-plane census admits each plane in isolation and overshoots
 *  the cap. The reservation tally dedups on the dir — planes sharing
 *  one census dir (the caller-scoped override) contribute its held
 *  claims once. `excludePids` names caller-owned multiplexers whose
 *  lock rows the claims already cover (see `planeLiveExcluding`).
 *  Count it INSIDE the caller's locked section or after its claims
 *  landed: the figure must see every claim already held. */
export function providerCapCensus(
  planes: readonly SessionPlane[],
  agents: Record<string, Record<string, unknown>> | undefined,
  workerEnv: Record<string, string> | undefined,
  providerCap: ProviderCapLane,
  excludePids?: ReadonlySet<number>
): number {
  const dirs = new Set<string>();
  for (const plane of planes) {
    dirs.add(sessionStartCensusDir(plane, agents, providerCap));
  }
  const census = sessionLaneCensus({
    dirs: [...dirs],
    countLive: () => {
      // each plane's rows enumerated AHEAD of its count — the rows
      // the correlation forgives on and the count they justify are
      // one observation (spec bro-x601l), and the same rows feed the
      // pid exclusion so no scan counts what another proved
      const rows: DiscoveredSession[] = [];
      let enumerable = false;
      const live = planes.reduce((total, plane) => {
        const planeRows = plane.listLive?.(agents?.[plane.kind] ?? {}, workerEnv);
        if (planeRows !== undefined) {
          enumerable = true;
          rows.push(...planeRows);
        }
        return (
          total +
          planeLiveExcluding(plane, agents?.[plane.kind] ?? {}, workerEnv, excludePids, planeRows)
        );
      }, 0);
      return { counts: live, ...(enumerable ? { rows } : {}) };
    },
  });
  return census.counts + census.claims;
}

/** The lane checks inside the admission mutex — POST-CLAIM: the
 *  caller's own slot already sits inside `resDir`, so every cap's
 *  verdict is the strict `live > cap` test (the held-count twin of
 *  the pre-claim `live + 1 > cap`). Claiming before counting is the
 *  protocol every un-locked fallback on this ledger runs: a census
 *  taken before the claim reads headroom a contender can take between
 *  the count and the slot write, so the lane can over-refuse under a
 *  burst but never over-admit (spec bro-x601l).
 *
 *  The plane counts run BEFORE the reservation tally: a plane that
 *  can see its own session marks retires a landed spawn's still-fresh
 *  `.slot` inside its own count, and the tally must see that sweep —
 *  otherwise a landed worker counts twice (live + reservation) and the
 *  cap refuses before reaching its configured capacity. Every
 *  remaining reservation is an in-flight spawn — the slot feed is
 *  worker-only by construction. Throws SpawnError — 'config' when a
 *  knob is unusable, 'cap' when a lane is full, 'unavailable' when a
 *  count can't be established. */
function checkSessionLanes(
  plane: SessionPlane,
  bag: Record<string, unknown>,
  quota: SessionQuota | undefined,
  resDir: string,
  opts: SessionLaneOpts
): void {
  const refused = opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : '';
  const providerCap = opts.providerCap;
  const maxWorkers = quota?.maxWorkers ?? 0;
  const maxBatchWorkers = quota?.maxBatchWorkers ?? 0;
  const maxSessions = quota?.maxSessions ?? 0;
  const batch = isBatchSpawn(opts.workerEnv);
  // The plane counts run BEFORE the reservation tally: a plane that
  // retires a landed spawn's still-fresh `.slot` inside its own count
  // must have that sweep VISIBLE to the tally, or a landed worker
  // counts twice (live + reservation) and the cap refuses a rightful
  // admit. The claims snapshot rides AHEAD of the plane count inside
  // sessionLaneCensus — a claim a CONCURRENT count's sweep retires
  // mid-scan (a landing our own scan never saw) still counts unless
  // our live rows prove its holder, so the handoff can over-refuse,
  // never under-count (spec bro-x601l). The batch count rides the
  // same rule.
  const census = sessionLaneCensus({
    dirs: [resDir],
    // EVERY plane count runs inside the window — a sweep retires a
    // landed claim inside countWorkers as readily as countLive, and
    // the after-tally must see each of them. The live rows ride the
    // SAME observation, enumerated ahead of the counts — a row the
    // counts never saw can only be a session that died between the
    // list and the count, never a landing a later scan forgave on
    // behalf of a count that missed it.
    countLive: () => {
      const rows = plane.listLive?.(bag, opts.workerEnv);
      return {
        counts: {
          // the provider cap counts the same census the session lane
          // does — the plane's host-wide sweep plus the claims held.
          // An extra verdict that carries no census of its own falls
          // back to `sessions + reservations`, so it owes the live
          // count even when no primary providerCap or kind quota does
          sessions:
            maxSessions > 0 ||
            providerCap !== undefined ||
            (opts.extraProviderVerdicts ?? []).some(v => v.providerCensus === undefined)
              ? plane.countLive(bag, opts.workerEnv)
              : 0,
          workers:
            maxWorkers > 0 && plane.countWorkers !== undefined
              ? plane.countWorkers(bag, opts.workerEnv)
              : 0,
          batchWorkers:
            maxBatchWorkers > 0 && batch && plane.countBatchWorkers !== undefined
              ? plane.countBatchWorkers(bag, opts.workerEnv)
              : 0,
        },
        // listLive absent means handoff correlation has nothing to
        // prove against — undefined, not an empty set (the census
        // reads that as "protection on, nothing provable" and
        // double-counts every landing the count just swept)
        ...(rows === undefined ? {} : { rows }),
      };
    },
  });
  const sessions = census.counts.sessions;
  const workers = census.counts.workers;
  const batchWorkers = census.counts.batchWorkers;
  const reservations = census.claims;
  // the fleet's share counts the fleet's reservations only — an
  // interactive spawn in flight must not eat the batch lane's cap
  const batchReservations = census.batchClaims;
  // the provider cap is the OUTER gate — a lane of the ACCOUNT, wider
  // than any kind lane, judged first so its refusal names the real
  // constraint (spec bro-x601l). `providerCensus` supplies the
  // combined count over EVERY plane the provider's command claims —
  // a multi-plane command draws one session per plane on the same
  // lane, and a per-plane census would admit each in isolation. Every
  // OTHER lane covering the kind judges the post-claim census too —
  // a shared kind claims once but each lane's cap is its own verdict.
  const providerVerdicts = [
    ...(providerCap === undefined ? [] : [{ providerCap, providerCensus: opts.providerCensus }]),
    ...(opts.extraProviderVerdicts ?? []),
  ];
  for (const verdict of providerVerdicts) {
    const cap = verdict.providerCap;
    if (cap.cap <= 0) {
      continue;
    }
    const live = verdict.providerCensus?.() ?? sessions + reservations;
    if (live > cap.cap) {
      throw new SpawnError(
        `provider '${cap.provider}' lane cap reached — ${live}/${cap.cap} live lanes ` +
          `(fleet.providerCaps.${cap.provider} in the global bro config) ` +
          `— cause: provider_cap` +
          refused,
        'cap',
        'provider_cap'
      );
    }
  }
  if (maxSessions > 0 && sessions + reservations > maxSessions) {
    throw new SpawnError(
      `${plane.kind} session quota reached — ${sessions + reservations}/${maxSessions} live sessions ` +
        `(agents.${plane.kind}.maxSessions in bro.config)` +
        refused,
      'cap'
    );
  }
  if (maxBatchWorkers > 0 && batch) {
    // the fleet's own share of the worker budget
    const budget: LaneBudget = {
      lane: 'maxBatchWorkers',
      cap: maxBatchWorkers,
      live: batchWorkers,
    };
    checkWorkerCap(plane, workerCap(plane, budget), { reservations: batchReservations, refused });
  }
  if (maxWorkers > 0) {
    const budget: LaneBudget = { lane: 'maxWorkers', cap: maxWorkers, live: workers };
    checkWorkerCap(plane, workerCap(plane, budget), { reservations, refused });
  }
  checkWorkBudget(plane, quota, opts, refused);
}

/** The admission opts the lane checks see — `key` is the spawn's claim
 *  key (its agentId) so a budget segment names the same worker the
 *  registry does. `scope`/`liveKeys` opt the budget's dead-worker
 *  prune in: the caller's repo is the liveness truth for its own
 *  segments. `budgetDir` isolates the ledger in tests. `providerCap`
 *  arms the account-wide provider lane gate on the same census;
 *  `providerCensus` is that gate's combined count over every plane
 *  the provider's command claims (spec bro-x601l) — counted INSIDE
 *  this plane's mutex, after this call's own claim landed. */
interface SessionLaneOpts {
  key: string;
  molStep?: string;
  workerEnv?: Record<string, string>;
  scope?: string;
  liveKeys?: ReadonlySet<string>;
  now?: number;
  budgetDir?: string;
  providerCap?: ProviderCapLane;
  /** The provider lane's aggregate census — this plane's own
   *  `sessions + reservations` when the caller does not supply one
   *  (a single-plane command needs no wider count). */
  providerCensus?: () => number;
  /** The OTHER provider lanes whose planes cover this kind — a kind
   *  two provider entries share claims once, but every covering lane
   *  owes ITS cap a verdict on the post-claim census: forwarding only
   *  the first gate would let the second lane's cap sit unjudged while
   *  the start lands (spec bro-x601l). */
  extraProviderVerdicts?: readonly {
    providerCap: ProviderCapLane;
    providerCensus: (() => number) | undefined;
  }[];
  /** Called when a work-budget segment just opened for `key` on this
   *  plane's kind — the spawn path records them so a LATER refusal
   *  (fleet cap, a sibling plane's verdict) can refund the segment
   *  instead of charging minutes for a worker that never ran. */
  budgetCharged?: (kind: string) => void;
}

/** The work budget (spec bro-tdndq) — the fleet's running-time
 *  allowance per rolling window, charged LAST before the slot claim so
 *  every earlier refusal leaves nothing behind. Batch lane only: the
 *  operator's interactive sessions are never throttled (the rate-gate
 *  convention). A spent budget refuses 'cap' with the projected decay
 *  point — the lane parks with headroom instead of dying at the wall
 *  and escalating its reset. */
function checkWorkBudget(
  plane: SessionPlane,
  quota: SessionQuota | undefined,
  opts: SessionLaneOpts,
  refused: string
): void {
  if (quota?.workBudgetMinutes === undefined || !isBatchSpawn(opts.workerEnv)) {
    return;
  }
  const cfg = {
    minutes: quota.workBudgetMinutes,
    windowMinutes: quota.workBudgetWindowMinutes ?? DEFAULT_WORK_BUDGET_WINDOW_MINUTES,
  };
  const admit = laneBudgetAdmit(plane.kind, laneBudgetKey(opts.scope ?? '', opts.key), cfg, {
    now: opts.now,
    ...(opts.budgetDir === undefined ? {} : { dir: opts.budgetDir }),
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    ...(opts.liveKeys === undefined ? {} : { liveKeys: opts.liveKeys }),
  });
  if (!admit.ok) {
    throw new SpawnError(
      `${plane.kind} work budget spent — ${admit.spentMin}/${cfg.minutes} worker-minutes ` +
        `in the last ${cfg.windowMinutes}m (agents.${plane.kind}.workBudgetMinutes) ` +
        `— lane parked, retry in ~${admit.retryAfterSec}s` +
        refused,
      'cap'
    );
  }
  // the segment is live bookkeeping now — tell the caller so a later
  // refusal can hand it back; a refund that never comes charges it
  // when the next scan closes it, the leak this hook exists to close
  opts.budgetCharged?.(plane.kind);
}

/**
 * One worker lane's cap — the whole budget (`maxWorkers`) or the fleet's
 * share of it (`maxBatchWorkers`). The two lanes differ in the knob,
 * the population and the wording; the check itself is one shape, so a
 * change to the rule lands in one place.
 */
/** Which lane a budget belongs to — the whole worker pool or the
 *  fleet's share of it. A named lane, not a loose string: the knob,
 *  the wording and the countable check all follow from it. */
type WorkerLane = 'maxWorkers' | 'maxBatchWorkers';

/** Which lane a RESERVATION belongs to — the fleet's or the operator's.
 *  Explicit at every call site: an untagged reservation would be
 *  counted as nobody's, and the fleet's cap would undercount its own
 *  in-flight spawns. */
export type ReservationLane = 'batch' | 'interactive';

/** A lane's numbers — the cap and what is live against it. */
interface LaneBudget {
  lane: WorkerLane;
  cap: number;
  live: number;
}

interface WorkerCap {
  /** the config knob (`agents.<kind>.<knob>`) */
  knob: WorkerLane;
  /** the subject in the refusal — "worker" / "batch worker" */
  subject: 'worker' | 'batch worker';
  /** the counted population — "workers" / "batch workers" */
  population: 'workers' | 'batch workers';
  /** what a plane that cannot split would be unable to tell apart */
  undistinguishable: 'worker sessions' | 'batch workers';
  /** the cap */
  cap: number;
  /** the lane's live count (the plane counted it before the tally) */
  live: number;
  /** can the plane tell this population apart at all? */
  countable: boolean;
}

/** One lane's cap — the whole budget (`maxWorkers`) or the fleet's
 *  share of it (`maxBatchWorkers`). One shape for both: the wording
 *  differs, the rule does not. */
function workerCap(plane: SessionPlane, budget: LaneBudget): WorkerCap {
  const batch = budget.lane === 'maxBatchWorkers';
  return {
    knob: budget.lane,
    subject: batch ? 'batch worker' : 'worker',
    population: batch ? 'batch workers' : 'workers',
    undistinguishable: batch ? 'batch workers' : 'worker sessions',
    cap: budget.cap,
    live: budget.live,
    countable: batch ? plane.countBatchWorkers !== undefined : plane.countWorkers !== undefined,
  };
}

/** The lane's cap: a plane that cannot tell the population apart
 *  refuses 'config' rather than silently unguard-ing the cap the
 *  operator armed. */
function checkWorkerCap(
  plane: SessionPlane,
  cap: WorkerCap,
  ctx: { reservations: number; refused: string }
): void {
  if (!cap.countable) {
    throw new SpawnError(
      `agents.${plane.kind}.${cap.knob} is set but the '${plane.kind}' session plane ` +
        `cannot distinguish ${cap.undistinguishable} from interactive sessions` +
        ctx.refused,
      'config'
    );
  }
  // post-claim: the caller's own reservation already sits inside
  // `ctx.reservations`, so the verdict is the strict held test —
  // the same boundary the pre-claim `live + 1 > cap` drew
  if (cap.live + ctx.reservations > cap.cap) {
    throw new SpawnError(
      `${plane.kind} ${cap.subject} quota reached — ${cap.live + ctx.reservations}/${cap.cap} live ${cap.population} ` +
        `(agents.${plane.kind}.${cap.knob} in bro.config)` +
        ctx.refused,
      'cap'
    );
  }
}

/** Atomic host-wide admission: the slot claim lands under ONE mutex
 *  shared by every repo BEFORE the count is taken — a per-repo
 *  registry lock cannot serialize this, so without it two spawns each
 *  count below the cap and both start. Claiming before counting is
 *  the same protocol the un-locked session-start fallbacks run on
 *  this ledger (spec bro-x601l): every census sees every claim held,
 *  the verdicts are the strict post-claim tests, and the lane can
 *  over-refuse under a burst but never over-admit. The mutex sits
 *  inside the slots dir under a non-`.slot` name so the counter never
 *  reads it as a reservation. Returns the reservation path —
 *  released by the caller when the spawn fails before a session
 *  exists; a landed session needs no release — its own mark is the
 *  count, and a plane that can see its marks retires the slot inside
 *  its next count (the TTL still bounds what's left). Throws
 *  SpawnError — 'config' when the cap is misconfigured, 'cap' when
 *  full, 'unavailable' when the count can't be established or the
 *  mutex outlives its wait. */
export function admitSessionSlot(
  plane: SessionPlane,
  agents: Record<string, Record<string, unknown>> | undefined,
  opts: SessionLaneOpts
): string | undefined {
  const bag = agents?.[plane.kind] ?? {};
  const quota = sessionQuotaConfig(agents, plane.kind);
  const providerCap = opts.providerCap;
  if (quota === undefined && providerCap === undefined) {
    return undefined;
  }
  // the census dir: the kind's own slots dir — `agents.<kind>.
  // reservationsDir` overrides (even a quota-free bag names it), and a
  // caller-scoped providerCap override wins last (the test seam). The
  // mutex lands in the same dir by construction.
  const resDirOverride =
    providerCap?.reservationsDir ?? quota?.reservationsDir ?? bagReservationsDir(bag);
  const resDir = sessionSlotsDir(plane.kind, resDirOverride);
  try {
    return withFileLock(
      sessionAdmissionLock(plane.kind, resDirOverride),
      () => {
        if (quota?.invalid === true) {
          // a present-but-unparsable cap is a config bug — refuse
          // loudly rather than spawn past a quota the operator armed
          throw new SpawnError(
            `agents.${plane.kind}.${quota.invalidKey ?? 'maxSessions'} must be a positive integer` +
              (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
            'config'
          );
        }
        // claim first — the same protocol the session-start admissions
        // and the un-locked fallbacks on this ledger run (spec
        // bro-x601l): the lane checks below count with this call's
        // slot already inside, so a contender's claim between the
        // count and the write can never be missed. The verdicts are
        // the strict post-claim tests — the lane can over-refuse
        // under a burst, never over-admit.
        const claim = reserveSessionSlot(
          resDir,
          opts.key,
          isBatchSpawn(opts.workerEnv) ? 'batch' : 'interactive'
        );
        try {
          checkSessionLanes(plane, bag, quota, resDir, opts);
        } catch (err) {
          // a refused lane (or a count that cannot be established)
          // hands the claim back inside the section — the budget
          // never holds a slot for a start that did not run
          releaseSessionSlot(claim);
          throw err;
        }
        return claim;
      },
      { label: `${plane.kind} session quota admission` }
    );
  } catch (err) {
    if (err instanceof LockTimeout) {
      throw new SpawnError(
        `${plane.kind} quota admission lock held — ${err.message}`,
        'unavailable'
      );
    }
    throw err;
  }
}

/** The `agents.<kind>.reservationsDir` override a quota-free bag still
 *  names — the reservation dir is bro's own bookkeeping, so the knob
 *  reads whether or not a lane is armed. */
function bagReservationsDir(bag: Record<string, unknown>): string | undefined {
  const raw = bag['reservationsDir'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

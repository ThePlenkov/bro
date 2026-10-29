/**
 * The lane's pacing mechanics (spec bro-y3jvd) — two mechanisms over
 * the provider wall the routing layer derives:
 *
 * 1. The rate gate: `providers.<name>.rateGate` arms a host-shared
 *    token bucket per lane model (`<lane>/<model>` under
 *    `$XDG_STATE_HOME/bro/lane-gate/`). A BATCH spawn pays its
 *    `spawnCost` request-tokens at admission; an empty bucket refuses
 *    with 'cap' + retryAfter. The fleet paces to the account ceiling
 *    instead of discovering it by dying. Interactive spawns never
 *    consult it — the operator's lane is not throttled.
 * 2. The wall pause: while a provider wall holds, `SIGSTOP` the live
 *    workers' process groups — the account is shared, so the lane is
 *    the unit. A worker frozen mid-turn stops feeding the wall
 *    (every attempt pushes the reset out); `SIGCONT` on lift resumes
 *    it where it left off. Records live in `lane-pause.json` so a
 *    reconcile knows who to thaw and never signals a recycled pid.
 *    `providers.<name>.wallPause: false` opts out.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  agentRegistryPath,
  deriveProviderWalls,
  isBatchSpawn,
  laneGateDir,
  laneGateLevel,
  laneGateTake,
  pidAlive,
  procStat,
  readAgentRegistry,
  SpawnError,
  wallText,
  withFileLock,
  type AgentRegistryEntry,
  type LaneRateGate,
  type ProviderEntry,
  type ProviderWall,
  type SpawnSpec,
} from '@broject/core';

// the refund half — re-exported for the spawn path's catch (spec bro-y3jvd)
export { laneGateCredit } from '@broject/core';
import { groupMemberAlive, providerWallsFor, type AgentConnectorEnv } from './agent-connectors.ts';

// --- the rate gate ------------------------------------------------------

/** The bucket key's lane half — a shared `lane` name lets two provider
 *  entries that resolve to the same account (`devin` + `devin-acp`)
 *  draw one budget. */
const laneOf = (name: string, gate: LaneRateGate): string => gate.lane ?? name;

/** Spawn-surface entries carry rateGate; api entries never spawn. */
function gateOf(entry: ProviderEntry | undefined): LaneRateGate | undefined {
  return entry !== undefined && (entry.type === 'cli' || entry.type === 'acp')
    ? entry.rateGate
    : undefined;
}

/** The bucket key's model half — an unmodeled spawn draws the
 *  `(default)` bucket (the free-model lane pins no model). */
const modelOf = (spec: SpawnSpec, entry: ProviderEntry | undefined): string =>
  spec.model ?? (entry !== undefined && 'model' in entry ? entry.model : undefined) ?? '(default)';

/** Charge a batch spawn against its lane's token bucket — returns the
 *  refusal, or undefined when admitted (no gate, interactive lane,
 *  tokens available). Runs inside the caller's registry-lock section:
 *  a refused spawn leaves no half-state either way. */
/** What one admission decides: the refusal to throw, and — on an
 *  admitted take — the charge the caller must be able to hand back if
 *  the spawn dies before its launch step (spec bro-y3jvd). */
export interface LaneAdmission {
  refusal?: SpawnError;
  admitted?: { lane: string; model: string; gate: LaneRateGate };
}

export function laneGateAdmission(
  env: AgentConnectorEnv,
  spec: SpawnSpec,
  now = Date.now()
): LaneAdmission {
  if (spec.provider === undefined || !isBatchSpawn(spec.env)) {
    return {};
  }
  const entry = env.providers?.[spec.provider];
  const gate = gateOf(entry);
  if (gate === undefined) {
    return {};
  }
  const lane = laneOf(spec.provider, gate);
  const model = modelOf(spec, entry);
  const take = laneGateTake(lane, model, gate, { now });
  if (take.ok) {
    return { admitted: { lane, model, gate } };
  }
  return {
    refusal: new SpawnError(
      `provider ${spec.provider} lane '${lane}' out of request budget (${model})` +
        ` — rateGate ${gate.requestsPerHour} req/h · ${gate.spawnCost}/spawn` +
        `; retry in ~${take.retryAfterSec}s` +
        (spec.molStep !== undefined ? ` — spawn of ${spec.molStep} refused` : ''),
      'cap'
    ),
  };
}

/** The refusal-only view — callers/tests that only need the verdict;
 *  the admitted charge travels on `laneGateAdmission`. */
export function laneGateRefusal(
  env: AgentConnectorEnv,
  spec: SpawnSpec,
  now = Date.now()
): SpawnError | undefined {
  return laneGateAdmission(env, spec, now).refusal;
}

// --- the wall pause -----------------------------------------------------

/** A frozen process group — pidStart pins identity so a recycled pid
 *  is never signaled (or reported) as ours. Exported: the pause file's
 *  schema is the artifact the writer seam below speaks in. */
export interface PauseRecord {
  provider: string;
  molStep: string;
  agentId: string;
  pidStart?: string;
  pausedAt: string;
}

export interface PauseFile {
  paused: Record<string, PauseRecord>;
}

/** `<git-common>/bro/lane-pause.json` — repo-scoped like the registry
 *  the walls derive from. */
export function lanePausePath(dir: string): string | null {
  const regPath = agentRegistryPath(dir);
  return regPath === null ? null : join(dirname(regPath), 'lane-pause.json');
}

function readPauseFile(path: string): PauseFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PauseFile>;
    if (raw.paused !== null && typeof raw.paused === 'object') {
      return { paused: raw.paused as Record<string, PauseRecord> };
    }
  } catch {
    // missing/corrupt — start clean; a torn pause file must not strand
    // records nobody will thaw (the reconcile re-freezes what should
    // be frozen anyway)
  }
  return { paused: {} };
}

function writePauseFile(path: string, file: PauseFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

const sig = (pgid: number, signal: 'SIGSTOP' | 'SIGCONT'): boolean => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
};

/** The pause publish seam — injectable so a test can fail the write
 *  and prove the freeze rollback. Production callers never pass it. */
export type PauseWriter = (path: string, file: PauseFile) => void;

/** Does this provider pause on walls? Default ON — a walled account
 *  is rejecting work, and a running worker can only push the reset
 *  out. `wallPause: false` opts out. */
const pauseWanted = (env: AgentConnectorEnv, provider: string): boolean => {
  const entry = env.providers?.[provider];
  if (entry === undefined || !('wallPause' in entry)) {
    return true;
  }
  return entry.wallPause !== false;
};

/** The entry's recorded pid starttime — the reuse pin; absent when the
 *  entry predates identity recording. */
const entryStart = (entry: AgentRegistryEntry): string | undefined =>
  typeof entry.pidStart === 'string' && entry.pidStart !== '' ? entry.pidStart : undefined;

const groupLive = (entry: AgentRegistryEntry): boolean => {
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined;
  if (pid === undefined) {
    return false;
  }
  const start = entryStart(entry);
  return pidAlive(pid, start) || groupMemberAlive(pid, start);
};

/** A recorded pause still points at the same registry row — a respawn
 *  or stop replaces the entry, and the new pid is the reconcile's
 *  problem, not this record's. */
function entryStillOurs(rec: PauseRecord, registry: Record<string, AgentRegistryEntry>): boolean {
  const cur = registry[rec.molStep];
  if (cur === undefined || cur.agentId !== rec.agentId) {
    return false;
  }
  return cur.stopped !== true;
}

/** The one decision per freeze candidate — the wall covers this
 *  entry's provider, the entry is ours to stop, and the group is
 *  live. Returns the group pid to signal. `native` only: its `sh -c`
 *  wrapper is a detached process-group leader bro itself spawned —
 *  pid+pidStart identity pins it. Any other backend's `pid` may name
 *  a container shim or a REMOTE process — SIGSTOP on the host would
 *  hit a stranger. */
function freezablePid(
  entry: AgentRegistryEntry,
  walled: ReadonlyMap<string, ProviderWall>,
  env: AgentConnectorEnv
): number | undefined {
  if (entry.backend !== 'native' || entry.provider === undefined) {
    return undefined;
  }
  if (!walled.has(entry.provider) || entry.stopped === true) {
    return undefined;
  }
  if (!pauseWanted(env, entry.provider) || typeof entry.pid !== 'number') {
    return undefined;
  }
  return groupLive(entry) ? entry.pid : undefined;
}

/** Freeze pass — every live registry worker on a walled provider. The
 *  wall is an account fact, so the lane is the unit: interactive
 *  registry workers pause too (bro-owned labor stops spending the
 *  shared account); the operator's own terminal sessions are not
 *  registry entries and are never touched. Records land in
 *  `file.paused` in place. Returns the groups this pass actually
 *  stopped — the caller's rollback list when the publish fails. */
function freezeLane(
  registry: Record<string, AgentRegistryEntry>,
  lane: { walled: ReadonlyMap<string, ProviderWall>; env: AgentConnectorEnv },
  file: PauseFile,
  now: number
): Array<{ pid: number; pidStart?: string }> {
  const { walled, env } = lane;
  const stopped: Array<{ pid: number; pidStart?: string }> = [];
  for (const [molStep, entry] of Object.entries(registry)) {
    const pid = freezablePid(entry, walled, env);
    if (pid === undefined || file.paused[String(pid)] !== undefined) {
      continue;
    }
    if (sig(pid, 'SIGSTOP')) {
      // pin identity at freeze time: the entry's recorded starttime,
      // else a live read — the record's pidStart is what keeps a
      // recycled pgid out of every later signal decision
      const pidStart = entryStart(entry) ?? procStat(pid)?.start;
      file.paused[String(pid)] = {
        provider: entry.provider as string,
        molStep,
        agentId: entry.agentId,
        pidStart,
        pausedAt: new Date(now).toISOString(),
      };
      stopped.push({ pid, pidStart });
    }
  }
  return stopped;
}

/** Is the recorded group still out there — the wrapper OR a group
 *  member. The signal targets the whole pgid, so the unit the pause
 *  holds is the GROUP: a dead wrapper with live descendants must still
 *  thaw — dropping the record would orphan a stopped group forever.
 *  pidStart bounds member starttimes, so a recycled pgid can't pass. */
const groupStillLive = (pid: number, pidStart: string | undefined): boolean => {
  if (!Number.isInteger(pid)) {
    return false;
  }
  return pidAlive(pid, pidStart) || groupMemberAlive(pid, pidStart);
};

/** Thaw pass — a record survives while its provider still walls AND
 *  its group is still live. Gone or recycled groups drop WITHOUT a
 *  signal — never SIGCONT a stranger. */
function thawLane(
  paused: Record<string, PauseRecord>,
  walled: ReadonlyMap<string, ProviderWall>,
  env: AgentConnectorEnv,
  registry: Record<string, AgentRegistryEntry>
): { next: Record<string, PauseRecord>; thawed: number } {
  const next: Record<string, PauseRecord> = {};
  let thawed = 0;
  for (const [pidStr, rec] of Object.entries(paused)) {
    const pid = Number(pidStr);
    if (!groupStillLive(pid, rec.pidStart)) {
      continue;
    }
    const covered = walled.has(rec.provider) && pauseWanted(env, rec.provider);
    if (covered && entryStillOurs(rec, registry)) {
      next[pidStr] = rec;
      continue;
    }
    if (sig(pid, 'SIGCONT')) {
      thawed++;
    }
  }
  return { next, thawed };
}

/** Assert the pause state the walls imply — freeze newly-walled live
 *  workers, thaw what the wall no longer covers, drop records whose
 *  pids are gone or recycled. `registry`/`walls` may be caller-supplied
 *  (prepareSpawn already holds both under the registry lock). */
function reconcile(
  env: AgentConnectorEnv,
  registry: Record<string, AgentRegistryEntry>,
  walls: ProviderWall[],
  pass: { path: string; now: number; write: PauseWriter }
): { paused: number; thawed: number } {
  const { path, now, write } = pass;
  const walled = new Map(walls.map(w => [w.provider, w]));
  // the pause file is a shared read-modify-write — the drive pass and
  // a spawn-path refusal can reconcile at once, and a stale write
  // would drop records whose groups then stay frozen forever
  return withFileLock(`${path}.lock`, () => {
    const file = readPauseFile(path);
    const stopped = freezeLane(registry, { walled, env }, file, now);
    const { next, thawed } = thawLane(file.paused, walled, env, registry);
    // a present file always syncs — even all-drained; nothing to
    // write only when no records moved AND no file exists
    const settled = Object.keys(next).length === 0 && Object.keys(file.paused).length === 0;
    try {
      if (!settled || existsSync(path)) {
        write(path, { paused: next });
      }
    } catch (error) {
      // the publish failed — on-disk records still cover previously
      // paused groups, but the groups THIS pass stopped have none: a
      // later reconcile could never thaw them. Resume exactly those,
      // and only while the leader's recorded identity still verifies
      // (pid+starttime — never a liveness guess a recycled pgid passes)
      for (const g of stopped) {
        if (pidAlive(g.pid, g.pidStart)) {
          sig(g.pid, 'SIGCONT');
        }
      }
      throw error;
    }
    return { paused: Object.keys(next).length, thawed };
  });
}

const NO_PAUSE = { walled: [] as ProviderWall[], paused: 0, thawed: 0 };

/** Shared tail of both entry points — null path means no git common
 *  dir, and there is nowhere to remember a pause anyway. */
function reconcileWith(
  env: AgentConnectorEnv,
  registry: Record<string, AgentRegistryEntry>,
  walls: ProviderWall[],
  opts: { dir: string; now: number; write: PauseWriter }
): { walled: ProviderWall[]; paused: number; thawed: number } {
  const { dir, now, write } = opts;
  const path = lanePausePath(dir);
  if (path === null) {
    return NO_PAUSE;
  }
  const { paused, thawed } = reconcile(env, registry, walls, { path, now, write });
  return { walled: walls, paused, thawed };
}

/** The periodic/idle call — reads the registry and derives walls
 *  itself (providerWallsFor harvests pending exit causes first, so a
 *  fresh rate_limited death walls this pass, not the next). `write`
 *  is the publish seam — tests fail it to prove the rollback. */
export function reconcileLanePause(
  dir: string,
  env: AgentConnectorEnv,
  now = Date.now(),
  write: PauseWriter = writePauseFile
): { walled: ProviderWall[]; paused: number; thawed: number } {
  return reconcileWith(env, readAgentRegistry(dir), providerWallsFor(dir), { dir, now, write });
}

/** The spawn-path call — the caller's locked registry snapshot is
 *  authoritative (a fresh read mid-lock would see the same file
 *  anyway; threading it through keeps the critical section's reads
 *  consistent). Walls re-derive from that same snapshot. */
export function reconcileLanePauseForRegistry(
  dir: string,
  env: AgentConnectorEnv,
  registry: Record<string, AgentRegistryEntry>,
  now = Date.now()
): { walled: ProviderWall[]; paused: number; thawed: number } {
  return reconcileWith(env, registry, deriveProviderWalls(registry, now), {
    dir,
    now,
    write: writePauseFile,
  });
}

// --- status ---------------------------------------------------------------

export interface LaneStatusRow {
  provider: string;
  wall?: ProviderWall;
  paused: number;
  gate?: Array<{ model: string; tokens: number; capacity: number }>;
}

/** The lane section `bro agents status` renders: walled providers,
 *  frozen-worker counts, and armed-gate levels. Walls derive read-only
 *  here — status never harvests causes (a read that writes is the
 *  spawn path's laziness, not a report's). */
export function laneStatus(dir: string, env: AgentConnectorEnv, now = Date.now()): LaneStatusRow[] {
  const walls = new Map(deriveProviderWalls(readRegistrySafe(dir), now).map(w => [w.provider, w]));
  const pausedBy = pauseCounts(lanePausePath(dir));
  const rows = new Map<string, LaneStatusRow>();
  const row = (p: string): LaneStatusRow => {
    const cur = rows.get(p);
    if (cur !== undefined) {
      return cur;
    }
    const r: LaneStatusRow = { provider: p, paused: pausedBy.get(p) ?? 0 };
    rows.set(p, r);
    return r;
  };
  for (const [provider, w] of walls) {
    row(provider).wall = w;
  }
  for (const provider of pausedBy.keys()) {
    row(provider);
  }
  for (const [name, gate] of armedGates(env)) {
    row(name).gate = gateLevels(laneOf(name, gate), gate, now);
  }
  return [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Registry read that never throws — an unreadable/missing registry
 *  renders as no walls, not a broken status. */
function readRegistrySafe(dir: string): Record<string, AgentRegistryEntry> {
  try {
    return readAgentRegistry(dir);
  } catch {
    return {};
  }
}

/** provider → frozen-group count from the pause file. */
function pauseCounts(path: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (path === null) {
    return out;
  }
  for (const raw of Object.values(readPauseFile(path).paused)) {
    // a hand-edited/corrupt record must not crash `agents status` —
    // count what parses as a pause record, skip the rest (coderabbit)
    const rec: PauseRecord | null = raw;
    if (rec === null || typeof rec !== 'object' || typeof rec.provider !== 'string') {
      continue;
    }
    out.set(rec.provider, (out.get(rec.provider) ?? 0) + 1);
  }
  return out;
}

/** provider name → its armed gate — the configured lanes only. */
function armedGates(env: AgentConnectorEnv): Array<[string, LaneRateGate]> {
  const out: Array<[string, LaneRateGate]> = [];
  for (const [name, entry] of Object.entries(env.providers ?? {})) {
    const gate = gateOf(entry);
    if (gate !== undefined) {
      out.push([name, gate]);
    }
  }
  return out;
}

/** Every bucket file under `<lane>/` — models the gate has touched. */
function gateLevels(
  lane: string,
  gate: LaneRateGate,
  now: number
): Array<{ model: string; tokens: number; capacity: number }> {
  const dir = laneGateDir();
  const prefix = encodeURIComponent(`${lane}/`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ model: string; tokens: number; capacity: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) {
      continue;
    }
    const model = decodeURIComponent(name.slice(prefix.length, -'.json'.length));
    const level = laneGateLevel(lane, model, gate, { now, dir });
    if (level !== null) {
      out.push({ model, ...level });
    }
  }
  return out;
}

const pausedPhrase = (n: number): string => `${n} worker${n === 1 ? '' : 's'} paused`;

/** One row's wall/pause clause — the wall text when held, else the
 *  bare frozen count (a paused group outliving a lifted wall's row). */
function wallClause(r: LaneStatusRow): string | undefined {
  if (r.wall !== undefined) {
    return r.paused > 0 ? `${wallText(r.wall)} · ${pausedPhrase(r.paused)}` : wallText(r.wall);
  }
  return r.paused > 0 ? pausedPhrase(r.paused) : undefined;
}

/** The status table's lane lines — one per walled/paused provider,
 *  one per armed gate bucket. */
export function laneStatusLines(rows: LaneStatusRow[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    const clause = wallClause(r);
    if (clause !== undefined) {
      lines.push(`  ${r.provider}: ${clause}`);
    }
    for (const g of r.gate ?? []) {
      lines.push(`  ${r.provider}: gate ${g.model} — ${g.tokens}/${g.capacity} req budget`);
    }
  }
  return lines;
}

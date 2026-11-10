/** The copilot session plane — a remote count.
 *
 *  Copilot coding-agent tasks live on GitHub's runners, not this host:
 *  the "live session" a quota gates is a task in a live-ish state on
 *  the account's `GET /agents/tasks` listing. `SessionPlane.countLive`
 *  is synchronous and runs inside the host-wide admission mutex, so an
 *  awaited fetch cannot run there — the plane is a CACHED count. The
 *  copilot connector refreshes `live-count.json` beside the
 *  reservations on every spawn/list/status; countLive reads it
 *  synchronously and fails closed ('unavailable') when the cache is
 *  absent, corrupt, or stale — an unverifiable remote count never
 *  silently admits.
 *
 *  `countWorkers` is the same count: there is no interactive copilot
 *  task kind — every agent task is a spawned worker, so maxWorkers and
 *  maxSessions read the same evidence. Landed `.slot` reservations are
 *  swept by the connector's refresh — it alone can correlate a slot
 *  key (the agentId) to a remote taskId through the repo registry;
 *  the TTL still bounds whatever the sweep misses.
 *
 *  Vendor knowledge at the plugin layer like devin.ts — core owns the
 *  mutex/reservation mechanics, this file owns the cache shape; the gh
 *  calls that refresh it live with the connector in
 *  agent-connectors.ts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  readAgentRegistry,
  registerExternalPlane,
  registerSessionPlane,
  sessionSlotsDir,
  SpawnError,
  withFileLock,
  type ExternalActivity,
  type ExternalActivityPlane,
  type ExternalProbeCtx,
  type SessionPlane,
} from '@broject/core';

/** How long a refreshed count stays trustworthy. Remote task state
 *  changes outside bro's view (the session completes server-side), so
 *  the window is the reservation TTL's own bound — a stale count fails
 *  closed rather than admit on evidence the remote may have moved past. */
export const COPILOT_COUNT_TTL_MS = 120_000;

/** The cache payload — `ids` is what the refresh observed (occupancy
 *  probes correlate entries against it); `count` is the lane's number.
 *  `incomplete` marks a truncated inventory that cannot be treated as
 *  complete (pagination hit the limit). */
export interface CopilotCountCache {
  at: number;
  count: number;
  ids: string[];
  incomplete?: boolean;
}

/** `<slots>/live-count.json` — inside the reservations dir, invisible
 *  to the `.slot` tally (it reads `*.slot` only). The reservationsDir
 *  override relocates it for tests like the devin plane's lockDir. */
export function copilotCountFile(resDir?: string): string {
  return join(sessionSlotsDir('copilot', resDir), 'live-count.json');
}

/** Parse the cache — anything unreadable/corrupt is "no count", never
 *  a fabricated zero. */
export function readCopilotCount(file: string): CopilotCountCache | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return undefined;
    }
    const c = v as { at?: unknown; count?: unknown; ids?: unknown; incomplete?: unknown };
    if (typeof c.at !== 'number' || typeof c.count !== 'number' || c.count < 0) {
      return undefined;
    }
    const ids = Array.isArray(c.ids) ? c.ids.filter((x): x is string => typeof x === 'string') : [];
    const incomplete = c.incomplete === true;
    return { at: c.at, count: c.count, ids, incomplete: incomplete || undefined };
  } catch {
    return undefined;
  }
}

/** The connector's refresh — the remote live-task id set observed by a
 *  `GET /agents/tasks?state=<live>` listing lands here for the next
 *  synchronous count. `at` is the observation time the caller stamps
 *  (the fetch's START): a concurrent refresh that observed earlier must
 *  never overwrite this one — an on-disk `at` newer than ours wins. */
export function writeCopilotCount(
  resDir: string | undefined,
  ids: string[],
  at = Date.now(),
  incomplete = false
): CopilotCountCache {
  const file = copilotCountFile(resDir);
  const cache: CopilotCountCache = {
    at,
    count: ids.length,
    ids,
    incomplete: incomplete || undefined,
  };
  const persist = (): CopilotCountCache => {
    const existing = readCopilotCount(file);
    if (existing !== undefined && existing.at > cache.at) {
      return existing;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(cache)}\n`);
    } catch {
      // a cache that can't persist just stays absent — the next count
      // fails closed like a stale one
    }
    return cache;
  };
  // the read-compare-write must be serialized — two processes passing
  // the `at` check before either writes lets the older observation
  // clobber the newer one (the lock is `<file>.lock/`, invisible to
  // the `.slot` tally like the cache itself)
  try {
    return withFileLock(`${file}.lock`, persist, { waitMs: 1_000, label: 'copilot live-count' });
  } catch {
    // lock contention means another refresh is mid-write — re-read
    // once; persisting ours anyway would reopen the overwrite race
    // this lock exists to close
    return readCopilotCount(file) ?? cache;
  }
}

/** The fail-closed read both lanes share — a fresh cache yields its
 *  count; absent/corrupt/stale throws 'unavailable' so admission
 *  refuses instead of spawning past an unverifiable cap. `now` and the
 *  file are injectable for tests; `label` names the lane in the error. */
function cachedCount(file: string, label: string, now = Date.now()): number {
  const cache = readCopilotCount(file);
  if (cache === undefined) {
    throw new SpawnError(
      `cannot verify copilot ${label} count — ${file} absent or corrupt; ` +
        'the cache refreshes on copilot spawn/list/status',
      'unavailable'
    );
  }
  const age = now - cache.at;
  // negative age — a clock that moved backwards or a cache stamped in
  // the future — is as unverifiable as a stale one: fail closed
  if (age >= COPILOT_COUNT_TTL_MS || age < 0) {
    throw new SpawnError(
      `cannot verify copilot ${label} count — ${file} is stale ` +
        `(>${Math.round(COPILOT_COUNT_TTL_MS / 1000)}s old); ` +
        'the cache refreshes on copilot spawn/list/status',
      'unavailable'
    );
  }
  return cache.count;
}

/** The builtin plane — registers on import. `detectsCli` never fires:
 *  no local cli command starts a remote copilot task, so the kind is
 *  only reached through the copilot backend's fixed `sessionKind`
 *  default or an explicit `agents.<backend>.sessionKind: "copilot"`. */
export const copilotSessionPlane: SessionPlane = {
  kind: 'copilot',
  detectsCli: () => false,
  countLive(bag) {
    const override = bag['reservationsDir'];
    return cachedCount(
      copilotCountFile(typeof override === 'string' ? override : undefined),
      'session'
    );
  },
  countWorkers(bag) {
    const override = bag['reservationsDir'];
    return cachedCount(
      copilotCountFile(typeof override === 'string' ? override : undefined),
      'worker'
    );
  },
};

registerSessionPlane(copilotSessionPlane);

/** The external-activity probe (spec bro-eqi2d) — a live remote task
 *  is a working runner, never an idle one: `ids` the refresh observed,
 *  minus the taskIds this repo's registry dispatched (a bro-spawned
 *  task is bro's however long it runs). Absent/corrupt/stale cache =
 *  cannot see the remote — the plane reports quiet rather than
 *  inventing remote state (the quota lane's own fail-closed read still
 *  governs armed copilot caps). An incomplete inventory is treated as
 *  active so the guard blocks spawning until a complete listing is
 *  available. */
export function copilotExternalActivity(ctx: ExternalProbeCtx): ExternalActivity {
  const bag = ctx.agents['copilot'] ?? {};
  const override = bag['reservationsDir'];
  const cache = readCopilotCount(
    copilotCountFile(typeof override === 'string' ? override : undefined)
  );
  if (cache === undefined) {
    return { active: false };
  }
  const age = ctx.now - cache.at;
  if (age < 0 || age >= COPILOT_COUNT_TTL_MS) {
    return { active: false };
  }
  if (cache.incomplete === true) {
    return {
      active: true,
      detail: `copilot inventory incomplete — cannot verify foreign tasks`,
      activityAtMs: cache.at,
    };
  }
  const own = new Set<string>();
  for (const e of Object.values(readAgentRegistry(ctx.dir))) {
    if (e.backend === 'copilot' && typeof e.taskId === 'string' && e.taskId !== '') {
      own.add(e.taskId);
    }
  }
  const foreign = cache.ids.filter(id => !own.has(id));
  if (foreign.length === 0) {
    return { active: false, activityAtMs: cache.at };
  }
  return {
    active: true,
    detail: `${foreign.length} copilot task(s) live outside this rig (task ${foreign[0]})`,
    activityAtMs: cache.at,
  };
}

export const copilotExternalPlane: ExternalActivityPlane = {
  kind: 'copilot',
  externalActivity: copilotExternalActivity,
};

registerExternalPlane(copilotExternalPlane);

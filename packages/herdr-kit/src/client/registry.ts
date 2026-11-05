/** The agent-plane probes — liveness checks and the `<git-common>/bro/
 *  agents.json` registry readers every pane-side process shares.
 *  Converged from the plugin's lib.ts and tui/main.ts twins. */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pidAlive as corePidAlive } from '@broject/core';

/** One `bro/agents.json` entry — the registry's per-agent record. */
export interface AgentEntry {
  worktree?: string;
  pid?: number;
  provider?: string;
  /** the agent's native log path — its stem (`native-<hash>`) is
   *  also the events journal's stem and the pane's `--agent` id. */
  log?: string;
  [key: string]: unknown;
}

/** The whole agents registry — `<base>/bro/agents.json`, {} when
 *  absent or unreadable. */
export function agentsJson(base: string): Record<string, AgentEntry> {
  try {
    return JSON.parse(readFileSync(join(base, 'bro', 'agents.json'), 'utf8')) as Record<
      string,
      AgentEntry
    >;
  } catch {
    return {};
  }
}

/** An entry's archive stem — its log's basename minus `.log`, or
 *  undefined when `log` is absent or not a string. The registry is an
 *  unvalidated JSON boundary: `?.` guards null/undefined only, a
 *  `log: 42` entry would throw the `.replace` — and `basename` reads
 *  both separators where a split('/') sees only one. */
export function logStem(entry: AgentEntry | undefined): string | undefined {
  return typeof entry?.log === 'string' ? basename(entry.log).replace(/\.log$/, '') : undefined;
}

/** One registry entry — undefined when the id or the file is absent.
 *  The id matches a registry KEY first, then an entry's archive stem
 *  (its log basename minus `.log`) — pane argv carries the journal
 *  stem `native-<hash>` while the registry keys on the run id. */
export function agentEntry(base: string, id: string | undefined): AgentEntry | undefined {
  if (id === undefined) return undefined;
  const reg = agentsJson(base);
  return reg[id] ?? Object.values(reg).find(e => logStem(e) === id);
}

/** The registry KEY for an id — the readable run id (`bro-2bv6q`)
 *  the pane reports as its agent name instead of the archive stem
 *  (`native-ab656051`, cryptic in the agents view). Same lookup
 *  contract as agentEntry: key first, then the log stem. */
export function agentKey(base: string, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const reg = agentsJson(base);
  if (reg[id] !== undefined) return id;
  return Object.keys(reg).find(k => logStem(reg[k]) === id);
}

/** The pane's display agent — the TRUE agent name, the registry
 *  entry's provider (`opencode-iceman`, `devin`, `omp-minimax`) the
 *  in-render labels already print. The readable run id falls back
 *  when the spawn carried no provider; a registry-known agent's
 *  archive stem (`native-<hash>`) is never the surface — only an id
 *  the registry has never seen returns verbatim. */
export function displayAgentOf(base: string, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  // the registry is an unvalidated JSON boundary — only a non-empty
  // string provider is a display name; anything else falls through
  const provider = agentEntry(base, id)?.provider;
  return (typeof provider === 'string' && provider) || agentKey(base, id) || id;
}

/** Is the pid live? `start` (the recorded /proc start stamp) tightens
 *  the check against pid reuse — a recycled pid with a different start
 *  reads dead. The core probe answers two lies a bare kill(0) tells:
 *  an unreaped zombie still answers, and a foreign-owned pid (EPERM)
 *  is alive, not absent — /proc stat is world-readable, so ownership
 *  never makes identity unverifiable. */
export function pidAlive(pid: number, start?: string): boolean {
  return corePidAlive(pid, start);
}

/** A journal is "actively written" when its mtime is this young —
 *  an agent mid-turn streams updates constantly; longer silence on a
 *  live pid means it is waiting or done, not working. */
export const ACTIVE_MS = 15 * 60_000;

/** mtime tolerance for clock drift and float precision — stat's
 *  mtimeMs is fractional where Date.now() truncates, so a file
 *  written this instant can read a millisecond "in the future".
 *  A stopped clock lies by minutes and hours, not sub-ms. */
const FUTURE_SKEW_MS = 60_000;

/** The registry's git common dir recovered from a journal's own
 *  location — `<git-common>/bro/agents/<id>.events.jsonl` walks up
 *  three. Any other layout yields undefined (the caller's fallback
 *  stands), never a wrong home — the worktree-less direct bind's
 *  scratch cwd must not blind the worker floor. */
export function registryHomeOf(eventsPath: string): string | undefined {
  const agents = dirname(eventsPath);
  const bro = dirname(agents);
  return basename(agents) === 'agents' && basename(bro) === 'bro' ? dirname(bro) : undefined;
}

/** The attempt's `.exit` record — `<agentId>.<runId>.exit` (or the
 *  legacy `<agentId>.exit`) beside the journal. The worker publishes
 *  it before the registry harvest lands, so a clean finish reads
 *  here while `exitStatus` is still unwritten — without it a dead
 *  pid + missing field is indistinguishable from a crash. First
 *  whitespace token is the code; absent/unreadable → undefined. */
function exitCodeOf(entry: AgentEntry, eventsPath: string | undefined): number | undefined {
  if (eventsPath === undefined) return undefined;
  const agentId =
    typeof entry.agentId === 'string' && basename(entry.agentId) === entry.agentId
      ? entry.agentId
      : basename(eventsPath).replace(/\.events\.jsonl$/, '');
  const runId =
    typeof entry.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.runId)
      ? entry.runId
      : undefined;
  const name = runId === undefined ? `${agentId}.exit` : `${agentId}.${runId}.exit`;
  try {
    const v = readFileSync(join(dirname(eventsPath), name), 'utf8')
      .trim()
      .split(/\s+/)[0];
    // an empty file is a truncated record, not exit 0 — `Number('')`
    // is 0, so the empty case must bail before the parse
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The worker LED floor for a direct-bound pane, pid-first: a dead
 *  recorded pid is 'blocked' unless a clean exit is proven —
 *  `stopped`/`exitStatus 0` in the registry, or the attempt's own
 *  `.exit 0` beside the journal (published before the harvest).
 *  `exitStatus`/`stopped` are attempt-scoped and go stale on a
 *  respawn, so they only read when the pid is actually gone. On a
 *  live pid, 'working' still requires a journal being written: loop
 *  records can point at the long-lived supervisor, and a
 *  silent-for-days journal is idle, not working. */
export function workerLedState(
  entry: AgentEntry | undefined,
  eventsPath: string | undefined,
  now = Date.now()
): 'working' | 'idle' | 'blocked' | 'unknown' {
  // no registry record means nothing is provable — 'unknown' lets the
  // archive's own verdict ride (a direct-bound pane on an
  // unregistered agent must not be capped by a blind floor)
  if (entry === undefined) return 'unknown';
  // a pid-less entry carrying spawnError is a FAILED spawn, not a
  // never-attempted one — the pane must show the crash, not idle
  if (entry.pid === undefined) return typeof entry.spawnError === 'string' ? 'blocked' : 'idle';
  const alive = pidAlive(
    entry.pid,
    typeof entry.pidStart === 'string' ? entry.pidStart : undefined
  );
  if (!alive) {
    // a recorded exit beats the stopped flag — a `down` on a crashed
    // worker writes stopped:true while exitStatus keeps the failure
    const code =
      typeof entry.exitStatus === 'number' ? entry.exitStatus : exitCodeOf(entry, eventsPath);
    if (code !== undefined) return code === 0 ? 'idle' : 'blocked';
    return entry.stopped === true ? 'idle' : 'blocked';
  }
  // a live pid alone is a lie — 'working' needs a journal provably
  // being written: no path, an unreadable, empty, or stale one is
  // 'idle' (the loop's long-lived supervisor cannot fake it, and a
  // failed first append leaves an empty file with a fresh mtime)
  if (eventsPath === undefined) return 'idle';
  try {
    const st = statSync(eventsPath);
    // a FUTURE mtime past skew is a stopped clock's lie — it passes
    // the freshness window until wall time catches up
    if (st.size === 0 || st.mtimeMs - now > FUTURE_SKEW_MS || now - st.mtimeMs > ACTIVE_MS)
      return 'idle';
  } catch {
    return 'idle';
  }
  return 'working';
}

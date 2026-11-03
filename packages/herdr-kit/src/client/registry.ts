/** The agent-plane probes — liveness checks and the `<git-common>/bro/
 *  agents.json` registry readers every pane-side process shares.
 *  Converged from the plugin's lib.ts and tui/main.ts twins. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

/** One registry entry — undefined when the id or the file is absent.
 *  The id matches a registry KEY first, then an entry's archive stem
 *  (its log basename minus `.log`) — pane argv carries the journal
 *  stem `native-<hash>` while the registry keys on the run id. */
export function agentEntry(base: string, id: string | undefined): AgentEntry | undefined {
  if (id === undefined) return undefined;
  const reg = agentsJson(base);
  return (
    reg[id] ??
    Object.values(reg).find(
      e =>
        e.log
          ?.replace(/\.log$/, '')
          .split('/')
          .pop() === id
    )
  );
}

/** The registry KEY for an id — the readable run id (`bro-2bv6q`)
 *  the pane reports as its agent name instead of the archive stem
 *  (`native-ab656051`, cryptic in the agents view). Same lookup
 *  contract as agentEntry: key first, then the log stem. */
export function agentKey(base: string, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const reg = agentsJson(base);
  if (reg[id] !== undefined) return id;
  return Object.keys(reg).find(
    k =>
      reg[k]?.log
        ?.replace(/\.log$/, '')
        .split('/')
        .pop() === id
  );
}

/** The pid's /proc start stamp — `comm` may carry spaces and parens,
 *  so the fields read from the LAST `)`. null when unreadable (no
 *  /proc, or the process just exited). */
function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return stat.slice(close + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** Is the pid live? `start` (the recorded /proc start stamp) tightens
 *  the check against pid reuse — a recycled pid with a different start
 *  reads dead; an unreadable /proc falls back to the kill() verdict. */
export function pidAlive(pid: number, start?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (start === undefined || start === '') return true;
  const st = procStart(pid);
  return st === null || st === start;
}

/** A journal is "actively written" when its mtime is this young —
 *  an agent mid-turn streams updates constantly; longer silence on a
 *  live pid means it is waiting or done, not working. */
export const ACTIVE_MS = 15 * 60_000;

/** The worker LED floor for a direct-bound pane, pid-first: a dead
 *  recorded pid is 'blocked' unless the record carries a clean exit
 *  (`stopped`/`exitStatus 0`) — a crash mid-turn must not pass for
 *  either working or idle. `exitStatus`/`stopped` are attempt-scoped
 *  and go stale on a respawn, so they only read when the pid is
 *  actually gone. On a live pid, 'working' still requires a journal
 *  being written: loop records can point at the long-lived
 *  supervisor, and a silent-for-days journal is idle, not working. */
export function workerLedState(
  entry: AgentEntry | undefined,
  eventsPath: string | undefined,
  now = Date.now()
): 'working' | 'idle' | 'blocked' | 'unknown' {
  // no registry record means nothing is provable — 'unknown' lets the
  // archive's own verdict ride (a direct-bound pane on an
  // unregistered agent must not be capped by a blind floor)
  if (entry === undefined) return 'unknown';
  if (entry.pid === undefined) return 'idle'; // never started — no crash to report
  const alive = pidAlive(entry.pid, entry.pidStart as string | undefined);
  if (!alive) {
    if (entry.stopped === true || entry.exitStatus === 0) return 'idle';
    return 'blocked';
  }
  // a live pid alone is a lie — 'working' needs a journal provably
  // being written: no path, an unreadable one, or a stale one is
  // 'idle' (the loop's long-lived supervisor cannot fake it)
  if (eventsPath === undefined) return 'idle';
  try {
    if (now - statSync(eventsPath).mtimeMs > ACTIVE_MS) return 'idle';
  } catch {
    return 'idle';
  }
  return 'working';
}

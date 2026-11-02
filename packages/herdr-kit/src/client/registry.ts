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

/** The worker LED floor for a direct-bound pane — 'working' requires
 *  BOTH an unfinished run (no exitStatus/stopped flag, live pid) AND a
 *  journal still being written. A live pid alone lies: loop records
 *  can point at the long-lived supervisor, and a silent-for-days
 *  journal on a live pid is idle, not working. */
export function workerLedState(
  entry: AgentEntry | undefined,
  eventsPath: string | undefined,
  now = Date.now()
): 'working' | 'idle' {
  if (entry === undefined) return 'idle';
  if (entry.stopped === true) return 'idle';
  if (typeof entry.exitStatus === 'number') return 'idle';
  if (entry.pid === undefined || !pidAlive(entry.pid, entry.pidStart as string | undefined)) {
    return 'idle';
  }
  if (eventsPath !== undefined) {
    try {
      if (now - statSync(eventsPath).mtimeMs > ACTIVE_MS) return 'idle';
    } catch {
      return 'idle';
    }
  }
  return 'working';
}

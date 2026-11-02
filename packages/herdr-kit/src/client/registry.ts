/** The agent-plane probes — liveness checks and the `<git-common>/bro/
 *  agents.json` registry readers every pane-side process shares.
 *  Converged from the plugin's lib.ts and tui/main.ts twins. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One `bro/agents.json` entry — the registry's per-agent record. */
export interface AgentEntry {
  worktree?: string;
  pid?: number;
  provider?: string;
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

/** One registry entry — undefined when the id or the file is absent. */
export function agentEntry(base: string, id: string | undefined): AgentEntry | undefined {
  if (id === undefined) return undefined;
  return agentsJson(base)[id];
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

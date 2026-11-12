import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Hook spool — the Tier-0 wire format `hooks/run.sh` appends to
 * `$XDG_STATE_HOME/bro/hooks.spool` (specs/bro-izpyk.1.1.md; epic contract
 * specs/sessions/bro-izpyk.md). Versioned TSV, `O_APPEND`, no lock:
 *
 *   v1 start: v1 <ts> start <id> <host> <event> <cwd>
 *   v1 end:   v1 <ts> end   <id> <host> <event> <rc> <outcome> <cwd>
 *   v2 start: v2 <ts> start <id> <host> <sid> <event> <pid> <ppid> <agent>
 *             <adapter> <proot> <launcher> <cwd>
 *   v2 end:   v2 <ts> end   <id> <host> <sid> <event> <pid> <ppid> <agent>
 *             <adapter> <proot> <launcher> <rc> <outcome> <cwd>
 *
 * `cwd` is always the last field and readers re-join the tail, so a path
 * containing a tab survives the round trip. `ts` is epoch SECONDS — the
 * ledger converts to ms at ingest. One parser serves the aggregate reader
 * (`bro hooks status`) and the ledger worker so the two never drift;
 * unknown versions/phases return undefined and are skipped, never fatal.
 */

/** Outcome tokens the spool may carry. The writer emits the v1 set plus
 *  `fastpath`; the canonical ledger outcomes (`timeout`, `killed`,
 *  `error`) are tolerated here so a future or foreign writer's rows still
 *  parse — aggregation buckets them onto the legacy columns. */
export const SPOOL_OUTCOMES = [
  'ok',
  'nonzero',
  'watchdog',
  'no-cli',
  'fastpath',
  'timeout',
  'killed',
  'error',
] as const;

export type SpoolOutcome = (typeof SPOOL_OUTCOMES)[number];

export function isSpoolOutcome(value: string | undefined): value is SpoolOutcome {
  return value !== undefined && (SPOOL_OUTCOMES as readonly string[]).includes(value);
}

/** One parsed spool line, normalized across versions. Enriched v2 fields
 *  stay undefined on v1 rows. */
export interface SpoolRow {
  version: 1 | 2;
  /** Epoch seconds. */
  ts: number;
  phase: 'start' | 'end';
  /** Launch-pair id — start and end rows of one run.sh invocation share
   *  it; also the ledger's `events.pair` and killed-synthesis dedup key. */
  id: string;
  host: string;
  sid?: string;
  event: string;
  pid?: number;
  ppid?: number;
  /** BRO_AGENT_ID — the bro-spawned agent badge (sessions.spawned_by). */
  agent?: string;
  /** Plugin manifest version (installs.adapter_version). */
  adapter?: string;
  /** Plugin root the launcher ran from (installs.plugin_root). */
  pluginRoot?: string;
  /** Session launcher kind: agent|herdr|tmux|zellij|screen|ssh|interactive. */
  launcher?: string;
  /** End rows only. */
  rc?: number;
  outcome?: SpoolOutcome;
  cwd?: string;
}

function digits(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Re-join the free-text tail — `cwd` is last, so any embedded tabs come
 *  back verbatim instead of corrupting the row. */
function tail(fields: string[], index: number): string | undefined {
  if (index >= fields.length) {
    return undefined;
  }
  return fields.slice(index).join('\t');
}

/** Wire version token → 1|2; anything else is not a spool row. */
function spoolVersion(value: string | undefined): 1 | 2 | undefined {
  if (value === 'v1') {
    return 1;
  }
  if (value === 'v2') {
    return 2;
  }
  return undefined;
}

/** Shared head fields — ts/phase plus the id/host slots both versions
 *  share, and the version-shifted event slot (v1 event@5, v2 event@6
 *  after sid@5). undefined = malformed row. */
function parseSpoolHead(
  f: string[],
  v2: boolean
): { ts: number; phase: 'start' | 'end'; id: string; host: string; event: string } | undefined {
  const ts = digits(f.at(1));
  if (ts === undefined) {
    return undefined;
  }
  const phase = f.at(2);
  if (phase !== 'start' && phase !== 'end') {
    return undefined;
  }
  const id = emptyUndef(f.at(3));
  if (id === undefined) {
    return undefined;
  }
  const host = emptyUndef(f.at(4));
  if (host === undefined) {
    return undefined;
  }
  const event = emptyUndef(f.at(v2 ? 6 : 5));
  if (event === undefined) {
    return undefined;
  }
  return { ts, phase, id, host, event };
}

/** v2-only enrichment fields (sid through launcher). */
function parseV2Fields(f: string[], out: SpoolRow): void {
  out.sid = emptyUndef(f.at(5));
  out.pid = digits(f.at(7));
  out.ppid = digits(f.at(8));
  out.agent = emptyUndef(f.at(9));
  out.adapter = emptyUndef(f.at(10));
  out.pluginRoot = emptyUndef(f.at(11));
  out.launcher = emptyUndef(f.at(12));
}

/** End rows carry rc+outcome before the cwd tail — a malformed end is
 *  dropped whole (it can't pair a duration). Mutates `out` only on a
 *  fully valid end. */
function parseSpoolEnd(f: string[], v2: boolean, out: SpoolRow): boolean {
  const rc = digits(f.at(v2 ? 13 : 6));
  if (rc === undefined) {
    return false;
  }
  const outcome = f.at(v2 ? 14 : 7);
  if (!isSpoolOutcome(outcome)) {
    return false;
  }
  out.rc = rc;
  out.outcome = outcome;
  return true;
}

/** Field index where the cwd tail begins — version- and phase-shifted
 *  (v1 start cwd@6 / end cwd@8; v2 start cwd@13 / end cwd@15). */
function spoolCwdIndex(v2: boolean, phase: 'start' | 'end'): number {
  if (v2) {
    return phase === 'end' ? 15 : 13;
  }
  return phase === 'end' ? 8 : 6;
}

/** Parse one spool line. undefined = not a usable row (wrong version,
 *  bad ts, missing identity, unknown phase, malformed end) — skipped by
 *  every consumer. */
export function parseSpoolLine(line: string): SpoolRow | undefined {
  const row = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (row === '') {
    return undefined;
  }
  const f = row.split('\t');
  // v1: id@3 host@4 event@5 — end adds rc@6 outcome@7, cwd@8; start cwd@6
  // v2: id@3 host@4 sid@5 event@6 pid@7 ppid@8 agent@9 adapter@10
  //     proot@11 launcher@12 — end adds rc@13 outcome@14, cwd@15;
  //     start cwd@13
  const version = spoolVersion(f.at(0));
  if (version === undefined) {
    return undefined;
  }
  const v2 = version === 2;
  const head = parseSpoolHead(f, v2);
  if (head === undefined) {
    return undefined;
  }
  const out: SpoolRow = {
    version,
    ts: head.ts,
    phase: head.phase,
    id: head.id,
    host: head.host,
    event: head.event,
    cwd: tail(f, spoolCwdIndex(v2, head.phase)),
  };
  if (v2) {
    parseV2Fields(f, out);
  }
  if (head.phase === 'end' && !parseSpoolEnd(f, v2, out)) {
    return undefined;
  }
  return out;
}

function emptyUndef(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** The spool's home — `$BRO_HOOK_SPOOL` pins it (literal `0` disables),
 *  else `$XDG_STATE_HOME/bro/hooks.spool` with the `~/.local/state`
 *  fallback. null = spooling off or no resolvable home. */
export function resolveHookSpoolPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BRO_HOOK_SPOOL === '0') {
    return null;
  }
  const home = env.HOME || homedir();
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return resolve(env.BRO_HOOK_SPOOL || join(stateHome, 'bro', 'hooks.spool'));
}

/** Drain order — the rotated `.1` holds older rows than the live file. */
export function hookSpoolFiles(spoolPath: string): string[] {
  return [`${spoolPath}.1`, spoolPath];
}

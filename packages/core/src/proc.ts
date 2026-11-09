/**
 * Process liveness over /proc — the shared probe behind pending-watch
 * markers, the agents registry lock, and session work markers. Kill(0)
 * alone lies twice: it answers for zombies (nobody polling) and can't
 * tell a reused pid from the process that recorded it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The process's /proc identity — state byte (field 3: 'Z' marks an
 *  unreaped zombie) and starttime (field 22). Post-comm fields split
 *  from index 0 = field 3. Null where /proc is absent or unreadable. */
export function procStat(pid: number): { state: string; start: string } | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { state: rest[0] ?? '', start: rest[19] ?? '' };
    } catch {
      return null;
    }
  }
  if (
    process.platform === 'darwin' ||
    process.platform === 'freebsd' ||
    process.platform === 'openbsd'
  ) {
    // lstart is formatted in the process's timezone+locale — a marker
    // written and re-checked under different environments would print a
    // different start string for the same live owner and read as dead.
    // Pinning TZ/LC makes the identity environment-independent while
    // staying a lstart Date.parse can still epoch-convert for doctor.
    const env = { ...process.env, TZ: 'UTC', LC_ALL: 'C', LC_TIME: 'C' };
    try {
      // Get state and start time on BSD/macOS; include pid to disambiguate on reuse
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'state=,lstart='], {
        encoding: 'utf8',
        timeout: 1000,
        env,
      });
      const lines = out.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      const line = lines[0];
      const trimmed = line.trim();
      // Strip the whole state token (may include modifiers like +, L, s) before parsing lstart
      const startMatch = trimmed.match(/^\S+\s+(.+)$/s);
      const start = startMatch ? startMatch[1].trim() : '';
      if (start !== '') {
        const st = trimmed.match(/^(\S+)/)?.[1] ?? '';
        // Return just lstart as start; pid is already tracked separately by the caller
        return { state: st[0] ?? st ?? '', start };
      }
      // Try with pid in output format
      try {
        const out2 = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,state=,lstart='], {
          encoding: 'utf8',
          timeout: 1000,
          env,
        });
        const lines2 = out2.trim().split('\n').filter(Boolean);
        if (lines2.length === 0) return null;
        const line2 = lines2[0];
        const trimmed2 = line2.trim();
        const m = trimmed2.match(/^(\d+)\s+(\S+)\s+(.+)$/s);
        if (m) {
          const st = m[2];
          const sstart = trimmed2.replace(/^\d+\s+\S+\s+/, '').trim();
          return { state: st[0] ?? st ?? '', start: sstart };
        }
        const m2 = trimmed2.match(/^(\S+)\s+(.+)$/s);
        if (m2) {
          const st = m2[1];
          const sstart = trimmed2.replace(/^\S+\s+/, '').trim();
          return { state: st[0] ?? st ?? '', start: sstart };
        }
      } catch {
        // fall through
      }
      // Fallback to just state
      try {
        const out2 = execFileSync('ps', ['-p', String(pid), '-o', 'state='], {
          encoding: 'utf8',
          timeout: 1000,
        });
        const st = out2.trim()[0] ?? '';
        return { state: st, start: '' };
      } catch {
        const st = trimmed.match(/^(\S)/)?.[1] ?? trimmed[0] ?? '';
        return { state: st, start: '' };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** pid alive = kill(pid, 0) doesn't throw, or throws EPERM (a live
 *  process owned by another uid — not ours to verify, still alive).
 *  Two exceptions where a surviving answer still means dead:
 *
 *  - an unreaped zombie ('Z' state) — kill succeeds, nobody is there;
 *  - pid reuse — when the caller recorded pidStart, a live pid with a
 *    different starttime is a different process.
 *
 *  Unverifiable identity (no /proc, unreadable stat) stays fail-open:
 *  alive, never a false stale report. A non-positive or non-integer
 *  pid is dead input, not unverifiable: kill(0) and kill(-pid) answer
 *  for process groups, so the signal cannot attest that pid. */
export function pidAlive(pid: number, pidStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM = exists but owned by another uid — still subject to the
    // zombie and reuse checks below; /proc stat is world-readable, so
    // foreign ownership doesn't make identity unverifiable
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
      return false;
    }
  }
  const st = procStat(pid);
  if (st?.state === 'Z') {
    return false;
  }
  if (pidStart === undefined) {
    return true;
  }
  if (st === null || st.start === '') {
    return true;
  }
  // pidStart may be stored as "pid start" or just "start" for compatibility
  if (st.start === pidStart) {
    return true;
  }
  // If stored as "<pid> <start>" match suffix
  const parts = pidStart.trim().split(/\s+/);
  if (parts.length >= 2) {
    const startOnly = pidStart.trim().replace(/^\S+\s+/, '');
    if (startOnly === st.start || st.start === startOnly) {
      return true;
    }
  }
  return false;
}

/** Whitespace/quote tokenization of a `ps` args line — the vector
 *  arrives space-joined on platforms without /proc, so quote runs are
 *  honored to keep quoted fragments glued where ps does emit them. */
export function psTokenize(s: string): string[] {
  const trimmed = s.replace(/\r?\n$/, '');
  if (trimmed === '') return [];
  const m = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (m && m.length > 0) {
    return m.map(t => t.replace(/^["']|["']$/g, ''));
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/** Tokens that only resolve joined — `ps` space-joins the arg vector,
 *  so a path argument containing spaces (`/Users/x/My Tools/app.js`)
 *  arrives pre-split and no fragment ever resolves on disk. Re-glue
 *  consecutive absolute-path fragments until the join exists: an
 *  executable or script arg must be on disk to run, so resolution is
 *  the boundary oracle. A fragment that never resolves (raced delete,
 *  a relative spelling) keeps its original split — never worse than
 *  the raw tokenize. Bounded so a bad guess can't swallow the line. */
export function psRegroupPaths(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const merged = t.startsWith('/') && !existsSync(t) ? mergePathFragment(tokens, i) : null;
    i += merged?.count ?? 0;
    out.push(merged?.text ?? t);
  }
  return out;
}

/** tokens[i..j] rejoined until the join exists on disk — the boundary
 *  oracle for a `ps`-split path. null when no rejoin resolves (raced
 *  delete, relative spelling) — the caller keeps the original token. */
function mergePathFragment(tokens: string[], i: number): { text: string; count: number } | null {
  const bound = Math.min(tokens.length - 1, i + 8);
  for (let j = i + 1; j <= bound; j++) {
    if (tokens[j]!.startsWith('-')) break;
    const acc = tokens.slice(i, j + 1).join(' ');
    if (existsSync(acc)) return { text: acc, count: j - i };
  }
  return null;
}

/** `ps <args> -p <pid>` — the darwin/BSD stand-in for /proc reads.
 *  Throws like execFileSync does; callers own the fallback chain. */
function psOut(pid: number, args: string[]): string {
  return execFileSync('ps', [...args, '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1000,
  });
}

/** Environment entries out of `ps eww` on darwin/BSD — the eww row is
 *  `PID TT STAT TIME <args> <env>`: args and env ride one space-joined
 *  column with no marker between them, so any `KEY=VAL` shape filter
 *  alone lets an ARGUMENT like `AI_AGENT=1` impersonate an env badge.
 *  Both halves come from the same kernel buffer under the same join
 *  rule: tokenize `ps -o args=` identically, consume that exact token
 *  run off the row's head, and everything past it is genuinely the
 *  environment. When the prefix can't be proven — a raced exit, a
 *  truncated row — nothing is env; an argument can never masquerade
 *  upward (a truncated env only under-reports, which fails closed for
 *  badge detection). */
export function psEwwEnvTokens(pid: number): string[] {
  for (const ewwArgs of [['eww'], ['e']]) {
    const tokens = psEwwEnvTry(pid, ewwArgs);
    if (tokens !== null) return tokens;
  }
  return [];
}

/** One `ps e` spelling of the env read — null on any failure so the
 *  caller walks the spelling chain; [] when the env boundary can't be
 *  proven (an argument must never masquerade upward). */
function psEwwEnvTry(pid: number, ewwArgs: string[]): string[] | null {
  let argTokens: string[];
  let row: string;
  try {
    argTokens = psTokenize(psOut(pid, ['-ww', '-o', 'args=']));
    row =
      psOut(pid, ewwArgs)
        .split('\n')
        .find(l => l.trim().split(/\s+/)[0] === String(pid)) ?? '';
  } catch {
    return null;
  }
  const rowTokens = psTokenize(row);
  // row = PID TT STAT TIME <argTokens> <envTokens>
  const head = 4 + argTokens.length;
  if (rowTokens.length < head) return null;
  if (!argTokens.every((t, i) => rowTokens[4 + i] === t)) return null;
  return rowTokens.slice(head).filter(t => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
}

export interface ProcEntry {
  pid: number;
  state: string;
  ppid: number;
  pgrp: number;
  start: string;
}

/** One shared scan of /proc for the group and tree probes — `null`
 *  when /proc itself is unreadable; `unverified` marks at least one
 *  non-ENOENT stat failure (a process we could not inspect). */
export function scanProc(): { entries: ProcEntry[]; unverified: boolean } | null {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const entries: ProcEntry[] = [];
  let unverified = false;
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (e) {
      // ENOENT/ENOTDIR is the process vanishing mid-scan — anything
      // else (EACCES under hidepid, …) is a process we could not inspect
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unverified = true;
      }
      continue;
    }
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // rest: state, ppid, pgrp, … — the same split procStat uses
    entries.push({
      pid,
      state: rest[0] ?? '',
      ppid: Number(rest[1]),
      pgrp: Number(rest[2]),
      start: rest[19] ?? '',
    });
  }
  return { entries, unverified };
}

/** A live member of process group `pgid`. kill(-pgid, 0) gates first —
 *  ESRCH is a group that no longer exists (pidAlive's ESRCH-or-hard-
 *  failure rule; EPERM is a live group we cannot signal) — but it also
 *  counts an unreaped zombie member, so live members are read from
 *  /proc the way procStat reads one process: state 'Z' is nobody.
 *  `minStart` bounds a member's starttime from below — our members
 *  forked after the group leader, so a member older than it belongs to
 *  a pgid the kernel recycled after the group died, not to this group.
 *
 *  Two edges where the probe cannot answer, and the answer differs by
 *  platform: on Linux a vanished /proc, or a member stat that fails
 *  for any reason but ENOENT, stays fail-open (pidAlive's rule: never
 *  a false "the group is dead"); off Linux /proc never exists at all,
 *  so the probe cannot tell a zombie member from a live one — false. */
export function groupMemberAlive(pgid: number, minStart?: string): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
      return false;
    }
  }
  const scan = scanProc();
  if (scan === null) {
    return process.platform === 'linux';
  }
  const min = minStart === undefined ? Number.NaN : Number(minStart);
  for (const e of scan.entries) {
    if (e.state === 'Z' || e.pgrp !== pgid) {
      continue;
    }
    const start = Number(e.start);
    if (!Number.isFinite(min) || !(start > 0) || start >= min) {
      return true;
    }
  }
  // no confirmed member — but a process we could not inspect might be
  // one: fail open, never a false "the group is dead"
  return scan.unverified;
}

/** An attempt handle's identity — `<pid> [starttime]`: the worker
 *  publishes its /proc starttime beside the pid so a reader can pin
 *  identity against pid reuse (the same pair markerOwner carries). A
 *  bare pid — a pre-identity handle, or a platform with no /proc for
 *  the worker to read — parses with `start` undefined: unverifiable,
 *  so callers stay fail-open the way pidAlive documents. Null when no
 *  positive integer pid is there at all. */
export function handleOwner(text: string): { pid: number; start?: string } | null {
  const s = text.trim();
  const parts = s.split(/\s+/);
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (parts.length < 2) {
    return { pid };
  }
  // start may contain spaces (e.g. BSD/macOS lstart); slice after the pid token
  const start = s.slice(parts[0].length).trim();
  return start === '' ? { pid } : { pid, start };
}

/** Line 1 of a session/work marker: `<millis> [pid start]` — the pid
 *  pair is the owning process's identity (start disambiguates reuse).
 *  A pid without a start can't disambiguate, so it reads as ownerless:
 *  a reuse-blind owner would suppress the mtime fallback while still
 *  trusting a recycled pid — the worst of both planes. */
export function markerOwner(firstLine: string | undefined): { pid: number; start: string } | null {
  const s = (firstLine ?? '').trim();
  // Parse positionally to avoid regex backtracking (CodeQL polynomial regex).
  // Separators are any whitespace — a tab-spaced marker is still owned.
  const firstSpace = s.search(/\s/);
  if (firstSpace === -1) return null;
  const rest = s.slice(firstSpace + 1).trimStart();
  const secondSpace = rest.search(/\s/);
  if (secondSpace === -1) return null;
  const pidStr = rest.slice(0, secondSpace).trim();
  const start = rest.slice(secondSpace + 1).trim();
  const pid = Number(pidStr);
  return Number.isInteger(pid) && pid > 0 && start !== '' ? { pid, start } : null;
}

/** Is this marker's owning session alive? A recorded owner decides by
 *  pid liveness alone — a dead session's marker is residue even when
 *  its mtime is fresh, and a live session's marker stays live past the
 *  freshness window. Ownerless markers fall back to the window. */
export function markerLive(
  firstLine: string | undefined,
  mtimeMs: number,
  liveMs: number,
  now: number = Date.now()
): boolean {
  const owner = markerOwner(firstLine);
  return owner === null ? mtimeMs >= now - liveMs : pidAlive(owner.pid, owner.start || undefined);
}

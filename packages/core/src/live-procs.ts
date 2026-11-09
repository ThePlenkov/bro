/**
 * Live child-process registry — the hook's exit hygiene. Async spawns
 * (bdAsync/ghAsync and friends) keep node's event loop alive until they
 * close: a probe that raced past its timeout leaves its child running,
 * so the hook process outlives the answer it already sent. Tracking
 * every spawn lets the hooks entrypoint unref the stragglers — command
 * paths never call this, so ordinary `await`ed spawns still pin the
 * process exactly like before.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Socket } from 'node:net';

const live = new Set<ChildProcess>();

/** Register a spawned child for later unref — deregisters itself on
 *  close, so settled spawns cost nothing. */
export function trackChild(proc: ChildProcess): void {
  live.add(proc);
  proc.on('close', () => {
    live.delete(proc);
  });
}

export interface SpawnResult {
  code: number | null;
  out: string;
  err: string;
  /** Set when 'error' (spawn failure) beat 'close' — the raw Error. */
  error?: Error;
}

function spawnEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  mode: 'replace' | undefined
): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  if (mode === 'replace') return env;
  return { ...process.env, ...env };
}

/** Spawn `cmd` with piped stdout/stderr collected — the shared skeleton
 *  behind the async CLI twins (bdAsync, ghTryAsync, …). Timeouts and
 *  exit-code policy stay with the caller; `done` resolves exactly once,
 *  on 'close' or 'error' (a spawn failure still surfaces via `error`
 *  with its message merged into `err`). */
export function spawnCollect(
  cmd: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  /** `detached` puts the child at the head of its own process group so a
   *  caller can `process.kill(-proc.pid)` the whole supervised tree
   *  (bd's `timeout` supervisor + bd) instead of just the direct child. */
  opts?: { detached?: boolean; envMode?: 'replace' }
): { proc: ChildProcess; done: Promise<SpawnResult> } {
  const proc = spawn(cmd, args, {
    // NOSONAR — PATH lookup is the contract (same as gh/git)
    cwd,
    detached: opts?.detached,
    env: spawnEnvironment(env, opts?.envMode),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
  const done = new Promise<SpawnResult>(resolve => {
    proc.on('error', error =>
      resolve({ code: null, out, err: (err + '\n' + error.message).trim(), error })
    );
    proc.on('close', code => resolve({ code, out, err: err.trim() }));
  });
  return { proc, done };
}

/** Kill the whole supervised process group — async spawns run detached
 *  so -pid reaches the complete tree. Direct-child kill is the fallback. */
export function killGroup(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* group already gone */
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already dead */
  }
}

/** Unref every still-running child and its stdio pipes — the pipes are
 *  handles too and would keep the loop alive on their own. Called by the
 *  hooks entrypoint after dispatch: any child still open belongs to a
 *  probe that already timed out, and its late output is discarded. */
export function unrefPendingChildren(): void {
  for (const proc of live) {
    proc.unref();
    // piped stdio are Sockets under the Readable type — handles that
    // keep the loop alive on their own
    (proc.stdout as Socket | null)?.unref();
    (proc.stderr as Socket | null)?.unref();
  }
}

// --- orphan `bd` sweep ---------------------------------------------------------

/** One /proc row as the classifier needs it — the reader fills this,
 *  the classifier never touches the filesystem (unit-testable). */
export interface ProcRow {
  pid: number;
  comm: string;
  ppid: number;
  /** Parent's comm — init/systemd means reparented = orphaned. */
  parentComm: string | null;
  /** readlink(/proc/pid/cwd) — null when unreadable (raced exit). */
  cwd: string | null;
  /** Process start, ms epoch — parsed from stat starttime jiffies. */
  startMs: number;
}

/** Parents an orphaned process lands on: pid 1, the WSL /init
 *  subreaper, or a systemd instance — never a live supervisor. */
const ORPHAN_PARENT_COMMS = new Set(['init', 'systemd']);

/** A legit bd call lasts seconds; a minute-old orphan holds the
 *  embedded noms LOCK past every caller's timeout — debris. */
const ORPHAN_BD_MIN_AGE_MS = 60_000;

/** Decide which rows are wedging candidates: `comm`, reparented onto an
 *  init/systemd parent, cwd inside `repoRoot`, older than the age
 *  floor. Pure — the /proc reader feeds it. */
export function pickOrphanProcs(
  rows: ProcRow[],
  comm: string,
  repoRoot: string,
  now = Date.now()
): number[] {
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  return rows
    .filter(
      r =>
        r.comm === comm &&
        r.cwd !== null &&
        (r.cwd === repoRoot || r.cwd.startsWith(root)) &&
        (r.ppid === 1 || (r.parentComm !== null && ORPHAN_PARENT_COMMS.has(r.parentComm))) &&
        now - r.startMs >= ORPHAN_BD_MIN_AGE_MS
    )
    .map(r => r.pid);
}

/** Read the rows pickOrphanProcs needs out of /proc — linux reads the
 *  fs, darwin shells out to ps/lsof; anything else returns []. Races
 *  are the norm: a pid vanishing mid-scan just drops out. */
export function readProcRows(procDir = '/proc'): ProcRow[] {
  if (process.platform === 'linux') {
    return readProcRowsLinux(procDir);
  }
  if (process.platform === 'darwin') {
    return readProcRowsDarwin();
  }
  return [];
}

function readProcRowsLinux(procDir: string): ProcRow[] {
  let uptimeSec = 0;
  try {
    uptimeSec = Number(readFileSync(`${procDir}/uptime`, 'utf8').split(' ')[0]);
  } catch {
    return [];
  }
  const bootMs = Date.now() - uptimeSec * 1000;
  const rows: ProcRow[] = [];
  for (const ent of readdirSync(procDir)) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const stat = readFileSync(`${procDir}/${ent}/stat`, 'utf8');
      // comm sits in parens and may itself hold parens — parse after ')'
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).split(' ');
      const ppid = Number(f[1]);
      // fields after comm are 1-indexed from state: starttime is
      // field 22 → index 19; jiffies run at 100 ticks/s on linux
      const startMs = bootMs + (Number(f[19]) / 100) * 1000;
      let parentComm: string | null = null;
      if (ppid > 0) {
        try {
          parentComm = readFileSync(`${procDir}/${ppid}/comm`, 'utf8').trim();
        } catch {
          /* parent exited mid-scan — orphan race, next tick decides */
        }
      }
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`${procDir}/${ent}/cwd`);
      } catch {
        /* kernel threads and raced exits have no cwd */
      }
      rows.push({ pid: Number(ent), comm, ppid, parentComm, cwd, startMs });
    } catch {
      continue;
    }
  }
  return rows;
}

/** One valid `pid=,ppid=,lstart=,comm=` line as its leading pair —
 *  null for header/short/garbage rows. */
function psPidPpid(line: string): { pid: number; ppid: number; parts: string[] } | null {
  const parts = line.replace(/^\s+/, '').split(/\s+/);
  if (parts.length < 3) return null;
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, ppid, parts };
}

/** The lstart/comm split of a ps row — lstart is 4 tokens (no year)
 *  or 5 (with year), so scan for the first 5-or-4-token run that
 *  Date.parse accepts; comm is whatever tokens remain. The token-join
 *  (not a regex on the raw line) keeps comm free of pattern escapes. */
function lstartComm(parts: string[]): { lstart: string; comm: string } | null {
  for (let start = 2; start <= parts.length - 1; start++) {
    for (let len = 5; len >= 4 && start + len <= parts.length; len--) {
      const candidate = parts.slice(start, start + len).join(' ');
      if (!isNaN(Date.parse(candidate))) {
        return {
          lstart: candidate,
          comm: parts
            .slice(start + len)
            .join(' ')
            .trim(),
        };
      }
    }
  }
  return null;
}

/** basename of a comm spelling — `ps` may print the full path. */
function commBase(comm: string): string {
  return (comm.includes('/') ? (comm.split('/').pop() ?? comm) : comm) || '';
}

/** pid → cwd for every live pid, batched through chunked
 *  `lsof -d cwd` runs (a single -p list would blow argv on a busy
 *  box). A failed chunk just leaves its pids to the per-pid fallback. */
function lsofCwdMap(pids: number[]): Map<number, string> {
  const cwdMap = new Map<number, string>();
  const chunkSize = 200;
  for (let i = 0; i < pids.length; i += chunkSize) {
    const chunk = pids.slice(i, i + chunkSize);
    try {
      const lout = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', chunk.join(',')], {
        encoding: 'utf8',
        timeout: 2000,
      });
      let currentPid: number | null = null;
      for (const l of lout.split('\n')) {
        if (l.startsWith('p')) {
          const v = Number(l.slice(1));
          currentPid = Number.isInteger(v) ? v : null;
          continue;
        }
        if (l.startsWith('n') && currentPid !== null) {
          cwdMap.set(currentPid, l.slice(1));
        }
      }
    } catch {
      // continue to next chunk — per-pid fallback covers the gap
    }
  }
  return cwdMap;
}

/** Whole-scan budget for the darwin readers — each pid missing from
 *  the batched lsof answer otherwise gets its own timeout, so a slow
 *  batch can stack hundreds of 500ms fallbacks into a ~100s stall that
 *  delays watch heartbeats or holds an occupancy lock. Past the
 *  deadline a pid keeps its batched answer (or none — a null cwd reads
 *  as a raced pid, the same contract the sweep already handles). */
export const DARWIN_SCAN_BUDGET_MS = 4000;

/** One pid's cwd — batched answer first, then a per-pid lsof bounded
 *  by the scan deadline; null when neither names a directory. */
function darwinCwd(pid: number, cwdMap: Map<number, string>, deadline: number): string | null {
  const batched = cwdMap.get(pid);
  if (batched !== undefined && batched !== '') return batched;
  const left = deadline - Date.now();
  if (left <= 0) return null;
  try {
    const lout = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: Math.min(500, left),
    });
    const cline = lout.split('\n').find(l => l.startsWith('n'));
    return cline === undefined ? null : cline.slice(1);
  } catch {
    return null;
  }
}

/** ppid → parent comm for every unique non-init parent, in one ps. */
function batchParentComms(ppids: number[]): Map<number, string | null> {
  const parentComms = new Map<number, string | null>();
  if (ppids.length === 0) return parentComms;
  try {
    const pout = execFileSync('ps', ['-p', ppids.join(','), '-o', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    for (const l of pout.split('\n').filter(Boolean)) {
      const t = l.trim().split(/\s+/);
      if (t.length >= 2) {
        parentComms.set(Number(t[0]), commBase(t.slice(1).join(' ')) || null);
      }
    }
  } catch {
    // per-pid fallback covers the gap
  }
  return parentComms;
}

/** A row's parent comm — 'launchd' for pid-1 children, the batched
 *  answer when ps had it, else a per-pid ps bounded by the scan
 *  deadline (same stall class as the lsof fallback). */
function darwinParentComm(
  ppid: number,
  parentComms: Map<number, string | null>,
  deadline: number
): string | null {
  if (ppid === 1) return 'launchd';
  if (ppid <= 0) return null;
  const batched = parentComms.get(ppid);
  if (batched !== undefined && batched !== null) return batched;
  const left = deadline - Date.now();
  if (left <= 0) return null;
  try {
    const pout = execFileSync('ps', ['-p', String(ppid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: Math.min(500, left),
    });
    return commBase(pout.trim()) || null;
  } catch {
    return null;
  }
}

/** One ps line → a ProcRow, or null when the line has no parseable
 *  lstart (weird rows drop out like a raced pid does on linux). */
function darwinRow(
  line: string,
  cwdMap: Map<number, string>,
  parentComms: Map<number, string | null>,
  deadline: number
): ProcRow | null {
  const lead = psPidPpid(line);
  if (lead === null) return null;
  const parsed = lstartComm(lead.parts);
  if (parsed === null) return null;
  return {
    pid: lead.pid,
    comm: commBase(parsed.comm),
    ppid: lead.ppid,
    parentComm: darwinParentComm(lead.ppid, parentComms, deadline),
    cwd: darwinCwd(lead.pid, cwdMap, deadline),
    startMs: Date.parse(parsed.lstart),
  };
}

function readProcRowsDarwin(): ProcRow[] {
  let lines: string[];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C', LC_TIME: 'C' },
    });
    lines = out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const deadline = Date.now() + DARWIN_SCAN_BUDGET_MS;
  const leads = lines.map(psPidPpid).filter((l): l is NonNullable<typeof l> => l !== null);
  const cwdMap = lsofCwdMap(leads.map(l => l.pid));
  const uniquePpids = new Set(leads.filter(l => l.ppid > 0 && l.ppid !== 1).map(l => l.ppid));
  const parentComms = batchParentComms(Array.from(uniquePpids));
  return lines
    .map(line => darwinRow(line, cwdMap, parentComms, deadline))
    .filter((r): r is ProcRow => r !== null);
}

export interface OrphanSweepReport {
  scanned: number;
  /** pids the signal was DELIVERED to — delivery, not exit: a bd
   *  parked in an uninterruptible flock wait may outlive the SIGTERM
   *  and needs the supervisor's -k backstop or a later sweep to die. */
  signaled: { pid: number; cwd: string }[];
  /** pids that matched but the injected signal never reached. */
  failed: number[];
}

/** SIGTERM `comm` processes reparented to init whose cwd sits under
 *  `repoRoot` — the debris a dead supervisor leaves behind. A bd
 *  orphan holds the embedded noms LOCK forever (its caller's timeout
 *  died with the caller) and wedges the whole store; the watch tick
 *  sweeps them the same way it sweeps dead session markers. */
export function sweepOrphanProcs(
  comm: string,
  repoRoot: string,
  opts: {
    procDir?: string;
    kill?: (pid: number) => void;
    now?: number;
    rows?: ProcRow[];
  } = {}
): OrphanSweepReport {
  const rows = opts.rows ?? readProcRows(opts.procDir);
  const pids = pickOrphanProcs(rows, comm, repoRoot, opts.now);
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const report: OrphanSweepReport = { scanned: rows.length, signaled: [], failed: [] };
  for (const pid of pids) {
    try {
      kill(pid);
      report.signaled.push({ pid, cwd: byPid.get(pid)?.cwd ?? '' });
    } catch {
      report.failed.push(pid);
    }
  }
  return report;
}

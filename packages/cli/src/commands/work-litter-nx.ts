/**
 * Stale nx daemons — `<wt>/node_modules/nx/dist/src/daemon/server/
 * start.js` is a long-lived helper nx respawns on demand: never a
 * worker, never work. Its cwd/argv inside the tree roots it on every
 * /proc occupancy plane all the same, so a dead fixer's orphaned
 * daemon pins the tree "live" and a safe reap reads as occupied
 * (bro-7dgu3 — verified live: trees held by nothing else).
 *
 * Leaf module — imports externals only.
 */
import { pidAlive } from '@broject/core';
import { type ProcHit, processesRootedIn } from '@broject/rig';

/** An nx daemon's argv signature — `<wt>/node_modules/nx/dist/src/
 *  daemon/server/start.js`. */
const NX_DAEMON_SCRIPT_RE = /nx[/\\]dist[/\\]src[/\\]daemon[/\\]server[/\\]start\.js$/;

/** argv[0] is a node binary (`node`, `…/node`, `node.exe`) AND its
 *  script argument is the daemon's start.js — a flattened-argv
 *  substring match would SIGTERM any process merely carrying the path
 *  as data (`vim <path>`, `cp <path> …`); the script position is the
 *  daemon's shape (codeant, #975). */
export function isNxDaemonCmd(cmd: string): boolean {
  const argv = cmd.split(' ').filter(Boolean);
  const exe = argv[0]?.split(/[/\\]/).pop() ?? '';
  if (!/^node(\.\w+)?$/.test(exe)) {
    return false;
  }
  const script = argv.slice(1).find(t => !t.startsWith('-'));
  return script !== undefined && NX_DAEMON_SCRIPT_RE.test(script);
}

/** Bound the SIGTERM→exit wait — the reap's own rooted-scan must see a
 *  signalled ghost gone in THIS pass, not one sweep later. */
const NX_KILL_WAIT_MS = 2_000;

export interface NxDaemonReapOpts {
  dryRun?: boolean;
  /** Injectable rooted-process scan — tests stub it; production is
   *  processesRootedIn (every occupant, not only agent-shaped). */
  scan?: (worktree: string) => ProcHit[];
  /** Injectable signal/liveness — tests never signal real pids. */
  kill?: (pid: number) => void;
  alive?: (pid: number) => boolean;
  /** Bound on the post-SIGTERM wait — interactive callers keep the
   *  default so this pass's verdict scan sees the ghosts gone; the
   *  drive daemon passes 0 (a sync wait would freeze its event loop —
   *  the next sweep's scan reaps once the daemons exit). */
  waitMs?: number;
}

/** The resolved probes + the report/kill lists one sweep accumulates —
 *  shared by the per-tree verdict so the scan/kill injection is
 *  threaded once. */
interface DaemonSweep {
  scan: (worktree: string) => ProcHit[];
  kill: (pid: number) => void;
  dryRun: boolean;
  killed: string[];
  pids: number[];
}

/** One worktree's daemon verdict — signal only when EVERY rooted
 *  process is daemon-shaped (the only live thing left is disposable
 *  infrastructure); one non-daemon hit keeps hands off the whole tree.
 *  An unreadable scan fails closed — the verdict layer keeps the tree.
 *  The report line lands under dryRun too (the 'would' list); no
 *  signals are sent then. */
function signalTreeDaemons(wt: string, s: DaemonSweep): void {
  let rooted: ProcHit[];
  try {
    rooted = s.scan(wt);
  } catch {
    return;
  }
  if (rooted.length === 0 || !rooted.every(h => isNxDaemonCmd(h.cmd))) {
    return;
  }
  for (const h of rooted) {
    if (!s.dryRun) {
      try {
        s.kill(h.pid);
        s.pids.push(h.pid);
      } catch {
        // already gone — nothing pinned
      }
    }
    s.killed.push(`nx daemon pid ${h.pid} (${wt})`);
  }
}

/** Let the SIGTERMs land before the verdicts' own rooted-scans — a
 *  still-dying daemon would pin its tree for one more sweep. Skipped
 *  at waitMs 0 — the caller chose the next sweep's scan over blocking
 *  this thread (the drive loop's async lane; Atomics.wait stalls every
 *  pending promise for the bound, amazon-q on #975). */
function awaitDaemonExit(pids: number[], alive: (pid: number) => boolean, waitMs: number): void {
  const deadline = Date.now() + waitMs;
  const pending = (): boolean => {
    // waitMs 0 short-circuits here — deadline already passed
    if (Date.now() >= deadline) {
      return false;
    }
    return pids.some(pid => alive(pid));
  };
  while (pending()) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

/** Kill stale nx daemons rooted in the candidate trees — bounded to
 *  trees whose EVERY rooted process is daemon-shaped: the only live
 *  thing left is disposable infrastructure. One non-daemon hit keeps
 *  hands off the whole tree — a live session's daemon keeps company.
 *  Returns the kill-report lines, 'nx daemon pid N (<path>)' — pushed
 *  under dryRun too (the 'would' list); no signals are sent then. */
export function reapStaleNxDaemons(worktrees: string[], opts: NxDaemonReapOpts = {}): string[] {
  const sweep: DaemonSweep = {
    scan: opts.scan ?? ((wt: string) => processesRootedIn(wt)),
    kill: opts.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM')),
    dryRun: opts.dryRun === true,
    killed: [],
    pids: [],
  };
  for (const wt of worktrees) {
    signalTreeDaemons(wt, sweep);
  }
  awaitDaemonExit(sweep.pids, opts.alive ?? pidAlive, opts.waitMs ?? NX_KILL_WAIT_MS);
  return sweep.killed;
}

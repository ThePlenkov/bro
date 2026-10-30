/**
 * The per-worktree fleet-state file (spec bro-idsat) — the contract
 * between the daemon projector (the only classifier/writer) and the
 * `bro: status` pane process (the primary LED reporter). One JSON
 * document per managed worktree under
 * `<git-common>/bro/fleet-status/`, swapped atomically and only when
 * the content moved (the pane's fs.watch must not fire on a no-op
 * rewrite).
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Herdr's reportable pane states — `done` is not reportable, `idle`
 *  renders the native `✓` on unviewed panes. */
export type LedState = 'working' | 'blocked' | 'idle' | 'unknown';

/** The semantic verdict the status pane self-reports — always a
 *  report: the pane is a dashboard, so `stopped` reads `idle` and
 *  release is reserved for the process's own exit. */
export interface PaneLed {
  state: LedState;
  message?: string;
}

/** One managed worktree's projection, as the status pane consumes it. */
export interface FleetPaneState {
  v: 1;
  /** Absolute worktree path this file describes. */
  worktree: string;
  /** The herdr workspace id the projector targeted — informational. */
  workspace: string;
  /** Display title (bead title or path basename). */
  title: string;
  /** Bead/claim slug when one resolved — the `--display-agent` text. */
  slug?: string;
  /** `statusString` — the bracket text the workspace label carries. */
  status: string;
  led: PaneLed;
  /** Wall-clock ms the projector classified at — staleness display. */
  ts: number;
}

/** `<base>/bro/fleet-status` — base is the git common dir, or the
 *  worktree itself when no common dir resolves (a repo-less fixture). */
export function fleetStatusDir(base: string): string {
  return join(base, 'bro', 'fleet-status');
}

const safe = (s: string): string => s.replace(/[^\w.-]+/g, '_');

/** The `bro:fleet` report seq — unix MICROS, monotonic per process
 *  (`hook_report_is_newer` drops anything not strictly higher, so a
 *  wall-clock regress or two reports inside one microsecond must
 *  still emit a bigger number than the last). Nanos are not
 *  representable: `now·1e6` exceeds 2^53 today, and the `seqLast + 1`
 *  clamp would round straight back to `seqLast` — silently emitting
 *  the same seq twice. The pane process is the steady-state writer;
 *  the daemon's backstop pushes share the source and win on
 *  freshness, so a coarser cross-process collision only ever drops a
 *  content-equal write. */
let seqLast = 0;
export function nextSeq(now = Date.now()): number {
  seqLast = Math.max(now * 1e3, seqLast + 1);
  return seqLast;
}

/** The state file for one worktree — readable basename plus a hash of
 *  the realpath so two trees sharing a basename can never collide
 *  (and a symlinked spelling resolves to the same file). */
export function fleetStatusPath(base: string, worktree: string): string {
  let real = worktree;
  try {
    real = realpathSync(worktree);
  } catch {
    // unresolved — hash the spelling we were given
  }
  const h = createHash('sha1').update(real).digest('hex').slice(0, 12);
  return join(fleetStatusDir(base), `${safe(basename(worktree))}.${h}.json`);
}

/** One string field or the parse fails. */
const isStr = (v: unknown): v is string => typeof v === 'string';

/** The led subdocument — a reportable state word plus an optional
 *  message. Anything else is a miss. */
function ledOk(led: unknown): led is PaneLed {
  if (typeof led !== 'object' || led === null) return false;
  const l = led as Partial<PaneLed>;
  if (!['working', 'blocked', 'idle', 'unknown'].includes(l.state as string)) return false;
  return l.message === undefined || isStr(l.message);
}

/** Parse + shape-check one document — anything else is a miss, never
 *  a throw: a torn write or a schema bump must not kill the pane. */
export function parseFleetState(raw: string): FleetPaneState | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const s = v as Partial<FleetPaneState>;
  if (typeof s !== 'object' || s === null) return undefined;
  if (s.v !== 1) return undefined;
  if (!isStr(s.worktree) || !isStr(s.workspace) || !isStr(s.title) || !isStr(s.status)) {
    return undefined;
  }
  if (!ledOk(s.led) || typeof s.ts !== 'number') return undefined;
  return s as FleetPaneState;
}

/** Read the state file — absent/corrupt is undefined, not an error. */
export function readFleetState(path: string): FleetPaneState | undefined {
  try {
    return parseFleetState(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Atomic tmp+rename write that no-ops on identical content — the
 *  pane's watch fires on real moves only. Returns whether a write
 *  happened. */
export function writeFleetState(path: string, s: FleetPaneState): boolean {
  const body = `${JSON.stringify(s)}\n`;
  try {
    if (readFileSync(path, 'utf8') === body) return false;
  } catch {
    // absent or unreadable — write it
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return true;
}

/** Remove state files for worktrees no longer managed — a stale file
 *  would paint a dead verdict if a pane ever reopened the tree. The
 *  `keep` set holds every path this pass still writes. */
export function pruneFleetStatus(base: string, keep: Set<string>): void {
  const dir = fleetStatusDir(base);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!f.endsWith('.json') || keep.has(join(dir, f))) continue;
    try {
      rmSync(join(dir, f), { force: true });
    } catch {
      // residue is harmless — next pass retries
    }
  }
}

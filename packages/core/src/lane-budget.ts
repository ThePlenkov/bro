/**
 * The lane work budget — worker RUNNING time inside the rolling window
 * (spec bro-tdndq). A free-tier account's limit is a request rate, and
 * the fleet was discovering it by dying: ~4 req/min per running worker
 * exhausts the hourly window in ~50–80 min, and every `rate_limited`
 * death escalates the provider's reset (5m→1h35m→3h observed). The
 * budget is the gate that keeps the lane from ever reaching the wall:
 * `agents.<kind>.workBudgetMinutes` worker-minutes of running time per
 * `workBudgetWindowMinutes` (default 60) the batch lane may spend,
 * summed across every worker of the kind.
 *
 * The meter is running-time segments — bro cannot see a worker's
 * requests mid-flight, but it knows when the worker runs. A batch
 * admission opens a segment; a lane freeze (wall or budget) or the
 * worker's end closes it — a SIGSTOP'd worker spends nothing, so
 * accrual stops at freeze or the spend never decays. `spend` is the
 * segments' overlap with the trailing window.
 *
 * The ledger is host-shared (`$XDG_STATE_HOME/bro/lane-budget/`)
 * because the account is — every repo's fleet draws one budget (the
 * lane-gate convention). Records carry `scope` (the owning repo's
 * projectId): a reconcile or admission closes only ITS OWN dead
 * workers' segments — the caller's registry is the liveness truth —
 * and never touches a foreign repo's still-live ones. An open
 * segment's contribution caps at one window: a worker whose end was
 * never recorded bleeds bounded spend and prunes itself out, so a
 * missed close can park the lane for at most ~2 windows.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withFileLock } from './filelock.ts';

/** The configured budget — `minutes` worker-minutes of running time
 *  per rolling `windowMinutes`. */
export interface LaneWorkBudget {
  minutes: number;
  windowMinutes: number;
}

/** `agents.<kind>.workBudgetWindowMinutes` unset — the provider's
 *  rolling window as the fleet observes it (~hourly tier). */
export const DEFAULT_WORK_BUDGET_WINDOW_MINUTES = 60;

/** One running interval — `e` absent means still accruing. */
interface BudgetSegment {
  s: number;
  e?: number;
}

interface BudgetWorker {
  /** The owning repo's projectId — liveness prunes are scoped so one
   *  repo's reconcile never closes a foreign repo's live segments. */
  scope?: string;
  /** Set while the worker is lane-frozen — `resume` owes it a fresh
   *  segment on thaw. */
  paused?: boolean;
  segments: BudgetSegment[];
}

interface LaneBudgetLedger {
  workers: Record<string, BudgetWorker>;
}

/** The ledger key — scope-tagged so two repos' fleets can't alias a
 *  worker (agentIds are minted per registry; the scope names which). */
export function laneBudgetKey(scope: string, agentId: string): string {
  return `${scope}:${agentId}`;
}

/** The host-shared ledger dir — machine state, not data: like
 *  `lane-gate/` it lives outside any repo because the account it
 *  meters is outside every repo. */
export function laneBudgetDir(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'bro', 'lane-budget');
}

function ledgerPath(dir: string, kind: string): string {
  return join(dir, `${encodeURIComponent(kind)}.json`);
}

/** Read the ledger; absent or corrupt ⇒ empty. An unreadable state
 *  file must not wedge the lane — atomic publish means real corruption
 *  is an operator's hand-edit, and the honest recovery is a fresh
 *  ledger, not a stall (the lane-gate convention). */
function readLedger(path: string): LaneBudgetLedger {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LaneBudgetLedger>;
    if (raw.workers !== null && typeof raw.workers === 'object') {
      return { workers: raw.workers as Record<string, BudgetWorker> };
    }
  } catch {
    // missing/corrupt — start clean
  }
  return { workers: {} };
}

function writeLedger(path: string, ledger: LaneBudgetLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`);
  renameSync(tmp, path);
}

const windowMs = (cfg: LaneWorkBudget): number => cfg.windowMinutes * 60_000;
const budgetMs = (cfg: LaneWorkBudget): number => cfg.minutes * 60_000;

/** A segment's effective end: a closed one reports it, an open one
 *  accrues to `now` — capped at one window so a never-closed (zombie)
 *  segment's spend saturates and slides out instead of parking the
 *  lane forever. */
function segEnd(seg: BudgetSegment, now: number, W: number): number {
  return seg.e !== undefined ? seg.e : Math.min(now, seg.s + W);
}

/** One segment's spend at `now` — its overlap with the trailing
 *  window. */
function contribution(seg: BudgetSegment, now: number, W: number): number {
  const end = Math.min(segEnd(seg, now, W), now);
  return Math.max(0, end - Math.max(seg.s, now - W));
}

/** The kind's running-time spend at `now`, in window units (ms). */
function spendOf(ledger: LaneBudgetLedger, now: number, W: number): number {
  let spent = 0;
  for (const w of Object.values(ledger.workers)) {
    for (const seg of w.segments) {
      spent += contribution(seg, now, W);
    }
  }
  return spent;
}

/** Drop segments whose contribution can never grow back — ended past
 *  the window's left edge, or open-but-zombie (their capped end slid
 *  out too). A `paused` record keeps its flag while segments remain —
 *  resume owes it a fresh one. */
function prune(ledger: LaneBudgetLedger, now: number, W: number): void {
  for (const [key, w] of Object.entries(ledger.workers)) {
    w.segments = w.segments.filter(seg => segEnd(seg, now, W) > now - W);
    if (w.segments.length === 0 && w.paused !== true) {
      delete ledger.workers[key];
    }
  }
}

/** Close open segments on workers the caller's registry says are done
 *  — scope-matched so a foreign repo's live segments are never
 *  touched. `liveKeys` = the agentIds still running on MY repo. A dead
 *  worker's record drops entirely once its segments are out (a paused
 *  flag on a dead worker never resumes either). */
function closeDead(
  ledger: LaneBudgetLedger,
  scope: string,
  liveKeys: ReadonlySet<string>,
  now: number
): void {
  for (const [key, w] of Object.entries(ledger.workers)) {
    if (w.scope !== scope) {
      continue;
    }
    const agentId = key.slice(scope.length + 1);
    if (liveKeys.has(agentId)) {
      continue;
    }
    for (const seg of w.segments) {
      if (seg.e === undefined) {
        seg.e = now;
      }
    }
    if (w.segments.length === 0) {
      delete ledger.workers[key];
    }
  }
}

/** The earliest `t > now` where projected spend drops below budget —
 *  the refusal's wait. Projection assumes every open segment freezes
 *  at `now` (the reconcile does exactly that on a spent lane), so
 *  spend is nonincreasing in `t` and the first decay breakpoint below
 *  budget is the answer — conservative by at most one breakpoint. */
function retryAfterSec(ledger: LaneBudgetLedger, cfg: LaneWorkBudget, now: number): number {
  const W = windowMs(cfg);
  const B = budgetMs(cfg);
  const spendAt = (t: number): number => {
    let spent = 0;
    for (const w of Object.values(ledger.workers)) {
      for (const seg of w.segments) {
        const end = segEnd(seg, now, W); // frozen at now for the projection
        spent += Math.max(0, end - Math.max(seg.s, t - W));
      }
    }
    return spent;
  };
  const points = new Set<number>();
  for (const w of Object.values(ledger.workers)) {
    for (const seg of w.segments) {
      const end = segEnd(seg, now, W);
      if (end > now - W) {
        points.add(seg.s + W);
        points.add(end + W);
      }
    }
  }
  for (const t of [...points].filter(t => t > now).sort((a, b) => a - b)) {
    if (spendAt(t) < B) {
      return Math.max(1, Math.ceil((t - now) / 1000));
    }
  }
  // unreachable while B > 0 — spend is zero past the last breakpoint
  return Math.ceil(W / 1000);
}

/** Clock/ledger overrides — tests pin `now` and isolate `dir`. `scope`
 *  + `liveKeys` opt the call into dead-worker pruning: the caller's
 *  registry is the liveness truth for ITS OWN scope's segments. */
export interface LaneBudgetOpts {
  now?: number;
  dir?: string;
  scope?: string;
  liveKeys?: ReadonlySet<string>;
}

/** The verdict of a spend check — `spent` is the level in whole
 *  worker-minutes; `retryAfterSec` is present exactly when the budget
 *  is exhausted. */
export interface LaneBudgetLevel {
  spentMin: number;
  budgetMin: number;
  windowMin: number;
  spent: boolean;
  retryAfterSec?: number;
}

/** One locked read-mutate-publish on the kind's ledger. */
function mutate<T>(
  kind: string,
  opts: LaneBudgetOpts,
  fn: (ledger: LaneBudgetLedger, now: number) => T
): T {
  const dir = opts.dir ?? laneBudgetDir();
  const path = ledgerPath(dir, kind);
  return withFileLock(`${path}.lock`, () => {
    const now = opts.now ?? Date.now();
    const ledger = readLedger(path);
    const out = fn(ledger, now);
    writeLedger(path, ledger);
    return out;
  });
}

/** Prune the ledger at `now`: dead-window segments out, the caller's
 *  dead workers' open segments closed, then the spend verdict. The
 *  reconcile pass and the admission both run this — a segment that
 *  outlives its worker gets closed by the next writer, not by a
 *  dedicated ticker. */
export function laneBudgetCheck(
  kind: string,
  cfg: LaneWorkBudget,
  opts: LaneBudgetOpts = {}
): LaneBudgetLevel {
  return mutate(kind, opts, (ledger, now) => {
    const W = windowMs(cfg);
    if (opts.scope !== undefined && opts.liveKeys !== undefined) {
      closeDead(ledger, opts.scope, opts.liveKeys, now);
    }
    prune(ledger, now, W);
    const spent = spendOf(ledger, now, W);
    const level: LaneBudgetLevel = {
      spentMin: Math.floor(spent / 60_000),
      budgetMin: cfg.minutes,
      windowMin: cfg.windowMinutes,
      spent: spent >= budgetMs(cfg),
    };
    if (level.spent) {
      level.retryAfterSec = retryAfterSec(ledger, cfg, now);
    }
    return level;
  });
}

/** Check + claim in one locked op: a batch spawn's first segment
 *  opens only while spend < budget. Returns the refusal's wait on
 *  exhaustion — the spawn never walks into the wall. */
export function laneBudgetAdmit(
  kind: string,
  key: string,
  cfg: LaneWorkBudget,
  opts: LaneBudgetOpts = {}
): { ok: true; spentMin: number } | { ok: false; spentMin: number; retryAfterSec: number } {
  return mutate(kind, opts, (ledger, now) => {
    const W = windowMs(cfg);
    if (opts.scope !== undefined && opts.liveKeys !== undefined) {
      closeDead(ledger, opts.scope, opts.liveKeys, now);
    }
    prune(ledger, now, W);
    const spent = spendOf(ledger, now, W);
    const spentMin = Math.floor(spent / 60_000);
    if (spent >= budgetMs(cfg)) {
      return { ok: false as const, spentMin, retryAfterSec: retryAfterSec(ledger, cfg, now) };
    }
    const worker = ledger.workers[key] ?? { segments: [] };
    if (opts.scope !== undefined) {
      worker.scope = opts.scope;
    }
    worker.segments.push({ s: now });
    ledger.workers[key] = worker;
    return { ok: true as const, spentMin };
  });
}

/** Freeze bookkeeping: the worker stopped spending — close its open
 *  segment and mark it owed a fresh one on thaw. Creates the record
 *  when missing (a live worker whose ledger entry pruned out between
 *  checks still gets re-metered on resume). */
export function laneBudgetPause(kind: string, key: string, opts: LaneBudgetOpts = {}): void {
  mutate(kind, opts, (ledger, now) => {
    const worker = ledger.workers[key] ?? { segments: [] };
    if (opts.scope !== undefined) {
      worker.scope = opts.scope;
    }
    for (const seg of worker.segments) {
      if (seg.e === undefined) {
        seg.e = now;
      }
    }
    worker.paused = true;
    ledger.workers[key] = worker;
  });
}

/** Thaw bookkeeping: a frozen worker runs again — open a fresh
 *  segment. No-op when the record is absent or was never marked
 *  paused (an unmetered worker stays unmetered). */
export function laneBudgetResume(kind: string, key: string, opts: LaneBudgetOpts = {}): void {
  mutate(kind, opts, (ledger, now) => {
    const worker = ledger.workers[key];
    if (worker === undefined || worker.paused !== true) {
      return;
    }
    worker.paused = undefined;
    worker.segments.push({ s: now });
    ledger.workers[key] = worker;
  });
}

/** Read-only level for status — no lock, no write: a torn read
 *  renders a stale number, never a wrong admission (the lane-gate
 *  level convention). Null when no ledger exists yet (never metered). */
export function laneBudgetLevel(
  kind: string,
  cfg: LaneWorkBudget,
  opts: LaneBudgetOpts = {}
): LaneBudgetLevel | null {
  const dir = opts.dir ?? laneBudgetDir();
  const path = ledgerPath(dir, kind);
  if (!existsSync(path)) {
    return null;
  }
  const now = opts.now ?? Date.now();
  const W = windowMs(cfg);
  const ledger = readLedger(path);
  const spent = spendOf(ledger, now, W);
  const level: LaneBudgetLevel = {
    spentMin: Math.floor(spent / 60_000),
    budgetMin: cfg.minutes,
    windowMin: cfg.windowMinutes,
    spent: spent >= budgetMs(cfg),
  };
  if (level.spent) {
    level.retryAfterSec = retryAfterSec(ledger, cfg, now);
  }
  return level;
}

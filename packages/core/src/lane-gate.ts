/**
 * The lane rate gate — a shared token bucket per model (spec
 * bro-y3jvd). A fleet of batch workers can outrun a provider's rate
 * limit only by dying: the gate paces ADMISSION instead. Each batch
 * spawn pays its estimated lifetime request spend (`spawnCost`) out of
 * a bucket refilling at `requestsPerHour` — the account's known
 * ceiling. A refused spawn waits; it never walks into the wall.
 *
 * The ledger is host-shared (`$XDG_STATE_HOME/bro/lane-gate/`) because
 * the account is — every repo's fleet on the host draws the same
 * budget. One JSON file per `<lane>/<model>` key, updated under a
 * filelock so two bro processes can't race a take.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withFileLock } from './filelock.ts';

/** A provider entry's `rateGate` config — the pacing knobs for one
 *  account lane. `requestsPerHour` and `spawnCost` are both required:
 *  the unit is requests, and the cost of a spawn is the operator's
 *  estimate of a worker's lifetime spend — bro cannot measure a
 *  worker's turns mid-flight, so the honest knob is config, not a
 *  guessed default. `burst` defaults to `requestsPerHour` (a full
 *  window's burst capacity — standard token-bucket semantics);
 *  `lane` defaults to the provider name and lets two entries that
 *  resolve to the same account share one bucket. */
export interface LaneRateGate {
  lane?: string;
  requestsPerHour: number;
  spawnCost: number;
  burst?: number;
}

/** The host-shared ledger dir — `$XDG_STATE_HOME/bro/lane-gate`
 *  (`~/.local/state` fallback). Machine state, not data: like
 *  `provider.json`, it lives outside any repo because the account
 *  it meters is outside every repo. */
export function laneGateDir(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'bro', 'lane-gate');
}

/** One bucket's ledger — tokens left and the timestamp the level was
 *  computed at. Refill is lazy: nothing ticks between takes. */
interface LaneGateLedger {
  tokens: number;
  updatedAt: number;
}

/** `burst` absent ⇒ a full window of burst capacity. */
const capacityOf = (cfg: LaneRateGate): number => cfg.burst ?? cfg.requestsPerHour;

/** Filesystem-safe one-file-per-key name — lane/model ids may carry
 *  `/` (router-prefixed model ids do), so the key is encoded, never
 *  concatenated raw into a path. */
function ledgerPath(dir: string, lane: string, model: string): string {
  const key = encodeURIComponent(`${lane}/${model}`);
  return join(dir, `${key}.json`);
}

/** Read the ledger; absent or corrupt ⇒ a fresh FULL bucket. An
 *  unreadable state file must not wedge the lane — atomic publish
 *  means real corruption is an operator's hand-edit, and the honest
 *  recovery is to start full, not to stall forever. */
function readLedger(path: string, cfg: LaneRateGate, now: number): LaneGateLedger {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LaneGateLedger>;
    if (typeof raw.tokens === 'number' && Number.isFinite(raw.tokens)) {
      const updatedAt =
        typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now;
      return { tokens: Math.max(0, raw.tokens), updatedAt };
    }
  } catch {
    // missing/corrupt — fresh bucket below
  }
  return { tokens: capacityOf(cfg), updatedAt: now };
}

function writeLedger(path: string, ledger: LaneGateLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`);
  renameSync(tmp, path);
}

const refill = (l: LaneGateLedger, cfg: LaneRateGate, now: number): number =>
  Math.min(
    capacityOf(cfg),
    // a host clock stepping backward must not drain the saved balance —
    // negative elapsed clamps to zero refill, never a debit
    l.tokens + (Math.max(0, now - l.updatedAt) / 3_600_000) * cfg.requestsPerHour
  );

/** Clock/ledger overrides — tests pin `now` and isolate `dir`. */
export interface LaneGateOpts {
  now?: number;
  dir?: string;
  /** The refund half — hand `spawnCost` back to the bucket instead of
   *  charging it (a spawn that died before launch never ran, spec
   *  bro-y3jvd). Always succeeds, capped at capacity: a refund can
   *  never mint budget the lane never had. */
  refund?: boolean;
}

/** Charge `cost` request-tokens to the `<lane>/<model>` bucket.
 *  Atomic across processes under the ledger's filelock. Returns the
 *  post-take level on success, or `retryAfterSec` — the wait until
 *  the bucket holds `cost` again. */
export function laneGateTake(
  lane: string,
  model: string,
  cfg: LaneRateGate,
  opts: LaneGateOpts = {}
): { ok: true; tokens: number } | { ok: false; retryAfterSec: number } {
  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? laneGateDir();
  const path = ledgerPath(dir, lane, model);
  return withFileLock(`${path}.lock`, () => {
    const cur = readLedger(path, cfg, now);
    const tokens = refill(cur, cfg, now);
    if (opts.refund === true) {
      // the refund never refuses and never overfills — the lane only
      // gets back what the failed spawn spent
      const credited = Math.min(capacityOf(cfg), tokens + cfg.spawnCost);
      writeLedger(path, { tokens: credited, updatedAt: now });
      return { ok: true as const, tokens: credited };
    }
    if (tokens < cfg.spawnCost) {
      // cost > capacity can never satisfy — refuse without the wait
      const retryAfterSec = Math.ceil(((cfg.spawnCost - tokens) / cfg.requestsPerHour) * 3600);
      return { ok: false as const, retryAfterSec };
    }
    const left = tokens - cfg.spawnCost;
    writeLedger(path, { tokens: left, updatedAt: now });
    return { ok: true as const, tokens: left };
  });
}

/** Read-only view for status: the bucket's level at `now` (no take,
 *  no lock — a torn read renders a stale number, never a wrong
 *  admission). Null when no ledger exists yet (never gated). */
export function laneGateLevel(
  lane: string,
  model: string,
  cfg: LaneRateGate,
  opts: LaneGateOpts = {}
): { tokens: number; capacity: number } | null {
  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? laneGateDir();
  const path = ledgerPath(dir, lane, model);
  if (!existsSync(path)) {
    return null;
  }
  const cur = readLedger(path, cfg, now);
  return { tokens: Math.floor(refill(cur, cfg, now)), capacity: capacityOf(cfg) };
}

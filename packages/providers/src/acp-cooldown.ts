/**
 * The provider wall's cooldown (spec bro-i6811).
 *
 * On 2026-11-10 `bro serve` answered a client's requests by spawning 147
 * devin-acp peers: the account answered `429`/`529`, the conductor
 * reported the wall — and the client's next request spawned AGAIN. Each
 * spawn pays the agent's full setup on a shared account, so the retry
 * storm WAS the outage: the account-wide rate limit was the symptom,
 * the respawn was the cause.
 *
 * The dead-loop guard (spec bro-b961a) cannot cover this. It measures
 * sessions opened and not completed, per conversation and per peer, and
 * it forgets a peer's tally when the peer dies — which is exactly what a
 * wall does: the transport dies, the peer is replaced, and the measure
 * starts over. The guard is the last resort; this cooldown is the
 * proactive half — it closes the SPAWN path while the wall holds, so a
 * refused request costs no session and no quota.
 *
 * Accounting, not heuristics: it counts the walls bro already knows about
 * (a 429 or a 529 on the wire) and refuses while the window they opened
 * is live. It lives here, in the provider layer, so it holds for every
 * client of the same lane — Claude Code, Codex, Cursor, bro's own loop.
 */

/** The wall a failure named — the reason the cooldown is logged. */
export interface AcpWallRefusal {
  /** Why the lane is cooling down — the wall's own words, short. */
  reason: string;
  /** How long the client should wait, seconds. */
  retryAfterSec: number;
}

/** A wall a failure NAMED — the classifier's answer. It carries the
 * arming policy on top of the refusal shape. */
export interface AcpWallSignal extends AcpWallRefusal {
  /** The account said so in so many words (a quota wall, an explicit
   *  `429`) — the lane closes at once. A generic provider failure is
   *  not: one failed turn is an incident of THIS turn, and only the
   *  second one in the window says the account is struggling. */
  immediate: boolean;
}

/** The lane is cooling down after a provider wall — the refusal costs no
 * session and no quota, because it happens BEFORE the spawn. The client
 * waits out the `retry-after` and comes back. */
export class AcpCooldownError extends Error {
  override name = 'AcpCooldownError';
  /** The wall's reason — the operator's reading of the refusal. */
  readonly reason: string;
  /** How long the client should wait, seconds. */
  readonly retryAfterSec: number;

  constructor(detail: { reason: string; retryAfterSec: number }) {
    super(
      `acp provider wall — the lane is cooling down (${detail.reason}) — ` +
        `no session was opened, retry in ${detail.retryAfterSec}s`
    );
    this.reason = detail.reason;
    this.retryAfterSec = detail.retryAfterSec;
  }
}

/** The cooldown's knobs. */
export interface AcpCooldownOptions {
  /** How long a wall holds the lane closed, ms. 0 disables the
   * cooldown — the lane never refuses on the wall alone. */
  cooldownMs?: number;
  /** The window the walls are counted in, ms. A wall older than the
   * window is forgotten — the account may have recovered. */
  windowMs?: number;
  /** The ceiling the escalation climbs to, ms. A lane under a long wall
   * backs off further, but never past this. */
  maxCooldownMs?: number;
}

/** The wall cooldown's default — a lane the account refused waits a
 * minute before it spends another session on the same wall. */
export const ACP_COOLDOWN_DEFAULT_MS = 60_000;

const DEFAULTS = {
  cooldownMs: ACP_COOLDOWN_DEFAULT_MS,
  windowMs: 300_000,
  maxCooldownMs: 900_000,
} as const;

/** The provider's own words for a quota wall. */
const RATE_WALL = /rate[\s._-]?limit|too many requests|quota exceeded|\b429\b/i;
/**
 * The provider's own words for a capacity wall.
 *
 * The bare word "unavailable" is NOT a signal here: bro's own wrapper
 * says "acp <entry> unavailable — <reason>" about EVERY failure it
 * re-throws, so matching it would arm the cooldown on an auth error
 * and on a bad model name alike. Only the provider's own phrasing
 * counts, and the capacity words are narrow on purpose — a message
 * about "storage capacity" is not the account saying no.
 * "Internal error" is in the set because that is what the ACP SDK
 * reports for a provider that broke — and a provider that broke is
 * exactly the case where paying one session per client retry burns an
 * account for nothing (2026-11-10: 32 spawns, 32 × "Internal error").
 */
const CAPACITY_WALL =
  /service unavailable|temporarily unavailable|overloaded|at capacity|service capacity|internal error|\b529\b/i;
/** bro's OWN caps — a local session cap is not the account's wall, and
 * arming the cooldown on it would refuse a lane that is serving fine. */
const LOCAL_CAP = /session quota reached|maxsessions|maxbatchworkers/i;

/** The HTTP status a failure carries, if any. Only a real HTTP status
 * counts — the ACP SDK's JSON-RPC `code` is a wire code, not a status,
 * and reading it as one would classify every RPC failure as a wall. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const raw =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return undefined;
  }
  return raw >= 400 && raw <= 599 ? raw : undefined;
}

/** The provider's own recovery window, seconds — when the failure
 * carries one. A provider that names its own recovery time knows
 * better than we do; the lane waits at least that long. */
function retryAfterOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const bag = err as { retryAfter?: unknown; retry_after?: unknown; headers?: unknown };
  const raw = bag.retryAfter ?? bag.retry_after;
  const seconds = retrySeconds(raw);
  if (seconds !== undefined) {
    return seconds;
  }
  const headers = bag.headers;
  if (typeof headers === 'object' && headers !== null) {
    return retrySeconds((headers as Record<string, unknown>)['retry-after']);
  }
  return undefined;
}

/** A retry-after value in seconds — a number or a numeric string. */
function retrySeconds(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : undefined;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? Math.ceil(num) : undefined;
  }
  return undefined;
}

/** One failure's own words — the wall it names, if any. The status is
 * read FIRST: an HTTP status is the provider's own verdict and outranks
 * any message shape. */
function wallOfOne(err: Error): AcpWallSignal | undefined {
  const status = statusOf(err);
  if (status === 429) {
    return {
      reason: 'the provider rate limited the request (429)',
      retryAfterSec: retryAfterOf(err) ?? 30,
      immediate: true,
    };
  }
  if (status === 529) {
    // a capacity wall, however it arrives — the message class is
    // non-immediate too, so the two spellings agree
    return {
      reason: 'the provider is unavailable (529)',
      retryAfterSec: retryAfterOf(err) ?? 15,
      immediate: false,
    };
  }
  const msg = err.message;
  if (msg === '' || LOCAL_CAP.test(msg)) {
    return undefined;
  }
  const retryAfter = retryAfterOf(err);
  if (RATE_WALL.test(msg)) {
    return {
      reason: 'the provider rate limited the request',
      retryAfterSec: retryAfter ?? 30,
      immediate: true,
    };
  }
  if (CAPACITY_WALL.test(msg)) {
    return {
      reason: 'the provider could not serve the request',
      retryAfterSec: retryAfter ?? 15,
      immediate: false,
    };
  }
  return undefined;
}

/** The wall a failure named — undefined when the failure is not the
 * account saying no. The classification is deliberately narrow: an
 * auth error, a bad model name or a timeout of the whole turn is a
 * failure of THIS request, not proof that the account is under a wall
 * — arming on those would refuse a lane that is perfectly able to
 * serve. */
export function acpWallOf(err: unknown): AcpWallSignal | undefined {
  // a refusal is never a wall — re-arming on it would extend the wait
  // forever, one client request at a time
  if (causeChain(err).some(isCooldownRefusal)) {
    return undefined;
  }
  // the chain is walked outermost first: bro's wrapper carries the
  // provider's own message inside it, so the outermost answer is the
  // one that names the provider
  return causeChain(err)
    .map(wallOfOne)
    .find(wall => wall !== undefined);
}

/** The failure's cause chain, outermost first. */
function causeChain(err: unknown): Error[] {
  const chain: Error[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    chain.push(e);
  }
  return chain;
}

/** The failure is a refusal of ours — never a wall. */
function isCooldownRefusal(err: Error): boolean {
  return err instanceof AcpCooldownError;
}

/** What arming a cooldown from a failure produced. */
export interface AcpArmedWall {
  /** The wall the failure named. */
  wall: AcpWallSignal;
  /** Whether the lane actually closed — a counted-only wall leaves it
   * open (the first capacity failure is a failed turn, not a wall). */
  armed: boolean;
}

/**
 * Arm a lane's cooldown from a failure — the ONE place the arming
 * policy lives, so the conductor and the brokered transport cannot
 * drift apart.
 *
 * The policy:
 *
 * - a quota wall (the account said no in so many words) closes the lane
 *   at once;
 * - a capacity wall (the provider could not serve) closes the lane on
 *   the SECOND one in the window — one failed turn is an incident of
 *   that turn. Without that threshold the cooldown would answer every
 *   provider hiccup, and the churn guard (spec bro-b961a) would never
 *   get to see the churn it exists to stop;
 * - a refusal is never a wall — re-arming on it would extend the wait
 *   forever, one client request at a time.
 */
export function armWallFromError(
  cooldown: AcpLaneCooldown,
  err: unknown
): AcpArmedWall | undefined {
  if (err instanceof AcpCooldownError) {
    return undefined;
  }
  const wall = acpWallOf(err);
  if (wall === undefined) {
    return undefined;
  }
  const seen = cooldown.wallCount();
  const armed = wall.immediate || seen > 0;
  cooldown.noteWall(wall.reason, { retryAfterSec: wall.retryAfterSec, arm: armed });
  return { wall, armed };
}

/** One lane's wall state. */
export class AcpLaneCooldown {
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly maxCooldownMs: number;
  /** When the window opened, ms. -1 = the window never opened. */
  private windowStart = -1;
  /** The walls seen in the window — the proactive measure's tally. */
  private walls = 0;
  /** The armings in the window — the escalation counts THESE, so a
   * wall that was only counted never makes the next wait longer. */
  private arms = 0;
  /** When the cooldown ends, ms. */
  private until = 0;
  /** The last wall's reason — what the refusal names. */
  private reason = '';

  constructor(opts: AcpCooldownOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.maxCooldownMs = opts.maxCooldownMs ?? DEFAULTS.maxCooldownMs;
  }

  /** A wall — the account refused work. The lane closes until the
   * cooldown ends: the next request must not pay for a spawn while the
   * wall holds.
   *
   * The cooldown ESCALATES while the walls keep coming: a lane that
   * keeps hitting walls is a lane the account cannot serve, and each
   * probe costs a session. The first wall waits the base window, the
   * second waits twice, and so on up to the ceiling.
   *
   * A wall that arrives while the lane is ALREADY closed is part of
   * that same wall — several turns were in flight when the account
   * said no, and each of them fails with the same refusal. Counting
   * them as separate walls would escalate one wall into a fifteen
   * minute lockout, so an active cooldown is only ever EXTENDED, never
   * escalated and never shortened.
   *
   * `arm: false` COUNTS the wall without closing the lane: a generic
   * provider failure is a failed turn, and only the second one in the
   * window says the account is struggling. */
  noteWall(
    reason: string,
    detail: { retryAfterSec?: number; now?: number; arm?: boolean } = {}
  ): void {
    if (this.cooldownMs <= 0) {
      return;
    }
    const now = detail.now ?? Date.now();
    if (this.windowsExpired(now)) {
      this.windowStart = now;
      this.walls = 0;
      this.arms = 0;
    }
    this.walls += 1;
    this.reason = reason;
    if (detail.arm === false) {
      return;
    }
    const asked = (detail.retryAfterSec ?? 0) * 1000;
    if (this.until > now) {
      // the lane is already closed — the wall extends the wait, it does
      // not start a new one
      this.until = Math.max(this.until, now + asked);
      return;
    }
    this.arms += 1;
    const escalated = Math.min(this.cooldownMs * 2 ** (this.arms - 1), this.maxCooldownMs);
    this.until = now + Math.max(escalated, asked);
  }

  /** The refusal — undefined while the lane is healthy. The refusal
   * costs nothing: it happens before the spawn, so no session is
   * opened and no quota is spent. */
  refusal(now = Date.now()): AcpWallRefusal | undefined {
    if (this.until <= now) {
      return undefined;
    }
    return {
      reason: this.reason,
      retryAfterSec: Math.max(1, Math.ceil((this.until - now) / 1000)),
    };
  }

  /** The walls seen in the current window — the proactive measure the
   * operator reads: a lane that keeps hitting walls is a lane the
   * account cannot serve. */
  wallCount(now = Date.now()): number {
    if (this.windowsExpired(now)) {
      return 0;
    }
    return this.walls;
  }

  /** The window is over — the tally starts clean. The cooldown itself
   * outlives the window: the wall owns the refusal until it ends. */
  private windowsExpired(now: number): boolean {
    return this.windowStart < 0 || now - this.windowStart >= this.windowMs;
  }
}

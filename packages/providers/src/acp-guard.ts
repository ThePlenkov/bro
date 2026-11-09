/**
 * Dead-loop prevention for bro's ACP sessions (spec bro-b961a).
 *
 * The ACP layer used to count nothing: every failure path is "evict the
 * session, open a new one next time", so a client that retries turns a
 * conversation into a rising tide of `session/new` calls that nobody in
 * bro observes. On 2026-11-09 a devin-acp listener opened 222 sessions
 * against 54 prompts in 57 minutes — 76 % of the sessions abandoned
 * without a prompt, each one paying the agent's full setup — and the
 * account was locked for five hours.
 *
 * The guard is accounting, not heuristics: it counts what bro already
 * knows (sessions opened, turns completed) and refuses the churn before
 * it costs quota. It lives here — in the provider layer, above every
 * transport — so it holds for every client: Claude Code, Codex, Cursor,
 * bro's own loop. A guard bolted onto one client is worthless, because the
 * next client repeats the burn.
 *
 * Three guards, one measure:
 *
 * - **scope churn** — per conversation, sessions opened and not yet
 *   completed. Over the budget, the scope is refused (the refusal costs
 *   no quota: it happens before the session opens).
 * - **peer churn** — the same measure per peer. Over the budget the peer
 *   is broken: the loop may live inside the child, and a fresh child is
 *   the only cure for a loop that survived in the old one.
 * - **stall** — a turn that says nothing for too long is ended. That one
 *   lives at `pumpTurn`, the chokepoint every ACP turn passes through.
 */

/** What the guard measures — a conversation and the peer behind it. */
export interface AcpTarget {
  /** The conversation scope — a key, never a guess. */
  scope: string;
  /** The peer key — the spawn label (`conductor:<entry>`). */
  peer?: string;
}

/** A scope (or a peer) is in a dead loop — the churn is refused. */
export class AcpDeadLoopError extends Error {
  override name = 'AcpDeadLoopError';
  /** The scope that tripped — a conversation key, never a guess. */
  readonly scope: string;
  /** Sessions opened without a completed turn, at the trip. */
  readonly opens: number;
  /** The budget that was exceeded. */
  readonly budget: number;
  /** Which measure tripped — the conversation's own churn, or the peer's. */
  readonly kind: 'scope' | 'peer';

  constructor(detail: { scope: string; opens: number; budget: number; kind?: 'scope' | 'peer' }) {
    const kind = detail.kind ?? 'scope';
    super(
      kind === 'scope'
        ? `acp dead loop: scope '${detail.scope}' opened ${detail.opens} sessions without a ` +
            `completed turn (budget ${detail.budget}) — the churn is refused, no session was opened`
        : `acp dead loop: peer '${detail.scope}' opened ${detail.opens} sessions without a ` +
            `completed turn (budget ${detail.budget}) — the peer was killed, the next request respawns it`
    );
    this.scope = detail.scope;
    this.opens = detail.opens;
    this.budget = detail.budget;
    this.kind = kind;
  }
}

/** The guard's knobs — the counts it refuses at. */
export interface AcpDeadLoopOptions {
  /** Sessions opened and not completed, per scope, before the scope
   *  trips. Default 8. */
  maxOpens?: number;
  /** Sessions opened and not completed, per peer, before the peer is
   *  marked for breaking. Default 32. */
  maxAbandoned?: number;
  /** The window both budgets count in, ms. Default 60_000. */
  windowMs?: number;
  /** How long a tripped scope stays refused, ms. Default 60_000. */
  cooldownMs?: number;
}

/** What a caller hands the guard: the guard itself and the target it
 *  measures. The ctx IS the target — one shape, one meaning. */
export interface AcpGuardCtx extends AcpTarget {
  guard: AcpDeadLoopGuard;
}

/** One counter set — the window's pending sessions. */
interface Tally {
  /** Sessions opened and not yet completed — the churn measure. */
  pending: number;
  /** When the current window opened, ms. */
  since: number;
  /** When the scope may be probed again, ms (0 = not tripped). */
  trippedUntil: number;
}

const DEFAULTS = {
  maxOpens: 8,
  maxAbandoned: 32,
  windowMs: 60_000,
  cooldownMs: 60_000,
} as const;

export class AcpDeadLoopGuard {
  private readonly maxOpens: number;
  private readonly maxAbandoned: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  /** Per scope — the conversation's own churn. */
  private readonly scopes = new Map<string, Tally>();
  /** Per peer — the churn of the transport behind the scope. */
  private readonly peers = new Map<string, Tally>();

  constructor(opts: AcpDeadLoopOptions = {}) {
    this.maxOpens = opts.maxOpens ?? DEFAULTS.maxOpens;
    this.maxAbandoned = opts.maxAbandoned ?? DEFAULTS.maxAbandoned;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
  }

  /** A session is about to open in the target's scope — throws when the
   *  scope is in a dead loop. The refusal happens BEFORE the session
   *  opens, so a tripped scope costs no quota at all. */
  open(target: AcpTarget): void {
    const now = Date.now();
    const tally = this.tally(this.scopes, target.scope, now);
    if (tally.trippedUntil > now) {
      throw new AcpDeadLoopError({ scope: target.scope, opens: tally.pending, budget: this.maxOpens });
    }
    if (tally.trippedUntil > 0) {
      // the cooldown expired — the burst that tripped the scope is stale.
      // The scope is half-open now: exactly one probe gets through, and
      // its completion clears the trip (a failure trips it again).
      tally.trippedUntil = 0;
      tally.pending = 0;
    }
    // the open that would cross the budget never happens — the refusal
    // is the point: no session, no quota
    if (tally.pending + 1 > this.maxOpens) {
      // tripped until the cooldown ends — a probe is allowed then, and a
      // completed turn clears the trip outright
      tally.trippedUntil = now + this.cooldownMs;
      throw new AcpDeadLoopError({
        scope: target.scope,
        opens: tally.pending + 1,
        budget: this.maxOpens,
      });
    }
    tally.pending += 1;
    if (target.peer !== undefined) {
      this.tally(this.peers, target.peer, now).pending += 1;
    }
  }

  /** The scope's turn completed — the session it opened is resolved and
   *  leaves the churn measure. A completed turn also clears the trip: a
   *  working conversation is never stuck behind a stale refusal. */
  done(target: AcpTarget): void {
    const now = Date.now();
    const tally = this.tally(this.scopes, target.scope, now);
    if (tally.pending > 0) {
      tally.pending -= 1;
    }
    tally.trippedUntil = 0;
    if (target.peer !== undefined) {
      const peerTally = this.tally(this.peers, target.peer, now);
      if (peerTally.pending > 0) {
        peerTally.pending -= 1;
      }
    }
  }

  /** The peer churned past its budget — the caller breaks the peer (the
   *  loop may live inside the child). False while the peer is healthy. */
  peerChurn(target: AcpTarget): boolean {
    return this.peerTrip(target) !== undefined;
  }

  /** The peer's churn — sessions opened and not completed. */
  peerChurnCount(target: AcpTarget): number {
    if (target.peer === undefined) {
      return 0;
    }
    return this.tally(this.peers, target.peer, Date.now()).pending;
  }

  /** The peer's break — the error the caller throws after killing it.
   *  Undefined while the peer is healthy. */
  peerTrip(target: AcpTarget): AcpDeadLoopError | undefined {
    if (target.peer === undefined) {
      return undefined;
    }
    const tally = this.tally(this.peers, target.peer, Date.now());
    return tally.pending > this.maxAbandoned
      ? new AcpDeadLoopError({
          scope: target.peer,
          opens: tally.pending,
          budget: this.maxAbandoned,
          kind: 'peer',
        })
      : undefined;
  }

  /** The scope's current churn — the sessions opened and not completed.
   *  For the error line and the operator's reading of the journal. */
  churn(target: AcpTarget): number {
    return this.tally(this.scopes, target.scope, Date.now()).pending;
  }

  /** The tally for a key, created on first use — a window that expired
   *  starts empty again. */
  private tally(map: Map<string, Tally>, key: string, now: number): Tally {
    const fresh = map.get(key);
    if (fresh === undefined) {
      const created: Tally = { pending: 0, since: now, trippedUntil: 0 };
      map.set(key, created);
      return created;
    }
    if (now - fresh.since >= this.windowMs) {
      // the window closed: the burst is over, the counters start clean.
      // The trip is NOT cleared here — the cooldown owns that, so a
      // scope stays refused for its full cooldown even when the window
      // it tripped in is already gone.
      fresh.pending = 0;
      fresh.since = now;
    }
    return fresh;
  }
}

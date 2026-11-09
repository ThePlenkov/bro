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

  constructor(detail: {
    scope: string;
    opens: number;
    budget: number;
    kind?: 'scope' | 'peer';
    /** Why this refusal — the plain text after the measure. */
    reason?: string;
  }) {
    const kind = detail.kind ?? 'scope';
    const why =
      detail.reason ??
      (kind === 'scope'
        ? 'the churn is refused, no session was opened'
        : 'the peer was killed, the next request respawns it');
    super(
      kind === 'scope'
        ? `acp dead loop: scope '${detail.scope}' opened ${detail.opens} sessions without a ` +
            `completed turn (budget ${detail.budget}) — ${why}`
        : `acp dead loop: peer '${detail.scope}' opened ${detail.opens} sessions without a ` +
            `completed turn (budget ${detail.budget}) — ${why}`
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

/** What one admitted open owes the guard — the tallies it was counted
 *  in, at the window they stood at. `resolve` settles THIS charge
 *  once: a completion that lands after its window rolled was already
 *  written off by the reset, so freeing it would eat a newer session's
 *  count; a second resolve frees nothing (a session's continuation
 *  prompts answer its own open, never another's). */
export interface AcpCharge {
  /** The session's own charge settled — idempotent. */
  resolve(): void;
}

/** One counter set — the window's pending sessions. */
interface Tally {
  /** Sessions opened and not yet completed — the churn measure. */
  pending: number;
  /** When the current window opened, ms. */
  since: number;
  /** When the scope may be probed again, ms (0 = not tripped). */
  trippedUntil: number;
  /** A half-open probe is in flight — the scope admits ONE open until
   *  the probe answers. A failed probe never answers, so the scope stays
   *  half-open until the cooldown ends. */
  probeInFlight: boolean;
}

/** How many tallies the maps hold before the prune runs. */
const PRUNE_AT = 256;

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
   *  opens, so a tripped scope costs no quota at all. The returned
   *  charge is the session's own debt: `resolve` it when its turn
   *  completes (a failed or abandoned open never resolves — that IS
   *  the churn the budgets measure). */
  open(target: AcpTarget): AcpCharge {
    const now = Date.now();
    const tally = this.tally(this.scopes, target.scope, now);
    // was the scope tripped before this call? — the open that follows the
    // cooldown is the probe, and only the probe
    const halfOpened = tally.trippedUntil > 0;
    this.refuseRefusedScope(target.scope, tally, now);
    this.refuseBusyPeer(target, now);
    this.refuseOverBudget(target.scope, tally, now);
    tally.pending += 1;
    // the window the charge was counted in — a rolled window already
    // wrote this charge off, so resolve() checks it before freeing
    const since = tally.since;
    let peerTally: Tally | undefined;
    let peerSince = 0;
    if (target.peer !== undefined) {
      peerTally = this.tally(this.peers, target.peer, now);
      peerTally.pending += 1;
      peerSince = peerTally.since;
    }
    // the scope was tripped a moment ago — this open IS the probe
    if (halfOpened) {
      tally.probeInFlight = true;
    }
    this.prune(this.scopes, now);
    this.prune(this.peers, now);
    let resolved = false;
    return {
      resolve: () => {
        if (resolved) {
          return;
        }
        resolved = true;
        // the window this charge was counted in rolled — the reset
        // already wrote it off; freeing it now would hide a NEWER
        // session's open behind this completion
        this.releasePending(tally, since);
        // a completed turn clears the trip outright — a working
        // conversation is never stuck behind a stale refusal
        tally.trippedUntil = 0;
        // the probe answered — the scope is healthy again
        tally.probeInFlight = false;
        if (peerTally !== undefined) {
          this.releasePending(peerTally, peerSince);
        }
      },
    };
  }

  /** One pending count down — only if the window the charge was counted
   *  in is still the current one (a rolled window already wrote it off). */
  private releasePending(tally: Tally, since: number): void {
    if (tally.since !== since) {
      return;
    }
    if (tally.pending === 0) {
      return;
    }
    tally.pending -= 1;
  }

  /** The scope is refused — the cooldown has not expired yet, or the
   *  half-open probe has not answered. The refusal costs no session:
   *  the scope is reset to half-open BEFORE the probe is counted. */
  private refuseRefusedScope(scope: string, tally: Tally, now: number): void {
    if (tally.trippedUntil > now) {
      throw new AcpDeadLoopError({ scope, opens: tally.pending, budget: this.maxOpens });
    }
    if (tally.trippedUntil > 0) {
      // the cooldown expired — the burst that tripped the scope is stale.
      // The scope is half-open now: exactly ONE probe gets through, and
      // its completion clears the trip (a failure never answers, so the
      // scope stays half-open until the next cooldown).
      tally.trippedUntil = 0;
      tally.pending = 0;
      tally.probeInFlight = false;
    }
    if (tally.probeInFlight) {
      // the probe has not answered — no second open. A half-open scope
      // admits one open per cooldown, not a fresh budget.
      throw new AcpDeadLoopError({
        scope,
        opens: tally.pending,
        budget: this.maxOpens,
        reason: 'the half-open probe has not answered, no session was opened',
      });
    }
  }

  /** The peer's churn is systemic — the loop may live inside the child.
   *  Checked BEFORE anything is counted: a refused open opens nothing. */
  private refuseBusyPeer(target: AcpTarget, now: number): void {
    if (target.peer === undefined) {
      return;
    }
    const peerTally = this.tally(this.peers, target.peer, now);
    if (peerTally.pending + 1 > this.maxAbandoned) {
      throw new AcpDeadLoopError({
        scope: target.peer,
        opens: peerTally.pending + 1,
        budget: this.maxAbandoned,
        kind: 'peer',
      });
    }
  }

  /** The open that would cross the scope's budget never happens — the
   *  refusal is the point: no session, no quota. The scope is tripped
   *  until the cooldown ends — a probe is allowed then, and a completed
   *  turn clears the trip outright. */
  private refuseOverBudget(scope: string, tally: Tally, now: number): void {
    if (tally.pending + 1 <= this.maxOpens) {
      return;
    }
    tally.trippedUntil = now + this.cooldownMs;
    throw new AcpDeadLoopError({
      scope,
      opens: tally.pending + 1,
      budget: this.maxOpens,
    });
  }

  /** The peer is gone — its churn died with it. A replacement is a
   *  fresh child: the old child's abandoned sessions are not the new
   *  child's, so the new peer must not be refused for them. */
  forgetPeer(target: AcpTarget): void {
    if (target.peer !== undefined) {
      this.peers.delete(target.peer);
    }
  }

  /** The scope itself is gone — a dropped connection's own key dies
   *  with it (a per-connection scope kept forever leaks one entry per
   *  client that ever connected). Only the scope's own entry is
   *  forgotten: the peer's tally keeps what it counted — those
   *  sessions happened. */
  forgetScope(target: AcpTarget): void {
    this.scopes.delete(target.scope);
  }

  /** The peer's churn is OVER its budget — the sessions it opened and
   *  never completed. The open's refusal is prospective (the next open
   *  crosses the budget); this reads the state that is already there.
   *  False while the peer is healthy. */
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

  /** The tallies are keyed by client-supplied scopes — they must not
   *  grow without bound. The prune drops the entries whose window
   *  closed; it runs only when the map grew past the threshold, so the
   *  hot path stays a map lookup. An entry whose COOLDOWN is still
   *  live survives the prune: the trip owns the refusal past the
   *  window it tripped in, and dropping it would admit the scope with
   *  a fresh budget mid-refusal. */
  private prune(map: Map<string, Tally>, now: number): void {
    if (map.size < PRUNE_AT) {
      return;
    }
    for (const [key, t] of map) {
      if (now - t.since >= this.windowMs && t.trippedUntil <= now) {
        map.delete(key);
      }
    }
  }

  /** The tally for a key, created on first use — a window that expired
   *  starts empty again. */
  private tally(map: Map<string, Tally>, key: string, now: number): Tally {
    const fresh = map.get(key);
    if (fresh === undefined) {
      const created: Tally = { pending: 0, since: now, trippedUntil: 0, probeInFlight: false };
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
      // the probe's window is over — the scope is not half-open anymore
      fresh.probeInFlight = false;
    }
    return fresh;
  }
}

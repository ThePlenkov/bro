/**
 * The gateway's admission — what stands between a burst of client
 * requests and the provider's limits (spec bro-9j4kt).
 *
 * The gateway is a LiteLLM-shaped front door: any client may fire any
 * number of requests at any model at any moment. The provider behind it
 * is NOT shaped that way — devin runs a bounded number of agent sessions
 * and meters them per account. Something has to translate the first
 * shape into the second, and the gateway is the only place that can.
 *
 * Three layers, in the order a request meets them:
 *
 *  1. THE CONVERSATION QUEUE (acpx's per-session queue). One turn per
 *     conversation at a time: a second request on the same conversation
 *     WAITS for the first instead of opening a twin session. The
 *     reference implementation (openclaw/acpx) serializes the prompts of
 *     one session through a queue owner; the gateway does the same
 *     in-process, and the waiting request then continues the SAME
 *     session — a delta turn, not a fresh session with the history
 *     re-sent.
 *  2. THE SESSION BUDGET — how many live ACP sessions the lane may hold.
 *     Every turn that opens a session takes one; a retained
 *     conversation keeps it. The provider's parallel-session wall is
 *     what a burst walks into, so the cap turns a burst into a paced
 *     stream: an idle session is recycled (LRU) to make room, and only
 *     when every session is busy does a request wait.
 *  3. THE REQUEST BUDGET — a token bucket per `<lane>/<model>`, the SAME
 *     host ledger the fleet's spawns charge (spec bro-y3jvd). The
 *     gateway and the batch workers draw one account's budget instead of
 *     two independent ones.
 *
 * Every limit is CONFIG (bro.config.json `serve.limits.<entry>`): an
 * absent knob means unbounded, never a guessed default. The refusals
 * are honest — a 429 with the real wait, not a fixed guess.
 */
import { laneGateTake, type LaneRateGate } from '@broject/core';

/** One lane's limits — the knobs of the admission. */
export interface LaneAdmissionLimits {
  /** how many live ACP sessions the lane may hold */
  maxSessions?: number;
  /** how many requests may WAIT for a session (0 = no queue: refuse) */
  maxQueue?: number;
  /** the request budget per hour */
  requestsPerHour?: number;
  /** the bucket's burst capacity (defaults to the hourly budget) */
  burst?: number;
  /** the bucket's lane half — two entries on one account draw one
   *  budget when they name the same lane */
  lane?: string;
}

/** A refusal — the request never reached the provider. The wire shape
 *  is a 429 with the real wait; the message says which limit spoke. */
export class RateRefused extends Error {
  /** how long until the lane can take the request — the client's
   *  Retry-After. */
  readonly retryAfterSec: number;

  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'RateRefused';
    this.retryAfterSec = retryAfterSec;
  }
}

/** The bucket's model half — the BARE model id, without the route
 *  prefix. The fleet's ledger keys the model the same way, so a fleet
 *  spawn and a gateway turn on the same model draw one bucket. */
export function bucketModel(model: string): string {
  const cut = model.indexOf('/');
  return cut > 0 ? model.slice(cut + 1) : model;
}

/** One granted session slot — the turn's end.
 *
 *  A turn that opens a session either RETAINS it (the conversation
 *  lives on in the lane's map — the slot is handed over) or lets it go
 *  (a one-shot, a failed open — the slot goes back to the lane). */
export interface SessionSlot {
  /** the session lives on in the lane's map — the slot is handed over */
  promote: () => void;
  /** the turn ended without a living session — the slot goes back */
  release: () => void;
}

/** A waiter for a free session slot. */
interface Waiter {
  grant: () => void;
  fail: (err: Error) => void;
}

/** The lane's admission — the session budget, the queue and the request
 *  budget. */
export class LaneAdmission {
  /** the turns in flight that hold a session slot */
  private inflight = 0;
  /** the requests waiting for a slot, in arrival order */
  private readonly waiters: Waiter[] = [];

  constructor(
    /** the lane's name — the bucket's lane half (unless the limits name
     *  their own) */
    private readonly lane: string,
    private readonly limits: LaneAdmissionLimits | undefined,
    /** the lane's RETAINED sessions — the ones a conversation keeps
     *  alive between its turns */
    private readonly retained: () => number,
    /** free the coldest idle session — true when one was freed */
    private readonly evictIdle: () => boolean,
    /** the bucket's ledger dir — the host-shared one by default, a test
     *  dir when a test pins it */
    private readonly bucketDir?: string
  ) {}

  /** the live sessions right now: the retained ones plus the turns in
   *  flight that hold a slot */
  get live(): number {
    return this.retained() + this.inflight;
  }

  /** how many requests wait for a slot */
  get queued(): number {
    return this.waiters.length;
  }

  /** Take a session slot for a turn that OPENS a session, or wait for
   *  one to free up.
   *
   *  The slot is the PROVIDER's parallel-session wall: a turn that
   *  continues an existing conversation needs no slot (its session is
   *  already counted), so only a turn that opens one comes here.
   *
   *  The returned release is the turn's end: call it when the turn
   *  settles, whatever the outcome. */
  async acquireSession(opts: {
    /** the client's abort signal — a waiter that is cancelled leaves the
     *  queue */
    signal: AbortSignal;
    /** the wait budget — the request may not queue past it */
    waitDeadline: number;
  }): Promise<SessionSlot> {
    const max = this.limits?.maxSessions;
    if (max === undefined) {
      // no cap — the request budget alone guards the lane
      this.inflight++;
      return this.slot();
    }
    if (this.admit(max)) return this.slot();
    const queueMax = this.limits?.maxQueue ?? 0;
    if (this.waiters.length >= queueMax) {
      throw new RateRefused(
        `lane '${this.lane}' is at its rate limit — ${max} live session(s) and the queue is full ` +
          `(maxQueue ${queueMax}); retry shortly`,
        1
      );
    }
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          resolve();
        },
        fail: err => {
          cleanup();
          reject(err);
        },
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
      };
      const onAbort = (): void => {
        waiter.fail(
          new Error('bro conductor: the request was cancelled while waiting for a free session slot')
        );
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      const remaining = opts.waitDeadline - Date.now();
      if (remaining <= 0) {
        waiter.fail(new Error('bro conductor: timed out waiting for a free session slot on the lane'));
        return;
      }
      timer = setTimeout(() => {
        waiter.fail(new Error('bro conductor: timed out waiting for a free session slot on the lane'));
      }, remaining);
      timer.unref?.();
      this.waiters.push(waiter);
      // a slot may have freed between the check and the enqueue
      this.pump(max);
    });
    return this.slot();
  }

  /** Charge the request budget — one token per request. The bucket is
   *  the host ledger the fleet charges too, so the two draw one
   *  account's budget. */
  charge(model: string): void {
    const requestsPerHour = this.limits?.requestsPerHour;
    if (requestsPerHour === undefined) return;
    const lane = this.limits?.lane ?? this.lane;
    const gate: LaneRateGate = {
      requestsPerHour,
      // one request, one token — the bucket's unit is requests
      spawnCost: 1,
      ...(this.limits?.burst === undefined ? {} : { burst: this.limits.burst }),
    };
    const take = laneGateTake(lane, bucketModel(model), gate, {
      ...(this.bucketDir === undefined ? {} : { dir: this.bucketDir }),
    });
    if (!take.ok) {
      throw new RateRefused(
        `lane '${lane}' is at its rate limit — out of request budget (${bucketModel(model)}) — ` +
          `${requestsPerHour} req/h; retry in ~${take.retryAfterSec}s`,
        take.retryAfterSec
      );
    }
  }

  /** A session became free (a turn ended) — wake the waiters. */
  notify(): void {
    const max = this.limits?.maxSessions;
    if (max === undefined) return;
    this.pump(max);
  }

  /** Try to take a slot outright: a free slot, or an idle session
   *  recycled to make one. */
  private admit(max: number): boolean {
    if (this.live < max) {
      this.inflight++;
      return true;
    }
    // the lane is full — recycle the coldest IDLE session (a busy one
    // is mid-turn: its handle must not be dropped under it)
    if (this.evictIdle()) {
      this.inflight++;
      return true;
    }
    return false;
  }

  /** Hand freed slots to the waiters, in arrival order. */
  private pump(max: number): void {
    while (this.waiters.length > 0 && this.admit(max)) {
      const waiter = this.waiters.shift();
      waiter?.grant();
    }
  }

  /** One granted slot — the turn's end. */
  private slot(): SessionSlot {
    let promoted = false;
    let released = false;
    const give = (): void => {
      this.inflight = Math.max(0, this.inflight - 1);
      this.notify();
    };
    return {
      /** the turn opened a session that LIVES on (a retained
       *  conversation): the lane's map counts it from now on, so the
       *  slot is handed over rather than given back */
      promote: () => {
        if (promoted || released) return;
        promoted = true;
        give();
      },
      /** the turn ended without a living session (a one-shot, a failed
       *  open): the slot goes back to the lane */
      release: () => {
        if (released) return;
        released = true;
        if (promoted) return;
        give();
      },
    };
  }
}

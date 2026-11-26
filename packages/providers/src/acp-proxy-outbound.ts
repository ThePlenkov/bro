import type { AnyMessage } from '@agentclientprotocol/sdk';
import { ACP_PROXY_WRITE_HIGH_WATER, latch } from './acp-proxy-types.ts';

export interface Outbound {
  /** Issue a wire write in order. The returned promise settles only after
   *  the sink accepts the message, so the ledger can use the sink's actual
   *  backpressure rather than merely counting calls to write(). A leg
   *  already declared dead accepts nothing — its queued writes abandon at
   *  teardown either way, and a peer that resumes mid-close must never
   *  execute work its callers already lost. */
  send(m: AnyMessage): Promise<void>;
  /** Charge one accepted-but-unwritten slot against the bound —
   *  returns the idempotent release, which the caller runs when its
   *  write issues (the write's own depth takes the slot over) or the
   *  work dies unrouted. */
  hold(): () => void;
  /** Synchronous room check — the pump's fast path. */
  spare(): boolean;
  /** Resolves once the ledger drops below the high-water mark —
   *  or immediately when the leg is already dead: a stalled leg's
   *  verdict belongs to the teardown race, never a sleeping pump. */
  room(): Promise<void>;
  /** Resolves on the leg's NEXT write settle — FIFO one-shot: each
   *  caller's wait ends on exactly one settle, in the order writes
   *  land. The intake bypass count decays on it — a bypassed
   *  control's charge is ordinary depth once its write issues, so
   *  holding the charge until room() returns would park the read
   *  behind ledger holds the bypass no longer represents. A dead
   *  leg releases every waiter. */
  nextSettle(): Promise<void>;
  /** The last write progress — teardown's close grace resets on it. */
  lastProgressAt(): number;
}

export const outbound = (
  writer: WritableStreamDefaultWriter<AnyMessage>,
  dead: ReturnType<typeof latch>,
  stallMs: number
): Outbound => {
  let depth = 0;
  let holds = 0;
  let lastProgress = Date.now();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Set<() => void>();
  const settleWaiters: Array<() => void> = [];
  const full = (): boolean => !dead.fired && depth + holds >= ACP_PROXY_WRITE_HIGH_WATER;
  const release = (): void => {
    for (const w of waiters) w();
    waiters.clear();
  };
  const disarm = (): void => {
    if (stall !== undefined) {
      clearTimeout(stall);
      stall = undefined;
    }
  };
  /** The stall bound lives only while depth is nonzero — a leg with
   *  unsettled writes but no settle for stallMs is dead (the peer
   *  stopped reading); any settle is progress and moves the deadline.
   *  ONE deadline rearmed from the last progress — not an interval:
   *  an interval's tick alignment lets silence run nearly a whole
   *  extra period past the mark before a tick even looks. And not a
   *  per-write deadline: under a healthy flood each write settles
   *  behind the queue, so the deadline rides the LAST progress and a
   *  busy leg only pushes it out. Holds never arm it —
   *  accepted-but-unwritten work is not evidence the peer stopped
   *  reading. */
  const rearm = (): void => {
    if (dead.fired || depth === 0) {
      return;
    }
    if (stall !== undefined) {
      clearTimeout(stall);
      stall = undefined;
    }
    stall = setTimeout(
      () => {
        stall = undefined;
        if (dead.fired || depth === 0) {
          return;
        }
        if (Date.now() - lastProgress >= stallMs) {
          dead.fire();
        } else {
          rearm(); // the clock moved backwards — measure the remainder
        }
      },
      Math.max(stallMs - (Date.now() - lastProgress), 1)
    );
    stall.unref();
  };
  const arm = (): void => {
    if (stall !== undefined || dead.fired || depth === 0) {
      return;
    }
    lastProgress = Date.now();
    rearm();
  };
  // a dead leg releases every waiter and never measures stalls again
  void dead.promise.then(() => {
    disarm();
    release();
    for (const w of settleWaiters.splice(0)) {
      w();
    }
  });
  const settled = (): void => {
    depth--;
    lastProgress = Date.now();
    if (depth === 0) {
      disarm();
    } else {
      rearm();
    }
    settleWaiters.shift()?.();
    if (!full()) {
      release();
    }
  };
  return {
    async send(m): Promise<void> {
      if (dead.fired) {
        return;
      }
      depth++;
      arm();
      try {
        await writer.write(m);
      } catch {
        dead.fire();
      } finally {
        settled();
      }
    },
    hold() {
      holds++;
      let freed = false;
      return () => {
        if (freed) {
          return;
        }
        freed = true;
        holds--;
        if (!full()) {
          release();
        }
      };
    },
    nextSettle() {
      // pends even with depth 0 — the caller's own write is usually
      // the settle it waits for; a dead leg drains every waiter
      return dead.fired
        ? Promise.resolve()
        : new Promise<void>(r => {
            settleWaiters.push(r);
          });
    },
    spare() {
      return !full();
    },
    room() {
      return !full()
        ? Promise.resolve()
        : new Promise<void>(r => {
            waiters.add(r);
          });
    },
    lastProgressAt() {
      return lastProgress;
    },
  };
};

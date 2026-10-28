/**
 * EventSource — the reconcile loop's only contract with "when to run".
 * An EventSource yields Planes snapshots; `converge()` consumes them
 * identically no matter what produced them. Swapping the source changes
 * the trigger, never the convergence (spec bro-762eh).
 */
import { diffKey, readPlanes, type Planes } from './planes.ts';

export interface EventSource extends AsyncIterable<Planes> {}

/** v1: poll. Re-reads the planes every `everyMs` and yields a snapshot
 *  when the diff-key moved — plus every FORCE_EVERYth tick regardless:
 *  a pass that half-failed (a refused `worktree open`, a dropped split)
 *  leaves the key unchanged, so without the heartbeat yield it would
 *  never be retried. A quiet rig still costs almost nothing. */
const FORCE_EVERY = 4;

export class PollSource implements EventSource {
  private readonly repo: string;
  private readonly everyMs: number;

  // no parameter properties — node runs these files with strip-only
  // type handling, where they are a syntax error
  constructor(repo: string, everyMs: number = 30_000) {
    this.repo = repo;
    this.everyMs = everyMs;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Planes, void> {
    let last = '';
    let tick = 0;
    for (;;) {
      const snap = readPlanes(this.repo);
      const key = diffKey(snap);
      tick += 1;
      if (key !== last || tick % FORCE_EVERY === 0) {
        last = key;
        yield snap;
      }
      await new Promise(r => setTimeout(r, this.everyMs));
    }
  }
}

/** Seam for a future push feed over bro's event plane. When a live
 *  feed lands it implements EventSource — the sync loop swaps
 *  `new PollSource(...)` for it and stops polling; converge() is
 *  untouched. No implementation ships in v1 and no transport is named
 *  here on purpose — the feed's mechanics are its own. */
export interface LiveSource extends EventSource {}

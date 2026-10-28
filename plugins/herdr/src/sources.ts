/**
 * EventSource — the reconcile loop's only contract with "when to run".
 * An EventSource yields Planes snapshots; `converge()` consumes them
 * identically no matter what produced them. Swapping the source changes
 * the trigger, never the convergence (spec bro-762eh).
 */
import { diffKey, readPlanes, type Planes } from './planes.ts';

export interface EventSource extends AsyncIterable<Planes> {}

/** v1: poll. Re-reads the planes every `everyMs` and yields a snapshot
 *  only when the diff-key moved — a quiet rig costs nothing, a moving
 *  rig gets a pass as fast as the tick allows. */
export class PollSource implements EventSource {
  constructor(
    private readonly repo: string,
    private readonly everyMs: number = 30_000
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Planes, void> {
    let last = '';
    for (;;) {
      const snap = readPlanes(this.repo);
      const key = diffKey(snap);
      if (key !== last) {
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

/**
 * The reconcile loop as a herdr-managed pane — a plugin daemon that
 * lives and dies with the server (no detached background process, per
 * plugin rules). The loop is `for await planes of source → converge`:
 * v1's source is PollSource (diff on a tick); when a live feed lands it
 * plugs into the LiveSource seam and this file changes on one line —
 * the `new PollSource(...)` below — nothing else.
 * Interval: BRO_SYNC_EVERY_S env or 30s.
 */
import { converge } from './reconcile.ts';
import { ctxJson, repoDir } from './lib.ts';
import { PollSource, type EventSource } from './sources.ts';

const requested = Number(process.env.BRO_SYNC_EVERY_S ?? 30);
const EVERY_MS = Math.max(5, Number.isFinite(requested) ? requested : 30) * 1000;

const repo = repoDir(ctxJson());
const source: EventSource = new PollSource(repo, EVERY_MS);

console.log(`bro sync loop — PollSource every ${EVERY_MS / 1000}s (close the pane to stop)`);
for await (const planes of source) {
  try {
    const r = converge(planes);
    console.log(`[${new Date().toISOString()}] pass ok — ${r.armed} armed, ${r.mirrors} mirrors`);
  } catch (err) {
    console.log(
      `[${new Date().toISOString()}] pass failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

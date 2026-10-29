/**
 * The reconcile loop as a herdr-managed pane — a plugin daemon that
 * lives and dies with the server (no detached background process, per
 * plugin rules). The loop is `for await planes of source → converge`:
 * the source is LiveSource (bus-event-woken polling); `BRO_SYNC_SOURCE=poll`
 * pins v1's PollSource verbatim for debugging or rigs that must not
 * spawn a tail child. Interval: BRO_SYNC_EVERY_S env or 30s.
 */

import { ctxJson, repoDir } from './lib.ts';
import { converge } from './reconcile.ts';
import { type EventSource, LiveSource, PollSource } from './sources.ts';

const requested = Number(process.env.BRO_SYNC_EVERY_S ?? 30);
const EVERY_MS = Math.max(5, Number.isFinite(requested) ? requested : 30) * 1000;

const repo = repoDir(ctxJson());
const source: EventSource =
  process.env.BRO_SYNC_SOURCE === 'poll'
    ? new PollSource(repo, EVERY_MS)
    : new LiveSource(repo, EVERY_MS);

console.log(
  `bro sync loop — ${process.env.BRO_SYNC_SOURCE === 'poll' ? 'PollSource' : 'LiveSource'} every ${EVERY_MS / 1000}s (close the pane to stop)`
);
for await (const planes of source) {
  try {
    const r = converge(planes);
    console.log(
      `[${new Date().toISOString()}] pass ok — ${r.armed} armed, ${r.mirrors} mirrors, ${r.renderers} renderers, ${r.reaped} reaped`
    );
  } catch (err) {
    console.log(
      `[${new Date().toISOString()}] pass failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

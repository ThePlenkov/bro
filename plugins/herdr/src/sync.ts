/**
 * The reconcile loop as a DETACHED plugin daemon — spawned by
 * `ensureSyncLoop` (`node src/sync.ts`, unref'd), never a pane
 * (user ruling 10.11: plumbing does not take a human's screen).
 * The loop is `for await planes of source → converge`: the source is
 * LiveSource (bus-event-woken polling); `BRO_SYNC_SOURCE=poll` pins
 * v1's PollSource verbatim for debugging or rigs that must not spawn
 * a tail child. Interval: BRO_SYNC_EVERY_S env or 30s. The loop dies
 * with its server: a herdr probe failing twice in a row exits the
 * process, so a dead server never strands a detached orphan.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { procStat } from '../../../packages/core/src/proc.ts';
import { ctxJson, herdrOk, repoDir, STATE_DIR, stateScope, syncPidPath } from './lib.ts';
import { converge } from './reconcile.ts';
import { type EventSource, LiveSource, PollSource } from './sources.ts';

const requested = Number(process.env.BRO_SYNC_EVERY_S ?? 30);
const EVERY_MS = Math.max(5, Number.isFinite(requested) ? requested : 30) * 1000;

const repo = repoDir(ctxJson());

// publish our pid + /proc starttime — the ensure-probe in reconcile.ts
// reads this file, so a launcher that rewrites argv (absolute path,
// non-node runtime) still counts as a live loop instead of a missing
// one, and a pid the kernel recycled is never mistaken for this loop.
// The write is advisory: a loop that cannot publish still reconciles —
// the ensure path just loses dedup for the pass
try {
  mkdirSync(STATE_DIR, { recursive: true });
  const start = procStat(process.pid)?.start;
  const stamp = start !== undefined && start !== '' ? ` ${start}` : '';
  writeFileSync(syncPidPath(stateScope(repo)), `${process.pid}${stamp}\n`);
} catch {
  console.log('bro sync — pid marker write failed; open-dedup degraded this pass');
}
const source: EventSource =
  process.env.BRO_SYNC_SOURCE === 'poll'
    ? new PollSource(repo, EVERY_MS)
    : new LiveSource(repo, EVERY_MS);

console.log(
  `bro sync loop — ${process.env.BRO_SYNC_SOURCE === 'poll' ? 'PollSource' : 'LiveSource'} every ${EVERY_MS / 1000}s (detached; dies with the server)`
);

// the server-death probe — a detached loop must not outlive the
// server it reconciles for. Two consecutive `workspace list` failures
// (~60s of dead herdr) end the process; a transient CLI hiccup does
// not, and the ensure path respawns the loop on the next hook anyway
let dead = 0;
for await (const planes of source) {
  if (herdrOk(['workspace', 'list'])) {
    dead = 0;
  } else if (++dead >= 2) {
    console.log(`[${new Date().toISOString()}] herdr unreachable twice — exiting`);
    break;
  }
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

/**
 * The act connector — the review-gate capability's contribution to the
 * agent lifecycle: the current PR's gate state at session start, a PR
 * URL in a prompt → its gate snapshot, and the stop-gate blocker when
 * the session armed 'act'. All host access goes through the resolved
 * ReviewFacade; this connector owns no vendor calls.
 */
import { loadConfig, reviewHost, spawnSelf, type Connector, type PrTarget } from '@broject/core';
import { checkHistory } from './check-history.ts';
import { evaluateExitGate } from './exit-gate.ts';
import { mergeSlotHolderAsync } from './merge-slot.ts';
import {
  hasLiveWatchAsync,
  listWatchesAsync,
  watchMarkerKind,
  watchRetire,
  type ListedWatch,
} from './pending-watch.ts';
import { cachedPrActState, fetchPrActState } from './state.ts';
import { prStateCache } from './state-cache.ts';

/** The bound-dir PR — async when the host has the twin, else a resolved
 *  sync call (a facade without currentPrAsync still answers, just not
 *  non-blocking). */
const currentPr = (rev: ReturnType<typeof reviewHost>) =>
  rev.currentPrAsync === undefined ? Promise.resolve(rev.currentPr()) : rev.currentPrAsync();

const resolvedRepo = (rev: ReturnType<typeof reviewHost>) =>
  rev.resolveRepoAsync === undefined
    ? Promise.resolve(rev.resolveRepo([]))
    : rev.resolveRepoAsync([]);

/** One-line gate summary for a PR — null when no PR/host resolves. */
async function gateLine(dir: string, target?: PrTarget): Promise<string | null> {
  try {
    const cfg = loadConfig(dir);
    const rev = reviewHost(dir, cfg.connectors);
    let t = target;
    if (!t) {
      const cur = await currentPr(rev);
      if (!cur || cur.state !== 'OPEN') {
        return null;
      }
      t = { repo: await resolvedRepo(rev), pr: cur.pr };
    }
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: cfg.act.ignoreChecks,
      checkHistory: checkHistory(dir),
      maxRounds: cfg.act.maxRounds,
      docsPaths: cfg.act.docsPaths,
      docsMaxRounds: cfg.act.docsMaxRounds,
      requireApproval: cfg.act.requireApproval,
      approvers: cfg.act.approvers,
      // the feed serves most probes; lockWaitMs 0 keeps a budgeted hook
      // from ever queuing behind a peer's in-flight fetch
      stateCache: prStateCache(dir, { lockWaitMs: 0 }),
    });
    const gate = evaluateExitGate(state, { requireApproval: cfg.act.requireApproval });
    const link = rev.prLink(t.repo, state.pr);
    const alertSuffix = gate.alerts.length === 0 ? '' : `; alert: ${gate.alerts.join('; ')}`;
    return gate.ok
      ? `pr ${link}: gate OK${alertSuffix}`
      : `pr ${link}: gate BLOCKED (${gate.blockers.join('; ')})${alertSuffix} — \`bro act status\``;
  } catch {
    return null;
  }
}

/** A live watch marker covering `pr` — any mode counts (the agent chose
 *  merge or watch-only deliberately); a dead-pid marker is unwatched by
 *  definition. `null` (store unreadable) is fail-open: a gate must never
 *  fabricate a block on a probe failure. */
async function watchCover(dir: string, pr: number): Promise<boolean> {
  try {
    return (await hasLiveWatchAsync(dir, pr)) ?? true;
  } catch {
    return true;
  }
}

/** The detach hint every unwatched-PR block shares — a watcher in a
 *  turn-bound shell dies with the turn, so the block points at the
 *  self-detaching form (bro-b16er). */
const armWatch = (pr: number): string =>
  `arm one: \`bro act wait ${pr} --merge --cleanup --detach\` ` +
  '(a watcher in a turn-bound shell dies with the turn); or state ' +
  'the exact open state and stop again';

/** Merge-slot holder line — a session seeing the slot held knows not to
 *  start a merge right now. Fail-open: no beads → no line. */
async function mergeSlotLine(): Promise<string | null> {
  try {
    const holder = await mergeSlotHolderAsync();
    return holder ? `merge slot: held by ${holder} — serialize merges via \`bro act merge\`` : null;
  } catch {
    return null;
  }
}

/** The line a settled watch marker earns at session start — null when
 *  the marker is skipped because the retire claim lost to a racing
 *  session start. */
function staleWatchLine({ watch, file, reported }: ListedWatch): string | null {
  // the retire is an atomic claim — a racing session start already
  // reporting this stale promise loses the rename and skips it. An
  // already-retired marker still re-flags: the claim proves nothing
  // about delivery, so a warning dropped with its session (hook
  // budget, crash) resurfaces until the marker ages out.
  if (reported !== true && !watchRetire(file)) {
    return null;
  }
  if (watch.verdict === 'blocked') {
    // a settled blocked wait is a finding, not a broken promise —
    // name the blockers; a fresh `bro act wait` supersedes it
    const list = (watch.blockers ?? []).join('; ');
    return (
      `act wait on ${watch.link} settled BLOCKED${list === '' ? '' : ` — ${list}`} — ` +
      `\`bro act threads ${watch.pr}\` lists them`
    );
  }
  const mode = watch.merge ? ' (was set to merge on green)' : '';
  const kind = watchMarkerKind(file, watch);
  // a bare `act wait` resurrects through `act rearm`; a supervisor
  // heartbeat belongs to the supervisor's own restart story —
  // pointing a dead drive's marker at rearm would report a recovery
  // that never happens. The recorded merge mode is part of the
  // promise: a supervisor that ran --no-merge (or drive.merge:
  // 'never') restarted bare would merge PRs it only ever watched
  const noMerge = watch.merge ? '' : ' --no-merge';
  const restart = kind === 'loop' ? 'bro loop' : `bro ${kind} --every${noMerge}`;
  return (
    `stale act watch on ${watch.link}${mode} — ` +
    (kind === 'wait'
      ? 'the watching session died; `bro act rearm` resurrects it, '
      : `the '${kind}' supervisor died — restart it (\`${restart}\`); `) +
    `\`bro act status --pr ${watch.pr}\` inspects`
  );
}

/** Pending-watch markers left by `bro act wait`: a dead pid means the
 *  session that promised to watch died mid-poll — flag the stale promise
 *  and retire the marker to claim the report. The claim says nothing
 *  about delivery, so a retired marker keeps re-flagging on later
 *  session starts until it ages out. A live pid is parallel work —
 *  passive context only. */
async function watchLines(dir: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for (const listed of await listWatchesAsync(dir)) {
      if (listed.alive) {
        out.push(
          `act watch active on ${listed.watch.link} (pid ${listed.watch.pid}) — another process is polling`
        );
        continue;
      }
      const line = staleWatchLine(listed);
      if (line !== null) {
        out.push(line);
      }
    }
    return out;
  } catch {
    // detection is passive — a probe failure must not break rehydrate
    return [];
  }
}

export const actConnector: Connector = {
  name: 'act',
  hooks: () => ({
    async sessionStart(ctx) {
      // watch markers first — local fs only, so a slow gate probe that
      // blows the hook budget can't strand a stale-promise report
      const out: string[] = await watchLines(ctx.dir);
      const gate = await gateLine(ctx.dir);
      if (gate) {
        out.push(gate);
      }
      const slot = await mergeSlotLine();
      if (slot) {
        out.push(slot);
      }
      return out;
    },
    async promptSubmit(ctx, prompt) {
      try {
        const t = reviewHost(ctx.dir, loadConfig(ctx.dir).connectors).parsePrRef(prompt);
        const line = t ? await gateLine(ctx.dir, t) : null;
        return line ? [line] : [];
      } catch {
        return [];
      }
    },
    async stopGate(ctx) {
      // the stop path never fetches: resolve the branch PR, read the
      // feed, and let a detached `bro act status` fill a miss
      // (bro-36sx7.4 — the 5-7 call fetch has no budget on a hook)
      try {
        const cfg = loadConfig(ctx.dir);
        const rev = reviewHost(ctx.dir, cfg.connectors);
        const cur = await currentPr(rev);
        if (!cur || cur.state !== 'OPEN') {
          return [];
        }
        const target = { repo: await resolvedRepo(rev), pr: cur.pr };
        const head = `bro: PR [#${cur.pr}](${cur.url})`;
        const cache = prStateCache(ctx.dir, { lockWaitMs: 0 });
        const state = cachedPrActState(cache, target, {
          requireApproval: cfg.act.requireApproval,
          approvers: cfg.act.approvers,
        });
        const watched = await watchCover(ctx.dir, cur.pr);
        if (state === null) {
          // no usable verdict — a miss never fabricates one: the
          // gate's invariant degrades to "verdict known or watcher
          // armed". claimRefresh dedups the spawn and stands down
          // while a peer's fetch holds the feed lock.
          if (cache !== null && cache.claimRefresh(target)) {
            spawnSelf(['act', 'status', '--pr', String(cur.pr)], ctx.dir);
          }
          if (watched) {
            // a poller publishes — nothing for this session
            return [];
          }
          const line = `${head}: gate verdict pending — no live act watch`;
          return [
            {
              aspect: 'act',
              block: `${line} — ${armWatch(cur.pr)}`,
              passive: `${line} (current branch — this session did not touch it)`,
            },
          ];
        }
        // The same gate `bro act status` enforces: open threads,
        // pending/failed CI and AI reviewers, SAST findings, unknown
        // mergeability, BEHIND.
        const gate = evaluateExitGate(state, { requireApproval: cfg.act.requireApproval });
        if (!gate.ok) {
          const line = `${head}: ${gate.blockers.join('; ')}`;
          const watchNote = watched ? 'live act watch' : 'no live act watch';
          return [
            {
              aspect: 'act',
              block:
                `${line} (${watchNote}) — ` +
                'list with `bro act threads` — fix inline or defer to a debt bead ' +
                '(reply + resolve); when fix_rounds exceeds the round cap ' +
                '(act.maxRounds — tighter on docs-only PRs) only defer ' +
                'counts; recheck `bro act status`',
              passive: `${line} (${watchNote}; current branch — this session did not touch it)`,
            },
          ];
        }
        if (watched) {
          return [];
        }
        // green gate is not "done" — a pushed PR ends the turn only
        // while somebody keeps polling it (bro-97lk).
        const line = `${head}: gate OK but no live act watch`;
        return [
          {
            aspect: 'act',
            block: `${line} — ${armWatch(cur.pr)}`,
            passive: `${line} (current branch — this session did not touch it)`,
          },
        ];
      } catch {
        // no repo/PR/auth — nothing to gate on
        return [];
      }
    },
  }),
};

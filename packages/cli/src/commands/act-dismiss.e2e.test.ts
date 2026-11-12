import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  initRepo,
  installFakeHost,
  inside,
  readHostState,
  runCli,
  writeHostState,
} from './testrepo.ts';

/** Repo + fake review host carrying a standing CHANGES_REQUESTED veto —
 *  `act dismiss` clears the STALE entries through the real connector
 *  path (facade → command → host.json mutation). */
function fixture() {
  const { root, main } = initRepo('bro-act-dismiss-');
  const { state } = installFakeHost(main);
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
    })
  );
  return { root, main, state };
}

const STALE_VETO = {
  id: 'PRR_stale',
  author: 'kody-ai',
  submittedAt: '2026-01-01T00:00:00Z',
  commitSha: 'abc123',
  threads: 2,
  stale: true,
};
const LIVE_VETO = { ...STALE_VETO, id: 'PRR_live', author: 'bob', stale: false };

const seedVeto = (state: string, vetoes: unknown[], decision = 'CHANGES_REQUESTED') =>
  writeHostState(state, {
    prState: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    reviewDecision: decision,
    vetoReviews: vetoes,
  });

describe('act dismiss — stale veto reviews (bro-n1foa)', () => {
  test('status names the veto split; dismiss clears the stale review and unblocks', () => {
    const { root, main, state } = fixture();
    inside(main, root, () => {
      seedVeto(state, [STALE_VETO, LIVE_VETO]);
      // the gate blocks on the host veto even at open_threads=0 — and
      // the blocker carries the stale/live split the probe enumerated
      const before = runCli(['act', 'status', '7'], { cwd: main });
      assert.equal(before.code, 1, before.stderr);
      assert.match(before.stdout, /review_decision=CHANGES_REQUESTED/);
      assert.match(before.stdout, /1 stale veto\(s\) by kody-ai/);
      assert.match(before.stdout, /1 live veto\(s\) by bob/);
      assert.match(before.stdout, /veto: kody-ai review PRR_stale — stale/);
      assert.match(before.stdout, /veto: .* review PRR_live — live/);

      // dry-run lists the candidate without touching the host
      const dry = runCli(['act', 'dismiss', '7', '--dry-run'], { cwd: main });
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /would dismiss kody-ai's review PRR_stale/);
      assert.doesNotMatch(dry.stdout, /PRR_live/);
      assert.equal(readHostState(state).dismissals, undefined);

      // the real run dismisses only the stale veto — the live one is
      // refused by construction, never by a forgotten flag
      const done = runCli(['act', 'dismiss', '7'], { cwd: main });
      assert.equal(done.code, 0, done.stderr);
      assert.match(done.stdout, /act: dismissed kody-ai's review PRR_stale/);
      const after = readHostState(state);
      assert.deepEqual(after.dismissals, [
        {
          pr: 7,
          review: 'PRR_stale',
          message: 'stale review — all referenced threads resolved (bro act dismiss)',
        },
      ]);
      // the surviving live veto keeps the gate blocked — dismissal of
      // the stale half changed nothing about bob's standing objection
      assert.deepEqual(after.vetoReviews, [LIVE_VETO]);
    });
  });

  test('a PR whose vetoes are all stale clears the decision and the gate goes green', () => {
    const { root, main, state } = fixture();
    inside(main, root, () => {
      seedVeto(state, [STALE_VETO]);
      const done = runCli(['act', 'dismiss', '7'], { cwd: main });
      assert.equal(done.code, 0, done.stderr);
      const after = readHostState(state);
      assert.deepEqual(after.vetoReviews, []);
      // the fake host mirrors the real one: the last veto lifting moves
      // reviewDecision off CHANGES_REQUESTED
      assert.equal(after.reviewDecision, 'REVIEW_REQUIRED');
      const status = runCli(['act', 'status', '7'], { cwd: main });
      assert.equal(status.code, 0, status.stderr + status.stdout);
      assert.match(status.stdout, /exit_gate=OK/);
    });
  });

  test('live vetoes only — nothing to dismiss, exit 0 with the honest answer', () => {
    const { root, main, state } = fixture();
    inside(main, root, () => {
      seedVeto(state, [LIVE_VETO]);
      const r = runCli(['act', 'dismiss', '7'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /1 veto\(s\) stand but none are stale — wait for re-review/);
      assert.equal(readHostState(state).dismissals, undefined);
    });
  });

  test('no standing veto — the command reports it and exits 0', () => {
    const { root, main, state } = fixture();
    inside(main, root, () => {
      seedVeto(state, [], 'APPROVED');
      const r = runCli(['act', 'dismiss', '7'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /no standing veto reviews/);
    });
  });

  test('--message overrides the dismissal note the host records', () => {
    const { root, main, state } = fixture();
    inside(main, root, () => {
      seedVeto(state, [STALE_VETO]);
      const r = runCli(['act', 'dismiss', '7', '--message', 'objection settled upstream'], {
        cwd: main,
      });
      assert.equal(r.code, 0, r.stderr);
      const after = readHostState(state);
      assert.equal(
        (after.dismissals as Array<{ message: string }>)[0]!.message,
        'objection settled upstream'
      );
    });
  });
});

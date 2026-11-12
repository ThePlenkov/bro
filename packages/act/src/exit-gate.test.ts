import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateExitGate } from './exit-gate.ts';
import { openActState as open } from './act-fixtures.ts';

describe('evaluateExitGate', () => {
  it('passes a clean open PR', () => {
    assert.equal(evaluateExitGate(open()).ok, true);
  });

  it('blocks on a reopened thread — resolved before, commented on again', () => {
    const g = evaluateExitGate(
      open({
        reopenedThreads: [
          {
            id: 't1',
            author: 'bob',
            reopenedAt: '2026-10-02T10:00:00Z',
            reason: 'thread was resolved before and is open again',
          },
        ],
      })
    );
    assert.equal(g.ok, false);
    assert.equal(g.reopened_threads, 1);
    assert.match(g.blockers[0]!, /reopened thread t1/);
    assert.match(g.blockers[0]!, /bob/);
  });

  it('does not block when no thread was reopened', () => {
    const g = evaluateExitGate(open({ reopenedThreads: [] }));
    assert.equal(g.ok, true);
    assert.equal(g.reopened_threads, 0);
  });

  it('blocks on open threads and pending/failing checks', () => {
    const g = evaluateExitGate(open({ openThreads: 2, ciPending: 1, ciFailing: 1 }));
    assert.equal(g.ok, false);
    assert.deepEqual(g.blockers, [
      '2 unresolved review thread(s)',
      '1 pending check(s)',
      '1 failing check(s)',
    ]);
  });

  it('blocks on pending but not failed AI reviewers', () => {
    assert.equal(evaluateExitGate(open({ reviewersPending: 1 })).ok, false);
    // a failed reviewer check is infra noise — its findings (if any)
    // arrive as threads, which block on their own
    const g = evaluateExitGate(open({ reviewersFailing: 2 }));
    assert.equal(g.ok, true);
    assert.equal(g.reviewers_failing, 2);
  });

  it('blocks on SAST findings, conflicts, drafts, unknown mergeability', () => {
    assert.equal(evaluateExitGate(open({ sastPending: 1 })).ok, false);
    assert.equal(evaluateExitGate(open({ sastUnknown: 1 })).ok, false);
    assert.equal(evaluateExitGate(open({ mergeable: 'CONFLICTING' })).ok, false);
    assert.equal(evaluateExitGate(open({ mergeable: 'UNKNOWN' })).ok, false);
    assert.equal(evaluateExitGate(open({ mergeState: 'BEHIND' })).ok, false);
    assert.equal(evaluateExitGate(open({ isDraft: true })).ok, false);
  });

  it('blocks on a standing CHANGES_REQUESTED review decision', () => {
    // bro-n1foa — #931: all threads resolved yet gh refused the merge;
    // the host veto is a third axis beside threads and checks
    const g = evaluateExitGate(open({ reviewDecision: 'CHANGES_REQUESTED', openThreads: 0 }));
    assert.equal(g.ok, false);
    assert.match(g.blockers[0]!, /CHANGES_REQUESTED/);
    // APPROVED, REVIEW_REQUIRED and a missing decision never block
    assert.equal(evaluateExitGate(open({ reviewDecision: 'APPROVED' })).ok, true);
    assert.equal(evaluateExitGate(open({ reviewDecision: 'REVIEW_REQUIRED' })).ok, true);
    assert.equal(evaluateExitGate(open()).ok, true);
  });

  it('names the stale/live veto split when the probe enumerated it', () => {
    // a stale veto is one `bro act dismiss` away; a live one waits on
    // re-review — the blocker carries both halves when both stand
    const staleOnly = evaluateExitGate(
      open({
        reviewDecision: 'CHANGES_REQUESTED',
        vetoReviews: [
          {
            id: 'PRR_1',
            author: 'kody-ai',
            submittedAt: '2026-10-01T00:00:00Z',
            commitSha: 'b'.repeat(40),
            threads: 15,
            stale: true,
          },
        ],
      })
    );
    assert.equal(staleOnly.ok, false);
    assert.match(staleOnly.blockers[0]!, /1 stale veto\(s\) by kody-ai/);
    assert.match(staleOnly.blockers[0]!, /bro act dismiss 1/);
    const liveOnly = evaluateExitGate(
      open({
        reviewDecision: 'CHANGES_REQUESTED',
        vetoReviews: [
          {
            id: 'PRR_2',
            author: 'bob',
            submittedAt: '2026-10-01T00:00:00Z',
            commitSha: 'b'.repeat(40),
            threads: 2,
            stale: false,
          },
        ],
      })
    );
    assert.match(liveOnly.blockers[0]!, /1 live veto\(s\) by bob — wait for re-review/);
    assert.doesNotMatch(liveOnly.blockers[0]!, /act dismiss/);
    const mixed = evaluateExitGate(
      open({
        reviewDecision: 'CHANGES_REQUESTED',
        vetoReviews: [
          {
            id: 'PRR_1',
            author: 'kody-ai',
            submittedAt: '2026-10-01T00:00:00Z',
            commitSha: 'b'.repeat(40),
            threads: 15,
            stale: true,
          },
          {
            id: 'PRR_2',
            author: 'bob',
            submittedAt: '2026-10-01T00:00:00Z',
            commitSha: 'b'.repeat(40),
            threads: 2,
            stale: false,
          },
        ],
      })
    );
    assert.match(mixed.blockers[0]!, /stale veto\(s\) by kody-ai/);
    assert.match(mixed.blockers[0]!, /live veto\(s\) by bob/);
    // an enumerated-but-empty list (veto already cleared) still
    // blocks — the host says CHANGES_REQUESTED until the next fetch,
    // and the generic wording covers the unenumerated case too
    const empty = evaluateExitGate(open({ reviewDecision: 'CHANGES_REQUESTED', vetoReviews: [] }));
    assert.match(empty.blockers[0]!, /dismiss a stale review or wait for re-review/);
  });

  it('is not blocked by stale pending statuses on a merged PR', () => {
    const g = evaluateExitGate(
      open({ state: 'MERGED', sastPending: 1, reviewersPending: 1, mergeable: 'UNKNOWN' })
    );
    assert.equal(g.ok, true);
    assert.deepEqual(g.blockers, []);
    // counts still surface — informational, not blocking
    assert.equal(g.sast_pending, 1);
  });

  it('is not blocked on a closed-unmerged PR either', () => {
    assert.equal(evaluateExitGate(open({ state: 'CLOSED', openThreads: 3 })).ok, true);
  });

  it('mandates debt-defer once fix rounds exceed the cap', () => {
    const g = evaluateExitGate(open({ openThreads: 2, fixRounds: 4, maxRounds: 3 }));
    assert.equal(g.ok, false);
    assert.match(g.blockers[0], /fix-round cap hit \(4>3\)/);
    assert.match(g.blockers[0], /defer the 2 remaining thread\(s\)/);
    // at/below the cap or cap disabled — plain thread blocker
    assert.match(
      evaluateExitGate(open({ openThreads: 1, fixRounds: 3, maxRounds: 3 })).blockers[0],
      /1 unresolved review thread/
    );
    assert.match(
      evaluateExitGate(open({ openThreads: 1, fixRounds: 9, maxRounds: 0 })).blockers[0],
      /1 unresolved review thread/
    );
    // no open threads → cap is moot
    assert.equal(evaluateExitGate(open({ fixRounds: 9, maxRounds: 3 })).ok, true);
  });

  it('carries advisory alerts through without blocking', () => {
    const g = evaluateExitGate(
      open({ alerts: ['advisory check "Kilo" failing — the reviewer may be down'] })
    );
    assert.equal(g.ok, true);
    assert.deepEqual(g.blockers, []);
    assert.equal(g.alerts.length, 1);
    assert.match(g.alerts[0]!, /may be down/);
  });

  it('names the docs-only PR in the cap blocker and reports docs_only', () => {
    const g = evaluateExitGate(
      open({ openThreads: 1, fixRounds: 3, maxRounds: 2, docsOnly: true })
    );
    assert.match(g.blockers[0], /fix-round cap hit \(3>2, docs-only PR\)/);
    assert.equal(g.docs_only, true);
    assert.equal(evaluateExitGate(open()).docs_only, false);
  });
});

describe('evaluateExitGate — requireApproval (bro-3vy93)', () => {
  it('blocks auto-merge without a human approval when the gate is on', () => {
    const on = { requireApproval: true };
    // a human approval passes — the probe, not the host's aggregate
    // verdict (bot approvals don't satisfy it)
    assert.equal(evaluateExitGate(open({ humanApproval: true }), on).ok, true);
    // no qualifying approval — the probe's reason rides the blocker so
    // the operator sees why (stale head, bot-only, standing objection)
    const denied = evaluateExitGate(
      open({ humanApproval: false, humanApprovalReason: 'changes requested by bob' }),
      on
    );
    assert.equal(denied.ok, false);
    assert.match(denied.blockers.at(-1)!, /changes requested by bob/);
    const bare = evaluateExitGate(open({ humanApproval: false }), on);
    assert.match(bare.blockers.at(-1)!, /not approved/);
    // an unanswerable probe reads as "not approved", never a pass
    const unknown = evaluateExitGate(open(), on);
    assert.equal(unknown.ok, false);
    assert.match(unknown.blockers.at(-1)!, /unanswerable/);
    // the flag off → the verdict is ignored entirely
    assert.equal(evaluateExitGate(open({ humanApproval: false })).ok, true);
    assert.equal(
      evaluateExitGate(open({ humanApproval: false }), { requireApproval: false }).ok,
      true
    );
    // policy rides the call, not the state: a PrActState physically
    // cannot carry requireApproval, so a cached `false` can never slip
    // the check — the caller decides every gate evaluation
    // (a merged PR's stale verdict is not a blocker — same rule as the
    // rest of the gate)
    assert.equal(evaluateExitGate(open({ state: 'MERGED' }), on).ok, true);
  });
});

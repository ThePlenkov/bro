/** The ACP dead-loop guard (spec bro-b961a) — the accounting that stops a
 *  conversation from burning an account on sessions that never answer. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpDeadLoopError, AcpDeadLoopGuard } from './acp-guard.ts';

describe('acp dead-loop guard (bro-b961a)', () => {
  test('a scope that opens sessions without completing trips the guard', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
    guard.open('conv-1');
    guard.open('conv-1');
    assert.throws(
      () => guard.open('conv-1'),
      (err: unknown) => err instanceof AcpDeadLoopError && err.opens === 3 && err.budget === 2
    );
  });

  test('the refused open never happens — the churn stops at the budget', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
    guard.open('conv-1');
    guard.open('conv-1');
    assert.throws(() => guard.open('conv-1'), AcpDeadLoopError);
    // the refused open is NOT charged — the count stays at the budget
    assert.equal(guard.churn('conv-1'), 2);
  });

  test('a completed turn releases the session — a conversation that answers never trips', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
    for (let i = 0; i < 10; i++) {
      guard.open('conv-1');
      guard.done('conv-1');
    }
    assert.equal(guard.churn('conv-1'), 0);
  });

  test('a tripped scope stays refused for the cooldown, then a probe is allowed', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1, cooldownMs: 20 });
    guard.open('conv-1');
    assert.throws(() => guard.open('conv-1'), AcpDeadLoopError);
    // still refused inside the cooldown
    assert.throws(() => guard.open('conv-1'), AcpDeadLoopError);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // half-open: one probe gets through
    guard.open('conv-1');
    // and the probe's success clears the trip outright
    guard.done('conv-1');
    guard.open('conv-1');
  });

  test('the peer churn trips the peer — the loop may live inside the child', () => {
    const guard = new AcpDeadLoopGuard({ maxAbandoned: 2 });
    guard.open('conv-1', 'conductor:dv');
    guard.open('conv-2', 'conductor:dv');
    assert.equal(guard.peerChurn('conductor:dv'), false);
    guard.open('conv-3', 'conductor:dv');
    const trip = guard.peerTrip('conductor:dv');
    assert.ok(trip instanceof AcpDeadLoopError);
    assert.equal(trip.kind, 'peer');
    assert.equal(trip.opens, 3);
  });

  test('a peer whose turns complete never trips', () => {
    const guard = new AcpDeadLoopGuard({ maxAbandoned: 2 });
    for (let i = 0; i < 10; i++) {
      guard.open(`conv-${i}`, 'conductor:dv');
      guard.done(`conv-${i}`, 'conductor:dv');
    }
    assert.equal(guard.peerChurn('conductor:dv'), false);
  });

  test('one scope\'s churn never implicates another', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1 });
    guard.open('conv-1');
    assert.throws(() => guard.open('conv-1'), AcpDeadLoopError);
    // a different conversation is untouched
    guard.open('conv-2');
    assert.equal(guard.churn('conv-2'), 1);
  });

  test('the window closes — a burst that is over starts clean', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1, windowMs: 20 });
    guard.open('conv-1');
    assert.throws(() => guard.open('conv-1'), AcpDeadLoopError);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // the window reset the counters; the cooldown still owns the refusal
    assert.throws(() => guard.open('conv-1'), AcpDeadLoopError);
  });
});

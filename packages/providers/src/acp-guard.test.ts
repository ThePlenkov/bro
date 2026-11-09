/** The ACP dead-loop guard (spec bro-b961a) — the accounting that stops a
 *  conversation from burning an account on sessions that never answer. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpDeadLoopError, AcpDeadLoopGuard } from './acp-guard.ts';
import type { AcpTarget } from './acp-guard.ts';

/** The measured target — a conversation and the peer behind it. */
const t = (scope: string, peer?: string): AcpTarget => ({ scope, peer });

describe('acp dead-loop guard (bro-b961a)', () => {
  test('a scope that opens sessions without completing trips the guard', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
    guard.open(t('conv-1'));
    guard.open(t('conv-1'));
    assert.throws(
      () => guard.open(t('conv-1')),
      (err: unknown) => err instanceof AcpDeadLoopError && err.opens === 3 && err.budget === 2
    );
  });

  test('the refused open never happens — the churn stops at the budget', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
    guard.open(t('conv-1'));
    guard.open(t('conv-1'));
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    // the refused open is NOT charged — the count stays at the budget
    assert.equal(guard.churn(t('conv-1')), 2);
  });

  test('a completed turn releases the session — a conversation that answers never trips', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
    for (let i = 0; i < 10; i++) {
      guard.open(t('conv-1'));
      guard.done(t('conv-1'));
    }
    assert.equal(guard.churn(t('conv-1')), 0);
  });

  test('a tripped scope stays refused for the cooldown, then a probe is allowed', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1, cooldownMs: 20 });
    guard.open(t('conv-1'));
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    // still refused inside the cooldown
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // half-open: one probe gets through
    guard.open(t('conv-1'));
    // and the probe's success clears the trip outright
    guard.done(t('conv-1'));
    guard.open(t('conv-1'));
  });

  test('the peer churn trips the peer AT the open — the loop may live inside the child', () => {
    const guard = new AcpDeadLoopGuard({ maxAbandoned: 2 });
    guard.open(t('conv-1', 'conductor:dv'));
    guard.open(t('conv-2', 'conductor:dv'));
    assert.equal(guard.peerChurn(t('peer', 'conductor:dv')), false);
    // the third open crosses the peer's budget — it is refused BEFORE the
    // session opens, and the refusal names the peer
    assert.throws(
      () => guard.open(t('conv-3', 'conductor:dv')),
      (err: unknown) =>
        err instanceof AcpDeadLoopError && err.kind === 'peer' && err.opens === 3
    );
    // the refused open never counted — the peer's churn is what it was
    assert.equal(guard.peerChurnCount(t('peer', 'conductor:dv')), 2);
  });

  test('the peer tally counts the refused open never — the break costs no session', () => {
    const guard = new AcpDeadLoopGuard({ maxAbandoned: 1 });
    guard.open(t('conv-1', 'conductor:dv'));
    assert.throws(() => guard.open(t('conv-2', 'conductor:dv')), AcpDeadLoopError);
    // one session was opened; the refused one never happened
    assert.equal(guard.peerChurnCount(t('peer', 'conductor:dv')), 1);
  });

  test('a peer whose turns complete never trips', () => {
    const guard = new AcpDeadLoopGuard({ maxAbandoned: 2 });
    for (let i = 0; i < 10; i++) {
      guard.open(t(`conv-${i}`, 'conductor:dv'));
      guard.done(t(`conv-${i}`, 'conductor:dv'));
    }
    assert.equal(guard.peerChurn(t('peer', 'conductor:dv')), false);
  });

  test('one scope\'s churn never implicates another', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1 });
    guard.open(t('conv-1'));
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    // a different conversation is untouched
    guard.open(t('conv-2'));
    assert.equal(guard.churn(t('conv-2')), 1);
  });

  test('a tripped scope admits exactly ONE probe per cooldown', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1, cooldownMs: 20 });
    guard.open(t('conv-1'));
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // the half-open probe gets through — once
    guard.open(t('conv-1'));
    // a second open before the probe answers is refused: the scope does
    // not hand out a fresh budget, it hands out one probe
    assert.throws(
      () => guard.open(t('conv-1')),
      (err: unknown) =>
        err instanceof AcpDeadLoopError && /probe has not answered/.test(err.message)
    );
    // the probe answers — the scope is healthy again
    guard.done(t('conv-1'));
    guard.open(t('conv-1'));
    guard.done(t('conv-1'));
  });

  test('the tallies are pruned — client-supplied scopes do not grow the guard', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1 });
    // 400 distinct scopes, each opened and completed — the maps must not
    // keep every key forever
    for (let i = 0; i < 400; i++) {
      guard.open(t(`conv-${i}`));
      guard.done(t(`conv-${i}`));
    }
    // a fresh scope still measures correctly
    guard.open(t('conv-fresh'));
    assert.equal(guard.churn(t('conv-fresh')), 1);
    assert.throws(() => guard.open(t('conv-fresh')), AcpDeadLoopError);
  });

  test('the window closes — a burst that is over starts clean', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1, windowMs: 20 });
    guard.open(t('conv-1'));
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // the window reset the counters; the cooldown still owns the refusal
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
  });
});

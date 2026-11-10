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
      guard.open(t('conv-1')).resolve();
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
    const probe = guard.open(t('conv-1'));
    // and the probe's success clears the trip outright
    probe.resolve();
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
      (err: unknown) => err instanceof AcpDeadLoopError && err.kind === 'peer' && err.opens === 3
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
      guard.open(t(`conv-${i}`, 'conductor:dv')).resolve();
    }
    assert.equal(guard.peerChurn(t('peer', 'conductor:dv')), false);
  });

  test("one scope's churn never implicates another", () => {
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
    const probe = guard.open(t('conv-1'));
    // a second open before the probe answers is refused: the scope does
    // not hand out a fresh budget, it hands out one probe
    assert.throws(
      () => guard.open(t('conv-1')),
      (err: unknown) =>
        err instanceof AcpDeadLoopError && /probe has not answered/.test(err.message)
    );
    // the probe answers — the scope is healthy again
    probe.resolve();
    guard.open(t('conv-1')).resolve();
  });

  test('a tripped scope admits exactly ONE probe per cooldown — a budget above one does not widen it', async () => {
    // maxOpens above ONE: a cooldown recovery that restored the full
    // budget would let three opens through. The half-open scope hands
    // out one probe, not a fresh allowance.
    const guard = new AcpDeadLoopGuard({ maxOpens: 3, cooldownMs: 20 });
    guard.open(t('conv-1'));
    guard.open(t('conv-1'));
    guard.open(t('conv-1'));
    assert.throws(() => guard.open(t('conv-1')), AcpDeadLoopError);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // half-open: ONE probe gets through
    guard.open(t('conv-1'));
    // a second open before the probe answers is refused: the scope does
    // not hand out a fresh budget, it hands out one probe
    assert.throws(
      () => guard.open(t('conv-1')),
      (err: unknown) =>
        err instanceof AcpDeadLoopError && /probe has not answered/.test(err.message)
    );
    // the probe failed — it never answered, so the scope stays half-open
    // until the next cooldown. A failed probe is not a fresh budget.
    assert.throws(
      () => guard.open(t('conv-1')),
      (err: unknown) =>
        err instanceof AcpDeadLoopError && /probe has not answered/.test(err.message)
    );
  });

  test('a dead peer takes its churn with it — the replacement is not refused for it', () => {
    const guard = new AcpDeadLoopGuard({ maxAbandoned: 2 });
    guard.open(t('conv-1', 'conductor:dv'));
    guard.open(t('conv-2', 'conductor:dv'));
    // the peer dies — its abandoned sessions died with it
    guard.forgetPeer(t('peer', 'conductor:dv'));
    // the replacement is a fresh child: it is not refused for its
    // predecessor's abandoned sessions
    guard.open(t('conv-3', 'conductor:dv'));
    assert.equal(guard.peerChurnCount(t('peer', 'conductor:dv')), 1);
    assert.equal(guard.peerChurn(t('peer', 'conductor:dv')), false);
  });

  test('the tallies are pruned — client-supplied scopes do not grow the guard', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1 });
    // 400 distinct scopes, each opened and completed — the maps must not
    // keep every key forever
    for (let i = 0; i < 400; i++) {
      guard.open(t(`conv-${i}`)).resolve();
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

  test('a charge resolves once — resolving it twice frees nothing', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 4, maxAbandoned: 4 });
    const charge = guard.open(t('conv-1', 'conductor:dv'));
    guard.open(t('conv-2', 'conductor:dv'));
    charge.resolve();
    // a second settle must not eat another session's charge — a retained
    // session prompts many turns but opened once
    charge.resolve();
    assert.equal(guard.churn(t('conv-1')), 0);
    assert.equal(guard.churn(t('conv-2')), 1);
    assert.equal(guard.peerChurnCount(t('peer', 'conductor:dv')), 1);
  });

  test('a completion frees its OWN charge — a rolled window hides nothing', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 4, windowMs: 20 });
    const stale = guard.open(t('conv-1'));
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // the window rolled: the stale open was already written off, and the
    // fresh open counts in the new window
    guard.open(t('conv-1'));
    assert.equal(guard.churn(t('conv-1')), 1);
    // the stale completion must not eat the fresh charge
    stale.resolve();
    assert.equal(guard.churn(t('conv-1')), 1);
  });

  test('the prune keeps a live cooldown — a tripped scope stays refused past its window', async () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1, windowMs: 20, cooldownMs: 60_000 });
    guard.open(t('conv-tripped'));
    assert.throws(() => guard.open(t('conv-tripped')), AcpDeadLoopError);
    // the window closes while the cooldown still owns the refusal
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    // fill the maps past the prune threshold — each open a fresh key
    for (let i = 0; i < 300; i++) {
      guard.open(t(`flood-${i}`));
    }
    // a pruned trip would admit the scope with a fresh budget — the
    // cooldown must still own the refusal
    assert.throws(() => guard.open(t('conv-tripped')), AcpDeadLoopError);
  });

  test('a dropped connection takes its scope with it', () => {
    const guard = new AcpDeadLoopGuard({ maxOpens: 1 });
    guard.open(t('conn-a'));
    guard.forgetScope(t('conn-a'));
    // the scope's own entry is gone — a same-keyed measurement starts
    // fresh, and the map never kept a dead client's tally
    guard.open(t('conn-a'));
    assert.equal(guard.churn(t('conn-a')), 1);
  });
});

/** The dead-loop prevention on the provider surface (spec bro-b961a) —
 *  the refusals and the watchdog that keep a churn from costing a
 *  session, a quota, or an operator's account. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentApp } from '@agentclientprotocol/sdk';
import { JudgeUnavailable } from '@broject/core';
import type { ProviderEntry } from '@broject/core';
import { acpOpen, acpPooledTurn, acpSessionRetain } from './acp.ts';
import type { AcpPeer } from './acp.ts';
import { AcpDeadLoopError, AcpDeadLoopGuard } from './acp-guard.ts';
import type { AcpGuardCtx } from './acp-guard.ts';
import { fakeAcpAgent } from './testkit.ts';

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>;

const ENTRY: AcpEntry = { type: 'acp', command: 'dv acp' };

const deadline = (ms = 10_000): number => Date.now() + ms;

/** A turn on the peer under the guard — the churn the guard sees. The
 *  shape every refusal test shares: one turn, one guard, one scope. */
function guardedTurn(peer: AcpPeer, app: AgentApp, ctx: AcpGuardCtx) {
  return acpPooledTurn(peer, ENTRY, { acp: { peer: app } }, 'p', deadline(), {
    by: 'conductor:t',
    guard: ctx,
  });
}

describe('acp dead-loop prevention (bro-b961a)', () => {
  test('the churn is refused BEFORE the session opens — the refusal costs no quota', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'generic' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxOpens: 2 });
      const ctx = { guard, scope: 'conv-1', peer: 'conductor:t' };
      // two failing turns — each opened a session and answered nothing
      for (let i = 0; i < 2; i++) {
        await assert.rejects(
          guardedTurn(peer, fake.app, ctx),
          JudgeUnavailable
        );
      }
      assert.equal(fake.sessions.length, 2);
      // the third is refused — and NO third session is opened
      await assert.rejects(
        guardedTurn(peer, fake.app, ctx),
        (err: unknown) => err instanceof AcpDeadLoopError && err.scope === 'conv-1'
      );
      assert.equal(fake.sessions.length, 2);
    } finally {
      peer.close();
    }
  });

  test('a conversation that answers never trips the guard', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxOpens: 1 });
      const ctx = { guard, scope: 'conv-1', peer: 'conductor:t' };
      for (let i = 0; i < 5; i++) {
        const r = await guardedTurn(peer, fake.app, ctx);
        assert.equal(r.text, 'ok');
      }
      assert.equal(guard.churn({ scope: 'conv-1' }), 0);
    } finally {
      peer.close();
    }
  });

  test("a retained session resolves its churn ONCE — a later prompt never clears another session's charge", async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxOpens: 4, maxAbandoned: 4 });
      const ctx = { guard, scope: 'conv-1', peer: 'conductor:t' };
      // another session of the SAME scope is open and never answered —
      // its charge must survive the retained session's later prompts
      guard.open(ctx);
      const retained = await acpSessionRetain(
        peer,
        ENTRY,
        { acp: { peer: fake.app } },
        deadline(),
        { by: 'conductor:t', guard: ctx }
      );
      try {
        await retained.prompt('one', deadline());
        // the retained session's own charge is resolved — the other
        // session's is still counted
        assert.equal(guard.churn(ctx), 1);
        await retained.prompt('two', deadline());
        // a second prompt must not decrement again: the charge it would
        // take is the other session's
        assert.equal(guard.churn(ctx), 1);
      } finally {
        retained.dispose();
      }
    } finally {
      peer.close();
    }
  });

  test('the peer breaks when the churn is systemic — the child may hold the loop', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'generic' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxAbandoned: 1 });
      const ctx = { guard, scope: 'conv-1', peer: 'conductor:t' };
      // the first turn opens a session and answers nothing — the peer's
      // churn is one unfinished session
      await assert.rejects(
        guardedTurn(peer, fake.app, ctx),
        JudgeUnavailable
      );
      assert.equal(fake.sessions.length, 1);
      // the next open crosses the peer's budget — it is refused BEFORE the
      // session opens, and the peer is killed (the child with it)
      await assert.rejects(
        guardedTurn(peer, fake.app, ctx),
        (err: unknown) => err instanceof AcpDeadLoopError && err.kind === 'peer'
      );
      assert.equal(fake.sessions.length, 1);
      assert.equal(peer.signal.aborted, true);
    } finally {
      peer.close();
    }
  });

  test('a silent turn is ended by the watchdog — the caller gets a definite answer', async () => {
    // an agent that says nothing and never finishes
    const fake = fakeAcpAgent({ updates: [], holdPromptUntil: new Promise<void>(() => {}) });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      await assert.rejects(
        acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(30_000), {
          by: 'conductor:t',
          stallMs: 50,
        }),
        (err: unknown) =>
          err instanceof JudgeUnavailable && /turn stalled: no session\/update/.test(err.message)
      );
    } finally {
      peer.close();
    }
  });

  test('a turn that reports itself is never touched by the watchdog', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const r = await acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
        by: 'conductor:t',
        stallMs: 50,
      });
      assert.equal(r.text, 'ok');
    } finally {
      peer.close();
    }
  });

  test('a turn that outlives the stall window but keeps reporting is untouched', async () => {
    // the turn lasts LONGER than the watchdog window, and reports every
    // 20ms — the silence bound measures the silence, not the turn. A
    // watchdog that counted the turn's whole life would fire here.
    const fake = fakeAcpAgent({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      ],
      updateDelayMs: 20,
    });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const r = await acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
        by: 'conductor:t',
        stallMs: 50,
      });
      assert.equal(r.text, 'abcok');
    } finally {
      peer.close();
    }
  });
});

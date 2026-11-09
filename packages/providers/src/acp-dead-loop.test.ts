/** The dead-loop prevention on the provider surface (spec bro-b961a) —
 *  the refusals and the watchdog that keep a churn from costing a
 *  session, a quota, or an operator's account. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { JudgeUnavailable } from '@broject/core';
import type { ProviderEntry } from '@broject/core';
import { acpOpen, acpPooledTurn } from './acp.ts';
import { AcpDeadLoopError, AcpDeadLoopGuard } from './acp-guard.ts';
import { fakeAcpAgent } from './testkit.ts';

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>;

const ENTRY: AcpEntry = { type: 'acp', command: 'dv acp' };

const deadline = (ms = 10_000): number => Date.now() + ms;

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
          acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
            by: 'conductor:t',
            guard: ctx,
          }),
          JudgeUnavailable
        );
      }
      assert.equal(fake.sessions.length, 2);
      // the third is refused — and NO third session is opened
      await assert.rejects(
        acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
          by: 'conductor:t',
          guard: ctx,
        }),
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
        const r = await acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
          by: 'conductor:t',
          guard: ctx,
        });
        assert.equal(r.text, 'ok');
      }
      assert.equal(guard.churn('conv-1'), 0);
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
      await assert.rejects(
        acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
          by: 'conductor:t',
          guard: ctx,
        }),
        JudgeUnavailable
      );
      // the second failure puts the peer over its budget — the peer is
      // killed and the churn is named
      await assert.rejects(
        acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
          by: 'conductor:t',
          guard: ctx,
        }),
        (err: unknown) => err instanceof AcpDeadLoopError && err.kind === 'peer'
      );
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
});

/** The provider wall's cooldown on the provider surface (spec
 *  bro-i6811) — the refusal is spoken BEFORE the session opens, so a
 *  client that keeps retrying under a wall spends no quota at all. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acpOpen, acpPooledTurn, acpSessionRetain } from './acp.ts';
import { AcpDeadLoopGuard } from './acp-guard.ts';
import type { AcpGuardCtx } from './acp-guard.ts';
import { AcpCooldownError, AcpLaneCooldown, type AcpWallCheck } from './acp-cooldown.ts';
import { fakeAcpAgent } from './testkit.ts';

const ENTRY = { type: 'acp', command: 'dv acp' } as const;
const deadline = (ms = 10_000): number => Date.now() + ms;

describe('acp wall cooldown (bro-i6811)', () => {
  test('the wall is refused BEFORE the session opens — the refusal costs no quota', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxOpens: 8 });
      const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
      const ctx: AcpGuardCtx = { guard, scope: 'conv-1', peer: 'conductor:t', cooldown };
      // the account says no — the lane closes
      cooldown.noteWall('the provider rate limited the request');
      await assert.rejects(
        acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
          by: 'conductor:t',
          guard: ctx,
        }),
        (err: unknown) => err instanceof AcpCooldownError && err.retryAfterSec === 60
      );
      // NO session was opened — that is the whole point
      assert.equal(fake.sessions.length, 0);
    } finally {
      peer.close();
    }
  });

  test('the retained path refuses the same way — no session, no quota', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxOpens: 8 });
      const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
      cooldown.noteWall('the provider is unavailable');
      await assert.rejects(
        acpSessionRetain(peer, ENTRY, { acp: { peer: fake.app } }, deadline(), {
          by: 'conductor:t',
          guard: { guard, scope: 'conv-1', peer: 'conductor:t', cooldown },
        }),
        AcpCooldownError
      );
      assert.equal(fake.sessions.length, 0);
    } finally {
      peer.close();
    }
  });

  test('a structural wall check refuses on a guardless ctx — the delegate lane shape (bro-acjzf)', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      // delegate --wait's shape: no `guard` leg (a per-request ctx has
      // no churn to measure), and the wall verdict is any AcpWallCheck —
      // the registry/ledger walls ride the admission seam without an
      // AcpLaneCooldown behind them
      let reads = 0;
      const check: AcpWallCheck = {
        refusal: () => {
          reads += 1;
          return { reason: 'p walled — rate_limited', retryAfterSec: 42 };
        },
      };
      await assert.rejects(
        acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
          by: 'delegate',
          guard: { scope: 'delegate:p', cooldown: check },
        }),
        (err: unknown) =>
          err instanceof AcpCooldownError &&
          err.retryAfterSec === 42 &&
          /p walled — rate_limited/.test(err.message)
      );
      // the verdict was read at admission — and NO session was opened
      assert.equal(reads, 1);
      assert.equal(fake.sessions.length, 0);
      assert.equal(fake.prompts.length, 0);
    } finally {
      peer.close();
    }
  });

  test('a healthy lane opens its session as before', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const peer = await acpOpen('conductor:t', ENTRY, { acp: { peer: fake.app } }, deadline());
    try {
      const guard = new AcpDeadLoopGuard({ maxOpens: 8 });
      const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
      const ctx: AcpGuardCtx = { guard, scope: 'conv-1', peer: 'conductor:t', cooldown };
      await acpPooledTurn(peer, ENTRY, { acp: { peer: fake.app } }, 'p', deadline(), {
        by: 'conductor:t',
        guard: ctx,
      });
      assert.equal(fake.sessions.length, 1);
    } finally {
      peer.close();
    }
  });
});

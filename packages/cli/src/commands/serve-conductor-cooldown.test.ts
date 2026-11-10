/** The conductor's wall cooldown (spec bro-i6811) — the lane stops
 *  spawning while the account is saying no, and the refusal reaches the
 *  client as a 429 it can wait out. The proof is the session count: a
 *  refused request opens NO session, so the retry storm that burned
 *  the account on 2026-11-10 cannot happen again. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAcpAgent } from '@broject/providers/testkit';
import { conductorProxy } from './serve-conductor.ts';
import type { ConductorConfig } from './serve-conductor.ts';
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts';

const BODY = { messages: [{ role: 'user', content: 'x' }], stream: false };

const CFG: ConductorConfig = {
  backend: 'dv-acp',
  entry: { type: 'acp', command: 'dv acp' },
  cwd: process.cwd(),
  timeoutMs: 30_000,
  // the session cap is bro's OWN budget — it must not be the thing
  // under test here, so the lane gets room to spawn a second session
  agents: { devin: { maxSessions: 10 } },
};

describe('serve /v1/messages — the wall cooldown (bro-i6811)', () => {
  test('the wall closes the lane — the next request opens NO session', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'rate-limit' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
      // the first turn opens a session and the account says no
      const first = await post();
      assert.equal(first.status, 429);
      assert.equal(fake.sessions.length, 1);
      // the second request is refused BEFORE the spawn — the session
      // count is the proof: no session, no quota
      const second = await post();
      assert.equal(second.status, 429);
      assert.equal(fake.sessions.length, 1);
      const text = await second.text();
      assert.match(text, /cooling down/);
    } finally {
      await close();
    }
  });

  test('the refusal carries the retry-after the client must wait out', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'rate-limit' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
      await post();
      const second = await post();
      assert.equal(second.status, 429);
      const retry = second.headers.get('retry-after');
      assert.ok(retry !== null, 'the refusal must name the wait');
      assert.ok(Number(retry) > 0, 'the wait must be a positive number of seconds');
    } finally {
      await close();
    }
  });

  test('a healthy lane is untouched — no wall, no refusal', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
      const first = await post();
      assert.equal(first.status, 200);
      const second = await post();
      assert.equal(second.status, 200);
    } finally {
      await close();
    }
  });

  test('a failure that is NOT the account saying no never closes the lane', async () => {
    // an auth failure is a failure of THIS turn — arming the cooldown on
    // it would refuse a lane that is serving fine
    const fake = fakeAcpAgent({ failPrompt: 'auth' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
      await post();
      const second = await post();
      // the lane kept spawning — the cooldown never closed it
      assert.equal(fake.sessions.length, 2);
      assert.doesNotMatch(await second.text(), /cooling down/);
    } finally {
      await close();
    }
  });

  test('one provider failure does not close the lane — the second one does', async () => {
    // the outage case of 2026-11-10: the provider broke, and every retry
    // bought another session. One failure is a failed turn; two in the
    // window say the account is struggling, and that closes the lane.
    const fake = fakeAcpAgent({ failPrompt: 'generic' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
      // the first failure is only counted
      await post();
      const second = await post();
      assert.doesNotMatch(await second.text(), /cooling down/);
      assert.equal(fake.sessions.length, 2);
      // the second failure closes the lane — the third request buys NO
      // session
      const third = await post();
      assert.equal(third.status, 429);
      assert.equal(fake.sessions.length, 2);
      assert.match(await third.text(), /cooling down/);
    } finally {
      await close();
    }
  });

  test('the openai dialect refuses the same way — 429 with a retry-after', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'rate-limit' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'dv', messages: [{ role: 'user', content: 'x' }] }),
        });
      await post();
      const second = await post();
      assert.equal(second.status, 429);
      assert.ok(second.headers.get('retry-after') !== null);
      assert.equal(fake.sessions.length, 1);
    } finally {
      await close();
    }
  });

  test('the cooldown can be switched off — the lane spawns through walls', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'rate-limit' });
    const off: ConductorConfig = { ...CFG, acpCooldownMs: 0 };
    const { url, close } = await listen(
      deps({ provider: conductorProxy(off, { acp: { peer: fake.app } }) })
    );
    try {
      const post = () =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
      await post();
      const second = await post();
      // the provider still answers 429 — but the LANE kept spawning, so
      // the cooldown did not close it
      assert.equal(fake.sessions.length, 2);
      assert.doesNotMatch(await second.text(), /cooling down/);
    } finally {
      await close();
    }
  });
});

/** The conductor's dead-loop refusal (spec bro-b961a) — a conversation
 *  that opens sessions without answering is stopped, and the refusal
 *  reaches the client as a 429 it can wait out. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAcpAgent } from '@broject/providers/testkit';
import { conductorProxy } from './serve-conductor.ts';
import type { ConductorConfig } from './serve-conductor.ts';
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts';

const BODY = { messages: [{ role: 'user', content: 'x' }], stream: false };

/** A conductor whose churn budget is one session — the second failure
 *  crosses it. */
const CFG: ConductorConfig = {
  backend: 'dv-acp',
  entry: { type: 'acp', command: 'dv acp' },
  cwd: process.cwd(),
  timeoutMs: 30_000,
  agents: {},
  acpMaxOpens: 1,
};

describe('serve /v1/messages — the dead-loop refusal (bro-b961a)', () => {
  test('a churning conversation is refused with 429 — and no session is opened for it', async () => {
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
      // the first turn opens a session and answers nothing
      const first = await post();
      assert.notEqual(first.status, 429);
      assert.equal(fake.sessions.length, 1);
      // the second crosses the churn budget — the refusal costs no session
      const second = await post();
      assert.equal(second.status, 429);
      assert.equal(second.headers.get('retry-after'), '60');
      assert.equal(fake.sessions.length, 1);
      const text = await second.text();
      assert.match(text, /dead loop/);
    } finally {
      await close();
    }
  });

  test('a conversation that answers is never refused', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        assert.equal(r.status, 200);
      }
    } finally {
      await close();
    }
  });
});

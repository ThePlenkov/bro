/** The conductor's dead-loop refusal (spec bro-b961a) — a conversation
 *  that opens sessions without answering is stopped, and the refusal
 *  reaches the client as a 429 it can wait out. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSessionPlanes,
  registerSessionPlane,
  type SessionPlane,
} from '@broject/core';
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

  test('the cap slot is released when the retained session is disposed', async () => {
    // a cap of ONE session: the second request must find the slot free,
    // which only holds if the first session's claim was released when it
    // was evicted (spec bro-b961a)
    const slots = mkdtempSync(join(tmpdir(), 'bro-cap-'));
    // the plane registry is process-global — a scripted plane claims the
    // command, so the cap counts THIS test's sessions and nothing else
    const plane: SessionPlane = {
      kind: 'capfake',
      detectsCli: cli => cli === 'capfake-cli',
      startsSessions: command => (command.includes('capfake-run') ? 1 : 0),
      countLive: () => 0,
    };
    clearSessionPlanes();
    registerSessionPlane(plane);
    const capped: ConductorConfig = {
      ...CFG,
      entry: { type: 'acp', command: 'capfake-run' },
      agents: { capfake: { maxSessions: 1, reservationsDir: join(slots, 'claims') } },
    };
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(capped, { acp: { peer: fake.app } }) })
    );
    try {
      const post = (system: string) =>
        fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'content-type': 'application/json',
            'x-bro-session': 'conv-1',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'x' }],
            system,
            stream: false,
          }),
        });
      const first = await post('a');
      assert.equal(first.status, 200);
      // the system changed — the stored context never proved this client,
      // so the session is evicted and a fresh one takes the slot
      const second = await post('b');
      const secondBody = await second.text();
      assert.ok(second.status === 200, `status=${second.status} body=${secondBody}`);
    } finally {
      await close();
      clearSessionPlanes();
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

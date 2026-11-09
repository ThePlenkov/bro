/** The pooled peer's idle release (spec bro-7ira8) — a listener that
 *  serves nothing must not hold a concurrent Devin lane. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAcpAgent } from '@broject/providers/testkit';
import type { ProviderEntry } from '@broject/core';
import { acpLinkPool, conductorProxy } from './serve-conductor.ts';
import type { ConductorConfig } from './serve-conductor.ts';
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts';

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>;

const ENTRY: AcpEntry = { type: 'acp', command: 'dv acp' };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('the pooled peer idle release (bro-7ira8)', () => {
  test('an idle peer is released — the listener stops holding the account', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const pool = acpLinkPool('conductor:t', ENTRY, { acp: { peer: fake.app } }, 10_000, 40);
    let deaths = 0;
    pool.onDeath(() => {
      deaths += 1;
    });
    try {
      await pool.link();
      assert.ok(pool.live());
      await sleep(120);
      // the peer is gone and the retained sessions it carried died with it
      assert.equal(pool.live(), undefined);
      assert.equal(deaths, 1);
    } finally {
      pool.dispose();
    }
  });

  test('a peer with a turn in flight is NOT released', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const pool = acpLinkPool('conductor:t', ENTRY, { acp: { peer: fake.app } }, 10_000, 40);
    try {
      await pool.link();
      pool.busy();
      await sleep(120);
      // the turn is still running — the peer stays
      assert.ok(pool.live());
      pool.idle();
      await sleep(120);
      // the turn settled — now the release applies
      assert.equal(pool.live(), undefined);
    } finally {
      pool.dispose();
    }
  });

  test('a window of 0 disables the release — the peer lives on', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const pool = acpLinkPool('conductor:t', ENTRY, { acp: { peer: fake.app } }, 10_000, 0);
    try {
      await pool.link();
      await sleep(120);
      assert.ok(pool.live());
    } finally {
      pool.dispose();
    }
  });

  test('the next link after a release spawns a fresh peer', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const pool = acpLinkPool('conductor:t', ENTRY, { acp: { peer: fake.app } }, 10_000, 40);
    try {
      await pool.link();
      await sleep(120);
      assert.equal(pool.live(), undefined);
      await pool.link();
      assert.ok(pool.live());
    } finally {
      pool.dispose();
    }
  });

  test('a turn in flight keeps its peer — the release waits for the turn', async () => {
    // the turn outlives the idle window: the release must not drop the
    // peer while the turn is still running. A pool that reports itself
    // idle before the turn settles drops the peer mid-flight and the
    // answer is lost.
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fake = fakeAcpAgent({ replyText: 'ok', holdEnd: () => gate });
    const cfg: ConductorConfig = {
      backend: 'dv-acp',
      entry: ENTRY,
      cwd: process.cwd(),
      timeoutMs: 30_000,
      agents: {},
      idleReleaseMs: 40,
    };
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      const pending = fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        }),
      });
      // the idle window passes while the turn is still pending
      await sleep(150);
      release();
      const r = await pending;
      const body = await r.text();
      assert.equal(r.status, 200, `status=${r.status} body=${body}`);
    } finally {
      await close();
    }
  });
});

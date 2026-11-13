/** The serve lane's quota gate (spec bro-ezboq) — `serve.limits`
 *  paces ACP spend BEFORE the provider sees it: the token bucket
 *  refuses with 429 + retry-after, the session/queue caps refuse
 *  saturated lanes, and the proof is always the same — a refused
 *  request opens NO session and pays NO turn. */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ServeLaneLimits } from '@broject/core';
import { fakeAcpAgent } from '@broject/providers/testkit';
import type { ConductorConfig } from './serve-conductor.ts';
import { conductorConfig, conductorProxy } from './serve-conductor.ts';
import { authHeaders, serveDeps as deps, listen } from './serve-testkit.ts';

const post = (url: string, messages: unknown[]) =>
  fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ messages, stream: false }),
  });

const m = (text: string) => ({ role: 'user', content: text });

const base = (limits: Record<string, ServeLaneLimits>): ConductorConfig => ({
  backend: 'dv-acp',
  entry: { type: 'acp', command: 'dv acp' },
  cwd: process.cwd(),
  timeoutMs: 30_000,
  agents: { devin: { maxSessions: 10 } },
  limits,
});

describe('serve /v1/messages — the lane quota gate (bro-ezboq)', () => {
  let stateDir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_STATE_HOME;
    stateDir = mkdtempSync(join(tmpdir(), 'bro-lanebudget-'));
    process.env.XDG_STATE_HOME = stateDir;
  });

  afterEach(() => {
    if (prevXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevXdg;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('an exhausted bucket refuses a new spawn 429 BEFORE any session opens', async () => {
    // capacity 60: conv-a pays spawn 50 + turn 10 → empty; conv-b's
    // open then costs 50 it cannot afford (burst < spawnCost configs
    // drop at parse — the rateGate rule — so exhaustion is the live
    // refusal path)
    const cfg = base({
      'dv-acp': { requestsPerHour: 120, spawnCost: 50, burst: 60, turnCost: 10 },
    });
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      assert.equal((await post(url, [m('conv-a')])).status, 200);
      const res = await post(url, [m('conv-b')]);
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.match(await res.text(), /budget/);
      // the proof: the refused open paid for no second session
      assert.equal(fake.sessions.length, 1);
    } finally {
      await close();
    }
  });

  test('the bucket meters turns — a warm continuation drains it too', async () => {
    // capacity 10: open pays 6+2, each continuation pays 2
    const cfg = base({
      'dv-acp': { requestsPerHour: 3600, spawnCost: 6, burst: 10, turnCost: 2 },
    });
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      assert.equal((await post(url, [m('one')])).status, 200); // 8 spent, 2 left
      assert.equal((await post(url, [m('one'), m('two')])).status, 200); // 2 spent, 0 left
      const third = await post(url, [m('one'), m('two'), m('three')]);
      assert.equal(third.status, 429);
      assert.match(await third.text(), /budget/);
      // one retained session, no second open was paid for the refusal
      assert.equal(fake.sessions.length, 1);
    } finally {
      await close();
    }
  });

  test('a replay pays nothing — the resend never reaches the provider', async () => {
    // capacity 8: the open spends all of it — a replay must still pass
    const cfg = base({
      'dv-acp': { requestsPerHour: 3600, spawnCost: 6, burst: 8, turnCost: 2 },
    });
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      assert.equal((await post(url, [m('one')])).status, 200); // 8 spent → 0 left
      // identical resend = replay — recorded reply, zero provider spend
      const replay = await post(url, [m('one')]);
      assert.equal(replay.status, 200);
      // a genuinely new turn on the empty bucket refuses
      const fresh = await post(url, [m('one'), m('two')]);
      assert.equal(fresh.status, 429);
    } finally {
      await close();
    }
  });

  test('maxSessions refuses a second conversation on the lane', async () => {
    const cfg = base({ 'dv-acp': { maxSessions: 1 } });
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      assert.equal((await post(url, [m('conv-a')])).status, 200);
      // a different first turn fingerprints a different conversation —
      // the lane already holds one session
      const second = await post(url, [m('conv-b')]);
      assert.equal(second.status, 429);
      assert.match(await second.text(), /sessions/);
      assert.equal(fake.sessions.length, 1);
    } finally {
      await close();
    }
  });

  test('maxQueue refuses while a turn is in flight', async () => {
    const cfg = base({ 'dv-acp': { maxQueue: 1 } });
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const fake = fakeAcpAgent({ replyText: 'ok', holdPromptUntil: hold });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      const first = post(url, [m('slow')]);
      // the prompt reaching the fake means the turn is held inside
      // holdPromptUntil — in-flight for certain, no clock involved
      const deadline = Date.now() + 5_000;
      while (fake.prompts.length === 0) {
        if (Date.now() > deadline) throw new Error('first turn never reached the peer');
        await new Promise(r => setTimeout(r, 10));
      }
      const second = await post(url, [m('other')]);
      assert.equal(second.status, 429);
      assert.match(await second.text(), /queue/);
      release();
      assert.equal((await first).status, 200);
    } finally {
      release();
      await close();
    }
  });

  test('the ledger namespaces serve budgets away from fleet buckets', async () => {
    const cfg = base({
      'dv-acp': { requestsPerHour: 100, spawnCost: 10, burst: 50, turnCost: 1 },
    });
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      assert.equal((await post(url, [m('hi')])).status, 200);
      const files = readdirSync(join(stateDir, 'bro', 'lane-gate'));
      assert.ok(
        files.some(f => f.startsWith('serve%3Adv-acp')),
        `expected a serve:-namespaced ledger, got ${files.join(',')}`
      );
    } finally {
      await close();
    }
  });

  test('a lane without limits is ungated', async () => {
    const cfg: ConductorConfig = {
      backend: 'dv-acp',
      entry: { type: 'acp', command: 'dv acp' },
      cwd: process.cwd(),
      timeoutMs: 30_000,
      agents: { devin: { maxSessions: 10 } },
    };
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await post(url, [m(`turn-${i}`)])).status, 200);
      }
    } finally {
      await close();
    }
  });
});

describe('conductorConfig — serve.limits parsing', () => {
  test('limits parse per entry; malformed values drop', async () => {
    const { mkdtempSync: mk, writeFileSync } = await import('node:fs');
    const dir = mk(join(tmpdir(), 'bro-cfg-'));
    try {
      writeFileSync(
        join(dir, 'bro.config.json'),
        JSON.stringify({
          serve: {
            backend: 'devin-acp',
            limits: {
              'devin-acp': {
                requestsPerHour: 240,
                spawnCost: 20,
                burst: 60,
                turnCost: 2,
                maxSessions: 3,
                maxQueue: 8,
                bogus: 'drop-me',
              },
              'bad-entry': { requestsPerHour: -5, maxSessions: 1.5 },
              'empty-entry': {},
              // capacity (burst ?? rph) below spawnCost can never admit
              // one open — the rateGate rule drops the entry
              'bad-burst': { requestsPerHour: 100, spawnCost: 50, burst: 10 },
              // no burst — capacity defaults to requestsPerHour, which
              // clears spawnCost, so the entry survives
              'no-burst': { requestsPerHour: 100, spawnCost: 50, maxSessions: 2 },
            },
          },
          // the backend must resolve — a bare serve.backend with no
          // providers entry is a loud startup error, not a config
          providers: { 'devin-acp': { type: 'acp', command: 'dv acp' } },
        })
      );
      const cfg = conductorConfig({}, dir);
      assert.ok(cfg !== undefined);
      const lim = cfg.limits?.['devin-acp'];
      assert.ok(lim !== undefined);
      assert.equal(lim.requestsPerHour, 240);
      assert.equal(lim.spawnCost, 20);
      assert.equal(lim.burst, 60);
      assert.equal(lim.turnCost, 2);
      assert.equal(lim.maxSessions, 3);
      assert.equal(lim.maxQueue, 8);
      assert.equal((lim as Record<string, unknown>).bogus, undefined);
      // negative rph drops; fractional maxSessions drops; empty entry drops
      assert.equal(cfg.limits?.['bad-entry'], undefined);
      assert.equal(cfg.limits?.['empty-entry'], undefined);
      assert.equal(cfg.limits?.['bad-burst'], undefined);
      const noBurst = cfg.limits?.['no-burst'];
      assert.equal(noBurst?.spawnCost, 50);
      assert.equal(noBurst?.maxSessions, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

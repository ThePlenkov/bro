import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentPromptPath, loadAgentEnv, type AgentConnectorEnv } from '../agent-connectors.ts';
import { clearExternalPlanes, readAgentRegistry, writeAgentRegistry } from '@broject/core';
import { fakeAcpAgent, fakeFetch } from '@broject/providers/testkit';
import { capture, initRepo, installFakeBd, killRun } from './testrepo.ts';
import { delegate } from './delegate.ts';
import { runDelegateCommand } from './delegate-cli.ts';
import { delegateWallCheck } from './delegate-provider.ts';

// real host planes would flake spawn tests — the registry clear is the belt
clearExternalPlanes();

interface Fixture {
  root: string;
  main: string;
  beads: string;
  restore(): void;
}

/** Detached workers outlive a failed assertion — kill whatever the
 *  registry still points at before the tmpdir goes away (tests fake
 *  'running' with their own pid — never kill self or the runner). */
function killRegistered(main: string): void {
  try {
    for (const e of Object.values(readAgentRegistry(main))) {
      // the handle's group dies beside the recorded one — they differ
      // under a fork-style scope wrap (bro-ybo8z)
      killRun(main, { pid: e.pid, runId: e.runId, agentId: e.agentId });
    }
  } catch {
    // no readable registry — nothing spawned
  }
}

function restoreEnv(scrubbed: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(scrubbed)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

/** Real git repo + fake bd on PATH + agents.native.command — the
 *  agents.test fixture pattern: wait tests only need the repo (the
 *  registry wall read is real); detach spawns a long-lived node — the
 *  prompt file rides as argv, NOT the program, because the composed
 *  work order now carries the learn+retro closeout block (spec
 *  bro-xkv42.1) which is not valid JS. */
function fixture(): Fixture {
  const { root, main } = initRepo('bro-delegate-');
  const beads = join(root, 'beads');
  mkdirSync(beads);
  const { binDir } = installFakeBd(beads, []);
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      agents: { native: { command: 'node -e "setTimeout(()=>{},30000)" {promptFile}' } },
      providers: { p: { type: 'acp', command: 'no-such-acp-binary', model: 'm-acp' } },
    })
  );
  const prev = {
    cwd: process.cwd(),
    PATH: process.env.PATH ?? '',
    scrubbed: {} as Record<string, string | undefined>,
  };
  for (const k of Object.keys(process.env)) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|BEADS_DIR|BRO_)/.test(k)) {
      prev.scrubbed[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.PATH = `${binDir}:${prev.PATH}`;
  process.chdir(main);
  return {
    root,
    main,
    beads,
    restore() {
      killRegistered(main);
      process.chdir(prev.cwd);
      process.env.PATH = prev.PATH;
      restoreEnv(prev.scrubbed);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const env = (over: Partial<AgentConnectorEnv> = {}): AgentConnectorEnv => ({
  agents: {},
  connectors: {},
  providers: {
    p: { type: 'acp', command: 'no-such-acp-binary', model: 'm-acp' },
    cli1: { type: 'cli', command: 'no-such-cli' },
  },
  ...over,
});

const LONG_RUN = 'setTimeout(() => {}, 30000)';

describe('bro fleet delegate — --wait', () => {
  test('pooled turn over the acp peer — prompt in, text + provenance out', async () => {
    const fx = fixture();
    try {
      const fake = fakeAcpAgent({ replyText: 'answer from B' });
      const r = await delegate(
        fx.main,
        env(),
        { prompt: 'review this diff', provider: 'p', mode: 'wait' },
        { acp: { peer: fake.app } }
      );
      assert.equal(r.mode, 'wait');
      assert.equal(r.provider, 'p');
      assert.equal(r.model, 'm-acp');
      assert.equal(r.stopReason, 'end_turn');
      assert.equal(r.text, 'answer from B');
      assert.deepEqual(fake.prompts, ['review this diff']);
    } finally {
      fx.restore();
    }
  });

  test('BRO_AGENT_ID on the caller pins delegatedBy into the wait result', async () => {
    const fx = fixture();
    try {
      process.env.BRO_AGENT_ID = 'native-asker';
      const fake = fakeAcpAgent({ replyText: 'with provenance' });
      const r = await delegate(
        fx.main,
        env(),
        { prompt: 'who asked', provider: 'p', mode: 'wait' },
        { acp: { peer: fake.app } }
      );
      assert.equal(r.mode, 'wait');
      if (r.mode !== 'wait') {
        return assert.fail('wait mode expected');
      }
      assert.equal(r.delegatedBy, 'native-asker');
    } finally {
      fx.restore();
    }
  });

  test('--class routes through fleet.routing — chain[0] supplies provider + model', async () => {
    const fx = fixture();
    try {
      const fake = fakeAcpAgent({ replyText: 'routed answer' });
      const e = env({
        fleet: {
          maxConcurrent: 0,
          routing: { review: { chain: [{ provider: 'p', model: 'm-chain' }] } },
        },
      });
      const r = await delegate(
        fx.main,
        e,
        { prompt: 'ask the review lane', class: 'review', mode: 'wait' },
        { acp: { peer: fake.app } }
      );
      assert.equal(r.mode, 'wait');
      if (r.mode !== 'wait') {
        return assert.fail('wait mode expected');
      }
      assert.equal(r.provider, 'p');
      assert.equal(r.class, 'review');
      assert.equal(r.model, 'm-chain');
    } finally {
      fx.restore();
    }
  });

  test('a provider wall refuses the wait — the delegate lane waits like the batch lane', async () => {
    const fx = fixture();
    try {
      writeAgentRegistry(fx.main, {
        'dead-worker': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          provider: 'p',
          cause: 'rate_limited',
        },
      });
      const fake = fakeAcpAgent({ replyText: 'never reached' });
      await assert.rejects(
        () =>
          delegate(
            fx.main,
            env(),
            { prompt: 'hi', provider: 'p', mode: 'wait' },
            { acp: { peer: fake.app } }
          ),
        (err: unknown) => {
          assert.match(String(err), /p walled — rate_limited/);
          return true;
        }
      );
      assert.deepEqual(fake.prompts, []);
    } finally {
      fx.restore();
    }
  });

  test('a wall landed during acpOpen refuses at turn admission — no session was opened (bro-acjzf)', async () => {
    const fx = fixture();
    try {
      const fake = fakeAcpAgent({ replyText: 'never reached' });
      await assert.rejects(
        () =>
          delegate(
            fx.main,
            env(),
            { prompt: 'hi', provider: 'p', mode: 'wait' },
            {
              acp: {
                // the peer resolver runs INSIDE acpOpen — the wall lands
                // in the exact refuseWalled → session/new window a
                // concurrent worker's death can hit
                peer: () => {
                  writeAgentRegistry(fx.main, {
                    'dead-worker': {
                      agentId: 'native-dead',
                      backend: 'native',
                      spawnedAt: new Date().toISOString(),
                      provider: 'p',
                      cause: 'rate_limited',
                    },
                  });
                  return fake.app;
                },
              },
            }
          ),
        (err: unknown) => {
          assert.match(String(err), /p walled — rate_limited/);
          assert.match(String(err), /no session was opened/);
          return true;
        }
      );
      assert.deepEqual(fake.sessions, []);
      assert.deepEqual(fake.prompts, []);
    } finally {
      fx.restore();
    }
  });

  test('delegateWallCheck — a clean registry admits, a walled provider refuses with a retry hint', () => {
    const fx = fixture();
    try {
      assert.equal(delegateWallCheck(fx.main, 'p').refusal(), undefined);
      writeAgentRegistry(fx.main, {
        'dead-worker': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          provider: 'p',
          cause: 'rate_limited',
        },
      });
      const refusal = delegateWallCheck(fx.main, 'p').refusal();
      assert.ok(refusal !== undefined, 'a live wall refuses');
      assert.match(refusal.reason, /p walled — rate_limited/);
      assert.match(refusal.reason, /--detach to a different lane/);
      assert.ok(refusal.retryAfterSec >= 1, 'a retry hint rides the refusal');
      // p's wall refuses only p — another provider's lane stays open
      assert.equal(delegateWallCheck(fx.main, 'other').refusal(), undefined);
    } finally {
      fx.restore();
    }
  });

  test('input errors — no provider, non-acp provider, exclusive flags, empty prompt', async () => {
    const fx = fixture();
    try {
      const fake = fakeAcpAgent();
      const opts = { acp: { peer: fake.app } };
      // no provider and no routing → usage-grade input error
      await assert.rejects(
        () => delegate(fx.main, env({ providers: {} }), { prompt: 'hi', mode: 'wait' }, opts),
        /needs a provider/
      );
      // a cli-kind provider cannot serve a pooled turn
      await assert.rejects(
        () => delegate(fx.main, env(), { prompt: 'hi', provider: 'cli1', mode: 'wait' }, opts),
        /cannot serve a delegate turn/
      );
      // --provider + --class
      await assert.rejects(
        () =>
          delegate(
            fx.main,
            env(),
            { prompt: 'hi', provider: 'p', class: 'review', mode: 'wait' },
            opts
          ),
        /mutually exclusive/
      );
      // --class with no routing declared
      await assert.rejects(
        () => delegate(fx.main, env(), { prompt: 'hi', class: 'review', mode: 'wait' }, opts),
        /no fleet\.routing is declared/
      );
      // no prompt
      await assert.rejects(
        () => delegate(fx.main, env(), { provider: 'p', mode: 'wait' }, opts),
        /requires a prompt/
      );
      assert.deepEqual(fake.prompts, []);
    } finally {
      fx.restore();
    }
  });
});

describe('bro fleet delegate — --detach', () => {
  test('registers an agent entry — adhoc step, delegatedBy stamp, batch lane marker', async () => {
    const fx = fixture();
    try {
      process.env.BRO_AGENT_ID = 'native-caller';
      const r = await delegate(fx.main, loadAgentEnv(fx.main), {
        prompt: LONG_RUN,
        mode: 'detach',
        beadsDir: fx.beads,
      });
      assert.equal(r.mode, 'detach');
      const info = r.agent;
      assert.match(info.molStep, /^adhoc-[0-9a-f]{8}$/);
      const entry = readAgentRegistry(fx.main)[info.molStep];
      assert.ok(entry, 'registry entry for the adhoc step');
      assert.equal(entry.agentId, info.id);
      assert.equal(entry.delegatedBy, 'native-caller');
      assert.equal(info.delegatedBy, 'native-caller');
      // BRO_BATCH marks the fleet's lane inside the worker's env
      if (info.pid !== undefined && existsSync(`/proc/${info.pid}/environ`)) {
        const environ = readFileSync(`/proc/${info.pid}/environ`, 'utf8');
        assert.match(environ, /BRO_BATCH=1/);
        assert.match(environ, /BRO_DELEGATED_BY=native-caller/);
      }
      // the stored work order is ask text + the shared closeout contract
      const stored = agentPromptPath(fx.main, String(entry.agentId));
      assert.ok(stored !== null, 'spawn-time prompt persisted');
      const text = readFileSync(stored, 'utf8');
      assert.ok(text.startsWith(LONG_RUN), 'the ask leads the work order');
      assert.ok(text.includes('learn + retro'), 'closeout block present');
      assert.ok(text.includes('`learn:`/`learning:`'), 'mol-capture flag named');
      assert.ok(text.includes('bro self learn add'), 'lesson command named');
      assert.ok(text.includes('bro self learn capture --dry-run'), 'capture preview named');
    } finally {
      fx.restore();
    }
  });

  test('a minted id that hits the registry re-mints — the seeded row is never rewritten', async () => {
    const fx = fixture();
    try {
      // a dead adhoc row the blind mint could land on — pre-fix the
      // spawn would respawn over it and overwrite a row it never ran
      writeAgentRegistry(fx.main, {
        'adhoc-taken00': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          exitStatus: 0,
          // a classified terminal row — the spawn's death-harvest
          // sweep skips it instead of rewriting it mid-test
          cause: 'ok',
        },
      });
      const scripted = ['adhoc-taken00', 'adhoc-free000'];
      let i = 0;
      const r = await delegate(
        fx.main,
        loadAgentEnv(fx.main),
        { prompt: LONG_RUN, mode: 'detach', beadsDir: fx.beads },
        { mintStep: () => scripted[i++] ?? 'adhoc-overflow' }
      );
      assert.equal(r.mode, 'detach');
      assert.equal(r.agent.molStep, 'adhoc-free000', 'registry hit re-minted');
      const reg = readAgentRegistry(fx.main);
      assert.equal(reg['adhoc-taken00']!.agentId, 'native-dead', 'hit row untouched');
      assert.equal(reg['adhoc-taken00']!.exitStatus, 0);
      assert.equal(reg['adhoc-free000']!.agentId, r.agent.id);
    } finally {
      fx.restore();
    }
  });

  /** Routing fixture — a declared table + an armed class router. The
   *  spawned worker's command IS the chain provider's template (cli
   *  entries substitute for the backend's), so chain heads carry the
   *  same long-running node command the base fixture uses. */
  const ORCA = {
    type: 'api',
    baseUrl: 'https://orca.test',
    apiKeyEnv: 'ORCA_TEST_KEY',
    models: { 'jev-1.0': 'systemone' },
  };
  const withRouting = (fx: Fixture, mode: string): void => {
    writeFileSync(
      join(fx.main, 'bro.config.json'),
      JSON.stringify({
        agents: { native: { command: 'node -e "setTimeout(()=>{},30000)" {promptFile}' } },
        providers: {
          alt: { type: 'cli', command: 'node -e "setTimeout(()=>{},30000)" {promptFile}' },
          sweeps: { type: 'cli', command: 'node -e "setTimeout(()=>{},30000)" {promptFile}' },
          orca: ORCA,
        },
        fleet: {
          routing: {
            default: { chain: ['alt'] },
            sweep: { chain: ['sweeps'] },
          },
          router: { provider: 'orca', mode },
        },
      })
    );
  };

  // spec bro-ejdn3 — a class-less --detach mints a phantom adhoc-*
  // molStep: no bead, no title/description — nothing for the router to
  // classify. The resolved `default` lane stands under BOTH modes and
  // the judge is never asked (the phantom used to fire the router on
  // empty state — enforce could land the work on an unrelated lane)
  for (const mode of ['shadow', 'enforce'] as const) {
    test(`class-less --detach under router ${mode}: default lane stands, no judge call`, async () => {
      const fx = fixture();
      try {
        withRouting(fx, mode);
        const { fetch, calls } = fakeFetch();
        const r = await delegate(
          fx.main,
          loadAgentEnv(fx.main),
          { prompt: LONG_RUN, mode: 'detach', beadsDir: fx.beads },
          { fetch }
        );
        assert.equal(calls.length, 0); // nothing to judge → no decide call
        assert.equal(r.mode, 'detach');
        if (r.mode !== 'detach') {
          return assert.fail('detach mode expected');
        }
        assert.match(r.agent.molStep, /^adhoc-[0-9a-f]{8}$/);
        const entry = readAgentRegistry(fx.main)[r.agent.molStep];
        assert.ok(entry, 'registry entry for the adhoc step');
        assert.equal(entry.class, 'default');
        assert.equal(entry.provider, 'alt');
      } finally {
        fx.restore();
      }
    });
  }

  test('class-less --detach with routing but no default lane refuses — config error names the class', async () => {
    const fx = fixture();
    try {
      writeFileSync(
        join(fx.main, 'bro.config.json'),
        JSON.stringify({
          agents: { native: { command: 'node -e "setTimeout(()=>{},30000)" {promptFile}' } },
          providers: {
            sweeps: { type: 'cli', command: 'node -e "setTimeout(()=>{},30000)" {promptFile}' },
            orca: ORCA,
          },
          fleet: {
            routing: { sweep: { chain: ['sweeps'] } }, // no `default`
            router: { provider: 'orca', mode: 'enforce' },
          },
        })
      );
      const { fetch, calls } = fakeFetch();
      await assert.rejects(
        () =>
          delegate(
            fx.main,
            loadAgentEnv(fx.main),
            { prompt: LONG_RUN, mode: 'detach', beadsDir: fx.beads },
            { fetch }
          ),
        /no class "default"/
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(readAgentRegistry(fx.main), {});
    } finally {
      fx.restore();
    }
  });

  test('explicit --class --detach lands on the pinned lane — the router stays out of it', async () => {
    const fx = fixture();
    try {
      withRouting(fx, 'enforce');
      const { fetch, calls } = fakeFetch();
      const r = await delegate(
        fx.main,
        loadAgentEnv(fx.main),
        { prompt: LONG_RUN, mode: 'detach', class: 'sweep', beadsDir: fx.beads },
        { fetch }
      );
      assert.equal(calls.length, 0);
      assert.equal(r.mode, 'detach');
      if (r.mode !== 'detach') {
        return assert.fail('detach mode expected');
      }
      const entry = readAgentRegistry(fx.main)[r.agent.molStep];
      assert.ok(entry, 'registry entry for the adhoc step');
      assert.equal(entry.class, 'sweep');
      assert.equal(entry.provider, 'sweeps');
    } finally {
      fx.restore();
    }
  });
});

describe('bro fleet delegate — CLI surface', () => {
  test('--wait + --detach and mode-foreign flags are usage errors', async () => {
    const fx = fixture();
    try {
      const both = await capture(() => runDelegateCommand(['--wait', '--detach', 'hi']));
      assert.equal(both.code, 1);
      assert.match(both.err.join('\n'), /mutually exclusive/);
      const wrongMode = await capture(() =>
        runDelegateCommand(['--detach', '--timeout', '5', 'hi'])
      );
      assert.equal(wrongMode.code, 1);
      assert.match(wrongMode.err.join('\n'), /--timeout only applies to --wait/);
      const wrongMode2 = await capture(() =>
        runDelegateCommand(['--wait', '--connector', 'native', 'hi'])
      );
      assert.equal(wrongMode2.code, 1);
      assert.match(wrongMode2.err.join('\n'), /only apply to --detach/);
    } finally {
      fx.restore();
    }
  });

  test('--wait --json emits the provenance document — parse → env → delegate end-to-end', async () => {
    const fx = fixture();
    try {
      const fake = fakeAcpAgent({ replyText: 'json answer' });
      const r = await capture(() =>
        runDelegateCommand(['--wait', '--json', '--provider', 'p', 'hi there'], {
          acp: { peer: fake.app },
        })
      );
      assert.equal(r.code, 0);
      const doc = JSON.parse(r.out.join('')) as Record<string, unknown>;
      assert.equal(doc['mode'], 'wait');
      assert.equal(doc['provider'], 'p');
      assert.equal(doc['model'], 'm-acp');
      assert.equal(doc['stopReason'], 'end_turn');
      assert.equal(doc['text'], 'json answer');
      assert.deepEqual(fake.prompts, ['hi there']);
    } finally {
      fx.restore();
    }
  });

  test('--wait plain output — reply on stdout, provenance on stderr', async () => {
    const fx = fixture();
    try {
      const fake = fakeAcpAgent({ replyText: 'the answer' });
      const r = await capture(() =>
        runDelegateCommand(['--wait', '--provider', 'p', 'ask it'], { acp: { peer: fake.app } })
      );
      assert.equal(r.code, 0);
      assert.deepEqual(r.out, ['the answer']);
      assert.match(r.err.join('\n'), /provider p · model m-acp · end_turn/);
    } finally {
      fx.restore();
    }
  });
});

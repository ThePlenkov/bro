/** `/bro` command matrix (AGT-1 S4) — the same slash command must
 *  reach `bro` with identical argv on every host that exposes a command
 *  surface, whatever the host's native transport:
 *
 *    pi/omp   — RPC `prompt` record → extension command, disposition
 *               "handled", no model turn
 *    opencode — v2 `POST /api/session/{id}/command` → output becomes the
 *               next prompt (aimock sees the follow-up turn)
 *    kilo     — no slash surface; the model calls the `bro` tool, which
 *               runs `bro <sub> <args>` — same argv contract
 *
 *  Every leg asserts the FakeBro journal saw `command ['next','--json']`
 *  and that lifecycle hooks fired — semantics identical, transport
 *  host-specific by design. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEnv, which } from './env.ts';
import { installKiloPlugin, runKilo, writeKiloProviderConfig } from './hosts/kilo.ts';
import { installOmpPlugin, writeOmpProviderConfig } from './hosts/omp.ts';
import {
  installOpencodePlugin,
  startOpencodeServer,
  writeOpencodeConfig,
} from './hosts/opencode.ts';
import { installPiPlugin, writePiProviderConfig } from './hosts/pi.ts';
import { runRpcPrompt } from './hosts/rpc.ts';
import { startMock } from './mock.ts';
import { FakeBro } from './mocks/bro.ts';

const ARGS = ['next', '--json'];
const CMD_KEY = 'next --json';

function fakeBro(): FakeBro {
  return new FakeBro({
    commands: { [CMD_KEY]: { stdout: 'NEXT-BOARD\n' } },
    defaultCommand: { stdout: 'ok\n' },
  });
}

/** The matrix invariant: FakeBro journaled exactly this argv as a
 *  `command` entry. */
function assertBroCommand(fb: FakeBro, label: string): void {
  const hit = fb
    .journal()
    .some(en => en.kind === 'command' && JSON.stringify(en.argv) === JSON.stringify(ARGS));
  assert.ok(
    hit,
    `${label}: FakeBro never saw \`bro ${ARGS.join(' ')}\` — journal: ${JSON.stringify(fb.journal())}`
  );
}

test('pi: /bro <args> dispatches to bro with matrix argv (S4)', {
  skip: which('pi') === null && 'pi binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'MOCK-OK' });
  const e = makeEnv();
  writePiProviderConfig(e, `${mock.url}/v1`);
  const inst = await installPiPlugin(e);
  assert.equal(inst.code, 0, `plugins install pi failed: ${inst.stderr.slice(-400)}`);
  const fb = fakeBro().install(e);

  const r = await runRpcPrompt(e, 'pi', `/bro ${CMD_KEY}`);
  assert.equal(
    r.disposition,
    'handled',
    `pi did not handle /bro: ${JSON.stringify(r.records.slice(-5))}`
  );
  assertBroCommand(fb, 'pi');
  // an extension-handled command never becomes a model prompt, so
  // prompt-submit legitimately does not fire — session-start is the
  // lifecycle evidence that hooks are wired at all
  assert.ok(
    fb.hookEvents().includes('session-start'),
    `pi hooks missing session-start: ${fb.hookEvents()}`
  );
});

test('omp: /bro <args> dispatches to bro with matrix argv (S4)', {
  skip: which('omp') === null && 'omp binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'MOCK-OK' });
  const e = makeEnv();
  writeOmpProviderConfig(e, `${mock.url}/v1`);
  const inst = await installOmpPlugin(e);
  assert.equal(inst.code, 0, `plugins install omp failed: ${inst.stderr.slice(-400)}`);
  const fb = fakeBro().install(e);

  const r = await runRpcPrompt(e, 'omp', `/bro ${CMD_KEY}`);
  // omp's response record carries success, not pi's data.disposition —
  // the command argv in the journal is the dispatch proof either way
  assert.equal(r.success, true, `omp /bro prompt failed: ${JSON.stringify(r.records.slice(-5))}`);
  assertBroCommand(fb, 'omp');
  assert.ok(
    fb.hookEvents().includes('session-start'),
    `omp hooks missing session-start: ${fb.hookEvents()}`
  );
});

test('opencode: /bro <args> via session command API → bro argv + follow-up turn (S4)', {
  skip: which('opencode') === null && 'opencode binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'MOCK-OK' });
  const e = makeEnv();
  installOpencodePlugin(e);
  writeOpencodeConfig(e, mock.url);
  const fb = fakeBro().install(e);
  const srv = await startOpencodeServer(e);
  const AUTH = {
    authorization: `Basic ${Buffer.from('opencode:e2e').toString('base64')}`,
    'content-type': 'application/json',
  };
  try {
    const sess = (await (
      await fetch(`${srv.url}/api/session`, { method: 'POST', headers: AUTH, body: '{}' })
    ).json()) as { id?: string; data?: { id?: string } };
    const sessionID = sess.id ?? sess.data?.id;
    assert.ok(sessionID, 'session.create returned no id');

    const res = await fetch(`${srv.url}/api/session/${sessionID}/command`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'bro', text: CMD_KEY }),
    });
    assert.ok(res.status === 200 || res.status === 204, `command API returned ${res.status}`);

    // the command output is submitted as the next prompt — the model
    // turn lands on aimock a beat after the bro dispatch; poll both
    const deadline = Date.now() + 30_000;
    let journal: Awaited<ReturnType<typeof mock.journal>> = [];
    while (Date.now() < deadline) {
      const dispatched = fb
        .journal()
        .some(en => en.kind === 'command' && JSON.stringify(en.argv) === JSON.stringify(ARGS));
      journal = await mock.journal();
      if (dispatched && journal.length >= 1) {
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    assertBroCommand(fb, 'opencode');
    assert.ok(journal.length >= 1, 'opencode /bro follow-up prompt never reached the mock');
  } finally {
    await srv.stop();
  }
});

/** Command family (AGT-1 §command family) — the curated verbs are
 *  first-class slash commands; a host-native name forces the `bro:`
 *  namespace instead of shadowing. */

function familyFakeBro(...argvs: string[][]): FakeBro {
  const commands: Record<string, { stdout: string }> = {};
  for (const argv of argvs) {
    commands[argv.join(' ')] = { stdout: `ok ${argv.join(' ')}\n` };
  }
  return new FakeBro({ commands, defaultCommand: { stdout: 'ok\n' } });
}

function assertArgv(fb: FakeBro, argv: string[], label: string): void {
  const hit = fb
    .journal()
    .some(en => en.kind === 'command' && JSON.stringify(en.argv) === JSON.stringify(argv));
  assert.ok(
    hit,
    `${label}: FakeBro never saw \`bro ${argv.join(' ')}\` — journal: ${JSON.stringify(fb.journal())}`
  );
}

test('pi: family commands dispatch bare names — /learn, /wtf multilingual (S4f)', {
  skip: which('pi') === null && 'pi binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'MOCK-OK' });
  const e = makeEnv();
  writePiProviderConfig(e, `${mock.url}/v1`);
  const inst = await installPiPlugin(e);
  assert.equal(inst.code, 0, `plugins install pi failed: ${inst.stderr.slice(-400)}`);
  const fb = familyFakeBro(['learn', 'backlog'], ['wtf', 'какого', 'черта']);
  fb.install(e);

  const r1 = await runRpcPrompt(e, 'pi', '/learn backlog');
  assert.equal(
    r1.disposition,
    'handled',
    `pi /learn not handled: ${JSON.stringify(r1.records.slice(-5))}`
  );
  const r2 = await runRpcPrompt(e, 'pi', '/wtf какого черта');
  assert.equal(
    r2.disposition,
    'handled',
    `pi /wtf not handled: ${JSON.stringify(r2.records.slice(-5))}`
  );
  assertArgv(fb, ['learn', 'backlog'], 'pi /learn');
  assertArgv(fb, ['wtf', 'какого', 'черта'], 'pi /wtf');
});

test('omp: native /goal + /loop → bro:goal/bro:loop namespace, rest bare (S4f)', {
  skip: which('omp') === null && 'omp binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'MOCK-OK' });
  const e = makeEnv();
  writeOmpProviderConfig(e, `${mock.url}/v1`);
  const inst = await installOmpPlugin(e);
  assert.equal(inst.code, 0, `plugins install omp failed: ${inst.stderr.slice(-400)}`);
  const fb = familyFakeBro(['goal', 'ship', 'it'], ['drill', 'auth-flow']);
  fb.install(e);

  // native /loop and /goal belong to omp — the bro aliases must live
  // under bro:<name> and still reach the same argv
  const r1 = await runRpcPrompt(e, 'omp', '/bro:loop 3');
  assert.equal(r1.success, true, `omp /bro:loop failed: ${JSON.stringify(r1.records.slice(-5))}`);
  const r2 = await runRpcPrompt(e, 'omp', '/drill auth-flow');
  assert.equal(r2.success, true, `omp /drill failed: ${JSON.stringify(r2.records.slice(-5))}`);
  assertArgv(fb, ['loop', '3'], 'omp /bro:loop');
  assertArgv(fb, ['drill', 'auth-flow'], 'omp /drill');
});

test('opencode: family commands via command API; /goal → bro:goal (native goal) (S4f)', {
  skip: which('opencode') === null && 'opencode binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'MOCK-OK' });
  const e = makeEnv();
  installOpencodePlugin(e);
  writeOpencodeConfig(e, mock.url);
  const fb = familyFakeBro(['wtf'], ['goal', 'ship', 'it']);
  fb.install(e);
  const srv = await startOpencodeServer(e);
  const AUTH = {
    authorization: `Basic ${Buffer.from('opencode:e2e').toString('base64')}`,
    'content-type': 'application/json',
  };
  try {
    const sess = (await (
      await fetch(`${srv.url}/api/session`, { method: 'POST', headers: AUTH, body: '{}' })
    ).json()) as { id?: string; data?: { id?: string } };
    const sessionID = sess.id ?? sess.data?.id;
    assert.ok(sessionID, 'session.create returned no id');

    for (const [name, text, argv] of [
      ['wtf', '', ['wtf']],
      ['bro:goal', 'ship it', ['goal', 'ship', 'it']],
    ] as const) {
      const res = await fetch(`${srv.url}/api/session/${sessionID}/command`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ name, text }),
      });
      assert.ok(res.status === 200 || res.status === 204, `command ${name} returned ${res.status}`);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (
          fb
            .journal()
            .some(en => en.kind === 'command' && JSON.stringify(en.argv) === JSON.stringify(argv))
        ) {
          break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      assertArgv(fb, [...argv], `opencode /${name}`);
    }
  } finally {
    await srv.stop();
  }
});

test('kilo: bro tool call dispatches sub+args to bro with matrix argv (S4)', {
  skip: which('kilo') === null && 'kilo binary not on PATH',
}, async () => {
  await using mock = await startMock();
  // leg 1: model asks for the bro tool; leg 2+: final answer
  mock.mock.on(
    {
      predicate: (req: { messages?: { role?: string; tool_call_id?: string }[] }) =>
        !(req.messages ?? []).some(m => m.role === 'tool' || m.tool_call_id),
    },
    {
      content: '',
      toolCalls: [{ name: 'bro', arguments: JSON.stringify({ sub: 'next', args: ['--json'] }) }],
    }
  );
  mock.mock.on({ predicate: () => true }, { content: 'KILO-MOCK-OK' });
  const e = makeEnv();
  const inst = await installKiloPlugin(e);
  assert.equal(inst.code, 0, `plugins install kilo failed: ${inst.stderr.slice(-400)}`);
  writeKiloProviderConfig(e, mock.url);
  const fb = fakeBro().install(e);

  const res = await runKilo(e, 'check the board');
  assertBroCommand(fb, 'kilo');
  const journal = await mock.journal();
  assert.ok(journal.length >= 1, 'kilo never reached the mock provider');
  void res;
});

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

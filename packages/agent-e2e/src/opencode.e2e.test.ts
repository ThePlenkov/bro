/** opencode × aimock e2e — the catalog plugin installed into an
 *  isolated HOME, the `mock` provider pointed at the aimock endpoint,
 *  and `opencode run` driving a real session. Assertions read the
 *  aimock journal: whatever the plugin injected (session-start context,
 *  prompt nudges) is visible in the recorded request bodies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock.ts';
import { makeEnv, which } from './env.ts';
import { installOpencodePlugin, runOpencode, writeOpencodeConfig } from './hosts/opencode.ts';

test('opencode run completes a turn against the mock LLM', {
  skip: which('opencode') === null && 'opencode binary not on PATH',
}, async () => {
  await using mock = await startMock();
  // catch-all reply — registered last so specific fixtures can precede it
  mock.mock.on({ predicate: () => true }, { content: 'mock says hi' });
  const e = makeEnv();
  installOpencodePlugin(e);
  writeOpencodeConfig(e, mock.url);

  const res = await runOpencode(e, 'say hi');
  assert.equal(res.code, 0, `opencode exited ${res.code}\nstderr: ${res.stderr.slice(-2000)}`);
  const journal = await mock.journal();
  assert.ok(journal.length >= 1, 'mock saw no requests — provider traffic never reached the mock');
  // opencode fires a tool-less title-gen call alongside the agent call —
  // the agent request is the one carrying a tools array
  const bodies = journal.map(
    en =>
      en.body as {
        messages?: { role: string; content: unknown }[];
        tools?: { function?: { name?: string } }[];
      }
  );
  const agentBody =
    bodies.find(b => Array.isArray(b.tools) && b.tools.length > 0) ?? bodies.at(-1)!;
  assert.ok(Array.isArray(agentBody.messages) && agentBody.messages.length > 0);
  // the turn must actually carry the mock's reply — a bare exit is not proof
  assert.match(res.stdout, /mock says hi/, 'opencode output never showed the mock reply');
  // plugin surface: the 8 bro_* read tools must reach the model as direct
  // function tools — codemode-only exposure is a spec violation (AGT-6)
  const toolNames = (agentBody.tools ?? []).map(t => t.function?.name ?? '');
  const broTools = toolNames.filter(n => n.startsWith('bro_'));
  assert.ok(
    broTools.length >= 8,
    `expected >=8 bro_* tools in request, got ${broTools.length}: ${toolNames.join(',')}`
  );
});

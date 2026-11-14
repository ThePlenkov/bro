/** pi × aimock e2e — real `bro plugins install pi` into the fixture
 *  HOME, custom openai-completions provider at the aimock endpoint,
 *  headless `pi -p` turn. Asserts the LLM path AND the plugin
 *  surface: `bro_status` must reach the model as a function tool
 *  (AGT-7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock.ts';
import { makeEnv, which } from './env.ts';
import { installPiPlugin, runPi, writePiProviderConfig } from './hosts/pi.ts';

test('pi run completes a turn against the mock LLM (S-coverage: bro_status tool + journal)', {
  skip: which('pi') === null && 'pi binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'PI-MOCK-OK' });
  const e = makeEnv();
  writePiProviderConfig(e, `${mock.url}/v1`);

  const inst = await installPiPlugin(e);
  assert.equal(
    inst.code,
    0,
    `plugins install failed: ${inst.stderr.slice(-500)}${inst.stdout.slice(-500)}`
  );
  const ext = join(e.home, '.pi', 'agent', 'extensions', 'bro.ts');
  assert.ok(existsSync(ext), `plugin not installed at ${ext}`);

  const res = await runPi(e, 'say hi');
  assert.equal(res.code, 0, `pi exited ${res.code}\nstderr: ${res.stderr.slice(-1500)}`);
  const journal = await mock.journal();
  assert.ok(journal.length >= 1, 'aimock saw no requests');
  assert.match(res.stdout, /PI-MOCK-OK/, 'pi output never showed the mock reply');
  const names = journal
    .flatMap(en => (en.body as { tools?: { function?: { name?: string } }[] }).tools ?? [])
    .map(t => t.function?.name ?? '');
  assert.ok(names.includes('bro_status'), `bro_status missing from tools: ${names.join(',')}`);
});

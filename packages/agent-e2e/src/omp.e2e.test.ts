/** omp × aimock e2e — real `bro plugins install omp` into the fixture
 *  HOME, custom openai-completions provider at the aimock endpoint,
 *  headless `omp -p` turn. Asserts the LLM path AND the plugin
 *  surface: `bro_status` must reach the model as a function tool
 *  (AGT-8). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock.ts';
import { makeEnv, which } from './env.ts';
import { installOmpPlugin, runOmp, writeOmpProviderConfig } from './hosts/omp.ts';

test('omp run completes a turn against the mock LLM (S-coverage: bro_status tool + journal)', {
  skip: which('omp') === null && 'omp binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'OMP-MOCK-OK' });
  const e = makeEnv();
  writeOmpProviderConfig(e, `${mock.url}/v1`);

  const inst = await installOmpPlugin(e);
  assert.equal(
    inst.code,
    0,
    `plugins install failed: ${inst.stderr.slice(-500)}${inst.stdout.slice(-500)}`
  );
  const ext = join(e.home, '.omp', 'agent', 'extensions', 'bro.ts');
  assert.ok(existsSync(ext), `plugin not installed at ${ext}`);

  const res = await runOmp(e, 'say hi');
  assert.equal(res.code, 0, `omp exited ${res.code}\nstderr: ${res.stderr.slice(-1500)}`);
  const journal = await mock.journal();
  assert.ok(journal.length >= 1, 'aimock saw no requests');
  assert.match(res.stdout, /OMP-MOCK-OK/, 'omp output never showed the mock reply');
  const names = journal
    .flatMap(en => (en.body as { tools?: { function?: { name?: string } }[] }).tools ?? [])
    .map(t => t.function?.name ?? '');
  assert.ok(names.includes('bro_status'), `bro_status missing from tools: ${names.join(',')}`);
});

/** ScriptedCli e2e — arbitrary CLI deps shadowed on the fixture PATH.
 *  Proves the mechanism: journal captures argv, rules answer, fallback
 *  catches the rest. The bd/gh/dolt scenarios plug into real-bro runs
 *  the same way FakeBro plugs into host-plugin runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, run } from './env.ts';
import { ScriptedCli } from './mocks/shim.ts';

test('scripted bd answers ready/show and journals argv', async () => {
  const e = makeEnv();
  const bd = new ScriptedCli('bd', {
    rules: [
      { match: 'ready', stdout: '[{"id":"bro-1","title":"mock bead","status":"open"}]\n' },
      { match: 'show', stdout: 'bro-1 mock bead\n' },
    ],
    fallback: { code: 1, stderr: 'unknown bd verb\n' },
  }).install(e);

  const ready = await run('bd', ['ready', '--json'], { cwd: e.proj, env: e.env });
  assert.equal(ready.code, 0);
  assert.match(ready.stdout, /bro-1/);
  const show = await run('bd', ['show', 'bro-1'], { cwd: e.proj, env: e.env });
  assert.match(show.stdout, /mock bead/);
  const bogus = await run('bd', ['bogus-verb'], { cwd: e.proj, env: e.env });
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /unknown bd verb/);

  const journal = bd.journal();
  assert.equal(journal.length, 3);
  assert.deepEqual(journal[0].argv, ['ready', '--json']);
  assert.equal(journal[0].bin, 'bd');
  assert.equal(journal[0].cwd, e.proj);
});

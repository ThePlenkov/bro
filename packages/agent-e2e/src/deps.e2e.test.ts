/** S8 service-degraded — real `bro hooks` against ScriptedCli dep
 *  shims. The contract (AGT-1): a failing downstream dep must never
 *  break the hook — degraded context is allowed, the dep journal
 *  proves the call was attempted. Here `bd` fails on everything;
 *  post-tool's learn-evidence probe lists lessons through it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, run } from './env.ts';
import { ScriptedCli } from './mocks/shim.ts';

function beadsEnv() {
  return makeEnv({
    seed: proj => {
      mkdirSync(join(proj, '.beads'), { recursive: true });
      writeFileSync(
        join(proj, '.beads', 'issues.jsonl'),
        '{"id":"bro-1","title":"seed","status":"open"}\n'
      );
    },
  });
}

test('S8: failing bd dep — hooks stay fail-open, dep journal records the call', {
  skip: false,
}, async () => {
  const e = beadsEnv();
  const bd = new ScriptedCli('bd', {
    fallback: { code: 1, stderr: 'fake bd: store unreachable\n' },
  }).install(e);

  const payload = JSON.stringify({
    session_id: 's1',
    cwd: e.proj,
    tool_name: 'shell',
    tool_input: { command: 'ls' },
    tool_response: { success: true },
  });
  const r = await run('bro', ['hooks', 'post-tool'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs: 60000,
    input: payload,
  });
  assert.equal(r.code, 0, `hook broke on dep failure: ${r.stderr.slice(-400)}`);

  const calls = bd.journal().map(j => j.argv.join(' '));
  assert.ok(
    calls.some(a => a.startsWith('kv list')),
    `expected a bd kv list probe, journal: ${JSON.stringify(calls)}`
  );
});

test('S8: healthy bd dep — kv list answer flows into the probe path', async () => {
  const e = beadsEnv();
  const bd = new ScriptedCli('bd', {
    rules: [{ match: 'kv list', stdout: '[]\n' }],
    fallback: { code: 1, stderr: 'fake bd: unhandled\n' },
  }).install(e);

  const payload = JSON.stringify({
    session_id: 's1',
    cwd: e.proj,
    tool_name: 'shell',
    tool_input: { command: 'ls' },
    tool_response: { success: true },
  });
  const r = await run('bro', ['hooks', 'post-tool'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs: 60000,
    input: payload,
  });
  assert.equal(r.code, 0);
  const calls = bd.journal().map(j => j.argv.join(' '));
  assert.ok(calls.some(a => a.startsWith('kv list')));
});

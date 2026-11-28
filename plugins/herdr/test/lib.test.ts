import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsJson, MAX_OUTPUT, runAsync, STATE_DIR, withStateLockAsync } from '../src/lib.ts';

function fixture(registry: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), 'herdr-agents-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const bro = join(repo, '.git', 'bro');
  mkdirSync(bro, { recursive: true });
  writeFileSync(join(bro, 'agents.json'), JSON.stringify(registry));
  return repo;
}

const valid = {
  agentId: 'native-1',
  backend: 'native',
  worktree: '/tmp/worktree',
  log: '/tmp/agent.log',
  pid: 123,
};

test('agentsJson rejects an array at the registry boundary', () => {
  assert.deepEqual(agentsJson(fixture([valid])), {});
});

test('agentsJson skips an entry with no log field', () => {
  assert.deepEqual(agentsJson(fixture({ missingLog: { ...valid, log: undefined } })), {});
});

test('agentsJson skips an entry with a wrong-typed worktree', () => {
  assert.deepEqual(agentsJson(fixture({ wrongWorktree: { ...valid, worktree: 42 } })), {});
});

test('agentsJson retains well-shaped entries beside malformed entries', () => {
  assert.deepEqual(
    agentsJson(
      fixture({
        valid,
        wrongWorktree: { ...valid, worktree: false },
        missingLog: { ...valid, log: null },
      })
    ),
    { valid }
  );
});

test('runAsync bounds both streams when either stream exceeds the limit', async () => {
  const script = `process.stdout.write('x'.repeat(${MAX_OUTPUT + 1})); process.stderr.write('y'.repeat(${MAX_OUTPUT + 1}))`;
  const result = await runAsync(process.execPath, ['-e', script]);
  assert.equal(result.code, -1);
  assert.ok(result.out.length <= MAX_OUTPUT);
  assert.ok(result.err.length <= MAX_OUTPUT);
});

test('withStateLockAsync fails instead of running after a lock timeout', async () => {
  const scope = `timeout-${process.pid}-${Date.now()}`;
  const lock = join(STATE_DIR, `state-${scope}.lock`);
  mkdirSync(lock, { recursive: true });
  try {
    await assert.rejects(
      withStateLockAsync(scope, async () => {
        throw new Error('critical section must not run');
      }),
      /timed out acquiring state lock/
    );
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
});

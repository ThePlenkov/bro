import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsJson } from '../src/lib.ts';

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

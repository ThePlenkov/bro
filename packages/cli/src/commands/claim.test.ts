import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ClaimFacade, ClaimRow } from '@broject/core';
import { claimArgs, expandResourceWords, runClaimCommand } from './claim.ts';

const root = mkdtempSync(join(tmpdir(), 'bro-claim-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fakeClaims(rows: ClaimRow[] = []): ClaimFacade & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async claim(resource, session) {
      calls.push(`claim:${resource}:${session.host}-${session.sid}`);
      return { ok: true };
    },
    async release(resource, session) {
      calls.push(`release:${resource}:${session.host}-${session.sid}`);
    },
    async list() {
      return rows;
    },
  };
}

test('claimArgs parses subs, flags, and positionals', () => {
  assert.deepEqual(claimArgs(['worktree']).sub, 'claim');
  assert.deepEqual(claimArgs(['worktree']).pos, ['worktree']);
  const rel = claimArgs(['release', 'branch:main', '--session', 's1']);
  assert.equal(rel.sub, 'release');
  assert.deepEqual(rel.pos, ['release', 'branch:main']);
  assert.equal(rel.session, 's1');
  const lst = claimArgs(['list', '--project', '--resource', 'role:']);
  assert.equal(lst.sub, 'list');
  assert.equal(lst.project, true);
  assert.equal(lst.resourcePrefix, 'role:');
  assert.equal(claimArgs([]).sub, 'list');
  assert.throws(() => claimArgs(['claim', 'a', 'b', 'c']));
});

test('expandResourceWords maps shorthands and passes URIs through', () => {
  const dir = root;
  assert.equal(expandResourceWords(['worktree'], dir), `worktree:${dir}`);
  assert.equal(expandResourceWords(['task', 'bro-1'], dir), 'task:bro-1');
  assert.equal(expandResourceWords(['pr', '42'], dir), 'pr:42');
  assert.equal(expandResourceWords(['#7'], dir), 'pr:7');
  assert.equal(expandResourceWords(['path', 'src/**'], dir), 'path:src/**');
  assert.match(expandResourceWords(['role', 'orchestrator'], dir), /^role:orchestrator@/);
  assert.equal(expandResourceWords(['worktree:/elsewhere'], dir), 'worktree:/elsewhere');
  assert.throws(() => expandResourceWords(['task'], dir));
  assert.throws(() => expandResourceWords(['pr', 'x'], dir));
});

test('runClaimCommand claims and releases through the facade', async () => {
  const claims = fakeClaims();
  const env = { BRO_SESSION_ID: 'sid-1', CLAUDE_PLUGIN_ROOT: '/p' } as NodeJS.ProcessEnv;
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  try {
    await runClaimCommand(['worktree'], { dir: root, env, claims });
    await runClaimCommand(['release', 'worktree'], { dir: root, env, claims });
    await runClaimCommand(['list'], { dir: root, env, claims });
  } finally {
    console.log = orig;
  }
  assert.ok(claims.calls.some(c => c.startsWith('claim:worktree:')));
  assert.ok(claims.calls.some(c => c.startsWith('release:worktree:')));
  assert.ok(logs.some(l => l.includes('no live claims')));
});

test('runClaimCommand refuses without a session id', async () => {
  const claims = fakeClaims();
  await assert.rejects(
    runClaimCommand(['worktree'], { dir: root, env: {} as NodeJS.ProcessEnv, claims }),
    /no session id/
  );
});

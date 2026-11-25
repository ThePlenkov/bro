import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseRemoteCeiling, reserveRemoteCeiling } from './ceiling-remote.ts';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

test('remote ceiling CAS admits only one of two clones', () => {
  const root = mkdtempSync(join(tmpdir(), 'bro-ceiling-'));
  const bare = join(root, 'remote.git');
  git(root, 'init', '--bare', '-q', bare);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', bare, seed);
  git(seed, 'config', 'user.name', 'test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(seed, 'README'), 'seed\n');
  git(seed, 'add', 'README');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const a = join(root, 'a');
  const b = join(root, 'b');
  git(root, 'clone', '-q', bare, a);
  git(root, 'clone', '-q', bare, b);
  const first = reserveRemoteCeiling(a, 1, 0, 1, 101);
  const second = reserveRemoteCeiling(b, 1, 0, 1, 202);
  assert.notEqual(first, null);
  assert.equal(second, 'remote-held');
  assert.equal(typeof first, 'string');
  assert.equal(releaseRemoteCeiling(first as string), true);
});

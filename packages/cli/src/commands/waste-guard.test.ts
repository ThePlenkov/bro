/** The waste-guard's two deterministic vetoes (spec bro-rw8z3):
 *  duplicate inspection calls and verify re-runs on an unchanged tree. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wasteGuardBlock } from './waste-guard.ts';

const git = (dir: string, args: string[]): void => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};

/** A scratch git repo — the guard's markers live under its common dir,
 *  never in the developer's real state. */
const withRepo = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-waste-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 't@t']);
    git(dir, ['config', 'user.name', 't']);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const READ = { file_path: '/repo/a.ts' };
const OTHER_READ = { file_path: '/repo/b.ts' };

describe('wasteGuardBlock — dup-read', () => {
  test('second identical read is blocked, a different path passes', () => {
    withRepo(dir => {
      const s = 'sess-dup';
      assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
      const block = wasteGuardBlock(dir, s, 'read', READ);
      assert.match(block ?? '', /identical read call/);
      assert.equal(wasteGuardBlock(dir, s, 'read', OTHER_READ), undefined);
    });
  });

  test('input field order does not split identity', () => {
    withRepo(dir => {
      const s = 'sess-order';
      wasteGuardBlock(dir, s, 'grep', { pattern: 'foo', path: '/repo' });
      const block = wasteGuardBlock(dir, s, 'grep', { path: '/repo', pattern: 'foo' });
      assert.match(block ?? '', /identical grep call/);
    });
  });

  test('mutating tools and reads without identity pass', () => {
    withRepo(dir => {
      const s = 'sess-mut';
      wasteGuardBlock(dir, s, 'edit', READ);
      assert.equal(wasteGuardBlock(dir, s, 'edit', READ), undefined);
      assert.equal(wasteGuardBlock(dir, s, 'read', {}), undefined);
      assert.equal(wasteGuardBlock(dir, s, 'read', {}), undefined);
    });
  });
});

describe('wasteGuardBlock — verify-gate', () => {
  test('unchanged tree blocks the re-run, an edit re-arms it', () => {
    withRepo(dir => {
      const s = 'sess-verify';
      const bash = { command: 'npm test' };
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
      writeFileSync(join(dir, 'a.ts'), 'x');
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
    });
  });

  test('non-verify commands are untouched', () => {
    withRepo(dir => {
      const s = 'sess-nonverify';
      const bash = { command: 'git status' };
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
    });
  });
});

describe('wasteGuardBlock — fail-open', () => {
  test('BRO_WASTE_GUARD=0 disables both guards', () => {
    withRepo(dir => {
      const s = 'sess-off';
      process.env.BRO_WASTE_GUARD = '0';
      try {
        assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
        assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
        const bash = { command: 'npm test' };
        assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
        assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      } finally {
        delete process.env.BRO_WASTE_GUARD;
      }
    });
  });

  test('non-git dir and empty session pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-waste-nogit-'));
    try {
      assert.equal(wasteGuardBlock(dir, 'sess-x', 'read', READ), undefined);
      assert.equal(wasteGuardBlock(dir, 'sess-x', 'read', READ), undefined);
      withRepo(repo => {
        assert.equal(wasteGuardBlock(repo, '', 'read', READ), undefined);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The waste-guard's two deterministic vetoes (spec bro-rw8z3):
 *  duplicate inspection calls and verify re-runs on an unchanged tree.
 *  `wasteGuardBlock` is the pre-tool check; `wasteGuardRecord` is the
 *  post-tool commit — a call that never ran leaves no marker. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wasteGuardAspects, wasteGuardBlock, wasteGuardRecord } from './waste-guard.ts';

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

/** An admitted call that then ran: the pre-tool check passes and the
 *  post-tool leg commits its marker. */
const admitRan = (
  dir: string,
  s: string,
  tool: string,
  input: Record<string, unknown>,
  outcome: unknown = true
): void => {
  assert.equal(wasteGuardBlock(dir, s, tool, input), undefined);
  wasteGuardRecord(dir, s, tool, input, outcome);
};

describe('wasteGuardBlock — dup-read', () => {
  test('second identical read is blocked, a different path passes', () => {
    withRepo(dir => {
      const s = 'sess-dup';
      admitRan(dir, s, 'read', READ);
      const block = wasteGuardBlock(dir, s, 'read', READ);
      assert.match(block ?? '', /identical read call/);
      assert.equal(wasteGuardBlock(dir, s, 'read', OTHER_READ), undefined);
    });
  });

  test('input field order does not split identity', () => {
    withRepo(dir => {
      const s = 'sess-order';
      admitRan(dir, s, 'grep', { pattern: 'foo', path: '/repo' });
      const block = wasteGuardBlock(dir, s, 'grep', { path: '/repo', pattern: 'foo' });
      assert.match(block ?? '', /identical grep call/);
    });
  });

  test('an edit to the tree re-arms the same read', () => {
    withRepo(dir => {
      const s = 'sess-edit';
      admitRan(dir, s, 'read', READ);
      assert.match(wasteGuardBlock(dir, s, 'read', READ) ?? '', /identical read call/);
      // the inspected data moved — the identical call is a new question
      writeFileSync(join(dir, 'changed.ts'), 'x');
      assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
      // and it dedups again on the new tree
      wasteGuardRecord(dir, s, 'read', READ, true);
      assert.match(wasteGuardBlock(dir, s, 'read', READ) ?? '', /identical read call/);
    });
  });

  test('a denied call leaves no marker — the retry re-evaluates', () => {
    withRepo(dir => {
      const s = 'sess-denied';
      assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
      // a connector veto denied the call — no post-tool, no record
      assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
      // the call that finally ran dedups normally from there
      wasteGuardRecord(dir, s, 'read', READ, true);
      assert.match(wasteGuardBlock(dir, s, 'read', READ) ?? '', /identical read call/);
    });
  });

  test('a failed call leaves no marker — no result to reuse', () => {
    withRepo(dir => {
      const s = 'sess-failed';
      admitRan(dir, s, 'read', READ, false);
      assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
    });
  });

  test('mutating tools and reads without identity pass', () => {
    withRepo(dir => {
      const s = 'sess-mut';
      admitRan(dir, s, 'edit', READ);
      assert.equal(wasteGuardBlock(dir, s, 'edit', READ), undefined);
      assert.equal(wasteGuardBlock(dir, s, 'read', {}), undefined);
      wasteGuardRecord(dir, s, 'read', {}, true);
      assert.equal(wasteGuardBlock(dir, s, 'read', {}), undefined);
    });
  });
});

describe('wasteGuardBlock — verify-gate', () => {
  test('unchanged tree blocks the re-run, an edit re-arms it', () => {
    withRepo(dir => {
      const s = 'sess-verify';
      const bash = { command: 'npm test' };
      admitRan(dir, s, 'bash', bash);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
      writeFileSync(join(dir, 'a.ts'), 'x');
      admitRan(dir, s, 'bash', bash);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
    });
  });

  test('an edit to an untracked file moves the fingerprint', () => {
    withRepo(dir => {
      const s = 'sess-untracked';
      const bash = { command: 'npm test' };
      writeFileSync(join(dir, 'new.ts'), 'v1');
      admitRan(dir, s, 'bash', bash);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
      // still untracked — porcelain reports only the name, so the
      // fingerprint must see the content move
      writeFileSync(join(dir, 'new.ts'), 'v2');
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
    });
  });

  test('a commit on a clean tree moves the fingerprint', () => {
    withRepo(dir => {
      const s = 'sess-commit';
      const bash = { command: 'npm test' };
      writeFileSync(join(dir, 'a.ts'), 'x');
      admitRan(dir, s, 'bash', bash);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
      // committing leaves status+diff empty — HEAD is what moved
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'c']);
      admitRan(dir, s, 'bash', bash);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
    });
  });

  test('a denied verify leaves no marker — the retry re-evaluates', () => {
    withRepo(dir => {
      const s = 'sess-vdenied';
      const bash = { command: 'npm test' };
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      // the prompt was refused — the verify never ran, no record
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      wasteGuardRecord(dir, s, 'bash', bash, true);
      assert.match(wasteGuardBlock(dir, s, 'bash', bash) ?? '', /tree unchanged/);
    });
  });

  test('non-verify commands are untouched', () => {
    withRepo(dir => {
      const s = 'sess-nonverify';
      const bash = { command: 'git status' };
      admitRan(dir, s, 'bash', bash);
      assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
    });
  });

  test('env-prefixed verify cannot smuggle past the gate', () => {
    withRepo(dir => {
      const s = 'sess-envprefix';
      admitRan(dir, s, 'bash', { command: 'npm test' });
      // the arena bypass attempt: a leading assignment must not hide
      // the verify-shaped tail from the gate
      assert.match(
        wasteGuardBlock(dir, s, 'bash', {
          command: 'BRO_WASTE_GUARD=0 npm test',
        }) ?? '',
        /tree unchanged/
      );
      assert.match(
        wasteGuardBlock(dir, s, 'bash', {
          command: 'env CI=1 npm run build',
        }) ?? '',
        /tree unchanged/
      );
    });
  });
});

describe('wasteGuardAspects — marker listing seam', () => {
  test('returns full aspect names keeping the waste- prefix', () => {
    withRepo(dir => {
      const s = 'sess-aspects';
      admitRan(dir, s, 'bash', { command: 'npm test' });
      admitRan(dir, s, 'read', READ);
      const aspects = wasteGuardAspects(dir, s);
      assert.deepEqual(
        aspects.map(a => a.replace(/^waste-dup-[0-9a-f-]+$/, 'waste-dup-<fp>-<hash>')),
        ['waste-dup-<fp>-<hash>', 'waste-tree']
      );
      // another session's markers do not bleed in
      assert.deepEqual(wasteGuardAspects(dir, 'sess-other'), []);
    });
  });
});

describe('wasteGuardBlock — fail-open', () => {
  test('BRO_WASTE_GUARD=0 disables both guards', () => {
    withRepo(dir => {
      const s = 'sess-off';
      process.env.BRO_WASTE_GUARD = '0';
      try {
        admitRan(dir, s, 'read', READ);
        assert.equal(wasteGuardBlock(dir, s, 'read', READ), undefined);
        const bash = { command: 'npm test' };
        admitRan(dir, s, 'bash', bash);
        assert.equal(wasteGuardBlock(dir, s, 'bash', bash), undefined);
      } finally {
        delete process.env.BRO_WASTE_GUARD;
      }
    });
  });

  test('non-git dir and empty session pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-waste-nogit-'));
    try {
      admitRan(dir, 'sess-x', 'read', READ);
      assert.equal(wasteGuardBlock(dir, 'sess-x', 'read', READ), undefined);
      withRepo(repo => {
        assert.equal(wasteGuardBlock(repo, '', 'read', READ), undefined);
        wasteGuardRecord(repo, '', 'read', READ, true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

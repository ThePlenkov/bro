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
import {
  type GuardedCall,
  wasteGuardAspects,
  wasteGuardBlock,
  wasteGuardRecord,
} from './waste-guard.ts';

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

const READ: GuardedCall = { tool: 'read', input: { file_path: '/repo/a.ts' } };
const OTHER_READ: GuardedCall = { tool: 'read', input: { file_path: '/repo/b.ts' } };
const NPM_TEST: GuardedCall = { tool: 'bash', input: { command: 'npm test' } };

/** An admitted call that then ran: the pre-tool check passes and the
 *  post-tool leg commits its marker. */
const admitRan = (dir: string, s: string, call: GuardedCall): void => {
  assert.equal(wasteGuardBlock(dir, s, call), undefined);
  wasteGuardRecord(dir, s, call);
};

describe('wasteGuardBlock — dup-read', () => {
  test('second identical read is blocked, a different path passes', () => {
    withRepo(dir => {
      const s = 'sess-dup';
      admitRan(dir, s, READ);
      const block = wasteGuardBlock(dir, s, READ);
      assert.match(block ?? '', /identical read call/);
      assert.equal(wasteGuardBlock(dir, s, OTHER_READ), undefined);
    });
  });

  test('input field order does not split identity', () => {
    withRepo(dir => {
      const s = 'sess-order';
      admitRan(dir, s, { tool: 'grep', input: { pattern: 'foo', path: '/repo' } });
      const block = wasteGuardBlock(dir, s, {
        tool: 'grep',
        input: { path: '/repo', pattern: 'foo' },
      });
      assert.match(block ?? '', /identical grep call/);
    });
  });

  test('an edit to the tree re-arms the same read', () => {
    withRepo(dir => {
      const s = 'sess-edit';
      admitRan(dir, s, READ);
      assert.match(wasteGuardBlock(dir, s, READ) ?? '', /identical read call/);
      // the inspected data moved — the identical call is a new question
      writeFileSync(join(dir, 'changed.ts'), 'x');
      assert.equal(wasteGuardBlock(dir, s, READ), undefined);
      // and it dedups again on the new tree
      wasteGuardRecord(dir, s, READ);
      assert.match(wasteGuardBlock(dir, s, READ) ?? '', /identical read call/);
    });
  });

  test('a denied call leaves no marker — the retry re-evaluates', () => {
    withRepo(dir => {
      const s = 'sess-denied';
      assert.equal(wasteGuardBlock(dir, s, READ), undefined);
      // a connector veto denied the call — no post-tool, no record
      assert.equal(wasteGuardBlock(dir, s, READ), undefined);
      // the call that finally ran dedups normally from there
      wasteGuardRecord(dir, s, READ);
      assert.match(wasteGuardBlock(dir, s, READ) ?? '', /identical read call/);
    });
  });

  test('a failed call leaves no marker — no result to reuse', () => {
    withRepo(dir => {
      const s = 'sess-failed';
      admitRan(dir, s, { ...READ, outcome: false });
      assert.equal(wasteGuardBlock(dir, s, READ), undefined);
    });
  });

  test('mutating tools and reads without identity pass', () => {
    withRepo(dir => {
      const s = 'sess-mut';
      admitRan(dir, s, { tool: 'edit', input: { file_path: '/repo/a.ts' } });
      const bare: GuardedCall = { tool: 'read', input: {} };
      assert.equal(wasteGuardBlock(dir, s, bare), undefined);
      wasteGuardRecord(dir, s, bare);
      assert.equal(wasteGuardBlock(dir, s, bare), undefined);
    });
  });
});

describe('wasteGuardBlock — verify-gate', () => {
  test('unchanged tree blocks the re-run, an edit re-arms it', () => {
    withRepo(dir => {
      const s = 'sess-verify';
      admitRan(dir, s, NPM_TEST);
      assert.match(wasteGuardBlock(dir, s, NPM_TEST) ?? '', /tree unchanged/);
      writeFileSync(join(dir, 'a.ts'), 'x');
      admitRan(dir, s, NPM_TEST);
      assert.match(wasteGuardBlock(dir, s, NPM_TEST) ?? '', /tree unchanged/);
    });
  });

  test('an edit to an untracked file moves the fingerprint', () => {
    withRepo(dir => {
      const s = 'sess-untracked';
      writeFileSync(join(dir, 'new.ts'), 'v1');
      admitRan(dir, s, NPM_TEST);
      assert.match(wasteGuardBlock(dir, s, NPM_TEST) ?? '', /tree unchanged/);
      // still untracked — porcelain reports only the name, so the
      // fingerprint must see the content move
      writeFileSync(join(dir, 'new.ts'), 'v2');
      assert.equal(wasteGuardBlock(dir, s, NPM_TEST), undefined);
    });
  });

  test('a commit on a clean tree moves the fingerprint', () => {
    withRepo(dir => {
      const s = 'sess-commit';
      writeFileSync(join(dir, 'a.ts'), 'x');
      admitRan(dir, s, NPM_TEST);
      assert.match(wasteGuardBlock(dir, s, NPM_TEST) ?? '', /tree unchanged/);
      // committing leaves status+diff empty — HEAD is what moved
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'c']);
      admitRan(dir, s, NPM_TEST);
      assert.match(wasteGuardBlock(dir, s, NPM_TEST) ?? '', /tree unchanged/);
    });
  });

  test('a denied verify leaves no marker — the retry re-evaluates', () => {
    withRepo(dir => {
      const s = 'sess-vdenied';
      assert.equal(wasteGuardBlock(dir, s, NPM_TEST), undefined);
      // the prompt was refused — the verify never ran, no record
      assert.equal(wasteGuardBlock(dir, s, NPM_TEST), undefined);
      wasteGuardRecord(dir, s, NPM_TEST);
      assert.match(wasteGuardBlock(dir, s, NPM_TEST) ?? '', /tree unchanged/);
    });
  });

  test('non-verify commands are untouched', () => {
    withRepo(dir => {
      const s = 'sess-nonverify';
      admitRan(dir, s, { tool: 'bash', input: { command: 'git status' } });
      assert.equal(
        wasteGuardBlock(dir, s, { tool: 'bash', input: { command: 'git status' } }),
        undefined
      );
    });
  });

  test('env-prefixed verify cannot smuggle past the gate', () => {
    withRepo(dir => {
      const s = 'sess-envprefix';
      admitRan(dir, s, NPM_TEST);
      // the arena bypass attempt: leading assignments, `env`, and env
      // options are all prefix noise — the verify tail is what gates
      for (const command of [
        'BRO_WASTE_GUARD=0 npm test',
        'env CI=1 npm run build',
        'FOO= npm test',
        "FOO='bar baz' npm test",
        'FOO=bar env npm test',
        'env -i npm test',
        'env -u FOO npm test',
      ]) {
        assert.match(
          wasteGuardBlock(dir, s, { tool: 'bash', input: { command } }) ?? '',
          /tree unchanged/,
          command
        );
      }
    });
  });
});

describe('wasteGuardAspects — marker listing seam', () => {
  test('returns full aspect names keeping the waste- prefix', () => {
    withRepo(dir => {
      const s = 'sess-aspects';
      admitRan(dir, s, NPM_TEST);
      admitRan(dir, s, READ);
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
        admitRan(dir, s, READ);
        assert.equal(wasteGuardBlock(dir, s, READ), undefined);
        admitRan(dir, s, NPM_TEST);
        assert.equal(wasteGuardBlock(dir, s, NPM_TEST), undefined);
      } finally {
        delete process.env.BRO_WASTE_GUARD;
      }
    });
  });

  test('non-git dir and empty session pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-waste-nogit-'));
    try {
      admitRan(dir, 'sess-x', READ);
      assert.equal(wasteGuardBlock(dir, 'sess-x', READ), undefined);
      withRepo(repo => {
        assert.equal(wasteGuardBlock(repo, '', READ), undefined);
        wasteGuardRecord(repo, '', READ);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

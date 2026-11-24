/** `bro debt import` e2e — explicit SARIF artifact imports over the
 *  built CLI: idempotent upserts, declared-fingerprint stability,
 *  dry-run, fail-closed parse, and the artifact-scoped resolve sweep
 *  (spec bro-l8c4f.15). Spawned: exit codes and on-disk ledger state are
 *  the assertion targets. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, initRepo, inside, runCli } from './testrepo.ts';

const SARIF = (results: unknown[]): string =>
  JSON.stringify({ runs: [{ tool: { driver: { name: 'eslint' } }, results }] });

const RES = (ruleId: string, text: string, uri: string, fp?: string): unknown => ({
  ruleId,
  level: 'warning',
  message: { text },
  ...(fp !== undefined ? { fingerprints: { primary: fp } } : {}),
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
});

/** Repo with beads opted out — ledger assertions stay on the jsonl
 *  store; the bd projection's external_ref dedup is covered elsewhere. */
function fixture(): { root: string; main: string } {
  const { root, main } = initRepo('bro-debt-import-');
  writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ stores: ['jsonl'] }));
  return { root, main };
}

const harvestDir = (main: string): string => join(main, '.agents', 'review-debt', 'harvests');

/** Every harvest row across snapshots — for thread_id assertions. The
 *  merged view is `debt list`'s job; this reads the raw append-only
 *  evidence. */
function harvestRows(main: string): Array<{ thread_id: string }> {
  const dir = harvestDir(main);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .flatMap(f =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l) as { thread_id: string })
    );
}

describe('bro debt import e2e', () => {
  test('two imports of one SARIF yield one open row — idempotent upsert', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      writeFileSync(
        join(main, 'findings.sarif'),
        SARIF([RES('no-unused-vars', 'x is unused', 'src/a.ts', 'fp-1')])
      );
      for (let i = 0; i < 2; i += 1) {
        const r = runCli(['debt', 'import', 'findings.sarif', '--repo', 'a/b'], { cwd: main });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stderr, /1 finding\(s\) from 1 artifact\(s\)/);
      }
      const list = runCli(['debt', 'list'], { cwd: main });
      assert.match(list.stderr, /debt list: 1 row\(s\)/);
      // both snapshots landed, but every row carries the same thread_id
      const rows = harvestRows(main);
      assert.ok(rows.length >= 2);
      assert.equal(new Set(rows.map(r => r.thread_id)).size, 1);
      assert.match(rows[0]!.thread_id, /^sverka:a%2Fb:eslint:no-unused-vars:findings\.sarif:fp-1$/);
    });
  });

  test('a declared fingerprint survives a re-run with reworded message', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      writeFileSync(
        join(main, 'f.sarif'),
        SARIF([RES('no-unused-vars', 'x is unused', 'src/a.ts', 'stable-fp')])
      );
      assert.equal(runCli(['debt', 'import', 'f.sarif', '--repo', 'a/b'], { cwd: main }).code, 0);
      // upstream re-ran and reworded — the declared fp pins identity
      writeFileSync(
        join(main, 'f.sarif'),
        SARIF([RES('no-unused-vars', "'x' is assigned but never used", 'src/a.ts', 'stable-fp')])
      );
      assert.equal(runCli(['debt', 'import', 'f.sarif', '--repo', 'a/b'], { cwd: main }).code, 0);
      assert.match(runCli(['debt', 'list'], { cwd: main }).stderr, /debt list: 1 row\(s\)/);
      assert.equal(new Set(harvestRows(main).map(r => r.thread_id)).size, 1);
    });
  });

  test('--dry-run prints the records and writes nothing', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      writeFileSync(join(main, 'f.sarif'), SARIF([RES('r1', 'm', 'f.ts')]));
      const r = runCli(['debt', 'import', '--dry-run', 'f.sarif', '--repo', 'a/b'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /"source":"sverka"/);
      assert.match(r.stderr, /would resolve 0 row\(s\)/);
      assert.equal(existsSync(harvestDir(main)), false);
      assert.equal(runCli(['debt', 'list'], { cwd: main }).stderr.includes('0 row(s)'), true);
    });
  });

  test('one malformed file aborts the whole import — nothing written', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      writeFileSync(join(main, 'good.sarif'), SARIF([RES('r1', 'm', 'f.ts')]));
      writeFileSync(join(main, 'bad.sarif'), '{not json');
      const r = runCli(['debt', 'import', 'good.sarif', 'bad.sarif', '--repo', 'a/b'], {
        cwd: main,
      });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /invalid SARIF JSON|refusing partial snapshot/);
      assert.equal(existsSync(harvestDir(main)), false);
    });
  });

  test('an import resolves only its own artifact scope', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      writeFileSync(join(main, 'a.sarif'), SARIF([RES('rule-x', 'x', 'x.ts', 'fx')]));
      writeFileSync(join(main, 'b.sarif'), SARIF([RES('rule-y', 'y', 'y.ts', 'fy')]));
      assert.equal(runCli(['debt', 'import', 'a.sarif', '--repo', 'a/b'], { cwd: main }).code, 0);
      assert.equal(runCli(['debt', 'import', 'b.sarif', '--repo', 'a/b'], { cwd: main }).code, 0);
      assert.match(runCli(['debt', 'list'], { cwd: main }).stderr, /debt list: 2 row\(s\)/);

      // re-importing a.sarif WITHOUT rule-x is a complete snapshot of
      // a.sarif — x resolves; b.sarif's y is a different scope entirely.
      writeFileSync(join(main, 'a.sarif'), SARIF([]));
      const r = runCli(['debt', 'import', 'a.sarif', '--repo', 'a/b'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /resolved 1 row\(s\)/);
      assert.match(runCli(['debt', 'list'], { cwd: main }).stderr, /debt list: 1 row\(s\)/);
      const done = runCli(['debt', 'list', '--status', 'done'], { cwd: main });
      assert.match(done.stdout, /rule-x/);
      assert.doesNotMatch(done.stdout, /rule-y/);
    });
  });

  test('a directory positional is a usage error pointing at the dir-scan', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      const r = runCli(['debt', 'import', '.', '--repo', 'a/b'], { cwd: main });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /not a file.*debt collect --source sverka/s);
    });
  });

  test('repo identity falls back to the origin remote', () => {
    const { root, main } = fixture();
    inside(main, root, () => {
      git(['remote', 'add', 'origin', 'https://github.com/o/r.git'], main);
      writeFileSync(join(main, 'f.sarif'), SARIF([RES('r1', 'm', 'f.ts')]));
      const r = runCli(['debt', 'import', 'f.sarif'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      assert.match(harvestRows(main)[0]!.thread_id, /^sverka:o%2Fr:eslint:r1:/);
    });
  });
});

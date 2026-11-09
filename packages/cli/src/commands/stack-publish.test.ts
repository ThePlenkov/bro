import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { maybeSpawnStackPublish, stackNameOfBranch } from './stack-publish.ts';
import { git, initRepo, inside } from './testrepo.ts';

describe('stackNameOfBranch', () => {
  test('a stack member names its chain', () => {
    assert.equal(stackNameOfBranch('stack/router/3-bro-sy4q3'), 'router');
  });

  test('a plain branch names no chain', () => {
    assert.equal(stackNameOfBranch('main'), undefined);
    assert.equal(stackNameOfBranch('feat/router-routes'), undefined);
    assert.equal(stackNameOfBranch('stack/router'), undefined);
    assert.equal(stackNameOfBranch(''), undefined);
  });
});

/** A repo checked out on a stack member's branch — the shape the hook
 *  sees when a worker opens that member's PR. */
function memberRepo(prefix: string): { root: string; main: string } {
  const { root, main } = initRepo(prefix);
  git(['checkout', '-q', '-b', 'stack/router/1-bro-aaa'], main);
  return { root, main };
}

describe('maybeSpawnStackPublish', () => {
  test("a member's branch spawns the registration", () => {
    const { root, main } = memberRepo('bro-stack-publish-');
    inside(main, root, () => {
      const calls: Array<[string, string, string]> = [];
      maybeSpawnStackPublish(
        main,
        (entry, dir, name) => calls.push([entry, dir, name]),
        process.execPath
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]![1], main);
      assert.equal(calls[0]![2], 'router');
    });
  });

  test('the registration runs in the MAIN worktree — the config lives there', () => {
    const { root, main } = initRepo('bro-stack-publish-');
    inside(main, root, () => {
      // a member worktree is a checkout of a branch — the plugin and the
      // config it points at live in the main worktree
      const wt = join(root, 'main--member');
      git(['worktree', 'add', '-q', wt, '-b', 'stack/router/1-bro-aaa'], main);
      const calls: Array<[string, string, string]> = [];
      maybeSpawnStackPublish(
        wt,
        (entry, cwd, name) => calls.push([entry, cwd, name]),
        process.execPath
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]![1], main);
      assert.equal(calls[0]![2], 'router');
    });
  });

  test('the entry is absolute — the child runs in another worktree', () => {
    const { root, main } = memberRepo('bro-stack-publish-');
    inside(main, root, () => {
      writeFileSync(join(main, 'bro'), 'x');
      const calls: Array<[string, string, string]> = [];
      // a relative entry would be resolved against the MAIN worktree,
      // where the CLI is not
      maybeSpawnStackPublish(main, (entry, cwd, name) => calls.push([entry, cwd, name]), './bro');
      assert.equal(calls.length, 1);
      assert.ok(isAbsolute(calls[0]![0]), 'the entry the child gets is absolute');
    });
  });

  test('a plain branch spawns nothing', () => {
    const { root, main } = initRepo('bro-stack-publish-');
    inside(main, root, () => {
      const calls: string[] = [];
      maybeSpawnStackPublish(main, (_e, _d, name) => calls.push(name), process.execPath);
      assert.deepEqual(calls, []);
    });
  });

  test('an unreadable branch spawns nothing', () => {
    const calls: string[] = [];
    maybeSpawnStackPublish(
      '/nonexistent/repo',
      (_e, _d, name) => calls.push(name),
      process.execPath
    );
    assert.deepEqual(calls, []);
  });

  test('a missing entry spawns nothing', () => {
    const { root, main } = memberRepo('bro-stack-publish-');
    inside(main, root, () => {
      const calls: string[] = [];
      maybeSpawnStackPublish(main, (_e, _d, name) => calls.push(name), '/nonexistent/bro-entry');
      assert.deepEqual(calls, []);
    });
  });
});

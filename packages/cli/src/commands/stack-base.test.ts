/**
 * The base's commit-ish — the resolver the stack sync reads every base
 * through (bro-yi9sz).
 *
 * Git's rev-parse never falls back from `main` to `origin/main`: the
 * shorthand names `refs/heads/main`. A repository whose default branch
 * has no local branch therefore reads every base as dead — the chain is
 * unsyncable and every member is skipped with a reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { baseRef } from './stack.ts';
import { git, initRepo, inside } from './testrepo.ts';

test('a local head wins — the local branch is the truth for a local rewrite', () => {
  const { root, main } = initRepo('bro-stack-base-');
  inside(main, root, () => {
    git(['init', '-q', '--bare', join(root, 'origin.git')], root);
    git(['remote', 'add', 'origin', join(root, 'origin.git')], main);
    git(['push', '-qu', 'origin', 'main'], main);
    assert.equal(baseRef(main, 'main'), 'refs/heads/main');
  });
});

test('a base that lives only as a remote-tracking ref is a base, not a dead ref', () => {
  const { root, main } = initRepo('bro-stack-base-');
  inside(main, root, () => {
    git(['init', '-q', '--bare', join(root, 'origin.git')], root);
    git(['remote', 'add', 'origin', join(root, 'origin.git')], main);
    git(['push', '-qu', 'origin', 'main'], main);
    // the local default branch is gone — the checkout never created it
    git(['checkout', '-q', '-b', 'scratch'], main);
    git(['branch', '-D', 'main'], main);
    assert.equal(baseRef(main, 'main'), 'refs/remotes/origin/main');
  });
});

test('a base that exists nowhere is undefined — the old answer', () => {
  const { root, main } = initRepo('bro-stack-base-');
  inside(main, root, () => {
    assert.equal(baseRef(main, 'nope'), undefined);
  });
});

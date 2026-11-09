/**
 * The fork point of a child whose base was rewritten under it.
 *
 * A fix that landed below a member rewrites the base's history: the
 * parent's commits get new shas (same patches, new ids), and the child —
 * built on the old ids — no longer has the base's tip as an ancestor.
 * The plain merge-base is then the parent's old ROOT, and a rebase from
 * there replays the parent's old commits on top of the new base: the
 * same changes twice, and a conflict at every file both touched.
 *
 * The real fork is the child's last commit the new base already holds —
 * by patch, which is how a rewritten parent looks to git.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { forkFor, forkPoint } from './stack.ts';
import { git, initRepo } from './testrepo.ts';

/** A repo with one file committed on `main`. */
function repo(): { root: string; main: string } {
  return initRepo('bro-stack-fork-', m => {
    writeFileSync(join(m, 'a.txt'), 'a\n');
  });
}

/** `base` (one commit) → `child` (the base's work plus the child's own).
 *  The two commits the fork point is read between. */
function baseAndChild(main: string): { baseWork: string; childWork: string } {
  git(['checkout', '-q', '-b', 'base'], main);
  writeFileSync(join(main, 'base.txt'), 'base\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'base work'], main);
  const baseWork = git(['rev-parse', 'HEAD'], main).trim();
  git(['checkout', '-q', '-b', 'child'], main);
  writeFileSync(join(main, 'child.txt'), 'child\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'child work'], main);
  const childWork = git(['rev-parse', 'HEAD'], main).trim();
  return { baseWork, childWork };
}

test('a base rewritten under the child forks at the child’s own work', () => {
  const { root, main } = repo();
  const { baseWork, childWork } = baseAndChild(main);
  // the base is rewritten — the same patch, a new sha
  git(['checkout', '-q', 'base'], main);
  // the same work, a new commit — the message moves, the patch does not
  git(['commit', '-q', '--amend', '-m', 'base work, rewritten'], main);
  const rewritten = git(['rev-parse', 'HEAD'], main).trim();
  assert.notEqual(rewritten, baseWork, 'the base carries a new sha');

  // the fork is read in the CHILD's worktree — that is where the rebase runs
  git(['checkout', '-q', 'child'], main);
  // the child's own work starts AFTER the base's old work — not at the
  // merge-base, which is the parent's old root
  const fork = forkPoint('base', main);
  assert.equal(fork, baseWork, 'the fork is the commit the new base holds by patch');
  assert.notEqual(fork, childWork, 'the child’s own work is not the fork');
  assert.ok(root.length > 0);
});

test('a base already inside the child forks at the merge-base', () => {
  const { root, main } = repo();
  baseAndChild(main);
  const fork = forkPoint('base', main);
  const mergeBase = git(['merge-base', 'base', 'HEAD'], main).trim();
  assert.equal(fork, mergeBase);
  assert.ok(root.length > 0);
});

test('a base that GAINED content still forks at the child’s own work', () => {
  // the rewrite is not patch-equivalent (the base gained a file), so only
  // the reflog knows where the child's work starts: the merge-base would
  // send the base's OLD commits back into the replay
  const { root, main } = repo();
  const { baseWork } = baseAndChild(main);
  // the base's history is REWRITTEN — the amend carries the old work AND
  // a new file, so the old commit is gone from the base's line
  git(['checkout', '-q', 'base'], main);
  writeFileSync(join(main, 'more.txt'), 'more\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '--amend', '-m', 'base work, extended'], main);
  git(['checkout', '-q', 'child'], main);
  const fork = forkPoint('base', main);
  assert.equal(fork, baseWork, 'the fork is where the child’s own work starts');
  assert.notEqual(fork, git(['merge-base', 'base', 'HEAD'], main).trim());
  assert.ok(root.length > 0);
});

test('the fork comes from the base the member forked FROM, not from where it goes', () => {
  // `main` → `parent` (the base's work) → `child` (forked at the base's
  // tip) → and the base ADVANCES afterwards. The member's line left
  // `parent`, so only `parent` knows where that line began; `main` — the
  // desired base — knows where the CHAIN left the trunk, and a fork from
  // there replays the base's own commits on top of the new base.
  const { root, main } = repo();
  const trunkWork = git(['rev-parse', 'HEAD'], main).trim();
  git(['checkout', '-q', '-b', 'parent'], main);
  writeFileSync(join(main, 'parent.txt'), 'parent\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'parent work'], main);
  const parentWork = git(['rev-parse', 'HEAD'], main).trim();
  git(['checkout', '-q', '-b', 'child'], main);
  writeFileSync(join(main, 'child.txt'), 'child\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'child work'], main);
  // the base advances AFTER the member forked off it
  git(['checkout', '-q', 'parent'], main);
  writeFileSync(join(main, 'later.txt'), 'later\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'parent moves on'], main);
  git(['checkout', '-q', 'child'], main);
  // the member's own reflog is gone — the creation entry that named the
  // base's tip has expired, and the plan's SHA is not available either
  git(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', 'refs/heads/child'], main);

  const fork = forkFor('child', undefined, 'parent', main);
  assert.equal(fork, parentWork, 'the fork is the base’s tip at the fork');
  assert.notEqual(fork, trunkWork, 'the trunk is not the fork — it replays the base’s commits');
  assert.ok(root.length > 0);
});

test('an unverifiable fork stops the rebase instead of replaying the base', () => {
  // the base's history is REWRITTEN and the rewrite is NOT patch-
  // equivalent, so the merge-base sits BEFORE the base's old commits: a
  // replay from there carries them, and they conflict with the base's
  // squash. With both reflogs gone nothing knows where the child's work
  // began — so there is no fork, and no replay either.
  const { root, main } = repo();
  baseAndChild(main);
  git(['checkout', '-q', 'base'], main);
  writeFileSync(join(main, 'more.txt'), 'more\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '--amend', '-m', 'base work, extended'], main);
  git(['checkout', '-q', 'child'], main);
  // both reflogs are gone — no fork-point, no creation entry
  git(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], main);

  assert.equal(forkPoint('base', main), '', 'no verified fork — the guess is refused');
  assert.equal(forkFor('child', undefined, 'base', main), '', 'no fork, no rebase');
  assert.ok(root.length > 0);
});

/**
 * `bro stack merge`'s landing verdict — `landMergeChain` maps the
 * connector's report onto the command's exit code. A report is an
 * ATTEMPTED merge: the git facade aborts with `merged: []` when the
 * primary worktree is dirty, sits on the wrong branch, or the trunk
 * cannot be resolved — and `undefined` only means "no connector can
 * serve this repo". An aborted attempt that reported success would
 * hand automation exit 0 for a chain that never landed.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitStacks } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import type { MergeCtx } from './stack-merge.ts';
import { landMergeChain } from './stack-merge.ts';
import type { MemberView } from './stack-refs.ts';
import { initRepo } from './testrepo.ts';

function mergeCtx(root: string): MergeCtx {
  return {
    root,
    trunk: 'main',
    rev: undefined,
    stacks: gitStacks(root),
    act: loadBroConfig(root).act,
  };
}

const OPTS = { method: 'merge', admin: false } as const;

test('a merge that aborts with nothing landed reports failure, not exit 0', async () => {
  const { main } = initRepo('bro-stack-merge-', m => {
    writeFileSync(join(m, 'a.txt'), 'a\n');
  });
  // the git facade refuses to merge into a dirty primary worktree —
  // the report is an abort ({lines, merged: []}), not a decline
  writeFileSync(join(main, 'dirty.txt'), 'uncommitted\n');
  const m: MemberView = { name: 's', n: 1, slug: 'x', branch: 'stack/s/1-x', rebaseable: true };
  assert.equal(await landMergeChain('s', [m], OPTS, mergeCtx(main)), false);
});

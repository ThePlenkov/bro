/**
 * The settle check — the base==prev-head invariant read AFTER the
 * member's move (stack-sync.ts `settleBase`). The plan and the
 * preflight saw the base's head, but the ref may have died under the
 * cascade (a concurrent delete, a prune between the two reads). An
 * unreadable head is an UNKNOWN truth: never a success — the member
 * fails, its edge stays stale so the next sync reschedules it, and the
 * publish tail is dropped rather than attesting a chain the invariant
 * cannot prove.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SyncPlanItem } from '@broject/stack';
import type { MemberView } from './stack-refs.ts';
import type { SyncCtx } from './stack-sync.ts';
import { settleBase } from './stack-sync.ts';
import { git, initRepo } from './testrepo.ts';

function member(branch: string): MemberView {
  return { name: 's', n: 1, slug: 'x', branch, rebaseable: true };
}

function ctx(root: string, lines: string[]): SyncCtx {
  return { root, rev: undefined, stacks: undefined, trunk: 'main', defaultBase: 'main', lines };
}

test('a base whose head cannot be read at settle fails the member', () => {
  const { main } = initRepo('bro-stack-sync-', m => {
    writeFileSync(join(m, 'a.txt'), 'a\n');
  });
  const m = member('stack/s/1-x');
  git(['branch', m.branch], main);
  // 'ghost' resolves nowhere — the same answer carriesBaseHead gives
  // when the base's ref dies between the preflight read and this one
  const item: SyncPlanItem<MemberView> = {
    member: m,
    desiredBase: 'ghost',
    oldBase: 'main',
    rebase: false,
    retarget: true,
  };
  const lines: string[] = [];
  assert.equal(settleBase(item, m, ctx(main, lines)), 'failed');
  assert.ok(
    lines.some(l => l.includes('the head of ghost cannot be read')),
    'the skip is reported, not silent'
  );
});

test('a base whose head the member still carries at settle passes', () => {
  const { main } = initRepo('bro-stack-sync-', m => {
    writeFileSync(join(m, 'a.txt'), 'a\n');
  });
  const m = member('stack/s/1-x');
  git(['branch', m.branch], main);
  const item: SyncPlanItem<MemberView> = {
    member: m,
    desiredBase: 'main',
    oldBase: 'main',
    rebase: false,
    retarget: true,
  };
  const lines: string[] = [];
  assert.equal(settleBase(item, m, ctx(main, lines)), 'ok');
});

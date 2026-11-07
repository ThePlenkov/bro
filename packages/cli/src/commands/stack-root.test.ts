/**
 * The chain's root — the branch the chain stands on.
 *
 * A member that MERGED left the chain: its base is the branch it landed
 * on, and that branch is gone with it. The root is therefore the first
 * member still IN the chain — reading past the merged ones is the
 * difference between a sync that moves the rest of the chain and one that
 * plans them onto a dead ref.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chainRootBase } from './stack.ts';
import type { SyncMemberInput } from '@broject/stack';

/** One member of the chain, with the state the sync reads. */
function member(over: Partial<SyncMemberInput> & { n: number; slug: string }): SyncMemberInput {
  return {
    name: 'router',
    branch: `stack/router/${over.n}-${over.slug}`,
    rebaseable: true,
    ...over,
  };
}

test('the root is the trunk when the first member merged', () => {
  const root = chainRootBase(
    [
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'MERGED' }),
      member({ n: 3, slug: 'tool-use', edgeBase: 'main', prState: 'OPEN' }),
    ],
    'main'
  );
  // the merged member's base is the branch it landed on — and that branch
  // is gone; the chain stands on the default branch, the same answer the
  // plan gives the member that follows
  assert.equal(root, 'main');
});

test("a member's PR base stands in when the edge is missing", () => {
  const root = chainRootBase(
    [member({ n: 3, slug: 'tool-use', prBase: 'main', prState: 'OPEN' })],
    'trunk'
  );
  assert.equal(root, 'main');
});

test('a chain whose members all merged roots at the trunk', () => {
  const root = chainRootBase(
    [
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'MERGED' }),
      member({ n: 2, slug: 'token', edgeBase: 'stack/router/1-code-health', prState: 'MERGED' }),
    ],
    'main'
  );
  assert.equal(root, 'main');
});

test('a chain that never merged keeps its own root', () => {
  const root = chainRootBase(
    [
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'OPEN' }),
      member({ n: 2, slug: 'token', edgeBase: 'stack/router/1-code-health', prState: 'OPEN' }),
    ],
    'main'
  );
  assert.equal(root, 'feat/router-routes');
});

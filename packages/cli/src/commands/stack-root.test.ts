/**
 * The chain's root — the branch the chain stands on.
 *
 * Two rules, both about a ref that is GONE:
 *
 * - A member that MERGED left the chain: its base is the branch it landed
 *   on, and that branch is gone with it. The root is the default branch —
 *   the same answer the plan gives the member that follows.
 * - A DEAD ref is never a base: the recorded edge may name a branch that
 *   has since merged and been deleted. Planning onto it is what made the
 *   sync refuse to move the members that were still in the chain.
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

/** The branches that still exist — everything else is a dead ref. */
function alive(...branches: string[]): (branch: string) => boolean {
  const set = new Set(branches);
  return branch => set.has(branch);
}

test('the root is the default branch when the first member merged', () => {
  const root = chainRootBase(
    [
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'MERGED' }),
      member({ n: 3, slug: 'tool-use', edgeBase: 'main', prState: 'OPEN' }),
    ],
    'trunk',
    alive('main', 'trunk')
  );
  // the merged member's base is the branch it landed on — and that branch
  // is gone; the chain stands on the default branch, the same answer the
  // plan gives the member that follows. The default is NOT the live
  // member's own base: the two must not be confused for each other.
  assert.equal(root, 'trunk');
});

test('a dead edge falls back to the default branch', () => {
  const root = chainRootBase(
    [
      // the arc's base merged and was deleted — the edge names a ref that
      // is gone, and the sync must not plan onto it
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'OPEN' }),
    ],
    'trunk',
    alive('trunk')
  );
  assert.equal(root, 'trunk');
});

test('a dead edge falls back to the PR base when that one lives', () => {
  const root = chainRootBase(
    [
      member({
        n: 1,
        slug: 'code-health',
        edgeBase: 'feat/router-routes',
        prBase: 'trunk',
        prState: 'OPEN',
      }),
    ],
    'main',
    alive('trunk')
  );
  assert.equal(root, 'trunk');
});

test('no live branch at all — there is nothing to stand on', () => {
  // not even the default branch exists: the chain has no root, and the
  // sync must say so instead of planning onto a dead ref
  const root = chainRootBase(
    [member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'OPEN' })],
    'trunk',
    alive()
  );
  assert.equal(root, undefined);
});

test('a member with neither an edge nor a PR base falls back to the default', () => {
  const members = [member({ n: 1, slug: 'code-health', prState: 'OPEN' })];
  assert.equal(chainRootBase(members, 'trunk', alive('trunk')), 'trunk');
  // and the default branch is not alive either — still no root
  assert.equal(chainRootBase(members, 'trunk', alive()), undefined);
});

test("a member's PR base stands in when the edge is missing", () => {
  const root = chainRootBase(
    [member({ n: 3, slug: 'tool-use', prBase: 'main', prState: 'OPEN' })],
    'trunk',
    alive('main')
  );
  assert.equal(root, 'main');
});

test('a chain whose members all merged roots at the default branch', () => {
  const root = chainRootBase(
    [
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'MERGED' }),
      member({ n: 2, slug: 'token', edgeBase: 'stack/router/1-code-health', prState: 'MERGED' }),
    ],
    'trunk',
    alive('trunk')
  );
  assert.equal(root, 'trunk');
});

test('a chain that never merged keeps its own root', () => {
  const root = chainRootBase(
    [
      member({ n: 1, slug: 'code-health', edgeBase: 'feat/router-routes', prState: 'OPEN' }),
      member({ n: 2, slug: 'token', edgeBase: 'stack/router/1-code-health', prState: 'OPEN' }),
    ],
    'main',
    alive('feat/router-routes', 'stack/router/1-code-health')
  );
  assert.equal(root, 'feat/router-routes');
});

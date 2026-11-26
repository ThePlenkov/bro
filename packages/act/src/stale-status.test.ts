import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emitLifecycle } from '@broject/core';
import { staleStatus } from './stale-status.ts';
import { tmpDir } from './testtmp.ts';
import type { PrStateCache } from './state-cache.ts';
import type { PrActState } from './types.ts';
import { testGit } from '@broject/core';

const state: PrActState = {
  pr: 7,
  url: 'https://github.com/o/r/pull/7',
  headSha: 'a'.repeat(40),
  headRef: 'feat/x',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  openThreads: 0,
  threads: [],
  reopenedThreads: [],
  ciPending: 0,
  ciFailing: 0,
  reviewersPending: 0,
  reviewersFailing: 0,
  sastPending: 0,
  sastUnknown: 0,
  fixRounds: 0,
  maxRounds: 0,
  docsOnly: false,
  alerts: [],
};

const cacheAt = (at: number): PrStateCache =>
  ({
    fetchedAt: () => at,
  }) as unknown as PrStateCache;

describe('staleStatus', () => {
  test('marks a cached status stale after a same-head review event', () => {
    const dir = tmpDir('bro-stale-status-');
    testGit(['init', '-q', dir]);
    const fetchedAt = Date.now() - 2_000;
    emitLifecycle(dir, {
      kind: 'verdict',
      pr: state.pr,
      ts: Date.now() - 1_000,
      detail: { sha: state.headSha },
    });
    assert.equal(staleStatus(dir, { repo: 'o/r', pr: state.pr }, state, cacheAt(fetchedAt)), true);
  });

  test('ignores events for another head', () => {
    const dir = tmpDir('bro-stale-status-');
    testGit(['init', '-q', dir]);
    const fetchedAt = Date.now() - 2_000;
    emitLifecycle(dir, {
      kind: 'gate',
      pr: state.pr,
      ts: Date.now() - 1_000,
      detail: { sha: 'b'.repeat(40) },
    });
    assert.equal(staleStatus(dir, { repo: 'o/r', pr: state.pr }, state, cacheAt(fetchedAt)), false);
  });
});

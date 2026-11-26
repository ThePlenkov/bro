import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExitGate, GateWaitResult, PrActState } from '@broject/act';
import { waitVerdict } from './act-report.ts';

const mergedState: PrActState = {
  pr: 7,
  url: 'https://example.test/o/r/pull/7',
  headSha: 'a'.repeat(40),
  headRef: 'feat/example',
  state: 'MERGED',
  isDraft: false,
  mergeable: 'UNKNOWN',
  mergeState: 'UNKNOWN',
  openThreads: 1,
  threads: [],
  ciPending: 1,
  ciFailing: 0,
  reviewersPending: 0,
  reviewersFailing: 0,
  sastPending: 0,
  sastUnknown: 0,
  fixRounds: 0,
  maxRounds: 3,
  docsOnly: false,
  alerts: [],
  reopenedThreads: [],
};

const blockedGate: ExitGate = {
  ok: false,
  blockers: ['1 unresolved review thread'],
  alerts: [],
  open_threads: 1,
  ci_pending: 1,
  ci_failing: 0,
  reviewers_pending: 0,
  reviewers_failing: 0,
  sast_pending: 0,
  sast_unknown: 0,
  is_draft: false,
  fix_rounds: 0,
  max_rounds: 3,
  docs_only: false,
  reopened_threads: 0,
};

describe('waitVerdict', () => {
  test('maps MERGED to success even when the gate is blocked', () => {
    const result: GateWaitResult = {
      state: mergedState,
      gate: blockedGate,
      timedOut: false,
      polls: 1,
    };
    assert.equal(waitVerdict(result), 'merged');
  });
});

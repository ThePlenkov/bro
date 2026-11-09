import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mergeClaimTarget,
  mergeCloseReason,
  verifyMergeClose,
  type MergeProbe,
  type MergeTarget,
} from './verify.ts';

const probe =
  (state: string, extra: Partial<MergeProbe> = {}) =>
  async (): Promise<MergeProbe> => ({
    state,
    ...extra,
  });

describe('mergeClaimTarget', () => {
  test('the explicit PR wins over the text', () => {
    const { target } = mergeClaimTarget({ result: 'PR #958 merged', pr: 12 });
    assert.deepEqual(target, { pr: 12 });
  });

  test('the result names the PR when it does', () => {
    const { target } = mergeClaimTarget({ result: 'PR #958 merged (squash d11788ce)' });
    assert.deepEqual(target, { pr: 958 });
  });

  test('a link in the result carries the repo', () => {
    const { target } = mergeClaimTarget({
      result: 'merged [#958](https://github.com/ThePlenkov/bro/pull/958)',
    });
    assert.deepEqual(target, { pr: 958, repo: 'ThePlenkov/bro', host: 'github.com' });
  });

  test('the handoff names the PR when the result does not', () => {
    const { target } = mergeClaimTarget({
      result: 'merged',
      inputs: [
        { id: 'bro-mol-ho8k', reason: 'Gate green on [#958](https://github.com/o/r/pull/958)' },
      ],
    });
    assert.equal(target?.pr, 958);
  });

  test('two different PRs in one claim are ambiguous, not a guess', () => {
    const { target, message } = mergeClaimTarget({ result: 'PR #958 and PR #959 merged' });
    assert.equal(target, undefined);
    assert.match(message ?? '', /2 different PRs/);
  });

  test('no PR anywhere is unverifiable', () => {
    const { target, message } = mergeClaimTarget({ result: 'merged it' });
    assert.equal(target, undefined);
    assert.match(message ?? '', /names no PR/);
  });

  test('an invalid explicit PR is refused, not guessed', () => {
    const { target, message } = mergeClaimTarget({ result: 'merged', pr: Number.NaN });
    assert.equal(target, undefined);
    assert.match(message ?? '', /invalid PR number/);
  });

  test('the linked repository survives a bare reference to the same PR', () => {
    const { target } = mergeClaimTarget({
      result: 'merged [#958](https://github.com/o/r/pull/958) — PR #958 landed',
    });
    assert.deepEqual(target, { pr: 958, repo: 'o/r', host: 'github.com' });
  });

  test('the link names the host the PR lives on', () => {
    const { target } = mergeClaimTarget({
      result: 'merged [#958](https://ghe.example.com/o/r/pull/958)',
    });
    assert.equal(target?.host, 'ghe.example.com');
  });

  test('one PR number in two repositories is ambiguous, not a guess', () => {
    const { target, message } = mergeClaimTarget({
      result:
        'merged [#958](https://github.com/o/r/pull/958) and [#958](https://github.com/o/other/pull/958)',
    });
    assert.equal(target, undefined);
    assert.match(message ?? '', /two repositories/);
  });
});

describe('verifyMergeClose', () => {
  test('a merged PR closes the step and the verdict leads the reason', async () => {
    const verdict = await verifyMergeClose(
      { result: 'PR #958 merged by the watcher' },
      probe('MERGED', { mergedBy: 'ThePlenkov', mergeSha: 'd11788ce1234567890' })
    );
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.match(verdict.reason, /^verified: PR #958 MERGED \(merge d11788ce, by ThePlenkov\)/);
    // the agent's sentence follows as the claim it is
    assert.match(verdict.reason, /PR #958 merged by the watcher/);
  });

  test('an open PR refuses — the gate holds', async () => {
    const verdict = await verifyMergeClose({ result: 'PR #958 merged' }, probe('OPEN'));
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.message, /is OPEN/);
    assert.match(verdict.message, /closes only on a merged PR/);
  });

  test('a closed-unmerged PR refuses too', async () => {
    const verdict = await verifyMergeClose({ result: 'PR #958 merged' }, probe('CLOSED'));
    assert.equal(verdict.ok, false);
  });

  test('a host that cannot answer refuses — fail closed', async () => {
    const verdict = await verifyMergeClose({ result: 'PR #958 merged' }, async () => {
      throw new Error('gh: API rate limit exceeded');
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.message, /could not answer/);
  });

  test('a claim without a PR refuses before the host is asked', async () => {
    let asked = false;
    const verdict = await verifyMergeClose({ result: 'merged it' }, async () => {
      asked = true;
      return { state: 'MERGED' };
    });
    assert.equal(verdict.ok, false);
    assert.equal(asked, false);
  });

  test('the probe is asked about the claimed PR', async () => {
    const seen: MergeTarget[] = [];
    await verifyMergeClose({ result: 'PR #958 merged' }, async t => {
      seen.push(t);
      return { state: 'MERGED' };
    });
    assert.deepEqual(seen, [{ pr: 958 }]);
  });
});

describe('mergeCloseReason', () => {
  test('a merge with no record reads as the bare verdict', () => {
    const reason = mergeCloseReason({ pr: 958 }, { state: 'MERGED' }, { result: '' });
    assert.equal(reason, 'verified: PR #958 MERGED');
  });

  test('a repository-qualified PR reads as a link — the verdict names the repo', () => {
    const reason = mergeCloseReason(
      { pr: 958, repo: 'o/r', host: 'github.com' },
      { state: 'MERGED', mergedBy: 'ThePlenkov', mergeSha: 'd11788ce1234' },
      { result: '' }
    );
    assert.match(
      reason,
      /verified: \[#958\]\(https:\/\/github\.com\/o\/r\/pull\/958\) MERGED \(merge d11788ce, by ThePlenkov\)/
    );
  });
});

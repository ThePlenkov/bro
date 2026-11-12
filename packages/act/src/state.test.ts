import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CheckInfo, PrMeta, PrTarget, ReviewFacade, ReviewThread } from '@broject/core';
import type { CheckHistory } from './check-history.ts';
import type { PrStateCache } from './state-cache.ts';
import type { PrActState } from './types.ts';
import { fetchPrActState } from './state.ts';

const SHA = 'a'.repeat(40);
const target: PrTarget = { repo: 'o/r', pr: 7 };

const meta: PrMeta = {
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/7',
  headSha: SHA,
  headRef: 'feat/x',
  baseRef: 'main',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
};

const check = (name: string, bucket: string): CheckInfo => ({
  name,
  state: bucket === 'fail' ? 'FAILURE' : bucket === 'pending' ? 'PENDING' : 'SUCCESS',
  bucket,
});

const thread = (author: string, createdAt: string): ReviewThread => ({
  id: `t-${author}-${createdAt}`,
  resolved: false,
  outdated: false,
  comment: { author, bot: true, path: 'x.ts', line: 1, body: 'n', createdAt },
});

function fakeRev(checks: CheckInfo[], threads: ReviewThread[]): ReviewFacade {
  return {
    prMeta: () => meta,
    reviewThreads: async () => threads,
    checks: () => checks,
    checkAnnotations: () => new Map(),
    reviewedShas: () => [SHA],
  } as unknown as ReviewFacade;
}

/** In-memory history with a preset streak — state.ts reads only the
 *  interface, so tests pin the streak directly. */
function memHistory(streak: number): CheckHistory & { recorded: string[] } {
  const recorded: string[] = [];
  return {
    recorded,
    record: o => {
      recorded.push(`${o.name}@${o.sha.slice(0, 7)}=${o.bucket}`);
    },
    consecutiveFailures: () => streak,
  };
}

const fresh = new Date().toISOString();
const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();

describe('fetchPrActState — conditional ignoreChecks', () => {
  const rules = [{ name: 'kilo', consecutiveFailures: 3, threadWindowDays: 7 }];

  test('non-matching checks pass through untouched', async () => {
    const s = await fetchPrActState(fakeRev([check('build', 'fail')], []), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    });
    assert.equal(s.ciFailing, 1);
    assert.deepEqual(s.alerts, []);
  });

  test('a pending ignored check stays silently ignored', async () => {
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'pending')], []), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(0),
    });
    assert.equal(s.reviewersPending, 0);
    assert.deepEqual(s.alerts, []);
  });

  test('failing with no thread activity alerts — silent reviewer', async () => {
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], []), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    });
    // the check stays out of the gate…
    assert.equal(s.ciFailing, 0);
    assert.equal(s.reviewersFailing, 0);
    // …but the silence is surfaced
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!, /may be down/);
    assert.match(s.alerts[0]!, /Kilo Code/);
  });

  test('failing below the streak with fresh threads alerts as unproven', async () => {
    const threads = [thread('kilo-code[bot]', fresh)];
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(2), // 2 < 3
    });
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!, /not yet proven flaky/);
  });

  test('streak + fresh thread by the check bot earns the quiet ignore', async () => {
    const threads = [thread('kilo-code[bot]', fresh)];
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(5),
    });
    assert.deepEqual(s.alerts, []);
    assert.equal(s.reviewersFailing, 0);
  });

  test('threads by another author do not certify the reviewer alive', async () => {
    const threads = [thread('human-reviewer', fresh), thread('greptile-apps[bot]', fresh)];
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    });
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!, /may be down/);
  });

  test('a matching thread outside the window is not proof of life', async () => {
    const threads = [thread('kilo-code[bot]', stale)];
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    });
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!, /may be down/);
  });

  test('a bare string entry is a rule with default thresholds', async () => {
    const threads = [thread('kilo-code[bot]', fresh)];
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: ['kilo'],
      checkHistory: memHistory(3), // default consecutiveFailures
    });
    assert.deepEqual(s.alerts, []);
  });

  test('no history means no streak — a first-seen failure alerts', async () => {
    const threads = [thread('kilo-code[bot]', fresh)];
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: null,
    });
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!, /not yet proven flaky/);
  });

  test('the current observation is recorded before the verdict', async () => {
    const h = memHistory(0);
    await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], []), target, {
      ignoreChecks: rules,
      checkHistory: h,
    });
    assert.deepEqual(h.recorded, [`Kilo Code@${SHA.slice(0, 7)}=fail`]);
  });

  test('an explicitly ignored SAST check drops its annotations from the gate', async () => {
    const rev = fakeRev([check('SonarCloud Code Analysis', 'pass')], []);
    rev.checkAnnotations = () => new Map([['SonarCloud Code Analysis', 3]]);
    const s = await fetchPrActState(rev, target, {
      ignoreChecks: ['sonarcloud'],
      checkHistory: memHistory(0),
    });
    // the operator named the scanner advisory — an explicit rule wins
    // over the SAST must-fix default, annotations and all
    assert.equal(s.sastPending, 0);
    assert.deepEqual(s.alerts, []);
  });

  test('an ignored SAST check with no findings stays quiet', async () => {
    const rev = fakeRev([check('SonarCloud Code Analysis', 'pass')], []);
    rev.checkAnnotations = () => new Map([['SonarCloud Code Analysis', 0]]);
    const s = await fetchPrActState(rev, target, {
      ignoreChecks: ['sonarcloud'],
      checkHistory: memHistory(0),
    });
    assert.equal(s.sastPending, 0);
    assert.deepEqual(s.alerts, []);
  });

  test('a failing ignored SAST check is advisory — surfaced as an alert, not a blocker', async () => {
    const s = await fetchPrActState(
      fakeRev([check('Codacy Static Code Analysis', 'fail')], []),
      target,
      {
        ignoreChecks: ['codacy'],
        checkHistory: memHistory(9),
      }
    );
    // the explicit rule excludes the scanner from the gate — and a
    // scanner never earns 'alive' from threads (verdicts live in the
    // check output), so the alert names the failure, not a dead reviewer
    assert.equal(s.ciFailing, 0);
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!, /check output, not threads/);
  });

  test('an unnamed SAST check still gates — the override must be explicit', async () => {
    const s = await fetchPrActState(
      fakeRev([check('Codacy Static Code Analysis', 'fail')], []),
      target,
      { checkHistory: memHistory(9) }
    );
    assert.equal(s.ciFailing, 1);
    assert.deepEqual(s.alerts, []);
  });

  test('a NEUTRAL SAST conclusion still gets its annotations inspected', async () => {
    const rev = fakeRev(
      [{ name: 'Codacy Static Code Analysis', state: 'NEUTRAL', bucket: 'pass' }],
      []
    );
    rev.checkAnnotations = () => new Map([['Codacy Static Code Analysis', 2]]);
    const s = await fetchPrActState(rev, target, {});
    assert.equal(s.sastPending, 2);
  });

  test('scanner names beyond the original set are recognized — deepsource/codeclimate', async () => {
    const rev = fakeRev([check('DeepSource: Analysis', 'pass'), check('codeclimate', 'pass')], []);
    rev.checkAnnotations = () =>
      new Map([
        ['DeepSource: Analysis', 1],
        ['codeclimate', 2],
      ]);
    const s = await fetchPrActState(rev, target, {});
    assert.equal(s.sastPending, 3);
  });
});

describe('fetchPrActState — the human-approval probe (bro-3vy93)', () => {
  test('a true verdict lands on state with no reason', async () => {
    const rev = fakeRev([], []);
    let seen: readonly string[] | undefined;
    rev.humanApprovedAsync = async (_t, o) => {
      seen = o?.approvers;
      return { approved: true };
    };
    const s = await fetchPrActState(rev, target, {
      requireApproval: true,
      approvers: ['alice'],
    });
    assert.equal(s.humanApproval, true);
    assert.equal(s.humanApprovalReason, undefined);
    assert.deepEqual(seen, ['alice']); // the allowlist reaches the host probe
  });

  test('a refused verdict carries its reason for the blocker', async () => {
    const rev = fakeRev([], []);
    rev.humanApprovedAsync = async () => ({
      approved: false,
      reason: 'changes requested by bob',
    });
    const s = await fetchPrActState(rev, target, { requireApproval: true });
    assert.equal(s.humanApproval, false);
    assert.equal(s.humanApprovalReason, 'changes requested by bob');
  });

  test('a host without the probe reads unanswerable — undefined, never a pass', async () => {
    const s = await fetchPrActState(fakeRev([], []), target, { requireApproval: true });
    assert.equal(s.humanApproval, undefined);
    assert.equal(s.humanApprovalReason, undefined);
  });

  test('a throwing probe is unanswerable, not a crash', async () => {
    const rev = fakeRev([], []);
    rev.humanApprovedAsync = async () => {
      throw new Error('host unreachable');
    };
    const s = await fetchPrActState(rev, target, { requireApproval: true });
    assert.equal(s.humanApproval, undefined);
  });

  test('requireApproval off → the probe never runs (lazy)', async () => {
    const rev = fakeRev([], []);
    let calls = 0;
    rev.humanApprovedAsync = async () => {
      calls += 1;
      return { approved: true };
    };
    // the SYNC twin counts too — an accidental sync call escapes an
    // async-only spy
    rev.humanApproved = () => {
      calls += 1;
      return { approved: true };
    };
    const s = await fetchPrActState(rev, target, {});
    assert.equal(calls, 0);
    assert.equal(s.humanApproval, undefined);
  });

  test('a legacy boolean probe answer normalizes to the verdict', async () => {
    const rev = fakeRev([], []);
    rev.humanApproved = () => true; // the #561 contract — still valid
    const s = await fetchPrActState(rev, target, { requireApproval: true });
    assert.equal(s.humanApproval, true);
  });

  test('a verdict bound to a superseded head refuses — it answered a different question', async () => {
    const rev = fakeRev([], []);
    rev.humanApprovedAsync = async () => ({ approved: true, headSha: 'b'.repeat(40) });
    const s = await fetchPrActState(rev, target, { requireApproval: true });
    assert.equal(s.humanApproval, false);
    assert.match(s.humanApprovalReason!, /head moved/);
  });

  test('the probe payload answers reviewDecision — no second host call', async () => {
    const rev = fakeRev([], []);
    let decisionCalls = 0;
    rev.reviewDecisionAsync = async () => {
      decisionCalls += 1;
      return 'APPROVED';
    };
    rev.humanApprovedAsync = async () => ({ approved: false, hostApproved: true });
    const s = await fetchPrActState(rev, target, { requireApproval: true });
    assert.equal(decisionCalls, 0);
    assert.equal(s.reviewDecision, 'APPROVED');
  });
});

describe('fetchPrActState — approval probe identity (PR 636 review)', () => {
  const memCache = (): PrStateCache => {
    let entry: PrActState | null = null;
    return {
      read: () => entry,
      write: (_t, s) => {
        entry = s;
      },
      invalidate: () => {
        entry = null;
      },
      invalidateAll: () => {
        entry = null;
      },
      acquire: () => () => {},
      acquireAsync: async () => () => {},
    };
  };

  test('a verdict probed under a different allowlist is not served', async () => {
    const rev = fakeRev([], []);
    const seen: string[][] = [];
    rev.humanApprovedAsync = async (_t, o) => {
      seen.push([...(o?.approvers ?? [])]);
      return { approved: true };
    };
    const cache = memCache();
    await fetchPrActState(rev, target, {
      requireApproval: true,
      approvers: ['alice'],
      stateCache: cache,
    });
    // second caller, different trust set — the cached verdict was
    // probed under ['alice'] and must not serve ['bob']
    await fetchPrActState(rev, target, {
      requireApproval: true,
      approvers: ['bob'],
      stateCache: cache,
    });
    assert.deepEqual(seen, [['alice'], ['bob']]);
  });

  test('a verdict probed under the same allowlist serves from cache', async () => {
    const rev = fakeRev([], []);
    let calls = 0;
    rev.humanApprovedAsync = async () => {
      calls += 1;
      return { approved: true };
    };
    const cache = memCache();
    const opts = { requireApproval: true, approvers: ['alice'], stateCache: cache };
    await fetchPrActState(rev, target, opts);
    // case/format variants of the same set share the probe identity
    await fetchPrActState(rev, target, { ...opts, approvers: ['ALICE'] });
    assert.equal(calls, 1);
  });

  test('a verdict from another probe generation never serves', async () => {
    const rev = fakeRev([], []);
    let calls = 0;
    rev.humanApprovedAsync = async () => {
      calls += 1;
      return { approved: true };
    };
    const cache = memCache();
    const opts = { requireApproval: true, approvers: ['alice'], stateCache: cache };
    const first = await fetchPrActState(rev, target, opts);
    assert.equal(calls, 1);
    // an entry written by an older probe — same allowlist, different
    // generation — answered a different question and must not serve
    cache.write(target, { ...first, humanApprovalProbe: '1' });
    await fetchPrActState(rev, target, opts);
    assert.equal(calls, 2);
  });

  test('a cached verdict bound to a different head never serves', async () => {
    const rev = fakeRev([], []);
    let calls = 0;
    rev.humanApprovedAsync = async () => {
      calls += 1;
      return { approved: true, headSha: meta.headSha };
    };
    const cache = memCache();
    const opts = { requireApproval: true, approvers: ['alice'], stateCache: cache };
    const first = await fetchPrActState(rev, target, opts);
    assert.equal(calls, 1);
    // a verdict naming a head that isn't the snapshot's head was
    // answered against a different question — never serve it
    cache.write(target, { ...first, humanApprovalHeadSha: 'f'.repeat(40) });
    await fetchPrActState(rev, target, opts);
    assert.equal(calls, 2);
  });

  test('in-flight dedup splits on the probe inputs, not just the target', async () => {
    const rev = fakeRev([], []);
    const releases: (() => void)[] = [];
    rev.prMetaAsync = async () => {
      await new Promise<void>(r => {
        releases.push(r);
      });
      return meta;
    };
    const seen: string[][] = [];
    rev.humanApprovedAsync = async (_t, o) => {
      seen.push([...(o?.approvers ?? [])]);
      return { approved: true };
    };
    const p1 = fetchPrActState(rev, target, { requireApproval: true, approvers: ['a'] });
    const p2 = fetchPrActState(rev, target, { requireApproval: true, approvers: ['b'] });
    // let both fetch chains reach their meta gate — two fetches means
    // the dedup key split on the probe inputs; one means a shared
    // fetch would smuggle one caller's trust set into the other's
    // verdict. Release before asserting so a regression can't hang.
    for (let i = 0; i < 50 && releases.length < 2; i++) {
      await new Promise(r => setTimeout(r, 0));
    }
    for (const release of releases) release();
    assert.equal(releases.length, 2);
    await Promise.all([p1, p2]);
    assert.deepEqual(seen.sort(), [['a'], ['b']]);
  });
});

describe('fetchPrActState — the gate never counts itself', () => {
  // The gate publishes itself as a project-side required check: while the
  // gate job runs, its own check is pending on the PR's head SHA. A gate
  // that counts itself waits for itself — it can never settle green, and
  // the required context can never report success (bro-k1au2).

  test('a pending self check is not counted as pending CI', async () => {
    const s = await fetchPrActState(fakeRev([check('act-gate', 'pending')], []), target, {
      selfCheck: 'act-gate',
    });
    assert.equal(s.ciPending, 0);
  });

  test('a failing self check is not counted as failing CI', async () => {
    const s = await fetchPrActState(fakeRev([check('act-gate', 'fail')], []), target, {
      selfCheck: 'act-gate',
    });
    assert.equal(s.ciFailing, 0);
  });

  test('without the setting the self check counts like any other check', async () => {
    const s = await fetchPrActState(fakeRev([check('act-gate', 'pending')], []), target);
    assert.equal(s.ciPending, 1);
  });

  test('the match ignores case and separator style', async () => {
    const s = await fetchPrActState(fakeRev([check('Act Gate', 'pending')], []), target, {
      selfCheck: 'ACT-GATE',
    });
    assert.equal(s.ciPending, 0);
  });

  test('the other checks still gate', async () => {
    const s = await fetchPrActState(
      fakeRev([check('act-gate', 'pending'), check('build-test', 'fail')], []),
      target,
      { selfCheck: 'act-gate' }
    );
    assert.equal(s.ciPending, 0);
    assert.equal(s.ciFailing, 1);
  });

  test('an empty setting excludes nothing', async () => {
    const s = await fetchPrActState(fakeRev([check('act-gate', 'pending')], []), target, {
      selfCheck: '',
    });
    assert.equal(s.ciPending, 1);
  });

  test('a check that merely contains the name is not the gate', async () => {
    // a substring match would drop an unrelated check from the gate —
    // the one thing the gate must never do
    const s = await fetchPrActState(fakeRev([check('my act gate wrapper', 'fail')], []), target, {
      selfCheck: 'act-gate',
    });
    assert.equal(s.ciFailing, 1);
  });

  test('a composite workflow / job name is the gate', async () => {
    const s = await fetchPrActState(
      fakeRev([check('Act gate / act-gate', 'pending')], []),
      target,
      {
        selfCheck: 'act-gate',
      }
    );
    assert.equal(s.ciPending, 0);
  });
});

describe('fetchPrActState — the veto-review probe (bro-n1foa)', () => {
  const vetoMeta: PrMeta = { ...meta, reviewDecision: 'CHANGES_REQUESTED' };
  const veto = {
    id: 'PRR_1',
    author: 'kody-ai',
    submittedAt: '2026-10-01T00:00:00Z',
    commitSha: SHA,
    threads: 15,
    stale: true,
  };

  test('a standing veto enumerates its reviews into state', async () => {
    const rev = fakeRev([], []);
    rev.prMeta = () => vetoMeta;
    rev.vetoReviews = async () => [veto];
    const s = await fetchPrActState(rev, target, {});
    assert.equal(s.reviewDecision, 'CHANGES_REQUESTED');
    assert.deepEqual(s.vetoReviews, [veto]);
  });

  test('non-veto decisions never pay the probe — laziness is the contract', async () => {
    const rev = fakeRev([], []);
    let calls = 0;
    rev.vetoReviews = async () => {
      calls += 1;
      return [veto];
    };
    rev.prMeta = () => ({ ...meta, reviewDecision: 'APPROVED' });
    await fetchPrActState(rev, target, {});
    assert.equal(calls, 0);
    // no decision at all — same
    rev.prMeta = () => meta;
    const s = await fetchPrActState(rev, target, {});
    assert.equal(calls, 0);
    assert.equal(s.vetoReviews, undefined);
  });

  test('a throwing probe degrades to undefined — the gate still blocks on reviewDecision', async () => {
    const rev = fakeRev([], []);
    rev.prMeta = () => vetoMeta;
    rev.vetoReviews = async () => {
      throw new Error('pagination broke');
    };
    const s = await fetchPrActState(rev, target, {});
    assert.equal(s.reviewDecision, 'CHANGES_REQUESTED');
    assert.equal(s.vetoReviews, undefined);
  });

  test('a SYNCHRONOUSLY throwing probe degrades the same way — the fetch survives', async () => {
    // codeant-ai on PR #1020: the facade contract types the probe
    // Promise-returning, but a non-async impl can throw before its
    // promise exists — .catch-on-promise alone let that escape the
    // whole state fetch
    const rev = fakeRev([], []);
    rev.prMeta = () => vetoMeta;
    rev.vetoReviews = () => {
      throw new Error('host exploded before returning a promise');
    };
    const s = await fetchPrActState(rev, target, {});
    assert.equal(s.reviewDecision, 'CHANGES_REQUESTED');
    assert.equal(s.vetoReviews, undefined);
  });

  test('a host without the probe leaves vetoReviews undefined', async () => {
    const rev = fakeRev([], []);
    rev.prMeta = () => vetoMeta;
    const s = await fetchPrActState(rev, target, {});
    assert.equal(s.reviewDecision, 'CHANGES_REQUESTED');
    assert.equal(s.vetoReviews, undefined);
  });
});

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgeUnavailable, scrubEnv, testGit } from '@broject/core';
import type { DecideResult, JudgeFacade, JudgeQuestion, Verdict } from '@broject/core';
import { readJournal } from './journal.ts';
import { ROUTE_PICK_KIND, routePick, routePickQuestions } from './route-pick.ts';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

const withRepo = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-judge-route-pick-'));
  try {
    testGit(['init', '-q', dir]);
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const OPTIONS = [
  { name: 'edit', description: 'chain: devin-acp → kilo-free' },
  { name: 'design', description: 'chain: devin-acp(swe-2-max)' },
];

/** A JudgeFacade returning a scripted DecideResult. */
const judgeReturning = (res: Partial<DecideResult>): JudgeFacade => ({
  decide: async () => ({
    answers: {},
    model: 'jev-test',
    latencyMs: 1,
    lowConfidence: [],
    ...res,
  }),
});

const judgeFailing = (err: Error): JudgeFacade => ({
  decide: async () => {
    throw err;
  },
});

const pick = (choice: string): Partial<DecideResult> => ({
  answers: {
    route: {
      type: 'choice',
      choice,
      probabilities: {},
      confidence: 0.9,
      decidedBy: 'provider:orca',
    },
  },
});

const lastVerdict = (dir: string): Verdict => {
  const rows = readJournal(dir).filter((r): r is Verdict => 'questions' in r);
  assert.ok(rows.length > 0, 'expected a journaled verdict');
  return rows.at(-1)!;
};

describe('routePickQuestions', () => {
  test('one choice question keyed route; the criteria ARE the candidate routes', () => {
    const qs = routePickQuestions(OPTIONS);
    assert.deepEqual(Object.keys(qs), ['route']);
    const q = qs['route']!;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria).sort(), ['design', 'edit']);
    // the criteria ARE the options' descriptions — whole values, not a
    // substring of one: a name that merely CONTAINS a model names no model
    assert.deepEqual(q.criteria, {
      edit: 'chain: devin-acp → kilo-free',
      design: 'chain: devin-acp(swe-2-max)',
    });
  });

  test('a "__proto__" route lands as an own key, never a prototype write', () => {
    const qs = routePickQuestions([{ name: '__proto__', description: 'chain: p' }]);
    const criteria = (qs['route'] as JudgeQuestion & { type: 'choice' }).criteria;
    assert.ok(Object.hasOwn(criteria, '__proto__'));
    assert.equal(criteria['__proto__'], 'chain: p');
  });
});

describe('routePick', () => {
  const state = { title: 'redesign the ledger', description: '' };

  test('shadow journals the verdict beside the resolved route and picks nothing', () =>
    withRepo(async dir => {
      const got = await routePick({
        dir,
        judge: judgeReturning(pick('design')),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'shadow',
      });
      assert.equal(got, undefined);
      const v = lastVerdict(dir);
      assert.equal(v.kind, ROUTE_PICK_KIND);
      assert.equal(v.subject.threadId, 'task-1');
      // the pick is journaled, the OUTCOME is the resolved route
      assert.equal(v.outcome, 'edit');
    }));

  test('enforce returns a confident pick and journals it as the outcome', () =>
    withRepo(async dir => {
      const got = await routePick({
        dir,
        judge: judgeReturning(pick('design')),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'enforce',
      });
      assert.equal(got, 'design');
      assert.equal(lastVerdict(dir).outcome, 'design');
    }));

  test('enforce never invents a route — an off-table pick is no verdict', () =>
    withRepo(async dir => {
      const got = await routePick({
        dir,
        judge: judgeReturning(pick('ghost')),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'enforce',
      });
      assert.equal(got, undefined);
      assert.equal(lastVerdict(dir).outcome, 'edit');
    }));

  test('off never calls the judge', () =>
    withRepo(async dir => {
      const got = await routePick({
        dir,
        judge: judgeFailing(new Error('must not be called')),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'off',
      });
      assert.equal(got, undefined);
      assert.equal(readJournal(dir).length, 0);
    }));

  test('JudgeUnavailable propagates — the caller owns the warn-and-stand', () =>
    withRepo(async dir => {
      await assert.rejects(
        () =>
          routePick({
            dir,
            judge: judgeFailing(new JudgeUnavailable('quota exhausted')),
            options: OPTIONS,
            state,
            subject: 'task-1',
            resolved: 'edit',
            mode: 'enforce',
          }),
        JudgeUnavailable
      );
      assert.equal(readJournal(dir).length, 0);
    }));

  test('escalate merges a confident answer onto a low-confidence key T2 never answered', () =>
    withRepo(async dir => {
      // T2 flags `route` low-confidence but emits NO answer entry — the
      // escalate judge's confident pick must still land, or enforce
      // falls back to the resolved route for no reason
      // (bro-0ykhg.2 review)
      const got = await routePick({
        dir,
        judge: judgeReturning({ answers: {}, lowConfidence: ['route'] }),
        escalate: judgeReturning(pick('design')),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'enforce',
      });
      assert.equal(got, 'design');
      assert.equal(lastVerdict(dir).outcome, 'design');
    }));

  test('escalate still overrides a low-confidence answer it disagrees with', () =>
    withRepo(async dir => {
      const got = await routePick({
        dir,
        judge: judgeReturning({ ...pick('edit'), lowConfidence: ['route'] }),
        escalate: judgeReturning(pick('design')),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'enforce',
      });
      assert.equal(got, 'design');
    }));

  test('a low-confidence escalate answer merges nothing — the resolved route stands', () =>
    withRepo(async dir => {
      const got = await routePick({
        dir,
        judge: judgeReturning({ answers: {}, lowConfidence: ['route'] }),
        escalate: judgeReturning({ ...pick('design'), lowConfidence: ['route'] }),
        options: OPTIONS,
        state,
        subject: 'task-1',
        resolved: 'edit',
        mode: 'enforce',
      });
      assert.equal(got, undefined);
      assert.equal(lastVerdict(dir).outcome, 'edit');
    }));
});

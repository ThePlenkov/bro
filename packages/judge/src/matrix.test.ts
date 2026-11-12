import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgeUnavailable, scrubEnv, testGit } from '@broject/core';
import type { DecideResult, FleetMatrix, JudgeFacade, Verdict } from '@broject/core';
import { readJournal } from './journal.ts';
import { MATRIX_KIND, matrixQuestions, routeMatrix } from './matrix.ts';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

const withRepo = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-judge-matrix-'));
  try {
    testGit(['init', '-q', dir]);
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const MATRIX: FleetMatrix = {
  provider: 'orca',
  mode: 'shadow',
  complexity: ['low', 'medium', 'high'],
  modes: ['planning', 'coding', 'review', 'fix'],
  models: {
    cheap: { modes: ['coding'], complexity: ['low'], provider: 'dirac' },
    max: { modes: ['planning', 'coding'], complexity: ['low', 'medium', 'high'] },
  },
};

/** A JudgeFacade returning a scripted DecideResult — records the
 *  questions it was asked so tests can prove the one-call shape. */
const judgeReturning = (
  res: Partial<DecideResult>
): { judge: JudgeFacade; seen: Array<Record<string, unknown>> } => {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    judge: {
      decide: async (_state: unknown, questions: Record<string, unknown>) => {
        seen.push(questions as Record<string, unknown>);
        return {
          answers: {},
          model: 'jev-test',
          latencyMs: 1,
          lowConfidence: [],
          ...res,
        };
      },
    },
  };
};

const both = (level: number, mode: string): Partial<DecideResult> => ({
  answers: {
    complexity: {
      type: 'score',
      score: level,
      probabilities: {},
      confidence: 0.9,
      decidedBy: 'provider:orca',
    },
    mode: {
      type: 'choice',
      choice: mode,
      probabilities: {},
      confidence: 0.9,
      decidedBy: 'provider:orca',
    },
  },
});

const matrixRows = (dir: string): Verdict[] =>
  readJournal(dir).filter((r): r is Verdict => 'questions' in r && r.kind === MATRIX_KIND);

describe('matrixQuestions', () => {
  test('ONE decide carries exactly two questions — score + choice', () => {
    const q = matrixQuestions(MATRIX);
    assert.deepEqual(Object.keys(q).sort(), ['complexity', 'mode']);
    assert.equal(q['complexity']!.type, 'score');
    assert.equal(q['mode']!.type, 'choice');
    // the score criteria ARE the ordered scale (order is the contract)
    const cx = q['complexity']!;
    assert.equal(cx.type, 'score');
    if (cx.type === 'score') {
      assert.equal(cx.criteria.length, 3);
    }
    // the choice criteria ARE the declared modes — the router never
    // invents a mode the matrix didn't declare
    const md = q['mode']!;
    assert.equal(md.type, 'choice');
    if (md.type === 'choice') {
      assert.deepEqual(Object.keys(md.criteria).sort(), ['coding', 'fix', 'planning', 'review']);
    }
  });

  test('a "__proto__" mode lands as an own key, never a prototype write', () => {
    const m: FleetMatrix = { ...MATRIX, modes: ['__proto__', 'coding'] };
    const q = matrixQuestions(m);
    const md = q['mode']!;
    assert.equal(md.type, 'choice');
    if (md.type === 'choice') {
      assert.equal(Object.hasOwn(md.criteria, '__proto__'), true);
      assert.equal(typeof md.criteria['__proto__'], 'string');
    }
  });
});

describe('routeMatrix', () => {
  test('shadow journals the verdict and picks nothing — spawn stands', () =>
    withRepo(async dir => {
      const { judge, seen } = judgeReturning(both(0, 'coding'));
      const pick = await routeMatrix({
        dir,
        judge,
        state: { molStep: 'fx-1', title: 'sweep', description: '' },
        subject: 'fx-1',
        matrix: MATRIX,
        mode: 'shadow',
      });
      assert.equal(pick, undefined);
      assert.equal(seen.length, 1); // ONE decide() for both questions
      const rows = matrixRows(dir);
      assert.equal(rows.length, 1);
      const v = rows[0]!;
      assert.equal(v.subject.threadId, 'fx-1');
      assert.equal(v.outcome, 'cheap'); // the would-be pick, journaled
      assert.equal(v.answers['complexity']!.type, 'score');
      assert.equal(v.answers['mode']!.type, 'choice');
    }));

  test('enforce returns the pick; a no-fit verdict returns undefined', () =>
    withRepo(async dir => {
      const { judge } = judgeReturning(both(2, 'review'));
      // 'review' mode: neither row declares it → no-fit under enforce
      const pick = await routeMatrix({
        dir,
        judge,
        state: {},
        subject: 'fx-2',
        matrix: MATRIX,
        mode: 'enforce',
      });
      assert.equal(pick, undefined);
      assert.equal(matrixRows(dir)[0]!.outcome, 'no-fit');
    }));

  test('enforce returns a confident pick as the verdict object', () =>
    withRepo(async dir => {
      const { judge } = judgeReturning(both(1, 'coding'));
      const pick = await routeMatrix({
        dir,
        judge,
        state: {},
        subject: 'fx-3',
        matrix: MATRIX,
        mode: 'enforce',
      });
      assert.equal(pick?.kind, 'pick');
      if (pick?.kind === 'pick') {
        assert.equal(pick.model, 'max'); // medium → cheap filtered out
      }
      assert.equal(matrixRows(dir)[0]!.outcome, 'max');
    }));

  test('off never calls the judge and journals nothing', () =>
    withRepo(async dir => {
      const { judge, seen } = judgeReturning(both(0, 'coding'));
      const pick = await routeMatrix({
        dir,
        judge,
        state: {},
        subject: 'fx-4',
        matrix: MATRIX,
        mode: 'off',
      });
      assert.equal(pick, undefined);
      assert.equal(seen.length, 0);
      assert.equal(matrixRows(dir).length, 0);
    }));

  test('an unanswered verdict journals outcome unanswered', () =>
    withRepo(async dir => {
      const { judge } = judgeReturning({ answers: {}, lowConfidence: ['complexity', 'mode'] });
      await routeMatrix({
        dir,
        judge,
        state: {},
        subject: 'fx-5',
        matrix: MATRIX,
        mode: 'shadow',
      });
      assert.equal(matrixRows(dir)[0]!.outcome, 'unanswered');
    }));

  test('JudgeUnavailable propagates — the caller owns warn-and-stand', () =>
    withRepo(async dir => {
      const judge: JudgeFacade = {
        decide: async () => {
          throw new JudgeUnavailable('down');
        },
      };
      await assert.rejects(
        () =>
          routeMatrix({
            dir,
            judge,
            state: {},
            subject: 'fx-6',
            matrix: MATRIX,
            mode: 'shadow',
          }),
        JudgeUnavailable
      );
      assert.equal(matrixRows(dir).length, 0); // no verdict, no row
    }));
});

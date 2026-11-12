import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { DecideResult } from '@broject/core';
import { candidates, inTableOrder } from './candidates.ts';
import {
  applyFormulaFilters,
  FormulaError,
  formulaAnswersToFeatures,
  formulaDoc,
  formulaQuestions,
  mergeTaskFeatures,
  parseFormulaText,
  readFormula,
  validateFormulaTable,
  type Formula,
} from './formula.ts';
import { resolveRoute } from './resolve.ts';
import { routeTable } from './schema.ts';
import { priorOnlyOutcomes, scoreCandidates, type OutcomeStatsSource } from './score.ts';
import type { RouteTable } from './types.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-routes-formula-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The spec's example, verbatim — the contract every parse starts from. */
const SPEC_FORMULA = `---
kind: formula
version: 1
shape: features
questions:
  complexity: { type: choice, options: [low, medium, high] }
  mode:       { type: choice, options: [planning, coding, review, fix] }
  needs_ui:   { type: bool }
filters:
  - route: free-lane
    unless: { complexity: [high] }
success: merged_first_round
---
Complexity is HIGH when the task touches more than one package or a
protocol boundary. Review means the task text names a PR …
`;

/** A formula doc, parsed — problems throw FormulaError. */
function formulaOf(doc: unknown): Formula {
  return formulaDoc(doc, 'test');
}

/** The problems a formula document carries. */
function formulaProblems(doc: unknown): string[] {
  try {
    formulaOf(doc);
    return [];
  } catch (err) {
    assert.ok(err instanceof FormulaError, 'expected a FormulaError');
    return err.problems;
  }
}

/** A valid features formula — the base every mutation starts from. */
const VALID_FEATURES = {
  kind: 'formula',
  version: 1,
  shape: 'features',
  questions: {
    complexity: { type: 'choice', options: ['low', 'medium', 'high'] },
    mode: { type: 'choice', options: ['planning', 'coding', 'review', 'fix'] },
    needs_ui: { type: 'bool' },
    effort: { type: 'score', levels: ['trivial', 'small', 'large'] },
  },
};

/** The table the formula checks against — feature-matched routes plus
 *  a catch-all, in declaration order. */
const TABLE: RouteTable = routeTable({
  kind: 'route',
  version: 1,
  routes: {
    'free-lane': {
      match: { features: { complexity: ['low', 'medium'] } },
      chain: [{ provider: 'kilo-free' }],
      description: 'the free lane',
    },
    'paid-lane': {
      match: { features: { complexity: 'high' } },
      chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
      description: 'the paid lane',
    },
    fallback: {
      chain: [{ provider: 'kilo-free' }],
      description: 'anything else',
    },
  },
});

describe('parseFormulaText', () => {
  test('the spec example parses — shape, questions, filters, prose', () => {
    const formula = parseFormulaText(SPEC_FORMULA, 'spec.md');
    assert.equal(formula.kind, 'formula');
    assert.equal(formula.shape, 'features');
    assert.equal(formula.success, 'merged_first_round');
    assert.deepEqual(Object.keys(formula.questions).sort(), ['complexity', 'mode', 'needs_ui']);
    assert.equal(formula.questions.complexity?.type, 'choice');
    assert.equal(formula.filters.length, 1);
    assert.equal(formula.filters[0]?.route, 'free-lane');
    assert.match(formula.prose, /Complexity is HIGH/);
  });

  test('each shape round-trips', () => {
    for (const shape of ['features', 'pick', 'score'] as const) {
      const doc =
        shape === 'pick'
          ? { kind: 'formula', version: 1, shape }
          : {
              kind: 'formula',
              version: 1,
              shape,
              questions: { mode: { type: 'choice', options: ['a', 'b'] } },
              ...(shape === 'score' ? { score: { lambda: 0.3, mu: 0.1 } } : {}),
            };
      const text = `---\n${JSON.stringify(doc)}\n---\nprose\n`;
      // JSON is valid YAML — the frontmatter contract is the same
      const formula = parseFormulaText(text, `${shape}.md`);
      assert.equal(formula.shape, shape);
      assert.equal(formula.prose, 'prose');
    }
  });

  test('a file without a frontmatter block fails loud', () => {
    assert.throws(() => parseFormulaText('no frontmatter here', 'bad.md'), /frontmatter/);
  });

  test('an unclosed frontmatter block fails loud', () => {
    assert.throws(() => parseFormulaText('---\nkind: formula\n', 'bad.md'), /frontmatter/);
  });

  test('invalid YAML fails loud', () => {
    assert.throws(() => parseFormulaText('---\nkind: [unclosed\n---\nx\n', 'bad.md'), /YAML/);
  });
});

describe('formulaDoc validation', () => {
  test('a wrong kind is a named problem', () => {
    const found = formulaProblems({ ...VALID_FEATURES, kind: 'route' });
    assert.ok(found.some(p => p.includes('kind')));
  });

  test('a missing shape is a named problem', () => {
    const { shape: _shape, ...doc } = VALID_FEATURES;
    const found = formulaProblems(doc);
    assert.ok(found.some(p => p.includes('shape')));
  });

  test('an unknown shape is a named problem', () => {
    const found = formulaProblems({ ...VALID_FEATURES, shape: 'vibes' });
    assert.ok(
      found.some(p => p.includes('choice|bool|score') || p.includes('features|pick|score'))
    );
  });

  test('an unknown top-level key is a named problem', () => {
    const found = formulaProblems({ ...VALID_FEATURES, extra: 1 });
    assert.deepEqual(found, ['extra: unknown key']);
  });

  test('features shape without questions is a named problem', () => {
    const { questions: _q, ...doc } = VALID_FEATURES;
    const found = formulaProblems(doc);
    assert.ok(found.some(p => p.includes('must declare at least one question')));
  });

  test('pick shape with questions is a named problem', () => {
    const found = formulaProblems({
      kind: 'formula',
      version: 1,
      shape: 'pick',
      questions: { mode: { type: 'choice', options: ['a'] } },
    });
    assert.ok(found.some(p => p.includes('pick')));
  });

  test('empty choice options are a named problem', () => {
    const doc: Record<string, unknown> = JSON.parse(JSON.stringify(VALID_FEATURES));
    (doc.questions as Record<string, { options: string[] }>).complexity!.options = [];
    const found = formulaProblems(doc);
    assert.ok(found.some(p => p.includes('options')));
  });

  test('duplicate choice options are a named problem', () => {
    const doc: Record<string, unknown> = JSON.parse(JSON.stringify(VALID_FEATURES));
    (doc.questions as Record<string, { options: string[] }>).complexity!.options = ['low', 'low'];
    const found = formulaProblems(doc);
    assert.ok(found.some(p => p.includes('duplicate')));
  });

  test('a filter naming an undeclared question is a named problem', () => {
    const found = formulaProblems({
      ...VALID_FEATURES,
      filters: [{ route: 'free-lane', unless: { undeclared: ['x'] } }],
    });
    assert.ok(found.some(p => p.includes('undeclared')));
  });

  test('a score block under shape features is a named problem', () => {
    const found = formulaProblems({ ...VALID_FEATURES, score: { lambda: 0.1, mu: 0 } });
    assert.ok(found.some(p => p.includes('score')));
  });

  test('a negative score weight is a named problem', () => {
    const found = formulaProblems({
      kind: 'formula',
      version: 1,
      shape: 'score',
      questions: { mode: { type: 'choice', options: ['a', 'b'] } },
      score: { lambda: -0.5, mu: 0 },
    });
    assert.ok(found.some(p => p.includes('non-negative')));
  });

  test('an invalid success value is a named problem', () => {
    const found = formulaProblems({ ...VALID_FEATURES, success: 'vibes' });
    assert.ok(found.some(p => p.includes('merged')));
  });

  test('a bool question carrying options is a named problem', () => {
    const doc: Record<string, unknown> = JSON.parse(JSON.stringify(VALID_FEATURES));
    (doc.questions as Record<string, unknown>).needs_ui = {
      type: 'bool',
      options: ['yes', 'no'],
    };
    const found = formulaProblems(doc);
    assert.ok(found.some(p => p.includes('unknown key')));
  });

  test('score levels outside 2–10 are a named problem', () => {
    const doc: Record<string, unknown> = JSON.parse(JSON.stringify(VALID_FEATURES));
    (doc.questions as Record<string, { levels: string[] }>).effort!.levels = ['only'];
    const found = formulaProblems(doc);
    assert.ok(found.some(p => p.includes('levels')));
  });

  test('a version above the schema is a named problem', () => {
    const found = formulaProblems({ ...VALID_FEATURES, version: 99 });
    assert.ok(found.some(p => p.includes('newer than')));
  });
});

describe('validateFormulaTable', () => {
  const formula = formulaOf(VALID_FEATURES);

  function tableProblems(table: RouteTable): string[] {
    try {
      validateFormulaTable(formula, table, 'test');
      return [];
    } catch (err) {
      assert.ok(err instanceof FormulaError, 'expected a FormulaError');
      return err.problems;
    }
  }

  test('a clean table + formula validates', () => {
    validateFormulaTable(formula, TABLE, 'test');
  });

  test('a match feature naming an undeclared question is a named problem', () => {
    const table = routeTable({
      kind: 'route',
      version: 1,
      routes: {
        x: { match: { features: { mystery: 'a' } }, chain: ['p'] },
      },
    });
    const found = tableProblems(table);
    assert.ok(found.some(p => p.includes('mystery') && p.includes('declares')));
  });

  test('a numeric score question as a categorical match is a named problem', () => {
    const table = routeTable({
      kind: 'route',
      version: 1,
      routes: {
        x: { match: { features: { effort: 2 } }, chain: ['p'] },
      },
    });
    const found = tableProblems(table);
    assert.ok(found.some(p => p.includes('cannot drive a categorical match')));
  });

  test('a wrongly typed match value is a named problem', () => {
    const table = routeTable({
      kind: 'route',
      version: 1,
      routes: {
        x: { match: { features: { complexity: 3 } }, chain: ['p'] },
      },
    });
    const found = tableProblems(table);
    assert.ok(found.some(p => p.includes('option string') || p.includes('must be')));
  });

  test('a match value outside the choice options is a named problem', () => {
    const table = routeTable({
      kind: 'route',
      version: 1,
      routes: {
        x: { match: { features: { complexity: 'extreme' } }, chain: ['p'] },
      },
    });
    const found = tableProblems(table);
    assert.ok(found.some(p => p.includes('not one of')));
  });

  test('a filter naming no table route is a named problem', () => {
    const f = formulaOf({
      ...VALID_FEATURES,
      filters: [{ route: 'ghost', unless: { mode: ['coding'] } }],
    });
    try {
      validateFormulaTable(f, TABLE, 'test');
      assert.fail('expected a FormulaError');
    } catch (err) {
      assert.ok(err instanceof FormulaError);
      assert.ok(err.problems.some(p => p.includes('ghost')));
    }
  });

  test('a filter value outside the choice options is a named problem', () => {
    const f = formulaOf({
      ...VALID_FEATURES,
      filters: [{ route: 'free-lane', unless: { mode: ['vibes'] } }],
    });
    try {
      validateFormulaTable(f, TABLE, 'test');
      assert.fail('expected a FormulaError');
    } catch (err) {
      assert.ok(err instanceof FormulaError);
      assert.ok(err.problems.some(p => p.includes('not one of')));
    }
  });

  test('a score filter value outside the levels range is a named problem', () => {
    // effort has 3 levels — a score answer lives in 0..2; 5 can never
    // match, so the filter would be dead config, not a rule
    const f = formulaOf({
      ...VALID_FEATURES,
      filters: [{ route: 'free-lane', unless: { effort: [5] } }],
    });
    try {
      validateFormulaTable(f, TABLE, 'test');
      assert.fail('expected a FormulaError');
    } catch (err) {
      assert.ok(err instanceof FormulaError);
      assert.ok(err.problems.some(p => p.includes('0..2')));
    }
  });

  test('a score filter value inside the levels range validates', () => {
    const f = formulaOf({
      ...VALID_FEATURES,
      filters: [{ route: 'free-lane', unless: { effort: [1.5, 2] } }],
    });
    validateFormulaTable(f, TABLE, 'test');
  });
});

describe('formulaQuestions + formulaAnswersToFeatures', () => {
  const formula = formulaOf(VALID_FEATURES);

  test('the wire shape — choice criteria are the options, bool is noul, score is levels', () => {
    const qs = formulaQuestions(formula);
    assert.deepEqual(Object.keys(qs).sort(), ['complexity', 'effort', 'mode', 'needs_ui']);
    const complexity = qs.complexity;
    assert.equal(complexity?.type, 'choice');
    if (complexity?.type === 'choice') {
      assert.deepEqual(Object.keys(complexity.criteria).sort(), ['high', 'low', 'medium']);
    }
    assert.equal(qs.needs_ui?.type, 'noul');
    const effort = qs.effort;
    assert.equal(effort?.type, 'score');
    if (effort?.type === 'score') {
      assert.deepEqual(effort.criteria, ['trivial', 'small', 'large']);
    }
  });

  const decide: DecideResult = {
    answers: {
      complexity: {
        type: 'choice',
        choice: 'high',
        probabilities: { high: 0.8, low: 0.1, medium: 0.1 },
        confidence: 0.9,
        decidedBy: 'test',
      },
      mode: {
        type: 'choice',
        choice: 'coding',
        probabilities: { coding: 0.7 },
        confidence: 0.9,
        decidedBy: 'test',
      },
      needs_ui: { type: 'noul', noul: 0.8, confidence: 0.85, decidedBy: 'test' },
      effort: { type: 'score', score: 1.5, probabilities: {}, confidence: 0.7, decidedBy: 'test' },
    },
    model: 'judge-test',
    latencyMs: 12,
    lowConfidence: [],
  };

  test('answers fold into typed features with probabilities on the trace', () => {
    const { features, answers } = formulaAnswersToFeatures(formula, decide);
    assert.deepEqual(features, {
      complexity: 'high',
      mode: 'coding',
      needs_ui: true,
      effort: 1.5,
    });
    const complexity = answers.find(a => a.id === 'complexity');
    assert.equal(complexity?.value, 'high');
    assert.equal(complexity?.probability, 0.8);
    const needsUi = answers.find(a => a.id === 'needs_ui');
    assert.equal(needsUi?.value, 'true');
    assert.equal(needsUi?.probability, 0.8);
  });

  test('a low-confidence answer is recorded but never applied', () => {
    const res: DecideResult = { ...decide, lowConfidence: ['mode'] };
    const { features, answers } = formulaAnswersToFeatures(formula, res);
    assert.equal(features.mode, undefined);
    assert.equal(answers.find(a => a.id === 'mode')?.lowConfidence, true);
    assert.equal(features.complexity, 'high');
  });

  test('an answer of the wrong type is unusable, not coerced', () => {
    const res: DecideResult = {
      ...decide,
      answers: {
        ...decide.answers,
        needs_ui: {
          type: 'choice',
          choice: 'yes',
          probabilities: {},
          confidence: 0.9,
          decidedBy: 'test',
        },
      },
    };
    const { features, answers } = formulaAnswersToFeatures(formula, res);
    assert.equal(features.needs_ui, undefined);
    assert.equal(answers.find(a => a.id === 'needs_ui')?.value, '(unusable answer)');
  });

  test('a choice outside the options is unusable', () => {
    const res: DecideResult = {
      ...decide,
      answers: {
        ...decide.answers,
        complexity: {
          type: 'choice',
          choice: 'extreme',
          probabilities: {},
          confidence: 0.9,
          decidedBy: 'test',
        },
      },
    };
    const { features } = formulaAnswersToFeatures(formula, res);
    assert.equal(features.complexity, undefined);
  });

  test('a score outside the levels range is unusable', () => {
    // effort has 3 levels — the wire contract bounds the answer to 0..2
    const res: DecideResult = {
      ...decide,
      answers: {
        ...decide.answers,
        effort: { type: 'score', score: 7, probabilities: {}, confidence: 0.9, decidedBy: 'test' },
      },
    };
    const { features, answers } = formulaAnswersToFeatures(formula, res);
    assert.equal(features.effort, undefined);
    assert.equal(answers.find(a => a.id === 'effort')?.value, '(unusable answer)');
  });

  test('mergeTaskFeatures conflicts fail loud, agreements pass', () => {
    assert.deepEqual(mergeTaskFeatures({ mode: 'coding' }, { mode: 'coding' }), { mode: 'coding' });
    assert.throws(
      () => mergeTaskFeatures({ mode: 'coding' }, { mode: 'review' }),
      /feature conflict/
    );
    assert.deepEqual(mergeTaskFeatures(undefined, { mode: 'coding' }), { mode: 'coding' });
  });
});

describe('applyFormulaFilters', () => {
  // the filter keys on needs_ui — orthogonal to free-lane's complexity
  // match, so the route IS a candidate when the filter fires
  const formula = formulaOf({
    ...VALID_FEATURES,
    filters: [{ route: 'free-lane', unless: { needs_ui: [true] } }],
  });

  test('a matching unless removes the route the judge preferred', () => {
    const task = { features: { complexity: 'low' as const, needs_ui: true } };
    const set = candidates(TABLE, task, {});
    assert.ok(set.candidates.some(c => c.route.name === 'free-lane'));
    const { set: filtered, fired } = applyFormulaFilters(set, formula, task);
    assert.ok(!filtered.candidates.some(c => c.route.name === 'free-lane'));
    assert.ok(filtered.rejected.some(r => r.route.name === 'free-lane'));
    assert.equal(fired.length, 1);
    assert.match(fired[0]?.reason ?? '', /unless matched/);
  });

  test('a non-matching unless keeps the route', () => {
    const task = { features: { complexity: 'low' as const, needs_ui: false } };
    const set = candidates(TABLE, task, {});
    const { set: filtered, fired } = applyFormulaFilters(set, formula, task);
    assert.ok(filtered.candidates.some(c => c.route.name === 'free-lane'));
    assert.equal(fired.length, 0);
  });

  test('an unresolved filter input excludes the route — never permission', () => {
    const task = { features: { complexity: 'low' as const } };
    const set = candidates(TABLE, task, {});
    const { set: filtered, fired } = applyFormulaFilters(set, formula, task);
    assert.ok(!filtered.candidates.some(c => c.route.name === 'free-lane'));
    assert.match(
      filtered.rejected.find(r => r.route.name === 'free-lane')?.reason ?? '',
      /unanswered/
    );
    assert.equal(fired.length, 1);
  });
});

describe('scoreCandidates', () => {
  // three feature-pinned routes on ORTHOGONAL questions plus a
  // catch-all — one task carries all the answers, so every route is a
  // candidate and the formula's arithmetic is what picks
  const SCORE_TABLE: RouteTable = routeTable({
    kind: 'route',
    version: 1,
    routes: {
      alpha: { match: { features: { fa: 'x' } }, chain: ['p1'] },
      beta: { match: { features: { fb: 'y' } }, chain: ['p2'] },
      gamma: { match: { features: { fc: 'z' } }, chain: ['p3'] },
      fallback: { chain: ['p4'] },
    },
  });
  const TASK = { features: { fa: 'x', fb: 'y', fc: 'z' } };
  const found = candidates(SCORE_TABLE, TASK, {});
  const formula = formulaOf({
    kind: 'formula',
    version: 1,
    shape: 'score',
    questions: {
      fa: { type: 'choice', options: ['x', 'w'] },
      fb: { type: 'choice', options: ['y', 'w'] },
      fc: { type: 'choice', options: ['z', 'w'] },
    },
    score: { lambda: 0.3, mu: 0.1 },
  });

  test('the fixture leaves every route a candidate', () => {
    assert.deepEqual(
      found.candidates.map(c => c.route.name),
      ['alpha', 'beta', 'gamma', 'fallback']
    );
  });

  test('zero rows read the Beta(1,1) prior — p = 0.5, n = 0', () => {
    const result = scoreCandidates(
      found.candidates,
      formula,
      TASK.features ?? {},
      priorOnlyOutcomes,
      SCORE_TABLE
    );
    assert.equal(result.scores.length, found.candidates.length);
    for (const row of result.scores) {
      assert.equal(row.p, 0.5);
      assert.equal(row.n, 0);
    }
  });

  test('unknown positively-weighted measures skip scoring — table order stands', () => {
    // priorOnlyOutcomes leaves cost/latency unknown and λ, μ are positive
    const result = scoreCandidates(
      found.candidates,
      formula,
      TASK.features ?? {},
      priorOnlyOutcomes,
      SCORE_TABLE
    );
    assert.equal(result.winner, undefined);
    assert.match(result.skipped ?? '', /unknown/);
    assert.ok(result.scores.every(s => s.score === undefined));
  });

  test('a zero weight needs no measure — scoring runs on p alone', () => {
    const noCost = formulaOf({
      kind: 'formula',
      version: 1,
      shape: 'score',
      questions: formula.questions,
      score: { lambda: 0, mu: 0 },
    });
    const result = scoreCandidates(
      found.candidates,
      noCost,
      TASK.features ?? {},
      priorOnlyOutcomes,
      SCORE_TABLE
    );
    assert.equal(result.winner, 'alpha'); // all p = 0.5 → tie → table order
    assert.ok(result.scores.every(s => s.score === 0.5));
  });

  test('the formula ranks by p − λ·cost − μ·latency', () => {
    const stats: Record<string, { p: number; n: number; costUsd?: number; wallSec?: number }> = {
      alpha: { p: 0.9, n: 4, costUsd: 0.1, wallSec: 60 },
      beta: { p: 0.7, n: 9, costUsd: 2.0, wallSec: 30 },
      gamma: { p: 0.95, n: 2, costUsd: 5.0, wallSec: 120 },
      fallback: { p: 0.5, n: 0, costUsd: 0.05, wallSec: 10 },
    };
    const source: OutcomeStatsSource = {
      statsFor: route => stats[route.name] ?? { p: 0.5, n: 0 },
    };
    const result = scoreCandidates(
      found.candidates,
      formula,
      TASK.features ?? {},
      source,
      SCORE_TABLE
    );
    // alpha:    0.9 − 0.3·0.1 − 0.1·60  = 0.9 − 0.03 − 6    = −5.13
    // beta:     0.7 − 0.3·2.0 − 0.1·30  = 0.7 − 0.6 − 3    = −2.9
    // gamma:    0.95 − 0.3·5.0 − 0.1·120 = 0.95 − 1.5 − 12 = −12.55
    // fallback: 0.5 − 0.3·0.05 − 0.1·10 = 0.5 − 0.015 − 1  = −0.515 → wins
    assert.equal(result.winner, 'fallback');
    const row = result.scores.find(s => s.route === 'fallback');
    assert.ok(Math.abs((row?.score ?? 0) - -0.515) < 1e-9);
    const alpha = result.scores.find(s => s.route === 'alpha');
    assert.ok(Math.abs((alpha?.score ?? 0) - -5.13) < 1e-9);
  });

  test('one unknown measure skips the WHOLE set, not just that route', () => {
    const source: OutcomeStatsSource = {
      statsFor: route =>
        route.name === 'gamma'
          ? { p: 0.5, n: 0 } // cost + latency unknown
          : { p: 0.9, n: 4, costUsd: 0.1, wallSec: 60 },
    };
    const result = scoreCandidates(
      found.candidates,
      formula,
      TASK.features ?? {},
      source,
      SCORE_TABLE
    );
    assert.equal(result.winner, undefined);
    assert.match(result.skipped ?? '', /gamma/);
  });

  test('a non-finite measure skips scoring like an unknown one', () => {
    // NaN cost would poison the arithmetic — it is no measure at all
    const source: OutcomeStatsSource = {
      statsFor: route =>
        route.name === 'gamma'
          ? { p: 0.5, n: 0, costUsd: Number.NaN, wallSec: 60 }
          : { p: 0.9, n: 4, costUsd: 0.1, wallSec: 60 },
    };
    const result = scoreCandidates(
      found.candidates,
      formula,
      TASK.features ?? {},
      source,
      SCORE_TABLE
    );
    assert.equal(result.winner, undefined);
    assert.match(result.skipped ?? '', /not finite/);
  });

  test('a zero weight never reads the measure — non-finite stays unread', () => {
    const noCost = formulaOf({
      kind: 'formula',
      version: 1,
      shape: 'score',
      questions: formula.questions,
      score: { lambda: 0, mu: 0 },
    });
    const source: OutcomeStatsSource = {
      statsFor: route => ({
        p: route.name === 'alpha' ? 0.9 : 0.4,
        n: 3,
        costUsd: Number.NaN, // lambda = 0 — never multiplied
        wallSec: Number.POSITIVE_INFINITY, // mu = 0 — never multiplied
      }),
    };
    const result = scoreCandidates(
      found.candidates,
      noCost,
      TASK.features ?? {},
      source,
      SCORE_TABLE
    );
    assert.equal(result.winner, 'alpha');
  });

  test('ties keep table order, not candidate-fit order', () => {
    // the catch-all sits FIRST in the table but last in fit order —
    // equal formula scores must still land on it
    const TIE_TABLE: RouteTable = routeTable({
      kind: 'route',
      version: 1,
      routes: {
        fallback: { chain: ['p4'] },
        alpha: { match: { features: { fa: 'x' } }, chain: ['p1'] },
        beta: { match: { features: { fb: 'y' } }, chain: ['p2'] },
      },
    });
    const tieTask = { features: { fa: 'x', fb: 'y' } };
    const tieFound = candidates(TIE_TABLE, tieTask, {});
    assert.deepEqual(
      tieFound.candidates.map(c => c.route.name),
      ['alpha', 'beta', 'fallback'] // fit order — fallback last
    );
    const tied: OutcomeStatsSource = {
      statsFor: () => ({ p: 0.8, n: 3, costUsd: 0.2, wallSec: 20 }),
    };
    const result = scoreCandidates(
      tieFound.candidates,
      formula,
      tieTask.features ?? {},
      tied,
      TIE_TABLE
    );
    assert.equal(result.winner, 'fallback'); // table order — index 0
  });
});

describe('features match in candidates + resolve', () => {
  test('declared feature keys drive the match — answers act as task fields', () => {
    const set = candidates(TABLE, { features: { complexity: 'high' } }, {});
    assert.equal(set.candidates[0]?.route.name, 'paid-lane');
    assert.ok(set.rejected.some(r => r.route.name === 'free-lane'));
  });

  test('a route pinning a feature the task lacks is rejected', () => {
    const set = candidates(TABLE, {}, {});
    assert.ok(set.rejected.some(r => r.route.name === 'free-lane'));
    assert.equal(
      set.rejected.find(r => r.route.name === 'free-lane')?.reason,
      'the task carries no feature complexity'
    );
  });

  test('a list match is membership; a scalar is exact', () => {
    const set = candidates(TABLE, { features: { complexity: 'medium' } }, {});
    assert.ok(set.candidates.some(c => c.route.name === 'free-lane'));
    assert.ok(!set.candidates.some(c => c.route.name === 'paid-lane'));
  });

  test('resolveRoute extras carry the precomputed set, pick provenance and trace', () => {
    const set = candidates(TABLE, { features: { complexity: 'high' } }, {});
    const trace = {
      shape: 'features' as const,
      answers: [],
      filtered: [],
    };
    const decision = resolveRoute(TABLE, { features: { complexity: 'high' } }, {}, undefined, {
      set,
      formula: trace,
    });
    assert.equal(decision.route?.name, 'paid-lane');
    assert.equal(decision.picked, 'static');
    assert.equal(decision.formula, trace);
  });

  test('inTableOrder restores declaration order among the survivors', () => {
    // the catch-all is declared first but fits worst — fit order ranks it
    // last; "table order" is the order the routes appear in the file
    const table = routeTable({
      kind: 'route',
      version: 1,
      routes: {
        fallback: { chain: ['p4'] },
        pinned: { match: { features: { tier: 'pro' } }, chain: ['p1'] },
      },
    });
    const set = candidates(table, { features: { tier: 'pro' } }, {});
    assert.deepEqual(
      set.candidates.map(c => c.route.name),
      ['pinned', 'fallback'] // fit order — the pinned route first
    );
    assert.deepEqual(
      inTableOrder(set, table).candidates.map(c => c.route.name),
      ['fallback', 'pinned'] // declaration order — the catch-all first
    );
  });

  test('a formula pick reports picked=formula with its own reason', () => {
    const set = candidates(TABLE, {}, {});
    const decision = resolveRoute(TABLE, {}, {}, () => 'fallback', {
      set,
      picked: 'formula',
      reason: 'the formula scored fallback highest (0.71)',
    });
    assert.equal(decision.route?.name, 'fallback');
    assert.equal(decision.picked, 'formula');
    assert.equal(decision.reason, 'the formula scored fallback highest (0.71)');
  });
});

describe('readFormula', () => {
  test('reads a file — frontmatter contract, prose body', () => {
    const file = join(scratch, 'formula.md');
    writeFileSync(file, SPEC_FORMULA);
    const formula = readFormula(file);
    assert.equal(formula.shape, 'features');
    assert.equal(formula.questions.mode?.type, 'choice');
  });

  test('a missing file fails loud', () => {
    assert.throws(() => readFormula(join(scratch, 'nope.md')), FormulaError);
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { DecideResult, JudgeAnswer, JudgeFacade } from '@broject/core';
import {
  parseFormulaText,
  priorOnlyOutcomes,
  validateFormulaTable,
  type Formula,
  type OutcomeStatsSource,
  type RouteTable,
} from '@broject/router-routes';
import { routeFacts } from './explain.ts';
import { decideByFormula } from './formula-decide.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch dir — no .git, so the verdict journal's appendRow no-ops. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brouter-formula-'));
  dirs.push(dir);
  return dir;
}

/** The fake judge — fixed answers, recorded calls. */
function fakeJudge(
  answers: Record<string, JudgeAnswer>,
  opts: { lowConfidence?: string[]; fail?: boolean } = {}
): { judge: JudgeFacade; calls: { state: unknown; questions: unknown }[] } {
  const calls: { state: unknown; questions: unknown }[] = [];
  return {
    calls,
    judge: {
      decide: async (state: unknown, questions: never) => {
        calls.push({ state, questions });
        if (opts.fail === true) {
          throw new Error('the judge is down');
        }
        const res: DecideResult = {
          answers,
          model: 'fake-judge',
          latencyMs: 3,
          lowConfidence: opts.lowConfidence ?? [],
        };
        return res;
      },
    },
  };
}

const choice = (pick: string, p = 0.9): JudgeAnswer => ({
  type: 'choice',
  choice: pick,
  probabilities: { [pick]: p },
  confidence: 0.9,
  decidedBy: 'fake',
});

const noul = (p: number): JudgeAnswer => ({
  type: 'noul',
  noul: p,
  confidence: 0.9,
  decidedBy: 'fake',
});

/** A formula from its md text — parse AND cross-check, the way
 *  decideRoute loads it. */
function formula(text: string, table: RouteTable): Formula {
  const parsed = parseFormulaText(text, 'test.md');
  validateFormulaTable(parsed, table, 'test.md');
  return parsed;
}

/** The features table — three routes, two pinned on the `tier` feature. */
const FEATURES_TABLE: RouteTable = {
  kind: 'route',
  version: 1,
  routes: [
    {
      name: 'pro',
      match: { features: { tier: 'pro' } },
      chain: [{ provider: 'a' }],
      description: 'the pro lane',
    },
    {
      name: 'free',
      match: { features: { tier: 'free' } },
      chain: [{ provider: 'b' }],
      description: 'the free lane',
    },
    { name: 'any', match: {}, chain: [{ provider: 'c' }] },
  ],
};

const FEATURES_FORMULA = [
  '---',
  'kind: formula',
  'version: 1',
  'shape: features',
  'questions:',
  '  tier: { type: choice, options: [free, pro] }',
  '  complexity: { type: choice, options: [low, high] }',
  '---',
  'The rubric the decision model reads.',
].join('\n');

describe('the features shape', () => {
  test('the answers become features and drive match', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge, calls } = fakeJudge({ tier: choice('pro'), complexity: choice('low') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'ship the feature',
      formula: f,
      formulaPath: 'test.md',
      snapshot: {},
      healthKnown: true,
      judge,
    });
    assert.equal(decision.route?.name, 'pro');
    assert.equal(decision.picked, 'static');
    // one decide() call carried every declared question
    assert.equal(calls.length, 1);
    const questions = calls[0]?.questions as Record<string, { type: string }>;
    assert.equal(questions.tier?.type, 'choice');
    assert.equal(questions.complexity?.type, 'choice');
    // the trace records each answer with its probability
    const trace = decision.formula;
    assert.equal(trace?.shape, 'features');
    assert.equal(trace?.answers.length, 2);
    const tier = trace?.answers.find(a => a.id === 'tier');
    assert.equal(tier?.value, 'pro');
    assert.equal(tier?.probability, 0.9);
  });

  test('the prose body reaches the judge as the rubric', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge, calls } = fakeJudge({ tier: choice('free'), complexity: choice('low') });
    await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    const state = calls[0]?.state as { task: string; rubric: string };
    assert.equal(state.task, 'a task');
    assert.equal(state.rubric, 'The rubric the decision model reads.');
  });

  test('a hard filter removes the route the answers preferred', async () => {
    const table = FEATURES_TABLE;
    const f = formula(
      [
        '---',
        'kind: formula',
        'shape: features',
        'questions:',
        '  tier: { type: choice, options: [free, pro] }',
        '  complexity: { type: choice, options: [low, high] }',
        'filters:',
        '  - route: pro',
        '    unless: { complexity: [high] }',
        '---',
        'rubric',
      ].join('\n'),
      table
    );
    // the judge says pro + high complexity — the filter still cuts pro:
    // code owns the restriction, the model cannot argue with it
    const { judge } = fakeJudge({ tier: choice('pro'), complexity: choice('high') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a hard task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    assert.equal(decision.route?.name, 'any');
    const rejected = decision.rejected.find(r => r.route.name === 'pro');
    assert.match(rejected?.reason ?? '', /hard filter/);
    assert.equal(decision.formula?.filtered[0]?.route, 'pro');
  });

  test('an unanswered filter input excludes the route — never permission', async () => {
    const table = FEATURES_TABLE;
    const f = formula(
      [
        '---',
        'kind: formula',
        'shape: features',
        'questions:',
        '  tier: { type: choice, options: [free, pro] }',
        '  complexity: { type: choice, options: [low, high] }',
        'filters:',
        '  - route: pro',
        '    unless: { complexity: [high] }',
        '---',
        'rubric',
      ].join('\n'),
      table
    );
    // no judge at all — complexity stays unresolved, so pro cannot dispatch
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
    });
    assert.equal(decision.route?.name, 'any');
    const fired = decision.formula?.filtered.find(fl => fl.route === 'pro');
    assert.match(fired?.reason ?? '', /unanswered/);
    assert.match(decision.formula?.note ?? '', /no decision model/);
  });

  test('shadow mode journals the answers but never lets them route', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge } = fakeJudge({ tier: choice('pro'), complexity: choice('low') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      router: { provider: 'fake', mode: 'shadow' },
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    // answers recorded, not applied — the feature-pinned routes stay
    // unresolved and the catch-all wins
    assert.equal(decision.route?.name, 'any');
    assert.equal(decision.formula?.answers.length, 2);
    assert.match(decision.formula?.note ?? '', /shadow/);
  });

  test('off mode never calls the judge', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge, calls } = fakeJudge({ tier: choice('pro'), complexity: choice('low') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      router: { provider: 'fake', mode: 'off' },
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    assert.equal(calls.length, 0);
    assert.equal(decision.route?.name, 'any');
    assert.match(decision.formula?.note ?? '', /off/);
  });

  test('a low-confidence answer is recorded and never applied', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge } = fakeJudge(
      { tier: choice('pro'), complexity: choice('low') },
      { lowConfidence: ['tier'] }
    );
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    // tier stayed unresolved → the pinned routes cannot serve
    assert.equal(decision.route?.name, 'any');
    const tier = decision.formula?.answers.find(a => a.id === 'tier');
    assert.equal(tier?.lowConfidence, true);
    assert.equal(tier?.value, 'pro');
  });

  test('caller and answer conflicts fail loud — never a silent override', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge } = fakeJudge({ tier: choice('pro'), complexity: choice('low') });
    await assert.rejects(
      decideByFormula({
        dir: scratchDir(),
        table,
        task: { features: { tier: 'free' } },
        text: 'a task',
        formula: f,
        snapshot: {},
        healthKnown: true,
        judge,
      }),
      /feature conflict/
    );
  });

  test('an agreeing caller feature merges without conflict', async () => {
    const table = FEATURES_TABLE;
    const f = formula(FEATURES_FORMULA, table);
    const { judge } = fakeJudge({ tier: choice('pro'), complexity: choice('low') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: { features: { tier: 'pro' } },
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    assert.equal(decision.route?.name, 'pro');
  });
});

/** The score table — two catch-alls, so every candidate survives. */
const SCORE_TABLE: RouteTable = {
  kind: 'route',
  version: 1,
  routes: [
    { name: 'a', match: {}, chain: [{ provider: 'a' }] },
    { name: 'b', match: {}, chain: [{ provider: 'b' }] },
  ],
};

const SCORE_FORMULA = [
  '---',
  'kind: formula',
  'shape: score',
  'questions:',
  '  risky: { type: bool }',
  'score: { lambda: 0.5, mu: 0.1 }',
  'success: merged_first_round',
  '---',
  'rubric',
].join('\n');

/** The outcomes seam — per-route stats the test controls. */
function outcomes(
  map: Record<string, { p: number; n: number; costUsd?: number; wallSec?: number }>
): OutcomeStatsSource {
  return {
    statsFor: route => map[route.name] ?? { p: 0.5, n: 0 },
  };
}

describe('the score shape', () => {
  test('the formula ranks the survivors — highest score wins', async () => {
    const table = SCORE_TABLE;
    const f = formula(SCORE_FORMULA, table);
    const { judge } = fakeJudge({ risky: noul(0.2) });
    const src = outcomes({
      // a: 0.4 − 0.5·0.02 − 0.1·2 = 0.19
      a: { p: 0.4, n: 5, costUsd: 0.02, wallSec: 2 },
      // b: 0.9 − 0.5·0.01 − 0.1·1 = 0.795
      b: { p: 0.9, n: 10, costUsd: 0.01, wallSec: 1 },
    });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
      outcomes: src,
    });
    assert.equal(decision.route?.name, 'b');
    assert.equal(decision.picked, 'formula');
    assert.match(decision.reason, /the formula scored b highest/);
    const scores = decision.formula?.scores ?? [];
    assert.equal(scores.length, 2);
    const b = scores.find(s => s.route === 'b');
    assert.ok(b !== undefined && b.score !== undefined && b.score > 0.7);
  });

  test('an unknown positively-weighted measure skips scoring — table order stands', async () => {
    const table = SCORE_TABLE;
    const f = formula(SCORE_FORMULA, table);
    const { judge } = fakeJudge({ risky: noul(0.2) });
    // b's cost is unknown and lambda is positive — the whole set skips
    const src = outcomes({
      a: { p: 0.4, n: 5, costUsd: 0.02, wallSec: 2 },
      b: { p: 0.9, n: 10, wallSec: 1 },
    });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
      outcomes: src,
    });
    assert.equal(decision.route?.name, 'a');
    assert.equal(decision.picked, 'static');
    assert.match(decision.reason, /scoring skipped/);
    assert.match(decision.formula?.note ?? '', /unknown/);
    // the trace still shows what was known — p and n, never a fake score
    const b = decision.formula?.scores?.find(s => s.route === 'b');
    assert.equal(b?.score, undefined);
    assert.equal(b?.p, 0.9);
  });

  test('a zero weight needs no measure — unknown cost is simply unread', async () => {
    const table = SCORE_TABLE;
    const f = formula(
      [
        '---',
        'kind: formula',
        'shape: score',
        'questions:',
        '  risky: { type: bool }',
        'score: { lambda: 0, mu: 0.1 }',
        '---',
        'rubric',
      ].join('\n'),
      table
    );
    const { judge } = fakeJudge({ risky: noul(0.2) });
    const src = outcomes({
      a: { p: 0.4, n: 5, wallSec: 2 }, // cost unknown, lambda = 0 — fine
      b: { p: 0.9, n: 10, wallSec: 1 },
    });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
      outcomes: src,
    });
    // b: 0.9 − 0.1·1 = 0.8; a: 0.4 − 0.1·2 = 0.2
    assert.equal(decision.route?.name, 'b');
    assert.equal(decision.picked, 'formula');
  });

  test('zero outcome rows read the Beta(1,1) prior — p = 0.5 at n = 0', async () => {
    const table = SCORE_TABLE;
    const f = formula(
      [
        '---',
        'kind: formula',
        'shape: score',
        'questions:',
        '  risky: { type: bool }',
        '---',
        'rubric',
      ].join('\n'),
      table
    );
    const { judge } = fakeJudge({ risky: noul(0.2) });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
      outcomes: priorOnlyOutcomes,
    });
    // every candidate ties at 0.5 — table order breaks the tie
    assert.equal(decision.route?.name, 'a');
    assert.equal(decision.picked, 'formula');
    for (const s of decision.formula?.scores ?? []) {
      assert.equal(s.p, 0.5);
      assert.equal(s.n, 0);
    }
  });
});

/** The pick table — the model chooses among the candidates. */
const PICK_TABLE: RouteTable = {
  kind: 'route',
  version: 1,
  routes: [
    { name: 'pro', match: {}, chain: [{ provider: 'a' }], description: 'the pro lane' },
    { name: 'free', match: {}, chain: [{ provider: 'b' }], description: 'the free lane' },
  ],
};

const PICK_FORMULA = [
  '---',
  'kind: formula',
  'shape: pick',
  '---',
  'Pick the route this task belongs to — the prose the model reads.',
].join('\n');

describe('the pick shape', () => {
  test("the model's choice wins under enforce — today's routePick", async () => {
    const table = PICK_TABLE;
    const f = formula(PICK_FORMULA, table);
    const { judge, calls } = fakeJudge({ route: choice('free') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    assert.equal(decision.route?.name, 'free');
    assert.equal(decision.picked, 'model');
    assert.equal(calls.length, 1);
  });

  test('shadow pick journals but the table order stands', async () => {
    const table = PICK_TABLE;
    const f = formula(PICK_FORMULA, table);
    const { judge } = fakeJudge({ route: choice('free') });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      router: { provider: 'fake', mode: 'shadow' },
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
    });
    assert.equal(decision.route?.name, 'pro');
    assert.equal(decision.picked, 'static');
  });

  test('no judge — the table order stands, the trace says why', async () => {
    const table = PICK_TABLE;
    const f = formula(PICK_FORMULA, table);
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
    });
    assert.equal(decision.route?.name, 'pro');
    assert.equal(decision.picked, 'static');
    assert.match(decision.formula?.note ?? '', /no decision model/);
  });
});

describe('the explanation', () => {
  test('routeFacts carries the formula — answers, filters, scores', async () => {
    const table = SCORE_TABLE;
    const f = formula(SCORE_FORMULA, table);
    const { judge } = fakeJudge({ risky: noul(0.2) });
    const src = outcomes({
      a: { p: 0.4, n: 5, costUsd: 0.02, wallSec: 2 },
      b: { p: 0.9, n: 10, costUsd: 0.01, wallSec: 1 },
    });
    const { decision } = await decideByFormula({
      dir: scratchDir(),
      table,
      task: {},
      text: 'a task',
      formula: f,
      snapshot: {},
      healthKnown: true,
      judge,
      outcomes: src,
    });
    const facts = routeFacts(decision);
    const labels = facts.map(fact => fact.label);
    assert.ok(labels.includes('formula'));
    assert.ok(labels.includes('answer: risky'));
    assert.ok(labels.includes('score: a'));
    assert.ok(labels.includes('score: b'));
    // every fact says why it holds
    for (const fact of facts) {
      assert.ok(fact.because.length > 0, `${fact.label} has no reason`);
    }
    // the verdict fact names the formula as the source
    const route = facts.find(fact => fact.label === 'route');
    assert.equal(route?.source, 'the formula');
  });
});

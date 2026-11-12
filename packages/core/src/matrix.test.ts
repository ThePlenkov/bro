import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecideResult } from './judge.ts';
import {
  DEFAULT_MATRIX_COMPLEXITY,
  DEFAULT_MATRIX_MODES,
  fleetMatrix,
  matrixVerdict,
  type FleetMatrix,
} from './matrix.ts';

const MATRIX: FleetMatrix = {
  provider: 'orca',
  mode: 'shadow',
  complexity: ['low', 'medium', 'high'],
  modes: ['planning', 'coding', 'review', 'fix'],
  models: {
    // declared first = preferred when eligible — cheap lanes lead
    cheap: { modes: ['coding'], complexity: ['low'], provider: 'dirac' },
    mid: { modes: ['coding', 'fix'], complexity: ['low', 'medium'], profile: 'sweeps' },
    max: { modes: ['planning', 'coding'], complexity: ['low', 'medium', 'high'], profile: 'max' },
  },
};

/** A DecideResult answering complexity (score level) + mode (choice). */
const verdict = (level: number, mode: string, lowConfidence: string[] = []): DecideResult => ({
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
  model: 'jev-test',
  latencyMs: 1,
  lowConfidence,
});

describe('fleetMatrix', () => {
  test('absent → undefined (the matrix is off, never defaulted on)', () => {
    assert.equal(fleetMatrix(undefined), undefined);
    assert.equal(fleetMatrix('x'), undefined);
    assert.equal(fleetMatrix([1]), undefined);
  });

  test('defaults: shadow mode, the 3-level scale, the 4 work modes', () => {
    const m = fleetMatrix({ provider: 'orca', models: { a: {} } })!;
    assert.equal(m.provider, 'orca');
    assert.equal(m.mode, 'shadow');
    assert.deepEqual(m.complexity, [...DEFAULT_MATRIX_COMPLEXITY]);
    assert.deepEqual(m.modes, [...DEFAULT_MATRIX_MODES]);
    assert.deepEqual(m.models['a'], {});
  });

  test('a declared scale replaces the default wholesale — rows must name it', () => {
    const m = fleetMatrix({
      complexity: ['trivial', 'small', 'large', 'epic'],
      modes: ['coding'],
      models: {
        ok: { complexity: ['trivial', 'small'], modes: ['coding'] },
        // 'high' is not in the declared scale → the whole row drops
        bad: { complexity: ['high'] },
      },
    })!;
    assert.deepEqual(m.complexity, ['trivial', 'small', 'large', 'epic']);
    assert.deepEqual(m.modes, ['coding']);
    assert.deepEqual(m.models['ok'], { complexity: ['trivial', 'small'], modes: ['coding'] });
    assert.equal(m.models['bad'], undefined);
  });

  test('capability fields fail closed — undeclared vocab or bad shape drops the ROW', () => {
    const m = fleetMatrix({
      models: {
        undeclared: { complexity: ['enormous'] },
        dupes: { modes: ['coding', 'coding'] },
        notarray: { modes: 'coding' },
        empty: { modes: [] },
        fine: { profile: 'p', provider: 'prov' },
      },
    })!;
    assert.deepEqual(Object.keys(m.models), ['fine']);
    assert.deepEqual(m.models['fine'], { profile: 'p', provider: 'prov' });
  });

  test('scalar fields drop field-level; a bad mode falls back to shadow', () => {
    const m = fleetMatrix({
      provider: 42,
      mode: 'bogus',
      models: { a: { profile: '', provider: 'dirac' } },
    })!;
    assert.equal(m.provider, undefined);
    assert.equal(m.mode, 'shadow');
    assert.deepEqual(m.models['a'], { provider: 'dirac' });
  });

  test('proto-named rows never land; non-object rows drop', () => {
    const m = fleetMatrix({
      models: {
        __proto__: { complexity: ['low'] },
        constructor: { complexity: ['low'] },
        junk: 'nope',
        ok: {},
      },
    })!;
    assert.deepEqual(Object.keys(m.models), ['ok']);
    assert.equal(Object.hasOwn(m.models, '__proto__'), false);
  });

  test('invalid declared scales fall back to defaults with the section intact', () => {
    const m = fleetMatrix({
      complexity: ['only-one'],
      modes: [],
      models: { a: { complexity: ['low'] } },
    })!;
    assert.deepEqual(m.complexity, [...DEFAULT_MATRIX_COMPLEXITY]);
    assert.deepEqual(m.modes, [...DEFAULT_MATRIX_MODES]);
    assert.deepEqual(m.models['a'], { complexity: ['low'] });
  });
});

describe('matrixVerdict', () => {
  test('low complexity + coding → first eligible declared row (cheap)', () => {
    const v = matrixVerdict(MATRIX, verdict(0, 'coding'));
    assert.deepEqual(v, {
      kind: 'pick',
      model: 'cheap',
      mode: 'coding',
      complexity: 'low',
      provider: 'dirac',
    });
  });

  test('medium complexity filters the low-ceiling row — mid wins', () => {
    const v = matrixVerdict(MATRIX, verdict(1, 'coding'));
    assert.equal(v.kind, 'pick');
    if (v.kind === 'pick') {
      assert.equal(v.model, 'mid');
      assert.equal(v.profile, 'sweeps');
    }
  });

  test('HARD FILTER: high complexity can never reach a low-ceiling row', () => {
    // even with mode 'coding' — the mode the cheap row serves — level
    // 'high' removes cheap AND mid before order matters
    const v = matrixVerdict(MATRIX, verdict(2, 'coding'));
    assert.equal(v.kind, 'pick');
    if (v.kind === 'pick') {
      assert.equal(v.model, 'max');
      assert.equal(v.complexity, 'high');
    }
  });

  test('mode is a filter too — planning skips coding-only rows', () => {
    const v = matrixVerdict(MATRIX, verdict(0, 'planning'));
    assert.equal(v.kind, 'pick');
    if (v.kind === 'pick') {
      assert.equal(v.model, 'max'); // cheap/mid don't declare planning
      assert.equal(v.mode, 'planning');
    }
  });

  test('no eligible row → no-fit, carrying the judged coordinates', () => {
    const m: FleetMatrix = {
      ...MATRIX,
      models: { onlyFix: { modes: ['fix'], complexity: ['low'] } },
    };
    const v = matrixVerdict(m, verdict(0, 'coding'));
    assert.deepEqual(v, { kind: 'no-fit', mode: 'coding', complexity: 'low' });
  });

  test('empty models → no-fit for any confident verdict', () => {
    const v = matrixVerdict({ ...MATRIX, models: {} }, verdict(1, 'fix'));
    assert.deepEqual(v, { kind: 'no-fit', mode: 'fix', complexity: 'medium' });
  });

  test('unconfident answers are no verdict — dim intake never routes', () => {
    assert.deepEqual(matrixVerdict(MATRIX, verdict(2, 'coding', ['complexity'])), {
      kind: 'unanswered',
    });
    assert.deepEqual(matrixVerdict(MATRIX, verdict(2, 'coding', ['mode'])), {
      kind: 'unanswered',
    });
  });

  test('missing or mistyped answers → unanswered', () => {
    const noMode: DecideResult = {
      answers: { complexity: verdict(1, 'x').answers['complexity']! },
      model: 'm',
      latencyMs: 1,
      lowConfidence: [],
    };
    assert.deepEqual(matrixVerdict(MATRIX, noMode), { kind: 'unanswered' });
    const wrongType: DecideResult = {
      answers: {
        complexity: {
          type: 'choice',
          choice: 'low',
          probabilities: {},
          confidence: 0.9,
          decidedBy: 'x',
        },
        mode: verdict(0, 'coding').answers['mode']!,
      },
      model: 'm',
      latencyMs: 1,
      lowConfidence: [],
    };
    assert.deepEqual(matrixVerdict(MATRIX, wrongType), { kind: 'unanswered' });
  });

  test('score rounds to the nearest rung — .5-up fails toward HIGH', () => {
    const borderline = verdict(1.5, 'coding'); // medium/high boundary → high
    const v = matrixVerdict(MATRIX, borderline);
    assert.equal(v.kind, 'pick');
    if (v.kind === 'pick') {
      assert.equal(v.model, 'max');
      assert.equal(v.complexity, 'high');
    }
    const lowBorder = verdict(0.4, 'coding'); // → low
    const v2 = matrixVerdict(MATRIX, lowBorder);
    assert.equal(v2.kind, 'pick');
    if (v2.kind === 'pick') {
      assert.equal(v2.model, 'cheap');
    }
  });

  test('a mode outside the declared vocab is unanswered, not no-fit', () => {
    const v = matrixVerdict(MATRIX, verdict(0, 'underwater-diving'));
    assert.deepEqual(v, { kind: 'unanswered' });
  });
});

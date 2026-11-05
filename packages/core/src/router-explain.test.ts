import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPLAIN_SLICES,
  explainFlag,
  parseExplainSlices,
  renderExplanation,
  unknownFact,
  withSlice,
} from './router-explain.ts';

test('every slice is asked for by name — "all" is the whole story', () => {
  assert.deepEqual(parseExplainSlices('all'), [...EXPLAIN_SLICES]);
  assert.deepEqual(parseExplainSlices('route,model'), ['route', 'model']);
  assert.deepEqual(parseExplainSlices(' route , cost '), ['route', 'cost']);
});

test('a slice is asked for once, however often it is named', () => {
  assert.deepEqual(parseExplainSlices('route,route'), ['route']);
});

test('an unknown slice is an error naming the known ones', () => {
  assert.throws(() => parseExplainSlices('nope'), /unknown explain slice "nope".*route, model, health, cost/s);
});

test('the flag without a value is the whole story', () => {
  const asked = explainFlag(['--explain']);
  assert.equal(asked.enabled, true);
  assert.deepEqual(asked.slices, [...EXPLAIN_SLICES]);
});

test('the flag with a value is a subset — and never eats the next argument', () => {
  const asked = explainFlag(['--explain=model', 'the question']);
  assert.equal(asked.enabled, true);
  assert.deepEqual(asked.slices, ['model']);
});

test('no flag, no explanation', () => {
  assert.equal(explainFlag([]).enabled, false);
  assert.equal(explainFlag(['--json']).enabled, false);
});

test('a fact carries its reason and its source', () => {
  let explanation = withSlice({ slices: {} }, 'model', [
    {
      label: 'model',
      value: 'swe-2-max',
      because: 'the route "edit" pins it',
      source: 'the table',
    },
  ]);
  const text = renderExplanation(explanation, ['model']);
  assert.match(text, /^model$/m);
  assert.match(text, /model: swe-2-max — the route "edit" pins it \(the table\)/);
});

test('an unknown says unknown — never a zero', () => {
  const fact = unknownFact('cost', 'the agent reports no cost', 'the agent');
  assert.equal(fact.value, 'unknown');
  assert.match(renderExplanation(withSlice({ slices: {} }, 'cost', [fact]), ['cost']), /cost: unknown/);
});

test('a slice with no facts is absent — the renderer says nothing', () => {
  const explanation = withSlice({ slices: {} }, 'route', []);
  assert.equal(renderExplanation(explanation, ['route']), '');
});

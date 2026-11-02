import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJudgeTurn, JUDGE_PROMPT_MARK, verdictOf } from './verdict.ts';

test('a journaled judge prompt marks its turn', () => {
  assert.equal(isJudgeTurn(`Intro\n\n${JUDGE_PROMPT_MARK}\n…`, undefined), true);
  assert.equal(isJudgeTurn('a plain user prompt', undefined), false);
  assert.equal(isJudgeTurn(undefined, 'bro review act:judge'), true);
  assert.equal(isJudgeTurn(undefined, 'agent-update'), false);
});

test('a wrapped {answers} body classifies — badge + field table', () => {
  const v = verdictOf(
    JSON.stringify({
      answers: {
        route: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } },
        sure: { type: 'noul', noul: 0.87 },
      },
    })
  );
  assert.equal(v?.badge, 'verdict');
  assert.deepEqual(v?.fields, [
    ['route', 'choice: a (a:0.90 b:0.10)'],
    ['sure', 'noul 0.87'],
  ]);
  assert.ok(v?.summary.includes('route choice: a'));
});

test('a reply naming its model badges with it — generic, not branded', () => {
  const v = verdictOf(
    JSON.stringify({
      model: 'typesafe/jev-1.13',
      answers: { route: { type: 'choice', choice: 'a' } },
    })
  );
  assert.equal(v?.model, 'typesafe/jev-1.13');
  assert.equal(v?.badge, 'typesafe/jev-1.13');
});

test('a bare {qid:answer} map classifies; score renders', () => {
  const v = verdictOf(JSON.stringify({ quality: { type: 'score', score: 2.5 } }));
  assert.deepEqual(v?.fields, [['quality', 'score: 2.50']]);
});

test('type-less answers still classify on a lone shape key', () => {
  const v = verdictOf(JSON.stringify({ go: { noul: 0.5 } }));
  assert.deepEqual(v?.fields, [['go', 'noul 0.50']]);
});

test('unknown/malformed bodies stay undefined — the ▸ JSON row keeps them', () => {
  assert.equal(verdictOf('not json'), undefined);
  assert.equal(verdictOf('{"a":{"type":"mystery","x":1}}'), undefined);
  assert.equal(verdictOf('{"a":{"type":"choice"}}'), undefined); // empty choice
  assert.equal(verdictOf('{}'), undefined);
  assert.equal(verdictOf('{"a":1}'), undefined); // non-object answer
});

import { expect, test } from 'bun:test';
import { isJudgeTurn, JUDGE_PROMPT_MARK, verdictOf } from './verdict.ts';

test('a journaled judge prompt marks its turn', () => {
  expect(isJudgeTurn(`Intro\n\n${JUDGE_PROMPT_MARK}\n…`, undefined)).toBe(true);
  expect(isJudgeTurn('a plain user prompt', undefined)).toBe(false);
  expect(isJudgeTurn(undefined, 'bro review act:judge')).toBe(true);
  expect(isJudgeTurn(undefined, 'agent-update')).toBe(false);
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
  expect(v?.badge).toBe('jev');
  expect(v?.fields).toEqual([
    ['route', 'choice: a (a:0.90 b:0.10)'],
    ['sure', 'noul 0.87'],
  ]);
  expect(v?.summary).toContain('route choice: a');
});

test('a bare {qid:answer} map classifies; score renders', () => {
  const v = verdictOf(JSON.stringify({ quality: { type: 'score', score: 2.5 } }));
  expect(v?.fields).toEqual([['quality', 'score: 2.50']]);
});

test('type-less answers still classify on a lone shape key', () => {
  const v = verdictOf(JSON.stringify({ go: { noul: 0.5 } }));
  expect(v?.fields).toEqual([['go', 'noul 0.50']]);
});

test('unknown/malformed bodies stay undefined — the ▸ JSON row keeps them', () => {
  expect(verdictOf('not json')).toBeUndefined();
  expect(verdictOf('{"a":{"type":"mystery","x":1}}')).toBeUndefined();
  expect(verdictOf('{"a":{"type":"choice"}}')).toBeUndefined(); // empty choice
  expect(verdictOf('{}')).toBeUndefined();
  expect(verdictOf('{"a":1}')).toBeUndefined(); // non-object answer
});

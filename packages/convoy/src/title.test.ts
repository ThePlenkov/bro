import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { titleMatches } from './title.ts';

describe('titleMatches', () => {
  test('an exact title matches', () => {
    assert.equal(
      titleMatches('Merge — bro act wait --merge', 'Merge — bro act wait --merge'),
      true
    );
  });

  test('a formula variable is a wildcard', () => {
    assert.equal(
      titleMatches('Implement {{bead}} per its spec', 'Implement bro-4cxnd per its spec'),
      true
    );
    assert.equal(titleMatches('Implement {{bead}} per its spec', 'Implement per its spec'), false);
  });

  test('a different title does not match', () => {
    assert.equal(titleMatches('Merge — bro act wait --merge', 'Close out — worktree'), false);
  });

  test('regex metacharacters in the title are literal', () => {
    assert.equal(titleMatches('a.b', 'a.b'), true);
    assert.equal(titleMatches('a.b', 'axb'), false);
  });

  test('an unclosed variable is literal text', () => {
    assert.equal(titleMatches('a {{b', 'a {{b'), true);
    assert.equal(titleMatches('a {{b', 'a xb'), false);
  });

  test('a variable name holding a brace is literal text', () => {
    assert.equal(titleMatches('a {{b}c}}', 'a {{b}c}}'), true);
  });

  test('nested-looking braces use the first opening pair as the variable', () => {
    assert.equal(titleMatches('{{outer {{inner}}', 'anything'), true);
  });

  test('an invalid opening can be followed by a valid variable', () => {
    assert.equal(titleMatches('{{a}{{b}}', '{{a}value'), true);
    assert.equal(titleMatches('{{a}{{b}}', 'value'), false);
  });

  test('empty braces are a wildcard', () => {
    assert.equal(titleMatches('before{{}}after', 'beforeafter'), true);
    assert.equal(titleMatches('before{{}}after', 'before middle after'), true);
  });

  test('a long run of unmatched openings completes', () => {
    const pattern = '{{'.repeat(10_000);
    assert.equal(titleMatches(pattern, pattern), true);
  });

  test("a leading wildcard leaves the title's start free", () => {
    assert.equal(titleMatches('{{what}} per its spec', 'anything per its spec'), true);
    assert.equal(titleMatches('{{what}} per its spec', 'anything else'), false);
  });

  test("a trailing wildcard leaves the title's end free", () => {
    assert.equal(titleMatches('Merge {{what}}', 'Merge PR #958'), true);
    assert.equal(titleMatches('Merge {{what}}', 'Closed PR #958'), false);
  });
});

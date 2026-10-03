import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { docsOnly, effectiveMaxRounds, isDocsPath } from './docs.ts'

describe('isDocsPath', () => {
  test('slash-less patterns match the basename at any depth', () => {
    assert.equal(isDocsPath('README.md', '*.md'), true)
    assert.equal(isDocsPath('docs/guide/intro.md', '*.md'), true)
    assert.equal(isDocsPath('src/readme.ts', '*.md'), false)
  })

  test('trailing-slash patterns match the dir at any depth', () => {
    assert.equal(isDocsPath('docs/a.txt', 'docs/'), true)
    assert.equal(isDocsPath('site/docs/a.txt', 'docs/'), true)
    assert.equal(isDocsPath('docs', 'docs/'), false)
    assert.equal(isDocsPath('docsify/x.md', 'docs/'), false)
  })

  test('slashed patterns are full-path globs — * stays in a segment', () => {
    assert.equal(isDocsPath('specs/bro-1.md', 'specs/*.md'), true)
    assert.equal(isDocsPath('specs/sub/bro-1.md', 'specs/*.md'), false)
    assert.equal(isDocsPath('specs/sub/bro-1.md', 'specs/**'), true)
    assert.equal(isDocsPath('other/specs/bro-1.md', 'specs/**'), false)
  })

  test('regex metacharacters in patterns are literal', () => {
    assert.equal(isDocsPath('a+b.md', 'a+b.md'), true)
    assert.equal(isDocsPath('axb.md', 'a+b.md'), false)
  })
})

describe('docsOnly', () => {
  const patterns = ['*.md', 'docs/']

  test('true only when every file matches', () => {
    assert.equal(docsOnly(['README.md', 'docs/x.txt'], patterns), true)
    assert.equal(docsOnly(['README.md', 'src/x.ts'], patterns), false)
  })

  test('empty file list or empty patterns is unknown scope, never docs', () => {
    assert.equal(docsOnly([], patterns), false)
    assert.equal(docsOnly(['a.md'], []), false)
  })
})

describe('effectiveMaxRounds', () => {
  test('non-docs PRs keep the general cap', () => {
    assert.equal(effectiveMaxRounds(3, false, 2), 3)
    assert.equal(effectiveMaxRounds(0, false, 2), 0)
  })

  test('docs PRs get the tighter of the two caps', () => {
    assert.equal(effectiveMaxRounds(3, true, 2), 2)
    assert.equal(effectiveMaxRounds(1, true, 2), 1)
    assert.equal(effectiveMaxRounds(0, true, 2), 2)
  })

  test('docsMaxRounds 0 disables the docs cap', () => {
    assert.equal(effectiveMaxRounds(3, true, 0), 3)
  })
})

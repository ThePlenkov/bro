import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { refKind } from './frames.ts'

describe('refKind', () => {
  test('pull/merge-request URLs → pr', () => {
    assert.equal(refKind('https://github.com/o/r/pull/17'), 'pr')
    assert.equal(refKind('https://gitlab.com/o/r/-/merge_requests/3'), 'pr')
  })

  test('full 40-char lowercase hex → git-sha', () => {
    assert.equal(refKind('a'.repeat(40)), 'git-sha')
    assert.equal(refKind('e59d025f1ab2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), 'git-sha')
  })

  test('short sha, upper hex, anything else → work-id', () => {
    assert.equal(refKind('abc1234'), 'work-id')
    assert.equal(refKind('A'.repeat(40)), 'work-id')
    assert.equal(refKind('transcript-2026-09-16'), 'work-id')
  })
})

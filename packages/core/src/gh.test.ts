import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { prLink } from './gh.ts'

describe('prLink', () => {
  test('renders a clickable markdown link', () => {
    assert.equal(
      prLink('ThePlenkov/bro', 95),
      '[#95](https://github.com/ThePlenkov/bro/pull/95)'
    )
  })
})

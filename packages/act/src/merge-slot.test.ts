import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAcquire, parseCheck } from './merge-slot.ts'

describe('parseAcquire', () => {
  test('acquired slot', () => {
    assert.deepEqual(
      parseAcquire('{"acquired":true,"holder":"devin","id":"x-merge-slot"}'),
      { kind: 'acquired' }
    )
  })

  test('held slot names the holder', () => {
    assert.deepEqual(
      parseAcquire('{"acquired":false,"holder":"other-session","id":"x-merge-slot"}'),
      { kind: 'held', holder: 'other-session' }
    )
  })

  test('non-JSON output (no bd / no database) is unavailable, not held', () => {
    assert.deepEqual(parseAcquire('Error: no beads database found'), { kind: 'unavailable' })
    assert.deepEqual(parseAcquire(''), { kind: 'unavailable' })
    assert.deepEqual(parseAcquire('{"acquired":false}'), { kind: 'unavailable' })
  })

  test('empty holder is degenerate output — unavailable, not held', () => {
    assert.deepEqual(
      parseAcquire('{"acquired":false,"holder":"","id":"x-merge-slot"}'),
      { kind: 'unavailable' }
    )
  })
})

describe('parseCheck', () => {
  test('held slot reports the holder', () => {
    assert.equal(
      parseCheck('{"available":false,"holder":"devin","id":"x-merge-slot","waiters":null}'),
      'devin'
    )
  })

  test('available or malformed → null', () => {
    assert.equal(parseCheck('{"available":true,"holder":null}'), null)
    assert.equal(parseCheck('Error: no beads database found'), null)
    assert.equal(parseCheck('{"available":false,"holder":null}'), null)
  })
})

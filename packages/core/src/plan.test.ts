import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { checkPlanVersion } from './plan.ts'

describe('checkPlanVersion', () => {
  const collect = (raw: unknown, latest = 1): string[] => {
    const errors: string[] = []
    checkPlanVersion(raw, 'k', latest, errors)
    return errors
  }

  test('absent is fine — unversioned plans stay valid', () => {
    assert.deepEqual(collect(undefined), [])
  })

  test('a pin at or below latest passes', () => {
    assert.deepEqual(collect(1), [])
    assert.deepEqual(collect(1, 3), [])
    assert.deepEqual(collect(2, 3), [])
  })

  test('a pin newer than latest names what this bro understands', () => {
    assert.match(collect(2)[0]!, /k schema v2 is newer.*latest v1/)
  })

  test('malformed pins are rejected, never coerced', () => {
    for (const raw of ['1', 0, -1, 1.5, true, {}, []]) {
      assert.match(collect(raw)[0]!, /version: must be a positive integer/, JSON.stringify(raw))
    }
  })
})

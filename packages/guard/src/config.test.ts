import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GUARD_CONFIG, guardSection } from './config.ts'

describe('guardSection', () => {
  test('defaults on junk input', () => {
    assert.deepEqual(guardSection(undefined), DEFAULT_GUARD_CONFIG)
    assert.deepEqual(guardSection('junk'), DEFAULT_GUARD_CONFIG)
    assert.deepEqual(guardSection(42), DEFAULT_GUARD_CONFIG)
    assert.deepEqual(guardSection({}), DEFAULT_GUARD_CONFIG)
  })

  test('enabled flips only on a real boolean', () => {
    assert.equal(guardSection({ enabled: false }).enabled, false)
    assert.equal(guardSection({ enabled: 'no' }).enabled, true)
  })

  test('maxPerEvent is a positive integer', () => {
    assert.equal(guardSection({ maxPerEvent: 7 }).maxPerEvent, 7)
    for (const bad of [0, -2, 1.5, '3']) {
      assert.equal(
        guardSection({ maxPerEvent: bad }).maxPerEvent,
        DEFAULT_GUARD_CONFIG.maxPerEvent,
        `maxPerEvent=${bad}`
      )
    }
  })

  test('defs pass through when valid', () => {
    const def = { name: 'g', when: { on: ['stop'] }, say: 'x' }
    assert.deepEqual(guardSection({ defs: [def] }).defs, [def])
    assert.deepEqual(guardSection({ defs: 'nope' }).defs, [])
  })

  test('malformed defs fail closed — dropped with a warning', () => {
    const errs: string[] = []
    const orig = console.error
    console.error = (m: unknown) => errs.push(String(m))
    try {
      const out = guardSection({
        defs: [
          { name: 'ok-def', when: { on: ['stop'] }, say: 'x' },
          { name: 'bad name!', when: { on: ['stop'] }, say: 'x' },
          { name: 'no-when', say: 'x' },
          null,
        ],
      })
      assert.deepEqual(out.defs.map((d) => d.name), ['ok-def'])
    } finally {
      console.error = orig
    }
    assert.equal(errs.length, 3)
    assert.match(errs[0]!, /'bad name!'.*dropped/)
    assert.match(errs[1]!, /'no-when'.*dropped/)
    assert.match(errs[2]!, /<unnamed>.*dropped/)
  })
})

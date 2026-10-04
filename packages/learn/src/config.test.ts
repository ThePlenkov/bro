import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_LEARN_CONFIG, learnSection } from './config.ts'

describe('learnSection', () => {
  it('falls back to defaults on garbage input', () => {
    assert.deepEqual(learnSection(undefined), DEFAULT_LEARN_CONFIG)
    assert.deepEqual(learnSection('junk'), DEFAULT_LEARN_CONFIG)
    assert.deepEqual(learnSection(42), DEFAULT_LEARN_CONFIG)
    assert.deepEqual(learnSection({}), DEFAULT_LEARN_CONFIG)
  })

  it('defaults to enabled — the kill switch is explicit opt-out', () => {
    assert.equal(learnSection({ enabled: false }).enabled, false)
    assert.equal(learnSection({ enabled: 'no' }).enabled, true)
  })

  it('normalizes maxInject — positive integers only', () => {
    assert.equal(learnSection({ maxInject: 7 }).maxInject, 7)
    assert.equal(learnSection({ maxInject: 0 }).maxInject, DEFAULT_LEARN_CONFIG.maxInject)
    assert.equal(learnSection({ maxInject: -2 }).maxInject, DEFAULT_LEARN_CONFIG.maxInject)
    assert.equal(learnSection({ maxInject: 1.5 }).maxInject, DEFAULT_LEARN_CONFIG.maxInject)
    assert.equal(learnSection({ maxInject: '3' }).maxInject, DEFAULT_LEARN_CONFIG.maxInject)
  })

  it('keeps known sources, drops unknown ones', () => {
    assert.deepEqual(learnSection({ sources: ['manual', 'probe'] }).sources, [
      'manual',
      'probe',
    ])
    assert.deepEqual(learnSection({ sources: ['manual', 'bogus'] }).sources, ['manual'])
    assert.deepEqual(learnSection({ sources: 'manual' }).sources, [])
  })
})

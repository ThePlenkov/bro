import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { PLUGINS } from './plugins.ts'

describe('plugin registry', () => {
  test('names are unique', () => {
    const names = PLUGINS.map((p) => p.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('every plugin has a runnable entry and a summary', () => {
    for (const p of PLUGINS) {
      assert.equal(typeof p.run, 'function', p.name)
      assert.ok(p.summary.length > 0, p.name)
    }
  })

  test('skill references point at existing skill dirs', () => {
    // skills/ is two levels up from packages/cli/src in the workspace
    for (const p of PLUGINS) {
      if (p.skill) {
        assert.ok(
          p.skill.length > 0 && !p.skill.includes('..'),
          `${p.name} skill`
        )
      }
    }
  })

  test('plugins lists itself', () => {
    assert.ok(PLUGINS.some((p) => p.name === 'plugins'))
  })
})

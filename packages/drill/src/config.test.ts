import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DRILL_CONFIG, drillSection } from './config.ts'

describe('drillSection', () => {
  test('defaults: drills/ dir, mode off', () => {
    assert.deepEqual(drillSection(undefined), DEFAULT_DRILL_CONFIG)
    assert.deepEqual(drillSection('junk'), DEFAULT_DRILL_CONFIG)
    assert.deepEqual(drillSection(42), DEFAULT_DRILL_CONFIG)
    assert.deepEqual(drillSection({}), DEFAULT_DRILL_CONFIG)
    assert.deepEqual(drillSection({ report: 'junk' }), DEFAULT_DRILL_CONFIG)
  })

  test('report.dir and report.mode pass through when valid', () => {
    const cfg = drillSection({ report: { dir: 'docs/drills', mode: 'always' } })
    assert.equal(cfg.report.dir, 'docs/drills')
    assert.equal(cfg.report.mode, 'always')
  })

  test('bad mode falls back to off; blank dir falls back to drills', () => {
    const cfg = drillSection({ report: { dir: '  ', mode: 'loud' } })
    assert.equal(cfg.report.dir, 'drills')
    assert.equal(cfg.report.mode, 'off')
  })

  test('absolute or escaping dir falls back to drills — reports stay in the repo', () => {
    for (const dir of ['/tmp/out', '../outside', 'a/../../b', '..\\up']) {
      assert.equal(drillSection({ report: { dir } }).report.dir, 'drills')
    }
    // a `..`-looking name that isn't a traversal segment is fine
    assert.equal(drillSection({ report: { dir: 'drills..x' } }).report.dir, 'drills..x')
  })
})

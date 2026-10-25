import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laneGateLevel, laneGateTake, type LaneRateGate } from './lane-gate.ts'
import { parseProviderEntry } from './providers.ts'
import { scrubEnv } from './testkit.ts'

after(scrubEnv())

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-lanegate-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const cfg = (over: Partial<LaneRateGate> = {}): LaneRateGate => ({
  requestsPerHour: 240,
  spawnCost: 60,
  ...over,
})

const ledgerPath = (dir: string, lane: string, model: string): string =>
  join(dir, `${encodeURIComponent(`${lane}/${model}`)}.json`)

describe('lane gate — the token bucket', () => {
  test('a take debits the bucket; the level reports the rest', () => {
    withDir((dir) => {
      const r = laneGateTake('devin', '(default)', cfg(), 1000, dir)
      assert.ok(r.ok)
      // 240 - 60 = 180 left
      assert.equal(r.tokens, 180)
      const level = laneGateLevel('devin', '(default)', cfg(), 1000, dir)
      assert.deepEqual(level, { tokens: 180, capacity: 240 })
    })
  })

  test('an empty bucket refuses with a retry wait', () => {
    withDir((dir) => {
      // burst=spawnCost ⇒ one take drains
      const c = cfg({ burst: 60 })
      assert.ok(laneGateTake('devin', '(default)', c, 1000, dir).ok)
      const r = laneGateTake('devin', '(default)', c, 1000, dir)
      assert.ok(!r.ok)
      // 60 tokens needed, refill 240/h ⇒ 15 minutes
      assert.equal(r.retryAfterSec, 900)
    })
  })

  test('refill is lazy — elapsed time puts tokens back', () => {
    withDir((dir) => {
      const c = cfg({ burst: 60 })
      assert.ok(laneGateTake('devin', '(default)', c, 0, dir).ok)
      // 15 minutes later: 60 tokens refilled — a take lands again
      const r = laneGateTake('devin', '(default)', c, 15 * 60 * 1000, dir)
      assert.ok(r.ok)
    })
  })

  test('buckets are per model — one model draining leaves the other full', () => {
    withDir((dir) => {
      const c = cfg({ burst: 60 })
      laneGateTake('devin', 'free', c, 0, dir)
      assert.ok(!laneGateTake('devin', 'free', c, 0, dir).ok)
      assert.ok(laneGateTake('devin', 'typesafe/jev-1', c, 0, dir).ok)
    })
  })

  test('a shared lane name draws one budget across provider names', () => {
    withDir((dir) => {
      const c = cfg({ burst: 60 })
      laneGateTake('devin', '(default)', c, 0, dir)
      // devin-acp gates on the same lane → the same (default) bucket
      assert.ok(!laneGateTake('devin', '(default)', c, 0, dir).ok)
    })
  })

  test('a corrupt ledger recovers as a fresh full bucket', () => {
    withDir((dir) => {
      writeFileSync(ledgerPath(dir, 'devin', '(default)'), '{nope')
      const r = laneGateTake('devin', '(default)', cfg(), 1000, dir)
      assert.ok(r.ok)
      assert.equal(r.tokens, 180)
    })
  })

  test('capacity honors burst, never the refill', () => {
    withDir((dir) => {
      const c = cfg({ burst: 120 })
      // an hour of quiet still caps at burst, not requestsPerHour
      const r = laneGateTake('devin', '(default)', c, 3_600_000, dir)
      assert.ok(r.ok)
      assert.equal(r.tokens, 60)
    })
  })
})

describe('providers.<name>.rateGate config', () => {
  const cli = (extra: Record<string, unknown>): unknown => ({
    type: 'cli',
    command: 'x {promptFile}',
    ...extra,
  })

  test('a valid gate parses onto the entry', () => {
    const e = parseProviderEntry('devin', cli({ rateGate: { requestsPerHour: 240, spawnCost: 120 } }))
    assert.ok(e !== null && e.type === 'cli')
    assert.deepEqual(e.rateGate, { requestsPerHour: 240, spawnCost: 120 })
  })

  test('burst + lane parse through', () => {
    const e = parseProviderEntry(
      'devin',
      cli({ rateGate: { requestsPerHour: 240, spawnCost: 60, burst: 480, lane: 'acct' } })
    )
    assert.ok(e !== null && e.type === 'cli')
    assert.deepEqual(e.rateGate, { requestsPerHour: 240, spawnCost: 60, burst: 480, lane: 'acct' })
  })

  test('a gate missing its cost is a config error — the entry drops', () => {
    assert.equal(parseProviderEntry('devin', cli({ rateGate: { requestsPerHour: 240 } })), null)
    assert.equal(
      parseProviderEntry('devin', cli({ rateGate: { requestsPerHour: 240, spawnCost: 0 } })),
      null
    )
    assert.equal(parseProviderEntry('devin', cli({ rateGate: 'fast' })), null)
  })

  test('wallPause parses on cli and acp kinds', () => {
    const e = parseProviderEntry('devin', cli({ wallPause: false }))
    assert.ok(e !== null && e.type === 'cli')
    assert.equal(e.wallPause, false)
    const a = parseProviderEntry('acpd', { type: 'acp', command: 'x', wallPause: false })
    assert.ok(a !== null && a.type === 'acp')
    assert.equal(a.wallPause, false)
  })

  test('an api entry ignores the spawn-surface knobs', () => {
    const e = parseProviderEntry('api1', {
      type: 'api',
      baseUrl: 'http://x',
      models: { m: 'openai-compat' },
      rateGate: { requestsPerHour: 1, spawnCost: 1 },
    })
    assert.ok(e !== null && e.type === 'api')
    assert.equal('rateGate' in e, false)
  })
})

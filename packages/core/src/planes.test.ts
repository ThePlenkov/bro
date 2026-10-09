import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearPlanes,
  mcpSection,
  planeNames,
  planes,
  PlaneUnavailable,
  PlaneVerbError,
  registerPlane,
  verbsNotWired,
  type PlaneDescriptor,
} from './index.ts'

const fakePlane = (name: string, reads: string[] = []): PlaneDescriptor => ({
  name,
  reads,
  verbs: [],
  capabilities: async () => ({ read: true }),
  list: async () => [],
  get: async () => undefined,
  read: async (n) => `read:${name}:${n}`,
  exec: verbsNotWired(name, []),
})

describe('plane registry', () => {
  test('registerPlane + planes(dir) builds the catalog in order', () => {
    clearPlanes()
    registerPlane('work', () => fakePlane('work'))
    registerPlane('debt', () => fakePlane('debt'))
    assert.deepEqual(planeNames(), ['work', 'debt'])
    const catalog = planes('/tmp/anywhere')
    assert.deepEqual(catalog.map((p) => p.name), ['work', 'debt'])
  })

  test('duplicate registration is skipped — a plugin cannot shadow a built-in', () => {
    clearPlanes()
    registerPlane('work', () => fakePlane('work'))
    registerPlane('work', () => fakePlane('work', ['shadow']))
    assert.equal(planes('/tmp')[0]!.reads.length, 0)
  })

  test('a throwing factory becomes an unavailable stub, not a catalog failure', async () => {
    clearPlanes()
    registerPlane('broken', () => {
      throw new Error('boom')
    })
    registerPlane('work', () => fakePlane('work'))
    const catalog = planes('/tmp')
    assert.equal(catalog.length, 2)
    const broken = catalog[0]!
    assert.deepEqual(await broken.capabilities(), { read: false, error: true })
    await assert.rejects(() => broken.list(), PlaneUnavailable)
    await assert.rejects(() => broken.read('x'), PlaneUnavailable)
    // the healthy plane still serves
    assert.equal(await catalog[1]!.read('ready'), 'read:work:ready')
  })
})

describe('verbsNotWired', () => {
  test('declared verb → PlaneUnavailable; undeclared → PlaneVerbError', async () => {
    const exec = verbsNotWired('work', ['claim'])
    await assert.rejects(() => exec('claim', {}), (err: unknown) => {
      assert.ok(err instanceof PlaneUnavailable)
      assert.match(err.message, /not exposed|authz|declared/i)
      return true
    })
    await assert.rejects(() => exec('explode', {}), PlaneVerbError)
  })
})

describe('mcpSection', () => {
  test('absent/empty section → planes stays undefined (every read plane)', () => {
    assert.deepEqual(mcpSection(undefined), {})
    assert.deepEqual(mcpSection({}), {})
    assert.deepEqual(mcpSection('garbage'), {})
  })

  test('planes: [] survives as an empty array (disable all ≠ absent)', () => {
    assert.deepEqual(mcpSection({ planes: [] }), { planes: [] })
  })

  test('allowlist keeps valid names, drops junk', () => {
    assert.deepEqual(mcpSection({ planes: ['work', 'debt', 3, '', ' learn '] }), {
      planes: ['work', 'debt', 'learn'],
    })
  })
})

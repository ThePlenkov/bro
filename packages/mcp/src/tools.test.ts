import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PlaneUnavailable,
  PlaneVerbError,
  type PlaneDescriptor,
  type PlaneRow,
} from '@broject/core'
import { callTool, catalogTools, planeTools } from './tools.ts'

const row = (id: string): PlaneRow => ({ id })

const fakePlane = (over: Partial<PlaneDescriptor> = {}): PlaneDescriptor => ({
  name: 'work',
  reads: ['ready', 'status'],
  verbs: ['claim'],
  readArgs: {
    ready: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  capabilities: async () => ({ read: true }),
  list: async (f) => [row('a'), row('b')].slice(0, typeof f?.limit === 'number' ? f.limit : 2),
  get: async (ref) => (ref === 'a' ? row('a') : undefined),
  read: async (name, args) => ({ name, args }),
  exec: async () => {
    throw new PlaneUnavailable('work', 'verbs not exposed')
  },
  ...over,
})

describe('planeTools — generation from descriptors', () => {
  test('every plane emits list + get + one tool per declared read', () => {
    const tools = planeTools(fakePlane())
    assert.deepEqual(
      tools.map((t) => t.name),
      ['bro_work_list', 'bro_work_get', 'bro_work_ready', 'bro_work_status']
    )
  })

  test('readArgs become inputSchema verbatim; undeclared reads get a permissive object', () => {
    const tools = planeTools(fakePlane())
    const ready = tools.find((t) => t.name === 'bro_work_ready')!
    assert.deepEqual(ready.inputSchema, {
      type: 'object',
      properties: { limit: { type: 'integer' } },
    })
    const status = tools.find((t) => t.name === 'bro_work_status')!
    assert.equal(status.inputSchema['type'], 'object')
    // get always requires ref
    const get = tools.find((t) => t.name === 'bro_work_get')!
    assert.deepEqual(get.inputSchema['required'], ['ref'])
  })

  test('a plane with no named reads emits only list + get', () => {
    const tools = planeTools(fakePlane({ reads: [] }))
    assert.deepEqual(
      tools.map((t) => t.name),
      ['bro_work_list', 'bro_work_get']
    )
  })
})

describe('catalogTools — capability gating', () => {
  test('read:false hides the plane entirely — absent capability = absent tool', async () => {
    const catalog = [
      fakePlane({ capabilities: async () => ({ read: false }) }),
      fakePlane({ name: 'debt', reads: ['summary'] }),
    ]
    const names = (await catalogTools(catalog)).map((t) => t.name)
    assert.deepEqual(names, ['bro_debt_list', 'bro_debt_get', 'bro_debt_summary'])
  })

  test('a capabilities() that throws is the same verdict as read:false', async () => {
    const catalog = [
      fakePlane({
        capabilities: async () => {
          throw new Error('probe wedged')
        },
      }),
      fakePlane({ name: 'debt', reads: [] }),
    ]
    const names = (await catalogTools(catalog)).map((t) => t.name)
    assert.deepEqual(names, ['bro_debt_list', 'bro_debt_get'])
  })

  test('a capabilities() that omits read is not advertised either', async () => {
    const catalog = [
      fakePlane({ capabilities: async () => ({}) }),
      fakePlane({ name: 'debt', reads: [] }),
    ]
    const names = (await catalogTools(catalog)).map((t) => t.name)
    assert.deepEqual(names, ['bro_debt_list', 'bro_debt_get'])
  })
})

describe('callTool — dispatch', () => {
  test('bro_<plane>_list → list(args)', async () => {
    const res = (await callTool([fakePlane()], 'bro_work_list', { limit: 1 })) as PlaneRow[]
    assert.deepEqual(res, [{ id: 'a' }])
  })

  test('bro_<plane>_get → get(ref); a miss is null, not an error', async () => {
    assert.deepEqual(await callTool([fakePlane()], 'bro_work_get', { ref: 'a' }), { id: 'a' })
    assert.equal(await callTool([fakePlane()], 'bro_work_get', { ref: 'nope' }), null)
  })

  test('get without ref is a client bug — PlaneVerbError', async () => {
    await assert.rejects(() => callTool([fakePlane()], 'bro_work_get', {}), PlaneVerbError)
  })

  test('bro_<plane>_<read> dispatches to the named read', async () => {
    const res = await callTool([fakePlane()], 'bro_work_ready', { limit: 3 })
    assert.deepEqual(res, { name: 'ready', args: { limit: 3 } })
  })

  test('unknown op on a known plane names the declared surface', async () => {
    await assert.rejects(
      () => callTool([fakePlane()], 'bro_work_explode', {}),
      (err: unknown) => {
        assert.ok(err instanceof PlaneVerbError)
        assert.match(err.message, /list, get, ready, status/)
        return true
      }
    )
  })

  test('a tool for an absent plane is PlaneUnavailable — enumerate first', async () => {
    await assert.rejects(() => callTool([fakePlane()], 'bro_queue_next', {}), PlaneUnavailable)
  })

  test('a call against a read-incapable plane is PlaneUnavailable, not dispatched', async () => {
    const p = fakePlane({
      capabilities: async () => ({ read: false }),
      list: async () => {
        throw new Error('list must not run')
      },
    })
    await assert.rejects(() => callTool([p], 'bro_work_list', {}), PlaneUnavailable)
  })

  test('longer plane names win — bro_work_archive_list hits work_archive, not work', async () => {
    const archive = fakePlane({
      name: 'work_archive',
      reads: [],
      list: async () => [row('archived-1')],
    })
    const res = (await callTool([fakePlane(), archive], 'bro_work_archive_list', {})) as PlaneRow[]
    assert.deepEqual(res, [{ id: 'archived-1' }])
  })

  test('a plane read that throws propagates for the { error } result', async () => {
    const p = fakePlane({
      read: async () => {
        throw new PlaneUnavailable('work', 'store down')
      },
    })
    await assert.rejects(() => callTool([p], 'bro_work_ready', {}), PlaneUnavailable)
  })
})

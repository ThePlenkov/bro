/** Tests for the REST projection of the plane catalog —
 *  specs/bro-9rls.1.md milestone 3. The descriptors are fakes; the
 *  surface under test is routing + error vocabulary, not a backend. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaneUnavailable, type PlaneDescriptor, type PlaneFilter } from '@broject/core'
import { routePlanes } from './rest.ts'

const fakePlane = (over: Partial<PlaneDescriptor> = {}): PlaneDescriptor => ({
  name: 'test',
  reads: ['tail'],
  verbs: ['poke'],
  capabilities: async () => ({ read: true, verbs: true }),
  list: async () => [{ id: 'a' }],
  get: async (ref: string) => (ref === 'a' ? { id: 'a' } : undefined),
  read: async (name: string, args?: Record<string, unknown>) => ({ read: name, args }),
  exec: async () => {
    // v1 contract — a declared-but-unwired verb is unavailable here
    throw new PlaneUnavailable('test', 'verb declared but not exposed')
  },
  ...over,
})

const call = (
  method: string,
  api: string[],
  opts: {
    body?: string
    catalog?: PlaneDescriptor[]
    query?: Record<string, string>
  } = {}
) => routePlanes(method, ['planes', ...api], opts.body, opts.catalog ?? [fakePlane()], opts.query ?? {})

describe('planes/rest — the catalog index', () => {
  test('GET /api/v1/planes lists every descriptor with live capabilities', async () => {
    const r = await call('GET', [], {
      catalog: [fakePlane(), fakePlane({ name: 'other', reads: [], verbs: [] })],
    })
    assert.equal(r.status, 200)
    const body = r.body as {
      planes: { name: string; reads: string[]; verbs: string[]; capabilities: Record<string, unknown> }[]
    }
    assert.deepEqual(
      body.planes.map((p) => p.name),
      ['test', 'other']
    )
    assert.deepEqual(body.planes[0]!.reads, ['tail'])
    assert.deepEqual(body.planes[0]!.verbs, ['poke'])
    assert.deepEqual(body.planes[0]!.capabilities, { read: true, verbs: true })
  })

  test('a failed capabilities probe indexes as incapable, never an error', async () => {
    const r = await call('GET', [], {
      catalog: [
        fakePlane({
          capabilities: async () => {
            throw new Error('backend dead')
          },
        }),
      ],
    })
    assert.equal(r.status, 200)
    const body = r.body as { planes: { capabilities: Record<string, unknown> }[] }
    assert.equal(body.planes[0]!.capabilities['read'], false)
    assert.equal(body.planes[0]!.capabilities['error'], true)
  })

  test('non-GET on the index is 405', async () => {
    const r = await call('POST', [])
    assert.equal(r.status, 405)
  })
})

describe('planes/rest — reads', () => {
  test('GET <plane> lists with a translated filter — status, limit, passthrough', async () => {
    let seen: PlaneFilter | undefined
    const r = await call('GET', ['test'], {
      catalog: [
        fakePlane({
          list: async (f) => {
            seen = f
            return []
          },
        }),
      ],
      query: { status: 'open', limit: '5', owner: 'me' },
    })
    assert.equal(r.status, 200)
    assert.deepEqual(seen, { owner: 'me', status: 'open', limit: 5 })
  })

  test('a declared read name wins over get(ref) — precedence is enumerable', async () => {
    const r = await call('GET', ['test', 'tail'], { query: { n: '3' } })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { read: 'tail', args: { n: '3' } })
  })

  test('GET <plane>/<ref> gets a row; a miss is 404', async () => {
    const hit = await call('GET', ['test', 'a'])
    assert.equal(hit.status, 200)
    assert.deepEqual(hit.body, { id: 'a' })
    const miss = await call('GET', ['test', 'zzz'])
    assert.equal(miss.status, 404)
  })

  test('read:false capability hides the plane — 404, not a fake empty list', async () => {
    const catalog = [fakePlane({ capabilities: async () => ({ read: false }) })]
    for (const api of [['test'], ['test', 'a'], ['test', 'tail']]) {
      const r = await call('GET', api, { catalog })
      assert.equal(r.status, 404, api.join('/'))
      const body = r.body as { error: string }
      assert.match(body.error, /test/)
    }
  })

  test('PlaneUnavailable on a read is 503, a thrown read is the handler’s 500', async () => {
    const unavailable = await call('GET', ['test'], {
      catalog: [
        fakePlane({
          list: async () => {
            throw new PlaneUnavailable('test', 'beads replica down')
          },
        }),
      ],
    })
    assert.equal(unavailable.status, 503)
    const body = unavailable.body as { error: string }
    assert.match(body.error, /replica down/)
  })

  test('an unknown plane is 404 naming the miss + the catalog', async () => {
    const r = await call('GET', ['nope'])
    assert.equal(r.status, 404)
    const body = r.body as { error: string; planes: string[] }
    assert.match(body.error, /nope/)
    assert.deepEqual(body.planes, ['test'])
  })
})

describe('planes/rest — the uniform write shape', () => {
  test('POST <plane>/<declared-verb> reaches exec with the body as args', async () => {
    let seen: Record<string, unknown> | undefined
    const r = await call('POST', ['test', 'poke'], {
      body: '{"ref":"a","why":"test"}',
      catalog: [
        fakePlane({
          exec: async (_v, args) => {
            seen = args
            return { id: 'a' }
          },
        }),
      ],
    })
    assert.equal(r.status, 200)
    assert.deepEqual(seen, { ref: 'a', why: 'test' })
    assert.deepEqual(r.body, { id: 'a' })
  })

  test('an empty body is {} — zero-arg verbs do not demand a doc', async () => {
    let seen: Record<string, unknown> | undefined
    await call('POST', ['test', 'poke'], {
      catalog: [
        fakePlane({
          exec: async (_v, args) => {
            seen = args
          },
        }),
      ],
    })
    assert.deepEqual(seen, {})
  })

  test('a declared-but-unwired verb is 503, an undeclared one 400', async () => {
    const unwired = await call('POST', ['test', 'poke'])
    assert.equal(unwired.status, 503)
    const undeclared = await call('POST', ['test', 'explode'])
    assert.equal(undeclared.status, 400)
  })

  test('a non-object body is a client bug — 400 not 500', async () => {
    for (const body of ['[1,2]', '"x"', 'not json']) {
      const r = await call('POST', ['test', 'poke'], { body })
      assert.equal(r.status, 400, body)
    }
  })

  test('PUT/PATCH on a plane sub-route is 405', async () => {
    const r = await call('PUT', ['test', 'poke'])
    assert.equal(r.status, 405)
  })
})

describe('planes/rest — surface absence', () => {
  test('a null catalog 404s the whole subtree like any unwired route', async () => {
    for (const [m, api] of [
      ['GET', []],
      ['GET', ['test']],
      ['POST', ['test', 'poke']],
    ] as const) {
      const r = await routePlanes(m, ['planes', ...api], undefined, undefined, {})
      assert.equal(r.status, 404, `${m} ${api.join('/')}`)
    }
  })
})

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
  capabilities: async () => ({ read: true, poke: true }),
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
    assert.deepEqual(body.planes[0]!.capabilities, { read: true, poke: true })
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
    // limit=0 is a real value — zero rows, not "no limit"
    await call('GET', ['test'], {
      catalog: [
        fakePlane({
          list: async (f) => {
            seen = f
            return []
          },
        }),
      ],
      query: { limit: '0' },
    })
    assert.deepEqual(seen, { limit: 0 })
  })

  test('percent-encoded refs decode before get — gen%3Aseq reaches the descriptor as gen:seq', async () => {
    let seen: string | undefined
    const r = await call('GET', ['test', 'gen%3Aseq'], {
      catalog: [
        fakePlane({
          get: async (ref) => {
            seen = ref
            return { id: ref }
          },
        }),
      ],
    })
    assert.equal(r.status, 200)
    assert.equal(seen, 'gen:seq')
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

  test('absent capability hides the plane — read:false, a missing flag, and a thrown probe all 404', async () => {
    const catalog = [fakePlane({ capabilities: async () => ({ read: false }) })]
    for (const api of [['test'], ['test', 'a'], ['test', 'tail']]) {
      const r = await call('GET', api, { catalog })
      assert.equal(r.status, 404, api.join('/'))
      const body = r.body as { error: string }
      assert.match(body.error, /test/)
    }
    // spec's "absent capability = hidden" — a caps doc without read
    // answers nothing
    const noFlag = await call('GET', ['test'], {
      catalog: [fakePlane({ capabilities: async () => ({}) })],
    })
    assert.equal(noFlag.status, 404)
    // a thrown probe is incapable, never a 500
    const thrown = await call('GET', ['test'], {
      catalog: [
        fakePlane({
          capabilities: async () => {
            throw new Error('backend dead')
          },
        }),
      ],
    })
    assert.equal(thrown.status, 404)
  })

  test('POST to a verb-incapable plane is 404 — the read gate does not cover writes', async () => {
    const r = await call('POST', ['test', 'poke'], {
      catalog: [fakePlane({ capabilities: async () => ({ read: true }) })],
    })
    assert.equal(r.status, 404)
    const body = r.body as { error: string }
    assert.match(body.error, /poke/)
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

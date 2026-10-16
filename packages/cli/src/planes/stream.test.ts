import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BusCursor, BusSubscription, BusSubscriptionHandlers, EventFilter } from '@broject/core'
import {
  asyncapiDocument,
  openEventsSse,
  parseEventCursor,
  routeEventsStream,
  type EventsStreamBus,
} from './stream.ts'

/** Minimal req/res fakes — the route only touches method, headers,
 *  writeHead/write/end/on. */
const fakeReq = (method: string, headers: Record<string, string> = {}) =>
  ({ method, headers }) as IncomingMessage

interface CapturedRes {
  status?: number
  headers?: Record<string, string>
  chunks: string[]
  ended: boolean
  closeHandlers: (() => void)[]
}

const fakeRes = () => {
  const r: CapturedRes = { chunks: [], ended: false, closeHandlers: [] }
  const res = {
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    writeHead: (status: number, headers: Record<string, string>) => {
      r.status = status
      r.headers = headers
      return res
    },
    flushHeaders: () => {},
    write: (chunk: string) => {
      r.chunks.push(chunk)
      return true
    },
    end: () => {
      r.ended = true
      res.writableEnded = true
    },
    on: (ev: string, fn: () => void) => {
      if (ev === 'close') r.closeHandlers.push(fn)
      return res
    },
  }
  return { res: res as unknown as ServerResponse, cap: r }
}

interface FakeSub {
  handlers?: BusSubscriptionHandlers
  opts?: { since?: number | BusCursor; limit?: number }
  filter?: EventFilter
  closed: boolean
  fail?: Error
}

const fakeBus = (sub: FakeSub): EventsStreamBus => ({
  socketPath: () => '/tmp/bus.sock',
  subscribe: async (_s: string, f: EventFilter, h: BusSubscriptionHandlers, o) => {
    sub.handlers = h
    sub.opts = o
    sub.filter = f
    if (sub.fail !== undefined) throw sub.fail
    return { close: () => (sub.closed = true) }
  },
})

describe('parseEventCursor', () => {
  test('parses <gen>:<seq>, degrades unparseable to cursorless', () => {
    assert.deepEqual(parseEventCursor('run-1:42'), { gen: 'run-1', seq: 42 })
    assert.deepEqual(parseEventCursor('a:0'), { gen: 'a', seq: 0 })
    assert.equal(parseEventCursor(undefined), undefined)
    assert.equal(parseEventCursor('42'), undefined)
    assert.equal(parseEventCursor('gen:abc'), undefined)
    assert.equal(parseEventCursor('gen:'), undefined)
    assert.equal(parseEventCursor(''), undefined)
    assert.deepEqual(parseEventCursor(['x:7', 'y:8']), { gen: 'x', seq: 7 })
  })
})

describe('routeEventsStream', () => {
  test('non-matching path falls through', async () => {
    const { res } = fakeRes()
    assert.equal(
      await routeEventsStream(fakeReq('GET'), res, '/api/v1/events/tail', fakeBus({ closed: false })),
      false
    )
    assert.equal(
      await routeEventsStream(fakeReq('GET'), res, '/api/v1/planes/events', undefined),
      false
    )
  })

  test('non-GET is 405', async () => {
    const { res, cap } = fakeRes()
    assert.equal(
      await routeEventsStream(fakeReq('POST'), res, '/api/v1/events/stream', fakeBus({ closed: false })),
      true
    )
    assert.equal(cap.status, 405)
  })

  test('absent bus seam or null socket is 503, never a hang', async () => {
    const { res, cap } = fakeRes()
    await routeEventsStream(fakeReq('GET'), res, '/api/v1/events/stream', undefined)
    assert.equal(cap.status, 503)

    const { res: res2, cap: cap2 } = fakeRes()
    const deadSock: EventsStreamBus = {
      socketPath: () => null,
      subscribe: async () => ({ close: () => {} }),
    }
    await routeEventsStream(fakeReq('GET'), res2, '/api/v1/events/stream', deadSock)
    assert.equal(cap2.status, 503)
  })

  test('cursorless connect subscribes with the ring-tail window', async () => {
    const sub: FakeSub = { closed: false }
    const { res, cap } = fakeRes()
    await routeEventsStream(fakeReq('GET'), res, '/api/v1/events/stream', fakeBus(sub))
    assert.equal(cap.status, 200)
    assert.match(cap.headers?.['content-type'] ?? '', /text\/event-stream/)
    assert.equal(sub.opts?.since, 0)
    assert.equal(sub.opts?.limit, 64)
  })

  test('Last-Event-ID resumes as {gen,seq} without the tail limit', async () => {
    const sub: FakeSub = { closed: false }
    const { res } = fakeRes()
    await routeEventsStream(
      fakeReq('GET', { 'last-event-id': 'run-9:41' }),
      res,
      '/api/v1/events/stream',
      fakeBus(sub)
    )
    assert.deepEqual(sub.opts?.since, { gen: 'run-9', seq: 41 })
    assert.equal(sub.opts?.limit, undefined)
  })

  test('envelopes emit unnamed frames with the gen:seq id; gap is named', async () => {
    const sub: FakeSub = { closed: false }
    const { res, cap } = fakeRes()
    await routeEventsStream(fakeReq('GET'), res, '/api/v1/events/stream', fakeBus(sub))
    sub.handlers?.onEvent({
      gen: 'run-1',
      seq: 7,
      topic: 'notify',
      kind: 'note',
      ts: 't',
      payload: 'hi',
    } as never)
    assert.equal(cap.chunks[0], 'id: run-1:7\n' + `data: ${JSON.stringify({ gen: 'run-1', seq: 7, topic: 'notify', kind: 'note', ts: 't', payload: 'hi' })}\n\n`)
    // unnamed frame — a browser's onmessage catches it
    assert.doesNotMatch(cap.chunks[0], /^event:/m)

    sub.handlers?.onGap?.(9)
    assert.equal(cap.chunks[1], 'event: gap\ndata: {"seq":9}\n\n')

    // a CR/LF in gen can never inject a second frame into the id line
    sub.handlers?.onEvent({
      gen: 'r\nun',
      seq: 8,
      topic: 'act',
      kind: 'k',
      ts: 't',
    } as never)
    assert.match(cap.chunks[2] ?? '', /^id: run:8\n/)
  })

  test('broker close ends the response; client close stops the subscription', async () => {
    const sub: FakeSub = { closed: false }
    const { res, cap } = fakeRes()
    await routeEventsStream(fakeReq('GET'), res, '/api/v1/events/stream', fakeBus(sub))
    sub.handlers?.onClose?.()
    assert.equal(cap.ended, true)
    assert.equal(sub.closed, true)

    const sub2: FakeSub = { closed: false }
    const { res: res2, cap: cap2 } = fakeRes()
    await routeEventsStream(fakeReq('GET'), res2, '/api/v1/events/stream', fakeBus(sub2))
    cap2.closeHandlers.forEach((f) => f())
    assert.equal(sub2.closed, true)
  })

  test('a subscribe rejection ends the stream rather than leaking', async () => {
    const sub: FakeSub = { closed: false, fail: new Error('broker wedged') }
    const { res, cap } = fakeRes()
    await routeEventsStream(fakeReq('GET'), res, '/api/v1/events/stream', fakeBus(sub))
    assert.equal(cap.ended, true)
  })

  test('a client close mid-subscribe still releases the broker subscription', async () => {
    const sub: FakeSub = { closed: false }
    const { res, cap } = fakeRes()
    let resolveSub: (s: BusSubscription) => void = () => {}
    const bus: EventsStreamBus = {
      socketPath: () => '/tmp/bus.sock',
      subscribe: (_s, _f, h, o) => {
        sub.handlers = h
        sub.opts = o
        return new Promise((r) => {
          resolveSub = r
        })
      },
    }
    const done = routeEventsStream(fakeReq('GET'), res, '/api/v1/events/stream', bus)
    // the close listener is armed before the subscribe resolves —
    // fire it while the handshake is still in flight
    cap.closeHandlers.forEach((f) => f())
    resolveSub({ close: () => (sub.closed = true) })
    await done
    assert.equal(sub.closed, true)
  })
})

describe('openEventsSse — the shared filtered leg', () => {
  test('the declared filter reaches the broker subscribe verbatim', async () => {
    const sub: FakeSub = { closed: false }
    const { res, cap } = fakeRes()
    await openEventsSse(fakeReq('GET'), res, fakeBus(sub), '/tmp/bus.sock', {
      topics: ['agent'],
      keys: ['native-aa11'],
    })
    assert.equal(cap.status, 200)
    assert.match(cap.headers?.['content-type'] ?? '', /text\/event-stream/)
    assert.deepEqual(sub.filter, { topics: ['agent'], keys: ['native-aa11'] })
    // scoped streams keep the same resume semantics as the fleet tail
    assert.equal(sub.opts?.since, 0)
    assert.equal(sub.opts?.limit, 64)
  })

  test('a scoped stream still honours Last-Event-ID resume', async () => {
    const sub: FakeSub = { closed: false }
    const { res } = fakeRes()
    await openEventsSse(
      fakeReq('GET', { 'last-event-id': 'run-9:41' }),
      res,
      fakeBus(sub),
      '/tmp/bus.sock',
      { topics: ['agent'], keys: ['acp:sess-1'] }
    )
    assert.deepEqual(sub.opts?.since, { gen: 'run-9', seq: 41 })
    assert.deepEqual(sub.filter, { topics: ['agent'], keys: ['acp:sess-1'] })
  })
})

describe('asyncapiDocument', () => {
  test('generates a 3.x doc whose messages come from the topic table', () => {
    const doc = asyncapiDocument() as {
      asyncapi: string
      channels: { events: { address: string; messages: Record<string, unknown> } }
      operations: { eventsStream: { action: string } }
    }
    assert.equal(doc.asyncapi, '3.0.0')
    assert.equal(doc.channels.events.address, '/api/v1/events/stream')
    assert.equal(doc.operations.eventsStream.action, 'send')
    for (const t of ['notify', 'act', 'convoy', 'drive', 'mesh', 'gap']) {
      assert.ok(t in doc.channels.events.messages, t)
    }
  })
})

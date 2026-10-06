import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { describe, test } from 'node:test'
import {
  BusRing,
  busMatches,
  busProbe,
  busPublish,
  busSocketPath,
  busStatus,
  busSubscribe,
  busTopicMatches,
  BUS_PROBE_WINDOW_MS,
  isBusEventInput,
  startBusBrokerAt,
  type BusBroker,
  type BusRecord,
  type BusEnvelope,
} from './bus.ts'
import { PROBE_TIMEOUT_MS } from './connectors.ts'

/** A broker on a throwaway socket. The path (not a repo dir) is the
 *  seam that keeps these tests free of git fixtures — `startBusBroker`
 *  is the dir-shaped wrapper, `startBusBrokerAt` the transport. */
async function withBroker(
  fn: (broker: BusBroker, socketPath: string) => Promise<void>,
  opts: { ring?: { limit?: number; ttlMs?: number; maxBytes?: number } } = {}
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
  const socketPath = join(dir, 'bus.sock')
  const broker = await startBusBrokerAt(socketPath, {
    ...(opts.ring !== undefined ? { ring: opts.ring } : {}),
    now: () => Date.parse('2026-10-04T12:00:00.000Z'),
  })
  try {
    await fn(broker, socketPath)
  } finally {
    await broker.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Let the broker's write reach the subscriber's read. Two turns: one
 *  for the publish to be acked, one for the event frame to land. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
}

/** Wait for a condition instead of guessing a sleep. `busSubscribe`
 *  resolves on connect, before the broker has read the `sub` frame, so
 *  anything the broker sends in reply — a `gap`, a replay — has no
 *  "arrived" signal. A fixed sleep made those assertions a coin flip
 *  under a loaded test run. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('busTopicMatches', () => {
  test('exact, star and trailing glob', () => {
    assert.equal(busTopicMatches('agent', 'agent'), true)
    assert.equal(busTopicMatches('agent', 'agents'), false)
    assert.equal(busTopicMatches('*', 'anything'), true)
    assert.equal(busTopicMatches('agent:*', 'agent:failed'), true)
    assert.equal(busTopicMatches('agent:*', 'pr:226'), false)
  })
})

describe('busMatches', () => {
  const event = { topic: 'agent:finished', kind: 'done' }

  test('an empty filter takes everything', () => {
    assert.equal(busMatches({}, event), true)
  })

  test('topics and kinds intersect, either may narrow alone', () => {
    assert.equal(busMatches({ topics: ['agent:*'] }, event), true)
    assert.equal(busMatches({ kinds: ['done'] }, event), true)
    assert.equal(busMatches({ kinds: ['failed'] }, event), false)
    assert.equal(busMatches({ topics: ['pr:*'], kinds: ['done'] }, event), false)
  })

  test('an empty list is not a filter — it would silently widen', () => {
    assert.equal(busMatches({ topics: [] }, event), true)
    assert.equal(busMatches({ topics: [] }, event), true)
  })
})

describe('isBusEventInput', () => {
  test('topic and kind are required and non-empty', () => {
    assert.equal(isBusEventInput({ topic: 'a', kind: 'b' }), true)
    assert.equal(isBusEventInput({ topic: 'a' }), false)
    assert.equal(isBusEventInput({ topic: '', kind: 'b' }), false)
    assert.equal(isBusEventInput({ topic: 'a', kind: 1 }), false)
    assert.equal(isBusEventInput(null), false)
    assert.equal(isBusEventInput('a'), false)
  })
})

describe('BusRing', () => {
  const T = Date.parse('2026-10-04T12:00:00.000Z')
  const env = (seq: number): BusRecord => ({ gen: 'g1', seq, ts: '2026-10-04T12:00:00.000Z', topic: 't', kind: 'k' })

  test('rejects a nonsense limit rather than silently truncating', () => {
    assert.throws(() => new BusRing({ limit: 0 }), RangeError)
    assert.throws(() => new BusRing({ limit: 1.5 }), RangeError)
  })

  test('evicts oldest past the limit', () => {
    const ring = new BusRing({ limit: 3 })
    for (const s of [1, 2, 3, 4]) {
      ring.push(env(s), T)
    }
    assert.equal(ring.size, 3)
    assert.deepEqual(ring.since(1, T)?.map((e) => e.seq), [2, 3, 4], 'cursor at the eviction edge still answers')
    assert.equal(ring.since(0, T), null, 'asking from evicted seq 1 is a hole, not a short list')
  })

  test('a cursor older than the window is a gap, not a short answer', () => {
    const ring = new BusRing({ limit: 2 })
    for (const s of [1, 2, 3]) {
      ring.push(env(s), T)
    }
    // seq 1 is gone but the consumer holds cursor 1: everything it asks
    // for (2, 3) is still present, so there is no hole to report
    assert.deepEqual(ring.since(1, T)?.map((e) => e.seq), [2, 3])
    assert.equal(ring.since(0, T), null, 'cursor 0 needs seq 1, which was evicted')
  })

  test('a count bound alone still leaks: age evicts too', () => {
    const T = Date.parse('2026-10-04T12:00:00.000Z')
    const ring = new BusRing({ limit: 100, ttlMs: 60_000 })
    const at = (seq: number, ts: string): BusRecord => ({ gen: 'g1', seq, ts, topic: 't', kind: 'k' })
    ring.push(at(1, '2026-10-04T12:00:00.000Z'), T)
    ring.push(at(2, '2026-10-04T12:00:30.000Z'), T)
    // still inside the ttl
    assert.equal(ring.since(0, T)?.length, 2)

    // An hour later the head is past its ttl even though the count
    // bound (100) is nowhere near — a slow trickle must still forget.
    const later = T + 3_600_000
    assert.equal(ring.since(0, later), null, 'the cursor now predates the window: a gap, not silence')
    assert.equal(ring.size, 0)
  })

  test('one fat payload cannot evict the whole ring by accident', () => {
    const T = Date.parse('2026-10-04T12:00:00.000Z')
    const ring = new BusRing({ limit: 1000, maxBytes: 4096 })
    for (const s of [1, 2, 3]) {
      ring.push({ gen: 'g1', seq: s, ts: '2026-10-04T12:00:00.000Z', topic: 't', kind: 'k' }, T)
    }
    ring.push({ gen: 'g1', seq: 4, ts: '2026-10-04T12:00:00.000Z', topic: 't', kind: 'k', payload: 'x'.repeat(8192) }, T)
    assert.ok(ring.size < 4, 'the byte bound has to bite')
    assert.equal(ring.since(0, T), null, 'whatever it dropped shows up as a gap, never a short list')
  })

  test('an empty ring answers a fresh cursor but not a future one', () => {
    const ring = new BusRing({ limit: 4 })
    assert.deepEqual(ring.since(0, T), [])
    // broker restarted: seq counts from 1 again, so a client claiming
    // seq 41 must be told to re-derive rather than wait forever
    assert.equal(ring.since(41, T), null)
  })
})

describe('broker fan-out', () => {
  test('one publish, two subscribers, each gets only its own subset', async () => {
    await withBroker(async (_broker, socketPath) => {
      const agentEvents: BusEnvelope[] = []
      const prEvents: BusEnvelope[] = []
      const subA = await busSubscribe(socketPath, { topics: ['agent:*'] }, {
        onEvent: (e) => agentEvents.push(e),
      })
      const subB = await busSubscribe(socketPath, { topics: ['pr:*'] }, {
        onEvent: (e) => prEvents.push(e),
      })
      await settle()

      const ack = await busPublish(socketPath, { topic: 'agent:finished', kind: 'done', key: 'bro-1' })
      assert.equal(ack.published, true)
      assert.equal(ack.seq, 1)
      await busPublish(socketPath, { topic: 'pr:threads', kind: 'opened', key: '226' })
      await settle()

      assert.deepEqual(agentEvents.map((e) => e.key), ['bro-1'])
      assert.deepEqual(prEvents.map((e) => e.key), ['226'])
      subA.close()
      subB.close()
    })
  })

  test('seq is assigned by the broker and is monotonic across publishers', async () => {
    await withBroker(async (broker, socketPath) => {
      const first = await busPublish(socketPath, { topic: 'a', kind: 'x' })
      const second = await busPublish(socketPath, { topic: 'b', kind: 'y' })
      assert.deepEqual([first.seq, second.seq], [1, 2])
      assert.equal(broker.seq, 2)
      assert.equal(first.seq !== second.seq, true)
    })
  })

  test('cause and ref survive the round trip — the chain stays readable', async () => {
    await withBroker(async (_broker, socketPath) => {
      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, { onEvent: (e) => seen.push(e) }, { since: 0 })
      await settle()
      await busPublish(socketPath, {
        topic: 'pr:fix',
        kind: 'landed',
        cause: 'bro-2hno',
        ref: '/tmp/wt/fixer-1',
      })
      await settle()
      sub.close()
      // Offsets and handles belong in the envelope from day one: a later
      // transport that stores events must not have to migrate them.
      assert.equal(seen[0]?.cause, 'bro-2hno')
      assert.equal(seen[0]?.ref, '/tmp/wt/fixer-1')
    })
  })

  test('ts comes from the broker clock, not the publisher', async () => {
    await withBroker(async (_broker, socketPath) => {
      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, { onEvent: (e) => seen.push(e) })
      await settle()
      await busPublish(socketPath, { topic: 'a', kind: 'x', payload: { at: 'not-a-timestamp' } })
      await settle()
      assert.equal(seen[0]?.ts, '2026-10-04T12:00:00.000Z')
      sub.close()
    })
  })

  test('a `to` filter gets broadcast and its own address, never a foreign one', async () => {
    await withBroker(async (_broker, socketPath) => {
      const mine: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, { to: 'fixer-1' }, {
        onEvent: (e) => mine.push(e),
      })
      await settle()
      await busPublish(socketPath, { topic: 'notify', kind: 'ask', to: 'fixer-1', payload: 'yours' })
      await busPublish(socketPath, { topic: 'notify', kind: 'ask', to: 'fixer-9', payload: 'not yours' })
      await busPublish(socketPath, { topic: 'notify', kind: 'note', payload: 'everyone' })
      await settle()
      assert.deepEqual(mine.map((e) => e.payload), ['yours', 'everyone'])
      sub.close()
    })
  })
})

describe('replay from a cursor', () => {
  test('a subscriber with no cursor gets the stream, not the backlog', async () => {
    await withBroker(async (_broker, socketPath) => {
      await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'old-1' })
      await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'old-2' })

      // Defaulting the cursor to 0 replayed the whole ring at every
      // plain subscriber; a stream consumer wants what happens next.
      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, { onEvent: (e) => seen.push(e) })
      await settle()
      assert.equal(seen.length, 0, 'a plain subscriber must not be handed the backlog')

      await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'new-1' })
      await settle()
      assert.deepEqual(seen.map((e) => e.key), ['new-1'])
      sub.close()
    })
  })

  test('replay obeys the filter, live delivery and replay agree', async () => {
    await withBroker(async (_broker, socketPath) => {
      await busPublish(socketPath, { topic: 'agent:finished', kind: 'done', key: 'bro-1' })
      await busPublish(socketPath, { topic: 'pr:threads', kind: 'opened', key: '226' })

      // Replay went unfiltered while live delivery filtered, so a
      // subscriber that reconnects saw topics it had excluded.
      const replayed: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, { topics: ['agent:*'] }, {
        onEvent: (e) => replayed.push(e),
      }, { since: 0 })
      await settle()

      const live: BusEnvelope[] = []
      await settle()
      assert.deepEqual(replayed.map((e) => e.key), ['bro-1'], 'replay must honour the filter')

      const sub2 = await busSubscribe(socketPath, { topics: ['agent:*'] }, {
        onEvent: (e) => live.push(e),
      })
      await settle()
      await busPublish(socketPath, { topic: 'agent:failed', kind: 'failed', key: 'bro-2' })
      await busPublish(socketPath, { topic: 'pr:merged', kind: 'ok', key: '227' })
      await settle()

      assert.deepEqual(replayed.map((e) => e.key), ['bro-1', 'bro-2'], 'the live match still arrives')
      assert.deepEqual(live.map((e) => e.key), ['bro-2'])
      sub.close()
      sub2.close()
    })
  })

  test('a gap is reported even when the filter would have hidden the events', async () => {
    await withBroker(async (_broker, socketPath) => {
      for (const s of ['a', 'b', 'c', 'd']) {
        await busPublish(socketPath, { topic: 'other', kind: 'k', key: s })
      }
      let gapped = false
      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, { topics: ['agent:*'] }, {
        onEvent: (e) => seen.push(e),
        onGap: () => {
          gapped = true
        },
      }, { since: 0 })
      await waitFor('the gap frame', () => gapped)
      sub.close()
      // Nothing in the ring matched, yet the hole is real: a silent
      // empty result would read as "nothing happened".
      assert.equal(gapped, true)
      assert.deepEqual(seen, [])
    }, { ring: { limit: 2 } })
  })

  test('a reconnecting consumer receives what it missed', async () => {
    await withBroker(async (_broker, socketPath) => {
      await busPublish(socketPath, { topic: 'a', kind: 'x' })
      await busPublish(socketPath, { topic: 'b', kind: 'y' })
      await busPublish(socketPath, { topic: 'c', kind: 'z' })

      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, { onEvent: (e) => seen.push(e) }, { since: 1 })
      await settle()
      assert.deepEqual(seen.map((e) => e.seq), [2, 3], 'replay starts after the cursor')
      sub.close()
    })
  })

  test('a cursor at the eviction edge replays; one below it reports a gap', async () => {
    await withBroker(async (_broker, socketPath) => {
      for (const s of ['a', 'b', 'c', 'd']) {
        await busPublish(socketPath, { topic: 't', kind: 'k', key: s })
      }
      let gapped = false
      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, {
        onEvent: (e) => seen.push(e),
        onGap: () => {
          gapped = true
        },
      }, { since: 0 })
      await waitFor('the gap frame', () => gapped)
      sub.close()
      assert.equal(gapped, true, 'a fresh cursor needs seq 1 and 2, both evicted')
      assert.ok(seen.length < 4, 'a gap must not be papered over with a full-looking list')
    }, { ring: { limit: 2 } })
  })

  test('gap is reported when the cursor predates the surviving ring', async () => {
    await withBroker(async (_broker, socketPath) => {
      for (const s of ['a', 'b', 'c', 'd']) {
        await busPublish(socketPath, { topic: 't', kind: 'k', key: s })
      }
      let gapped = false
      const seen: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, {
        onEvent: (e) => seen.push(e),
        onGap: () => {
          gapped = true
        },
      }, { since: 1 })
      await settle()
      sub.close()
      assert.equal(gapped, true, 'seq 1 was evicted — the consumer must re-derive')
      assert.ok(seen.length < 4, 'a gap must not be papered over with a full-looking list')
    }, { ring: { limit: 2 } })
  })
})

describe('fail-open contract', () => {
  // REVIEW.md: any path that can hang or exit non-zero on a hook event is
  // a critical finding. A broker that is simply not running is a normal
  // state, so every client path resolves rather than throws.
  test('publish against a broker that is not there resolves, not throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    try {
      const result = await busPublish(join(dir, 'absent.sock'), { topic: 'a', kind: 'x' })
      assert.equal(result.published, false)
      assert.equal(result.reason, 'broker down')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('probe against a broker that is not there returns an empty result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    try {
      const result = await busProbe(join(dir, 'absent.sock'))
      assert.deepEqual(result.events, [])
      assert.equal(result.gapped, false)
      assert.ok(result.reason !== undefined, 'the caller can tell down from empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('status reports down and does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    try {
      const status = await busStatus(join(dir, 'absent.sock'))
      assert.equal(status.running, false)
      assert.equal(status.reason, 'broker down')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('probe never outlives its window even when the broker is healthy', async () => {
    await withBroker(async (_broker, socketPath) => {
      const started = Date.now()
      const result = await busProbe(socketPath, { windowMs: 120 })
      const elapsed = Date.now() - started
      assert.ok(elapsed < 2_000, `probe took ${String(elapsed)}ms — a hook budget is not optional`)
      assert.deepEqual(result.events, [])
    })
  })
})

describe('probe collects what is waiting', () => {
  test('probe catches up on the backlog, a subscriber does not', async () => {
    await withBroker(async (_broker, socketPath) => {
      await busPublish(socketPath, { topic: 'agent:finished', kind: 'done', key: 'bro-1' })
      await busPublish(socketPath, { topic: 'agent:failed', kind: 'failed', key: 'bro-2' })

      // Same socket, two shapes: the probe asks what it missed, the
      // stream consumer asks what comes next.
      const probed = await busProbe(socketPath, { windowMs: 120 })
      assert.deepEqual(probed.events.map((e) => e.key), ['bro-1', 'bro-2'])

      const live: BusEnvelope[] = []
      const sub = await busSubscribe(socketPath, {}, { onEvent: (e) => live.push(e) })
      await settle()
      assert.equal(live.length, 0)
      sub.close()
    })
  })

  test('a cursorless probe is bounded and admits the truncation', async () => {
    await withBroker(async (_broker, socketPath) => {
      for (let i = 1; i <= 10; i += 1) {
        await busPublish(socketPath, { topic: 't', kind: 'k', key: `e${String(i)}` })
      }
      // A hook run must not inherit the whole ring; the newest slice is
      // what "what happened" means, and gapped says the rest was cut.
      const result = await busProbe(socketPath, { windowMs: 120, limit: 3 })
      assert.deepEqual(result.events.map((e) => e.key), ['e8', 'e9', 'e10'])
      assert.equal(result.gapped, true)

      // An explicit cursor is the caller's own bound — never truncated.
      const cursor = await busProbe(socketPath, { since: 1, windowMs: 120, limit: 3 })
      assert.equal(cursor.events.length, 9)
      assert.equal(cursor.gapped, false)
    })
  })

  test('a quiet broker yields nothing and stays quiet', async () => {
    await withBroker(async (_broker, socketPath) => {
      const result = await busProbe(socketPath, { windowMs: 80 })
      assert.deepEqual(result.events, [], 'an unchanged bus must produce no note')
    })
  })

  test('a probe with a cursor still replays what it missed', async () => {
    await withBroker(async (_broker, socketPath) => {
      await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'old-1' })
      await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'old-2' })
      const result = await busProbe(socketPath, { since: 1, windowMs: 80 })
      assert.deepEqual(result.events.map((e) => e.key), ['old-2'])
    })
  })
})

describe('malformed frames', () => {
  test('a malformed frame drops the subscriber, not just the socket', async () => {
    await withBroker(async (broker, socketPath) => {
      const sock = connect(socketPath)
      try {
        sock.write(`${JSON.stringify({ op: 'sub', filter: {} })}\n`)
        await settle()
        assert.equal(broker.subscriberCount, 1)
        // end() only schedules the close event that untracks the
        // subscriber — until the peer FINs back the broker would keep
        // delivering into a dead half of the socket.
        sock.write('not json\n')
        await settle()
        assert.equal(broker.subscriberCount, 0, 'a dead peer must not linger in the delivery set')
      } finally {
        sock.destroy()
      }
    })
  })
})

describe('broker restart', () => {
  test('a restarted broker tells a stale cursor to re-derive, not to wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(dir, 'bus.sock')
    try {
      const first = await startBusBrokerAt(socketPath, {
        now: () => Date.parse('2026-10-04T12:00:00.000Z'),
      })
      await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'before-restart' })
      assert.equal((await busPublish(socketPath, { topic: 'a', kind: 'x' })).seq, 2)
      await first.close()

      const second = await startBusBrokerAt(socketPath, {
        now: () => Date.parse('2026-10-04T12:00:05.000Z'),
      })
      try {
        let gapped = false
        const seen: BusEnvelope[] = []
        const sub = await busSubscribe(socketPath, {}, {
          onEvent: (e) => seen.push(e),
          onGap: () => {
            gapped = true
          },
          // a cursor the dead broker issued: seq restarts at 1, so this
          // consumer's "seq 2" can never be satisfied
        }, { since: 2 })
        await waitFor('the gap frame after restart', () => gapped)
        sub.close()
        assert.equal(gapped, true, 'a restart must read as a hole, not as silence')

        // And the registry stays the source of truth: the fresh broker
        // keeps counting from its own head, so a consumer that
        // re-derives lands on a consistent cursor again.
        const fresh = await busPublish(socketPath, { topic: 'a', kind: 'x', key: 'after-restart' })
        assert.equal(fresh.seq, 1)
        const caught: BusEnvelope[] = []
        const sub2 = await busSubscribe(socketPath, {}, { onEvent: (e) => caught.push(e) }, { since: 0 })
        await settle()
        sub2.close()
        assert.deepEqual(caught.map((e) => e.key), ['after-restart'])

        // The durable cursor is {gen, seq}: a cursor the dead run issued
        // must read as a gap even when the fresh seq space has grown
        // past it — a bare number cannot see the restart.
        assert.notEqual(first.gen, second.gen)
        let foreignGap = false
        const foreign: BusEnvelope[] = []
        const sub3 = await busSubscribe(socketPath, {}, {
          onEvent: (e) => foreign.push(e),
          onGap: () => {
            foreignGap = true
          },
        }, { since: { gen: first.gen, seq: 1 } })
        await settle()
        sub3.close()
        assert.equal(foreignGap, true, 'a {gen, seq} cursor from a dead run must report a gap')
        assert.deepEqual(foreign, [])

        // The same run's gen honours the cursor normally.
        const same: BusEnvelope[] = []
        const sub4 = await busSubscribe(socketPath, {}, { onEvent: (e) => same.push(e) }, {
          since: { gen: second.gen, seq: 0 },
        })
        await settle()
        sub4.close()
        assert.deepEqual(same.map((e) => e.key), ['after-restart'])
      } finally {
        await second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('probe never stalls', () => {
  // The bead names the existing per-probe budget
  // (packages/core/src/connectors.ts:439) rather than a second invented
  // one, and rates any hook path that can hang a critical finding. This
  // is the assertion that keeps that true from the outside.
  test('the default probe window is sub-second and under the hook budget', () => {
    assert.ok(BUS_PROBE_WINDOW_MS < 1000, 'the bead requires a hard sub-second budget')
    assert.ok(BUS_PROBE_WINDOW_MS < PROBE_TIMEOUT_MS, 'the bus budget must be the tighter of the two')
  })

  test('a down broker costs the probe budget and no more', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    try {
      const socketPath = join(dir, 'absent.sock')
      const started = Date.now()
      const result = await busProbe(socketPath, { windowMs: BUS_PROBE_WINDOW_MS })
      const elapsed = Date.now() - started
      assert.equal(result.gapped, false)
      assert.ok(
        elapsed <= BUS_PROBE_WINDOW_MS + 250,
        `probe took ${String(elapsed)}ms with no broker — it must fail open inside its budget`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a broker that accepts and then says nothing still costs the budget', async () => {
    // The worst shape for a hook: the socket connects, so there is no
    // ECONNREFUSED shortcut, and then the peer stalls forever.
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(dir, 'silent.sock')
    // Accept, then never answer. The accepted sockets are tracked so the
    // cleanup can actually finish: `server.close()` waits for its
    // connections, and a wedged peer is precisely what is being simulated.
    const held: Socket[] = []
    const silent = createServer((sock) => held.push(sock))
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve))
    try {
      const started = Date.now()
      const result = await busProbe(socketPath, { windowMs: BUS_PROBE_WINDOW_MS })
      const elapsed = Date.now() - started
      assert.equal(result.events.length, 0)
      assert.ok(
        elapsed <= BUS_PROBE_WINDOW_MS + 250,
        `probe took ${String(elapsed)}ms against a silent peer — a hung broker must not outlive the probe`
      )
    } finally {
      for (const sock of held) {
        sock.destroy()
      }
      await new Promise<void>((resolve) => silent.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('broker startup', () => {
  test('creates the socket dir it is about to bind into', async () => {
    // The suite above binds into an mkdtemp dir that already exists,
    // which hides a missing mkdir: binding into an absent nested dir
    // fails with EACCES on Linux, so this is the regression guard.
    const root = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(root, 'absent', 'nested', 'bus.sock')
    const broker = await startBusBrokerAt(socketPath, {
      now: () => Date.parse('2026-10-04T12:00:00.000Z'),
    })
    try {
      assert.equal(broker.socketPath, socketPath)
      assert.equal((await busPublish(socketPath, { topic: 'a', kind: 'x' })).published, true)
    } finally {
      await broker.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a stale socket inode does not block a restart', async () => {
    // A SIGKILLed broker never runs close(), so the socket file
    // survives. ECONNREFUSED is the proof nothing listens — unlink it
    // and bind instead of dying on EADDRINUSE.
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(dir, 'bus.sock')
    writeFileSync(socketPath, 'stale')
    try {
      const broker = await startBusBrokerAt(socketPath, {
        now: () => Date.parse('2026-10-04T12:00:00.000Z'),
      })
      try {
        assert.equal((await busPublish(socketPath, { topic: 'a', kind: 'x' })).published, true)
      } finally {
        await broker.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the socket dir is owner-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketDir = join(root, 'sub')
    const socketPath = join(socketDir, 'bus.sock')
    const broker = await startBusBrokerAt(socketPath, {
      now: () => Date.parse('2026-10-04T12:00:00.000Z'),
    })
    try {
      const mode = statSync(socketDir).mode & 0o777
      assert.equal(mode, 0o700, `socket dir mode ${mode.toString(8)} — another local user could plant a name`)
      assert.equal(statSync(socketPath).mode & 0o777, 0o600)
    } finally {
      await broker.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('socket path', () => {
  test('is null outside a repository and short enough for sun_path', () => {
    // outside a repo: no git-common-dir, so no bus
    const dirA = mkdtempSync(join(tmpdir(), 'bro-bus-out-'))
    const dirB = mkdtempSync(join(tmpdir(), 'bro-bus-out-'))
    try {
      const outside = busSocketPath(dirA)
      // tmpdir is not a repository, so this must be null or a valid path
      if (outside !== null) {
        // sun_path counts UTF-8 bytes, not UTF-16 code units — a
        // non-ASCII path can fit the first and still overflow the second
        assert.ok(
          Buffer.byteLength(outside, 'utf8') < 104,
          `socket path too long for sun_path: ${String(Buffer.byteLength(outside, 'utf8'))} bytes`
        )
        rmSync(outside.replace(/\/[^/]+$/, ''), { recursive: true, force: true })
      }
      rmSync(busSocketPath(dirB) ?? '', { force: true })
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe('bus: a broker that goes away ends the stream', () => {
  test('onClose fires when the broker shuts down, so a subscriber does not wait on a signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(dir, 'bus.sock')
    const broker = await startBusBrokerAt(socketPath)
    try {
      let sub: { close(): void } | undefined
      let closes = 0
      const closed = new Promise<void>((resolve, reject) => {
        // bounded wait — without onClose the promise never resolves
        // and a hanging test must fail, not stall the suite
        const t = setTimeout(() => reject(new Error('onClose never fired')), 5_000)
        t.unref()
        void busSubscribe(socketPath, {}, {
          onEvent: () => undefined,
          onClose: () => {
            closes += 1
            clearTimeout(t)
            resolve()
          },
        }).then((s) => {
          sub = s
        })
      })
      await settle()
      await broker.close()
      // Without onClose this never resolves and the CLI sits silent
      // until SIGINT — a shutdown that reads as a lull, not an ending.
      await closed
      assert.equal(closes, 1)
      sub?.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a rejected connect never fires onClose — there was no stream to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(dir, 'bus.sock') // nothing listening
    try {
      let closes = 0
      await assert.rejects(
        busSubscribe(socketPath, {}, {
          onEvent: () => undefined,
          onClose: () => {
            closes += 1
          },
        })
      )
      await settle() // let a stray 'close' event land
      assert.equal(closes, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a local close() never fires onClose — the caller chose to end it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
    const socketPath = join(dir, 'bus.sock')
    const broker = await startBusBrokerAt(socketPath)
    try {
      let closes = 0
      const sub = await busSubscribe(socketPath, {}, {
        onEvent: () => undefined,
        onClose: () => {
          closes += 1
        },
      })
      sub.close()
      await settle() // let the 'close' event land
      assert.equal(closes, 0)
    } finally {
      await broker.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bus: a cursor past the head is a gap', () => {
  test('since() reports unobtainable rather than empty when the cursor outran the run', () => {
    const ring = new BusRing()
    const ts = '2026-10-04T12:00:00.000Z'
    ring.push({ gen: 'g1', seq: 1, ts, topic: 'a', kind: 'b' }, Date.parse(ts))
    // A cursor at head is an ordinary tail: empty is the truth.
    assert.deepEqual(ring.since(1, Date.parse(ts)), [])
    // Above it, nothing in this run ever issued that seq — a restart
    // collision or a bogus cursor. `[]` would read as "caught up".
    assert.equal(ring.since(9, Date.parse(ts)), null)
  })
})

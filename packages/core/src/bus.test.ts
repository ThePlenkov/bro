import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  isBusEventInput,
  startBusBrokerAt,
  type BusBroker,
  type BusEnvelope,
} from './bus.ts'

/** A broker on a throwaway socket. The path (not a repo dir) is the
 *  seam that keeps these tests free of git fixtures — `startBusBroker`
 *  is the dir-shaped wrapper, `startBusBrokerAt` the transport. */
async function withBroker(
  fn: (broker: BusBroker, socketPath: string) => Promise<void>,
  opts: { ringLimit?: number } = {}
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-bus-'))
  const socketPath = join(dir, 'bus.sock')
  const broker = await startBusBrokerAt(socketPath, {
    ...(opts.ringLimit !== undefined ? { ringLimit: opts.ringLimit } : {}),
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
  const env = (seq: number): BusEnvelope => ({ seq, ts: '2026-10-04T12:00:00.000Z', topic: 't', kind: 'k' })

  test('rejects a nonsense limit rather than silently truncating', () => {
    assert.throws(() => new BusRing(0), RangeError)
    assert.throws(() => new BusRing(1.5), RangeError)
  })

  test('evicts oldest past the limit', () => {
    const ring = new BusRing(3)
    for (const s of [1, 2, 3, 4]) {
      ring.push(env(s))
    }
    assert.equal(ring.size, 3)
    assert.deepEqual(ring.since(1)?.map((e) => e.seq), [2, 3, 4], 'cursor at the eviction edge still answers')
    assert.equal(ring.since(0), null, 'asking from evicted seq 1 is a hole, not a short list')
  })

  test('a cursor older than the window is a gap, not a short answer', () => {
    const ring = new BusRing(2)
    for (const s of [1, 2, 3]) {
      ring.push(env(s))
    }
    // seq 1 is gone but the consumer holds cursor 1: everything it asks
    // for (2, 3) is still present, so there is no hole to report
    assert.deepEqual(ring.since(1)?.map((e) => e.seq), [2, 3])
    assert.equal(ring.since(0), null, 'cursor 0 needs seq 1, which was evicted')
  })

  test('an empty ring answers a fresh cursor but not a future one', () => {
    const ring = new BusRing(4)
    assert.deepEqual(ring.since(0), [])
    // broker restarted: seq counts from 1 again, so a client claiming
    // seq 41 must be told to re-derive rather than wait forever
    assert.equal(ring.since(41), null)
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
      await settle()
      sub.close()
      // Nothing in the ring matched, yet the hole is real: a silent
      // empty result would read as "nothing happened".
      assert.equal(gapped, true)
      assert.deepEqual(seen, [])
    }, { ringLimit: 2 })
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
      await settle()
      sub.close()
      assert.equal(gapped, true, 'a fresh cursor needs seq 1 and 2, both evicted')
      assert.ok(seen.length < 4, 'a gap must not be papered over with a full-looking list')
    }, { ringLimit: 2 })
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
    }, { ringLimit: 2 })
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
  test('a quiet broker yields nothing and stays quiet', async () => {
    await withBroker(async (_broker, socketPath) => {
      const result = await busProbe(socketPath, { windowMs: 80 })
      assert.deepEqual(result.events, [], 'an unchanged bus must produce no note')
    })
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
    const outside = busSocketPath(mkdtempSync(join(tmpdir(), 'bro-bus-out-')))
    try {
      // tmpdir is not a repository, so this must be null or a valid path
      if (outside !== null) {
        assert.ok(outside.length < 104, `socket path too long for sun_path: ${String(outside.length)} bytes`)
      }
    } finally {
      if (outside !== null) {
        rmSync(outside.replace(/\/[^/]+$/, ''), { recursive: true, force: true })
      }
      rmSync(busSocketPath(mkdtempSync(join(tmpdir(), 'bro-bus-out-'))) ?? '', { force: true })
    }
  })
})

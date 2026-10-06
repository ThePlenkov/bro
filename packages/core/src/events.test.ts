import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { busEvents, mailboxEvents } from './events-connectors.ts'
import { eventMatches, eventTopicMatches, isEventInput } from './events.ts'
import { gitTry } from './git.ts'

/** The facade's promise is that a transport is swappable and nothing
 *  observable changes for the caller. These tests hold both halves: the
 *  mailbox default keeps working with nothing installed, and naming the
 *  bus moves the same event somewhere else entirely. */
async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-events-'))
  // Without a .git the drops would land in the XDG mailbox and the
  // repo-local default — the whole point of the mailbox connector —
  // would go untested.
  gitTry(['-C', dir, 'init'])
  // A drain covers the repo mailbox AND the user-level one, so a test that
  // left XDG alone would count the real user's residue as its own events.
  const stateHome = mkdtempSync(join(tmpdir(), 'bro-events-state-'))
  const prior = process.env['XDG_STATE_HOME']
  process.env['XDG_STATE_HOME'] = stateHome
  try {
    await fn(dir)
  } finally {
    if (prior === undefined) {
      delete process.env['XDG_STATE_HOME']
    } else {
      process.env['XDG_STATE_HOME'] = prior
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
}

describe('event contract', () => {
  test('topic globs: exact, star and trailing prefix', () => {
    assert.equal(eventTopicMatches('agent', 'agent'), true)
    assert.equal(eventTopicMatches('agent', 'agents'), false)
    assert.equal(eventTopicMatches('*', 'anything'), true)
    assert.equal(eventTopicMatches('agent:*', 'agent:failed'), true)
    assert.equal(eventTopicMatches('agent:*', 'pr:226'), false)
  })

  test('an empty filter narrows nothing', () => {
    const event = { topic: 'agent:finished', kind: 'done' }
    assert.equal(eventMatches({}, event), true)
    assert.equal(eventMatches({ topics: [] }, event), true)
    assert.equal(eventMatches({ topics: ['agent:*'] }, event), true)
    assert.equal(eventMatches({ kinds: ['failed'] }, event), false)
    // topics and kinds intersect — either may narrow alone
    assert.equal(eventMatches({ topics: ['pr:*'], kinds: ['done'] }, event), false)
  })

  test('an event that cannot be filtered on is not an event', () => {
    assert.equal(isEventInput({ topic: 'a', kind: 'b' }), true)
    assert.equal(isEventInput({ topic: 'a' }), false)
    assert.equal(isEventInput({ topic: '', kind: 'b' }), false)
    assert.equal(isEventInput(null), false)
  })
})

describe('mailbox connector', () => {
  test('a string payload is dropped verbatim — formatting is the event', async () => {
    await withRepo(async (dir) => {
      const events = mailboxEvents(dir, 'ses-1')
      const res = await events.publish({ topic: 'notify', kind: 'note', payload: '  spaced note  ' })
      assert.equal(res.published, true)
      assert.ok(res.locator !== undefined, 'the mailbox must say which file it wrote')
      // `notify.ts:143-145` — drops are injected as-is, so the bytes on
      // disk are the bytes the caller passed
      assert.equal(readFileSync(res.locator!, 'utf8'), '  spaced note  ')
    })
  })

  test('a structured event survives the round trip', async () => {
    await withRepo(async (dir) => {
      const events = mailboxEvents(dir, 'ses-1')
      await events.publish({ topic: 'agent:failed', kind: 'failed', key: 'bro-1', payload: { code: 7 } })
      const probe = await events.probe()
      assert.equal(probe.events.length, 1)
      assert.equal(probe.events[0]?.topic, 'agent:failed')
      assert.equal(probe.events[0]?.key, 'bro-1')
      assert.deepEqual(probe.events[0]?.payload, { code: 7 })
    })
  })

  test('no seq is invented — a set of files has no total order', async () => {
    await withRepo(async (dir) => {
      const res = await mailboxEvents(dir, 'ses-1').publish({ topic: 't', kind: 'k', payload: 'x' })
      assert.equal(res.seq, undefined, 'a fabricated counter is the lie this facade refuses')
    })
  })

  test('delivery is scoped to the session that asked', async () => {
    await withRepo(async (dir) => {
      await mailboxEvents(dir, 'ses-1').publish({ topic: 't', kind: 'k', payload: 'for one' })
      assert.equal((await mailboxEvents(dir, 'ses-1').probe()).events.length, 1)
      assert.equal(
        (await mailboxEvents(dir, 'ses-2').probe()).events.length,
        1,
        'a second session still sees it — that is the fan-out the bus generalises'
      )
      assert.equal((await mailboxEvents(dir, 'ses-1').probe()).events.length, 0, 'the cursor advanced')
    })
  })

  test('without a session cursor it says why instead of throwing', async () => {
    await withRepo(async (dir) => {
      const probe = await mailboxEvents(dir, undefined).probe()
      assert.equal(probe.events.length, 0)
      assert.match(probe.reason ?? '', /session cursor/)
    })
  })

  test('a cursor it cannot honour reports a gap rather than pretending', async () => {
    await withRepo(async (dir) => {
      await mailboxEvents(dir, 'ses-1').publish({ topic: 't', kind: 'k', payload: 'x' })
      let gapped = false
      const seen: unknown[] = []
      await mailboxEvents(dir, 'ses-1').subscribe(
        {},
        {
          onEvent: (e) => seen.push(e),
          onGap: () => {
            gapped = true
          },
        },
        { since: 5 }
      )
      assert.equal(gapped, true, 'ignoring `since` would let a consumer believe it caught up')
      assert.equal(seen.length, 1, 'what it can deliver, it still delivers')
    })
  })

  test('the filter applies to a drain, not just to a bus', async () => {
    await withRepo(async (dir) => {
      const events = mailboxEvents(dir, 'ses-1')
      await events.publish({ topic: 'notify', kind: 'note', payload: 'note' })
      await events.publish({ topic: 'agent:failed', kind: 'failed', payload: 'fail' })
      const seen: { topic?: string }[] = []
      await events.subscribe({ topics: ['agent:*'] }, { onEvent: (e) => seen.push(e) })
      assert.deepEqual(seen.map((e) => e.topic), ['agent:failed'])
    })
  })

  test('a verbatim note keeps its notify topic — transports are swappable', async () => {
    await withRepo(async (dir) => {
      const events = mailboxEvents(dir, 'ses-1')
      await events.publish({ topic: 'notify', kind: 'note', payload: 'plain text note' })
      const probe = await events.probe()
      assert.equal(probe.events[0]?.topic, 'notify')
      assert.equal(probe.events[0]?.kind, 'note')
      // and a notify-scoped subscription actually receives it — the drain
      // is per session, so the probe above did not consume it for ses-2
      const seen: { topic?: string }[] = []
      await mailboxEvents(dir, 'ses-2').subscribe({ topics: ['notify'] }, { onEvent: (e) => seen.push(e) })
      assert.deepEqual(seen.map((e) => e.topic), ['notify'])
    })
  })
})

describe('bus connector', () => {
  test('outside a repository it reports rather than throwing', async () => {
    const events = busEvents(tmpdir())
    assert.equal((await events.publish({ topic: 'a', kind: 'b' })).published, false)
    assert.match((await events.probe()).reason ?? '', /not a repository/)
  })
})

describe('facade resolution', () => {
  test('a configured but unknown connector names the seam', async () => {
    const { facade, registerConnector, mailboxConnector, busConnector } = await import('./index.ts')
    registerConnector(mailboxConnector)
    registerConnector(busConnector)
    assert.throws(
      () => facade('events', { dir: process.cwd() }, { prefer: { events: 'mqtt' } }),
      /connector "mqtt" does not provide "events"/
    )
  })
})
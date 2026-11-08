import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beadForHead,
  ceilingHeld,
  deterministicHeadSlug,
  isFleetHead,
  orphanVerdict,
  type FleetPrRow,
  type ReconcileBead,
} from './ceiling.ts'
import { loopSlug } from './item.ts'

const row = (headRef: string, pr = 7): FleetPrRow => ({ pr, headRef })

const beads = (...rows: ReconcileBead[]): Map<string, ReconcileBead> => {
  const m = new Map<string, ReconcileBead>()
  for (const b of rows) {
    m.set(loopSlug(b.id), b)
  }
  return m
}

describe('isFleetHead / deterministicHeadSlug', () => {
  test('fleet namespaces count, foreign heads do not', () => {
    for (const h of ['work/x', 'loop/bro-a', 'stack/s/1-bro-a', 'fix/bro-b-typo']) {
      assert.equal(isFleetHead(h), true, h)
    }
    for (const h of ['main', 'feature/x', 'fix/unrelated']) {
      assert.equal(isFleetHead(h), false, h)
    }
  })

  test('loop and stack heads name their bead slug; work/fix do not', () => {
    assert.equal(deterministicHeadSlug('loop/bro-a1'), 'bro-a1')
    assert.equal(deterministicHeadSlug('stack/feat/2-bro-a1'), 'bro-a1')
    assert.equal(deterministicHeadSlug('work/bro-a1'), undefined)
    assert.equal(deterministicHeadSlug('fix/bro-a1-desc'), undefined)
  })
})

describe('ceilingHeld', () => {
  test('at-or-over holds; 0 disables; under admits', () => {
    assert.equal(ceilingHeld(10, 10), true)
    assert.equal(ceilingHeld(9, 10), false)
    assert.equal(ceilingHeld(99, 0), false)
  })
})

describe('beadForHead', () => {
  test('deterministic head resolves its own slug verbatim', () => {
    const m = beads({ id: 'bro-a1', status: 'open' })
    assert.equal(beadForHead(row('loop/bro-a1'), m)?.id, 'bro-a1')
  })

  test('deterministic head with no bead row stays unresolvable — never falls to prefix', () => {
    const m = beads({ id: 'bro-a1-long', status: 'open' })
    assert.equal(beadForHead(row('loop/bro-a1'), m), undefined)
  })

  test('single prefix match on a work head resolves', () => {
    const m = beads({ id: 'bro-a1', status: 'open' })
    assert.equal(beadForHead(row('work/bro-a1-desc'), m)?.id, 'bro-a1')
  })

  test('two different beads prefixing the tail answer no bead — ambiguous ownership keeps', () => {
    // live owner bro-a1 + closed sibling bro-a1-retry: the longest
    // prefix pick would name the closed bead and bury the live work
    const m = beads(
      { id: 'bro-a1', status: 'open' },
      { id: 'bro-a1-retry', status: 'closed' }
    )
    assert.equal(beadForHead(row('work/bro-a1-retry'), m), undefined)
  })

  test('one bead still resolves when the tail is ambiguous text', () => {
    const m = beads({ id: 'bro-a1', status: 'open' })
    assert.equal(beadForHead(row('work/bro-a1-retry-notes'), m)?.id, 'bro-a1')
  })
})

describe('orphanVerdict', () => {
  test('closed bead buries', () => {
    const v = orphanVerdict(row('loop/bro-a1'), { id: 'bro-a1', status: 'closed' })
    assert.equal(v.kind, 'close')
  })

  test('deterministic head with no bead buries as obsolete', () => {
    const v = orphanVerdict(row('loop/bro-a1'), undefined)
    assert.equal(v.kind, 'close')
  })

  test('non-deterministic head with no bead keeps', () => {
    const v = orphanVerdict(row('work/garden'), undefined)
    assert.equal(v.kind, 'keep')
  })

  test('open and in_progress beads keep', () => {
    for (const status of ['open', 'in_progress']) {
      assert.equal(orphanVerdict(row('loop/bro-a1'), { id: 'bro-a1', status }).kind, 'keep', status)
    }
  })

  test('deferred keeps — a parked member wakes back to its PR (bro-hl22w)', () => {
    const v = orphanVerdict(row('loop/bro-a1'), { id: 'bro-a1', status: 'deferred' })
    assert.equal(v.kind, 'keep')
  })

  test('a non-live status buries — only open/in_progress/deferred keep', () => {
    const v = orphanVerdict(row('loop/bro-a1'), { id: 'bro-a1', status: 'blocked' })
    assert.equal(v.kind, 'close')
  })

  test('an absent status keeps — an unreadable bead is never a burial order', () => {
    const v = orphanVerdict(row('loop/bro-a1'), { id: 'bro-a1' })
    assert.equal(v.kind, 'keep')
  })

  test('closed lead but a live member keeps the batch PR', () => {
    const v = orphanVerdict(
      row('loop/bro-a1'),
      { id: 'bro-a1', status: 'closed' },
      [
        { id: 'bro-a1', status: 'closed' },
        { id: 'bro-b2', status: 'deferred' },
      ]
    )
    assert.equal(v.kind, 'keep')
  })

  test('a member the listing could not find is dead — same rule as a missing deterministic bead', () => {
    const v = orphanVerdict(row('loop/bro-a1'), { id: 'bro-a1', status: 'closed' }, [
      { id: 'bro-a1', status: 'closed' },
      { id: 'bro-b2', status: 'unknown' },
    ])
    assert.equal(v.kind, 'close')
  })

  test('all members closed buries the batch PR', () => {
    const v = orphanVerdict(
      row('loop/bro-a1'),
      { id: 'bro-a1', status: 'closed' },
      [
        { id: 'bro-a1', status: 'closed' },
        { id: 'bro-b2', status: 'closed' },
      ]
    )
    assert.equal(v.kind, 'close')
  })
})

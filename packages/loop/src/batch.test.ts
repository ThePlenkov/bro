import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  affinityKeys,
  batchable,
  clumpMembers,
  coveredBeadIds,
  leadKey,
  type BatchableBead,
} from './batch.ts'

const bead = (over: Partial<BatchableBead>): BatchableBead => ({
  id: 'bro-x1',
  title: 'do the thing',
  priority: 3,
  issue_type: 'task',
  ...over,
})

describe('affinityKeys', () => {
  test('spec ref in the description binds first — the tightest key', () => {
    const b = bead({ description: 'see spec: specs/sessions/bro-x9.md', parent: 'bro-e1' })
    assert.equal(affinityKeys(b)[0], 'spec:sessions/bro-x9')
    assert.equal(leadKey(b), 'spec:sessions/bro-x9')
  })

  test('spec ref normalizes — specs/ prefix and .md suffix stripped', () => {
    assert.equal(leadKey(bead({ title: 'x', description: 'spec: bro-x9' })), 'spec:bro-x9')
    assert.equal(
      leadKey(bead({ title: 'x', description: 'spec: ./specs/bro-x9.md' })),
      'spec:bro-x9'
    )
  })

  test('epic family — a claimable bead with a parent keys on it', () => {
    assert.equal(leadKey(bead({ parent: 'bro-e1' })), 'epic:bro-e1')
  })

  test('area labels key after epic, before path', () => {
    const b = bead({ labels: ['debt', 'area:cli'], title: 'packages/cli: lint drift' })
    assert.equal(leadKey(b), 'area:cli')
    assert.deepEqual(affinityKeys(b), ['area:cli', 'path:packages/cli'])
  })

  test('path prefix — only a path-looking token before the colon counts', () => {
    assert.equal(leadKey(bead({ title: 'work.ts: handle nil' })), 'path:work.ts')
    assert.equal(leadKey(bead({ title: 'specs/x: stale doc' })), 'path:specs/x')
    // prose titles are not paths — 'loop:' is a word, not a place
    assert.equal(leadKey(bead({ title: 'loop: batch claims' })), undefined)
  })

  test('a bead with no signal has no key — it can only ever solo', () => {
    assert.deepEqual(affinityKeys(bead({ title: 'misc chore' })), [])
  })
})

describe('batchable', () => {
  test('the priority floor keeps urgent work solo', () => {
    assert.equal(batchable(bead({ priority: 3 }), 3), true)
    assert.equal(batchable(bead({ priority: 4 }), 3), true)
    assert.equal(batchable(bead({ priority: 2 }), 3), false)
    assert.equal(batchable(bead({ priority: 1 }), 3), false)
  })

  test('the solo label is the per-bead opt-out', () => {
    assert.equal(batchable(bead({ labels: ['solo'] }), 3), false)
  })
})

describe('clumpMembers', () => {
  const opts = { size: 4, minPriority: 3 }

  test('members carry the lead’s key — same-area debt clumps', () => {
    const lead = bead({ id: 'd1', labels: ['area:cli'] })
    const candidates = [
      bead({ id: 'd2', labels: ['area:cli'] }),
      bead({ id: 'd3', labels: ['area:ui'] }),
      bead({ id: 'd4', labels: ['area:cli'] }),
    ]
    assert.deepEqual(
      clumpMembers(lead, candidates, opts).map((b) => b.id),
      ['d2', 'd4']
    )
  })

  test('binds on the lead’s highest-precedence key only — no transitive growth', () => {
    // lead keys on the spec; a same-area bead without the spec stays out
    const lead = bead({ id: 's1', description: 'spec: bro-feat', labels: ['area:cli'] })
    const candidates = [
      bead({ id: 's2', description: 'spec: specs/bro-feat.md', labels: ['area:ui'] }),
      bead({ id: 's3', labels: ['area:cli'] }), // same area, wrong key
    ]
    assert.deepEqual(
      clumpMembers(lead, candidates, opts).map((b) => b.id),
      ['s2']
    )
  })

  test('a keyless or below-floor lead clumps with nobody', () => {
    const candidates = [bead({ id: 'd2', labels: ['area:cli'] })]
    assert.deepEqual(clumpMembers(bead({ id: 'l1' }), candidates, opts), [])
    assert.deepEqual(
      clumpMembers(bead({ id: 'l2', priority: 1, labels: ['area:cli'] }), candidates, opts),
      []
    )
  })

  test('members below the floor or solo-labelled never join', () => {
    const lead = bead({ id: 'd1', labels: ['area:cli'] })
    const candidates = [
      bead({ id: 'p1', priority: 1, labels: ['area:cli'] }),
      bead({ id: 's1', labels: ['area:cli', 'solo'] }),
      bead({ id: 'ok', labels: ['area:cli'] }),
    ]
    assert.deepEqual(
      clumpMembers(lead, candidates, opts).map((b) => b.id),
      ['ok']
    )
  })

  test('the cap counts the lead — size 3 admits at most 2 members', () => {
    const lead = bead({ id: 'd1', labels: ['area:cli'] })
    const candidates = ['d2', 'd3', 'd4', 'd5'].map((id) =>
      bead({ id, labels: ['area:cli'] })
    )
    assert.deepEqual(
      clumpMembers(lead, candidates, { size: 3, minPriority: 3 }).map((b) => b.id),
      ['d2', 'd3']
    )
    assert.deepEqual(clumpMembers(lead, candidates, { size: 1, minPriority: 3 }), [])
  })
})

describe('coveredBeadIds', () => {
  test('ids named in the commit log are covered', () => {
    const log = 'fix(cli): lint drift (bro-x2)\n\ndocs: typo (bro-x3)\n'
    assert.deepEqual(coveredBeadIds(log, ['bro-x2', 'bro-x3', 'bro-x4']), new Set(['bro-x2', 'bro-x3']))
  })

  test('a child id does not cover its parent — boundary excludes the dot', () => {
    const log = 'fix: epic child work (bro-x1.2)\n'
    assert.deepEqual(coveredBeadIds(log, ['bro-x1', 'bro-x1.2']), new Set(['bro-x1.2']))
  })

  test('unreadable log covers nothing — the fail-safe direction', () => {
    assert.deepEqual(coveredBeadIds('', ['bro-x1']), new Set())
  })
})

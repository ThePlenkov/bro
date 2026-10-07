import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  beadUri,
  envelopeFromBead,
  envelopeLabels,
  MESH_VERSION_LABEL,
  toEnvelope,
  validateEnvelope,
} from './envelope.ts'

const VALID = {
  v: 'mesh/1',
  id: 'req-bro-x1',
  kind: 'request',
  thread: 'req-bro-x1',
  from: 'mesh://sverka-dev/sverka',
  to: 'mesh://ThePlenkov/bro',
  title: 'fix the flake',
  body: 'please',
  refs: [{ kind: 'bead', ref: 'sv-yvkl' }],
  terms: { priority: 'p2' },
  evidence: [],
}

describe('validateEnvelope', () => {
  test('the spec-shaped envelope validates', () => {
    assert.deepEqual(validateEnvelope(VALID), [])
    assert.equal(toEnvelope(VALID)?.id, 'req-bro-x1')
  })

  test('rejects wrong version, kinds, non-rig addresses, missing title', () => {
    assert.ok(validateEnvelope({ ...VALID, v: 'mesh/2' }).length > 0)
    assert.ok(validateEnvelope({ ...VALID, kind: 'spam' }).length > 0)
    assert.ok(validateEnvelope({ ...VALID, to: 'not-a-rig' }).length > 0)
    assert.ok(validateEnvelope({ ...VALID, title: '' }).length > 0)
    assert.ok(validateEnvelope('string').length > 0)
  })
})

describe('bead mapping', () => {
  const bead = {
    id: 'bro-x1',
    title: 'fix the flake',
    description: 'please',
    priority: 2,
    labels: [
      MESH_VERSION_LABEL,
      'mesh:kind:request',
      'mesh:thread:req-bro-x1',
      'mesh:from:mesh://sverka-dev/sverka',
      'mesh:to:mesh://ThePlenkov/bro',
      'mesh:ref:bead:sv-yvkl',
    ],
  }

  test('envelopeLabels produces the full label set', () => {
    const env = toEnvelope(VALID)!
    assert.deepEqual(envelopeLabels(env), bead.labels)
  })

  test('envelopeFromBead reconstructs the envelope', () => {
    const env = envelopeFromBead(bead)
    assert.equal(env?.kind, 'request')
    assert.equal(env?.thread, 'req-bro-x1')
    assert.equal(env?.to, 'mesh://ThePlenkov/bro')
    assert.equal(env?.terms.priority, 'p2')
    assert.deepEqual(env?.refs, [{ kind: 'bead', ref: 'sv-yvkl' }])
  })

  test('evidence round-trips on mesh:ev labels', () => {
    const env = envelopeFromBead({
      ...bead,
      labels: [...bead.labels, 'mesh:ev:pr:https://github.com/x/y/pull/1'],
    })
    assert.deepEqual(env?.evidence, [
      { kind: 'pr', ref: 'https://github.com/x/y/pull/1' },
    ])
  })

  test('non-mesh beads and malformed label sets are not envelopes', () => {
    assert.equal(envelopeFromBead({ id: 'x', title: 't', labels: ['mesh'] }), null)
    assert.equal(
      envelopeFromBead({ ...bead, labels: bead.labels.filter((l) => !l.startsWith('mesh:to:')) }),
      null,
    )
    assert.equal(
      envelopeFromBead({
        ...bead,
        labels: bead.labels.map((l) => (l.startsWith('mesh:to:') ? 'mesh:to:bad' : l)),
      }),
      null,
    )
  })
})

describe('beadUri', () => {
  test('mesh://org/repo + bead id → the upstream beads uri', () => {
    assert.equal(beadUri('mesh://ThePlenkov/bro', 'bro-x1'), 'beads://ThePlenkov/bro/bro-x1')
    assert.throws(() => beadUri('nope', 'x'), /invalid rig uri/)
  })
})

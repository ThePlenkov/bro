/** dep-plane wait — the pure halves: external: ref parsing (last-colon
 *  split, rig validation) and rig→plane resolution (local checkout vs
 *  replica, posting-store split). The store reads are covered by the
 *  CLI e2e (fake-bd two-checkouts fixture). */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parseExternalRef, resolveWaitPlane } from './wait.ts'
import type { MeshPeer } from './peers.ts'

describe('parseExternalRef', () => {
  test('splits on the LAST colon — the rig uri carries its own', () => {
    assert.deepEqual(parseExternalRef('external:mesh://acme/sverka:fx-123'), {
      rig: 'mesh://acme/sverka',
      id: 'fx-123',
    })
  })

  test('canonicalizes the rig half', () => {
    assert.deepEqual(parseExternalRef('external:mesh://ACME/Sverka:fx-1'), {
      rig: 'mesh://acme/sverka',
      id: 'fx-1',
    })
  })

  test('rejects everything that is not external:<rig>:<id>', () => {
    for (const bad of [
      'fx-123',
      'external:',
      'external:fx-123',
      'external:mesh://acme/sverka:',
      'external:mesh://acme:fx-1',
      'external:notauri:fx-1',
      'external::fx-1',
      'beads://acme/sverka/fx-1',
      'external:mesh://acme/sverka',
      '',
    ]) {
      assert.equal(parseExternalRef(bad), null, bad)
    }
  })
})

describe('resolveWaitPlane', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'bro-mesh-wait-'))

  test('unbound rig → undefined (the caller exits 2, never polls)', () => {
    const dir = root()
    try {
      assert.equal(resolveWaitPlane(dir, [], 'mesh://acme/far', join(dir, '.git')), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('local binding → posting store and peer plane are the checkout', () => {
    const dir = root()
    try {
      const checkout = join(dir, 'peer')
      mkdirSync(join(checkout, '.beads'), { recursive: true })
      const peer: MeshPeer = {
        alias: 'near',
        rig: 'mesh://acme/near',
        remote: checkout,
        transport: 'local',
      }
      const plane = resolveWaitPlane(dir, [peer], 'mesh://acme/near', join(dir, '.git'))
      assert.ok(plane)
      assert.equal(plane.postDir, checkout)
      assert.equal(plane.postForeign, true)
      assert.equal(plane.peerDir, checkout)
      assert.equal(plane.replica, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('beads-remote binding → the posting-store split: own dir vs replica', () => {
    const dir = root()
    try {
      const common = join(dir, '.git')
      const peer: MeshPeer = {
        alias: 'far',
        rig: 'mesh://acme/far',
        remote: 'https://github.com/acme/far.git',
        transport: 'beads-remote',
      }
      const plane = resolveWaitPlane(dir, [peer], 'mesh://acme/far', common)
      assert.ok(plane)
      // the request bead lives on the requester's own store — the
      // replica never carries it (the peer pulls the post)
      assert.equal(plane.postDir, dir)
      assert.equal(plane.postForeign, false)
      // the ship predicate reads the peer plane — the replica dir
      assert.equal(plane.peerDir, join(common, 'bro', 'mesh', 'peers', 'far'))
      assert.equal(plane.replica, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('file:// remotes unwrap to the checkout path', () => {
    const dir = root()
    try {
      const checkout = join(dir, 'peer')
      mkdirSync(join(checkout, '.beads'), { recursive: true })
      const peer: MeshPeer = {
        alias: 'near',
        rig: 'mesh://acme/near',
        remote: `file://${checkout}`,
        transport: 'local',
      }
      const plane = resolveWaitPlane(dir, [peer], 'mesh://acme/near', join(dir, '.git'))
      assert.equal(plane?.postDir, checkout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

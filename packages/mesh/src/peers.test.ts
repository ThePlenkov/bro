/** peers — transport derivation + config-entry parsing. `local` needs a
 *  live checkout (a path containing `.beads`); any other remote is a
 *  `beads-remote` replica source. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parsePeer, transportOf } from './peers.ts'

describe('transportOf', () => {
  test('a live checkout on the filesystem is local; anything else is beads-remote', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-mesh-peers-'))
    try {
      const checkout = join(root, 'checkout')
      mkdirSync(join(checkout, '.beads'), { recursive: true })
      const bare = join(root, 'remote.git')
      mkdirSync(bare)

      assert.equal(transportOf(checkout), 'local')
      assert.equal(transportOf(`file://${checkout}`), 'local')
      assert.equal(transportOf(bare), 'beads-remote')
      assert.equal(transportOf('https://github.com/acme/rig.git'), 'beads-remote')
      assert.equal(transportOf('git@github.com:acme/rig.git'), 'beads-remote')
      assert.equal(transportOf(join(root, 'missing')), 'beads-remote')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an explicit transport overrides the derivation; a bogus one is rejected', () => {
    assert.equal(transportOf('/anywhere', 'local'), 'local')
    assert.equal(transportOf('/anywhere', 'beads-remote'), 'beads-remote')
    assert.equal(transportOf('/anywhere', 'wasteland'), null)
    assert.equal(transportOf('/anywhere', ''), null)
  })
})

describe('parsePeer', () => {
  test('accepts {rig, remote} and canonicalizes the rig', () => {
    const p = parsePeer('sverka', {
      rig: 'mesh://Sverka-Dev/SVERKA',
      remote: 'https://github.com/sverka-dev/sverka.git',
    })
    assert.ok(p)
    assert.equal(p.alias, 'sverka')
    assert.equal(p.rig, 'mesh://sverka-dev/sverka')
    assert.equal(p.transport, 'beads-remote')
  })

  test('rejects malformed entries instead of guessing', () => {
    for (const raw of [
      null,
      'x',
      {},
      { rig: 'not-a-uri', remote: '/tmp/x' },
      { rig: 'mesh://a/b' },
      { remote: '/tmp/x' },
      { rig: 'mesh://a/b', remote: 7 },
      { rig: 'mesh://a/b', remote: '/tmp/x', transport: 'pigeon' },
    ]) {
      assert.equal(parsePeer('p', raw), null, JSON.stringify(raw))
    }
  })
})

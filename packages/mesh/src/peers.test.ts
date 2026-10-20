/** peers — transport derivation + config-entry parsing. `local` needs a
 *  live checkout (a path containing `.beads`); a github.com remote is
 *  the `github` issue plane, `wl://`/`wasteland://` the board; any
 *  other remote is a `beads-remote` replica source. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parsePeer, transportOf } from './peers.ts'

describe('transportOf', () => {
  test('a live checkout on the filesystem is local; non-repo paths stay beads-remote', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-mesh-peers-'))
    try {
      const checkout = join(root, 'checkout')
      mkdirSync(join(checkout, '.beads'), { recursive: true })
      const bare = join(root, 'remote.git')
      mkdirSync(bare)

      assert.equal(transportOf(checkout), 'local')
      assert.equal(transportOf(`file://${checkout}`), 'local')
      assert.equal(transportOf(bare), 'beads-remote')
      assert.equal(transportOf(join(root, 'missing')), 'beads-remote')
      assert.equal(transportOf('https://gitlab.com/acme/rig.git'), 'beads-remote')
      assert.equal(transportOf('git@gitlab.com:acme/rig.git'), 'beads-remote')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a github.com remote is the issue plane; wl:// the board', () => {
    for (const remote of [
      'https://github.com/acme/rig.git',
      'https://github.com/acme/rig',
      'git@github.com:acme/rig.git',
      'ssh://git@github.com/acme/rig.git',
    ]) {
      assert.equal(transportOf(remote), 'github', remote)
    }
    assert.equal(transportOf('wl://gastownhall/wasteland'), 'wasteland')
    assert.equal(transportOf('wasteland://gastownhall/wasteland'), 'wasteland')
  })

  test('an explicit transport overrides the derivation; a bogus one is rejected', () => {
    // a github-hosted remote that IS a dolt replica source pins back
    assert.equal(transportOf('https://github.com/acme/rig.git', 'beads-remote'), 'beads-remote')
    assert.equal(transportOf('/anywhere', 'local'), 'local')
    assert.equal(transportOf('/anywhere', 'wasteland'), 'wasteland')
    assert.equal(transportOf('/anywhere', 'pigeon'), null)
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
    assert.equal(p.transport, 'github')
    assert.equal(p.login, undefined)
  })

  test('a github binding preserves `login`; a non-string/empty one drops', () => {
    const p = parsePeer('gh', {
      rig: 'mesh://acme/far',
      remote: 'https://github.com/acme/far',
      login: 'Acme-Bot',
    })
    assert.equal(p?.login, 'Acme-Bot')
    for (const login of [7, '', {}]) {
      const q = parsePeer('gh', {
        rig: 'mesh://acme/far',
        remote: 'https://github.com/acme/far',
        login,
      })
      assert.equal(q?.login, undefined, JSON.stringify(login))
    }
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

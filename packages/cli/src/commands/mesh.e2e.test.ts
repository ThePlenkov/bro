/** `bro mesh` e2e — identity resolution + peers CRUD against the built
 *  CLI. `me` derives mesh://<org>/<repo> from origin; peers writes
 *  round-trip bro.config.json and reject malformed rigs. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside, runCli } from './testrepo.ts'

describe('bro mesh', () => {
  test('me derives the rig uri from origin; peers add|list|remove round-trips', () => {
    const { root, main } = initRepo('bro-mesh-e2e-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: m })
    })
    inside(main, root, () => {
      const me = runCli(['mesh', 'me'], { cwd: main })
      assert.equal(me.code, 0, me.stderr)
      assert.match(me.stdout, /mesh:\/\/acme\/widgets/)

      assert.equal(runCli(['mesh', 'peers', 'list'], { cwd: main }).stdout.includes('no peers'), true)

      const add = runCli(
        ['mesh', 'peers', 'add', 'sverka', 'mesh://sverka-dev/sverka', 'https://github.com/sverka-dev/sverka.git'],
        { cwd: main },
      )
      assert.equal(add.code, 0, add.stderr)

      const listed = runCli(['mesh', 'peers', 'list'], { cwd: main })
      assert.match(listed.stdout, /sverka\tmesh:\/\/sverka-dev\/sverka\thttps:\/\/github\.com\/sverka-dev\/sverka\.git/)

      // the write lands in bro.config.json under mesh.peers
      const cfg = JSON.parse(readFileSync(join(main, 'bro.config.json'), 'utf8')) as {
        mesh: { peers: Record<string, { rig: string; remote: string }> }
      }
      assert.equal(cfg.mesh.peers.sverka?.rig, 'mesh://sverka-dev/sverka')

      const dup = runCli(
        ['mesh', 'peers', 'add', 'sverka', 'mesh://sverka-dev/sverka', 'x'],
        { cwd: main },
      )
      assert.equal(dup.code, 2)
      assert.match(dup.stderr, /already bound/)

      const bad = runCli(['mesh', 'peers', 'add', 'x', 'not-a-rig', 'y'], { cwd: main })
      assert.equal(bad.code, 2)
      assert.match(bad.stderr, /not a mesh:\/\/<org>\/<repo> uri/)

      assert.equal(runCli(['mesh', 'peers', 'remove', 'sverka'], { cwd: main }).code, 0)
      assert.equal(runCli(['mesh', 'peers', 'remove', 'sverka'], { cwd: main }).code, 2)
    })
  })

  test('me exits 2 when the rig cannot be derived', () => {
    const { root, main } = initRepo('bro-mesh-e2e-norg-')
    inside(main, root, () => {
      const res = runCli(['mesh', 'me'], { cwd: main })
      assert.equal(res.code, 2)
      assert.match(res.stderr, /unaddressed/)
    })
  })

  test('mesh.rig config pin wins over origin', () => {
    const { root, main } = initRepo('bro-mesh-e2e-pin-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: m })
    })
    inside(main, root, () => {
      writeFileSync(
        join(main, 'bro.config.json'),
        JSON.stringify({ mesh: { rig: 'mesh://pinned/rig', peers: {} } }),
      )
      const me = runCli(['mesh', 'me'], { cwd: main })
      assert.equal(me.code, 0, me.stderr)
      // the pin must override the derived acme/widgets identity
      assert.match(me.stdout, /mesh:\/\/pinned\/rig/)
      assert.doesNotMatch(me.stdout, /acme\/widgets/)
    })
  })
})

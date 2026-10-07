/** `bro mesh` e2e — identity resolution + peers CRUD against the built
 *  CLI. `me` derives mesh://<org>/<repo> from origin; peers writes
 *  round-trip bro.config.json and reject malformed rigs. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initRepo,
  inside,
  installFakeBd,
  installFakeDolt,
  installFakeDoltRemote,
  runCli,
} from './testrepo.ts'

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

  test('pull + inbox — beads-remote replica surfaces addressed requests with provenance', () => {
    const { root, main } = initRepo('bro-mesh-e2e-remote-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const binDir = installFakeDolt(root)
      const env = { PATH: `${binDir}:${process.env.PATH}` }
      const request = {
        id: 'rigB-u12',
        title: 'port the gate',
        status: 'open',
        priority: 1,
        labels: [
          'mesh:v:1',
          'mesh:kind:request',
          'mesh:thread:rigB-u12',
          'mesh:from:mesh://acme/RigB',
          'mesh:to:mesh://ThePlenkov/bro',
          'mesh:ref:bead:rigB-9x',
        ],
      }
      const noise = [
        // addressed to somebody else — must not surface
        { ...request, id: 'rigB-oth', labels: request.labels.map((l) => l.replace('ThePlenkov/bro', 'other/rig')) },
        // not a mesh record at all
        { id: 'rigB-zz', title: 'plain issue', status: 'open', labels: ['bug'] },
        // closed — stale request, skip
        { ...request, id: 'rigB-old', status: 'closed' },
      ]
      const { remoteDir, publish } = installFakeDoltRemote(root, [request, ...noise])

      const add = runCli(['mesh', 'peers', 'add', 'rigB', 'mesh://acme/rigB', remoteDir], { cwd: main, env })
      assert.equal(add.code, 0, add.stderr)

      const pull = runCli(['mesh', 'pull'], { cwd: main, env })
      assert.equal(pull.code, 0, pull.stderr)
      assert.match(pull.stdout, /pulled 1\/1/)

      const inbox = runCli(['mesh', 'inbox'], { cwd: main, env })
      assert.equal(inbox.code, 0, inbox.stderr)
      assert.match(inbox.stdout, /rigB\trigB-u12\tport the gate/)
      assert.doesNotMatch(inbox.stdout, /rigB-oth|rigB-zz|rigB-old/)

      // refresh: a newly published request appears only after a pull
      publish([request, ...noise, { ...request, id: 'rigB-new', title: 'fresh ask' }])
      const stale = runCli(['mesh', 'inbox', '--no-pull'], { cwd: main, env })
      assert.doesNotMatch(stale.stdout, /rigB-new/)
      const fresh = runCli(['mesh', 'inbox'], { cwd: main, env })
      assert.match(fresh.stdout, /rigB-new\tfresh ask/)

      const json = runCli(['mesh', 'inbox', '--json', '--no-pull'], { cwd: main, env })
      const rows = JSON.parse(json.stdout) as Array<{ peer: string; bead: string; thread: string; mismatch?: boolean }>
      const hit = rows.find((r) => r.bead === 'rigB-u12')
      assert.equal(hit?.peer, 'rigB')
      assert.equal(hit?.thread, 'rigB-u12')
      // config pinned 'acme/rigB'; the envelope says 'acme/RigB' — both
      // canonicalize, so provenance holds and mismatch stays false
      assert.equal(hit?.mismatch, undefined)
    })
  })

  test('inbox — a local peer is read through its live store', () => {
    const { root, main } = initRepo('bro-mesh-e2e-local-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const peerDir = join(root, 'peer')
      mkdirSync(join(peerDir, '.beads'), { recursive: true })
      const { binDir, db } = installFakeBd(join(root, 'peertools'), [
        {
          id: 'peer-1',
          title: 'local ask',
          status: 'open',
          labels: [
            'mesh:v:1',
            'mesh:kind:request',
            'mesh:thread:peer-1',
            'mesh:from:mesh://acme/peer',
            'mesh:to:mesh://theplenkov/bro',
          ],
        },
      ])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: db }

      const add = runCli(['mesh', 'peers', 'add', 'p', 'mesh://acme/peer', peerDir], { cwd: main, env })
      assert.equal(add.code, 0, add.stderr)

      const inbox = runCli(['mesh', 'inbox'], { cwd: main, env })
      assert.equal(inbox.code, 0, inbox.stderr)
      assert.match(inbox.stdout, /p\tpeer-1\tlocal ask/)
    })
  })

  test('inbox — an unreachable peer reports an error, not a silent empty', () => {
    const { root, main } = initRepo('bro-mesh-e2e-dead-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const binDir = installFakeDolt(root)
      const env = { PATH: `${binDir}:${process.env.PATH}` }
      const dead = join(root, 'no-such-remote')
      const add = runCli(['mesh', 'peers', 'add', 'ghost', 'mesh://acme/ghost', dead], { cwd: main, env })
      assert.equal(add.code, 0, add.stderr)
      const inbox = runCli(['mesh', 'inbox'], { cwd: main, env })
      assert.equal(inbox.code, 0)
      assert.match(inbox.stderr, /ghost.*failed|failed.*ghost/i)
    })
  })
})

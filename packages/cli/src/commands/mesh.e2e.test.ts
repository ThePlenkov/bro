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
  readBeads,
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
      const selfThread = (row: Record<string, unknown>) => ({
        ...row,
        labels: (row.labels as string[]).map((l) =>
          l.startsWith('mesh:thread:') ? `mesh:thread:${row.id}` : l,
        ),
      })
      const noise = [
        // addressed to somebody else — must not surface
        selfThread({ ...request, id: 'rigB-oth', labels: request.labels.map((l) => l.replace('ThePlenkov/bro', 'other/rig')) }),
        // not a mesh record at all
        { id: 'rigB-zz', title: 'plain issue', status: 'open', labels: ['bug'] },
        // closed — stale request, skip
        selfThread({ ...request, id: 'rigB-old', status: 'closed' }),
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
      publish([request, ...noise, selfThread({ ...request, id: 'rigB-new', title: 'fresh ask' })])
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

  test('inbox — verdicted threads (accepted/rejected) no longer list their request', () => {
    const { root, main } = initRepo('bro-mesh-e2e-term-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const binDir = installFakeDolt(root)
      const env = { PATH: `${binDir}:${process.env.PATH}` }
      const me = 'mesh://theplenkov/bro'
      const rigB = 'mesh://acme/rigb'
      const env1 = (id: string, kind: string, thread: string, claimedFrom = rigB) => ({
        id,
        title: `${kind} ${id}`,
        status: 'open',
        priority: 1,
        labels: [
          'mesh:v:1',
          `mesh:kind:${kind}`,
          `mesh:thread:${thread}`,
          `mesh:from:${claimedFrom}`,
          `mesh:to:${me}`,
        ],
      })
      const { remoteDir } = installFakeDoltRemote(root, [
        // accepted — terminal, must not surface
        env1('rigB-acc', 'request', 'rigB-acc'),
        env1('rigB-v1', 'accept', 'rigB-acc'),
        // rejected — terminal, must not surface
        env1('rigB-rej', 'request', 'rigB-rej'),
        env1('rigB-v2', 'reject', 'rigB-rej'),
        // a verdict whose from doesn't match the peer binding is
        // impersonation — it cannot close the thread
        env1('rigB-frg', 'request', 'rigB-frg'),
        env1('rigB-v3', 'accept', 'rigB-frg', 'mesh://mallory/forge'),
        // still pending — no verdict yet
        env1('rigB-pen', 'request', 'rigB-pen'),
      ])

      // a second peer whose request reuses rigB's verdicted thread id —
      // thread ids are per-store, so rigB's verdict must not close it
      const rigC = 'mesh://acme/rigc'
      mkdirSync(join(root, 'peerC'), { recursive: true })
      const { remoteDir: remoteC } = installFakeDoltRemote(join(root, 'peerC'), [
        env1('rigB-acc', 'request', 'rigB-acc', rigC),
      ])

      const add = runCli(['mesh', 'peers', 'add', 'rigB', rigB, remoteDir], { cwd: main, env })
      assert.equal(add.code, 0, add.stderr)
      const addC = runCli(['mesh', 'peers', 'add', 'rigC', rigC, remoteC], { cwd: main, env })
      assert.equal(addC.code, 0, addC.stderr)

      const inbox = runCli(['mesh', 'inbox'], { cwd: main, env })
      assert.equal(inbox.code, 0, inbox.stderr)
      assert.match(inbox.stdout, /rigB\trigB-pen\trequest rigB-pen/)
      assert.match(inbox.stdout, /rigB-frg/)
      // rigB's verdicted threads are gone; rigC's same-id request survives
      assert.match(inbox.stdout, /rigC\trigB-acc/)
      assert.doesNotMatch(inbox.stdout, /rigB\trigB-acc|rigB\trigB-rej|rigB-v\d/)

      const json = runCli(['mesh', 'inbox', '--json', '--no-pull'], { cwd: main, env })
      const keys = (JSON.parse(json.stdout) as Array<{ peer: string; bead: string }>)
        .map((r) => `${r.peer}:${r.bead}`)
        .sort()
      assert.deepEqual(keys, ['rigB:rigB-frg', 'rigB:rigB-pen', 'rigC:rigB-acc'])
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

  test('peers add refuses to clobber a malformed config or a ts-shadowed one', () => {
    const { root, main } = initRepo('bro-mesh-e2e-cfg-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: m })
      writeFileSync(join(m, 'bro.config.json'), '{ not json')
    })
    inside(main, root, () => {
      const bad = runCli(['mesh', 'peers', 'add', 'x', 'mesh://a/b', '/tmp/r'], { cwd: main })
      assert.equal(bad.code, 2)
      // the malformed file was NOT overwritten
      assert.equal(readFileSync(join(main, 'bro.config.json'), 'utf8'), '{ not json')
    })
  })

  test('request → claim → done → accept lifecycle on the local store', () => {
    const { root, main } = initRepo('bro-mesh-e2e-life-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const { binDir, db } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: db }

      // the request is self-addressed so this one store can play both
      // sides of the lifecycle
      const req = runCli(
        ['mesh', 'request', 'mesh://theplenkov/bro', 'port the gate', '--body', 'needs it', '--priority', '1', '--ref', 'bead:bro-abc'],
        { cwd: main, env },
      )
      assert.equal(req.code, 0, req.stderr)
      const thread = /request (\S+) →/.exec(req.stdout)?.[1]
      assert.ok(thread, req.stdout)

      // the posted bead carries the full mesh label set
      const posted = readBeads(db).find((r) => r.id === thread) as { labels: string[]; external_ref: string }
      assert.ok(posted.labels.includes('mesh:v:1'))
      assert.ok(posted.labels.includes('mesh:kind:request'))
      assert.ok(posted.labels.includes(`mesh:thread:${thread}`))
      assert.ok(posted.labels.includes('mesh:to:mesh://theplenkov/bro'))
      assert.equal(posted.external_ref, `beads://theplenkov/bro/${thread}`)

      const unknown = runCli(['mesh', 'claim', 'nope-1'], { cwd: main, env })
      assert.equal(unknown.code, 2)
      assert.match(unknown.stderr, /no request for thread/)

      // a request addressed to another rig can't be claimed here
      const foreign = runCli(
        ['mesh', 'request', 'mesh://acme/rigB', 'not for us'],
        { cwd: main, env },
      )
      const foreignThread = /request (\S+) →/.exec(foreign.stdout)?.[1]
      const wrong = runCli(['mesh', 'claim', foreignThread!], { cwd: main, env })
      assert.equal(wrong.code, 2)
      assert.match(wrong.stderr, /addressed to .* not this rig/)

      // sequencing: done before claim and verdicts before a result are refused
      const early = runCli(['mesh', 'done', thread], { cwd: main, env })
      assert.equal(early.code, 2)
      assert.match(early.stderr, /stage "posted"/)
      const premature = runCli(['mesh', 'accept', thread], { cwd: main, env })
      assert.equal(premature.code, 2)
      assert.match(premature.stderr, /no result submitted/)

      assert.equal(runCli(['mesh', 'claim', thread], { cwd: main, env }).code, 0)
      const done = runCli(['mesh', 'done', thread, '--ev', 'pr:https://github.com/x/y/pull/9'], { cwd: main, env })
      assert.equal(done.code, 0, done.stderr)

      const wait1 = runCli(['mesh', 'wait', thread], { cwd: main, env })
      assert.match(wait1.stdout, /submitted — requester's move/)

      // reject before accept is allowed; after a verdict the thread is terminal
      assert.equal(runCli(['mesh', 'accept', thread, '--body', 'lgtm'], { cwd: main, env }).code, 0)
      const wait2 = runCli(['mesh', 'wait', thread], { cwd: main, env })
      assert.match(wait2.stdout, /accepted — done/)

      const late = runCli(['mesh', 'reject', thread], { cwd: main, env })
      assert.equal(late.code, 2)
      assert.match(late.stderr, /already accepted/)

      // the verdict records carry evidence + thread labels
      const rows = readBeads(db)
      const result = rows.find((r) => (r.labels as string[] | undefined)?.includes('mesh:kind:result')) as { labels: string[] }
      assert.ok(result.labels.includes(`mesh:thread:${thread}`))
      assert.ok(result.labels.includes('mesh:ev:pr:https://github.com/x/y/pull/9'))
    })
  })

  test('request --for blocks a local bead on external:<rig>:<id>', () => {
    const { root, main } = initRepo('bro-mesh-e2e-dep-', (m) => {
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const { binDir, db } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: db }

      const waiter = JSON.parse(
        execFileSync('bd', ['-C', main, 'create', '--title', 'needs the port', '--json'], { env, encoding: 'utf8' }),
      ) as { id: string }

      const req = runCli(
        ['mesh', 'request', 'mesh://acme/rigB', 'port the gate', '--for', waiter.id],
        { cwd: main, env },
      )
      assert.equal(req.code, 0, req.stderr)
      assert.match(req.stdout, new RegExp(`${waiter.id} now blocked by external:`))

      const dbRows = JSON.parse(readFileSync(db, 'utf8')) as { deps: { from: string; to: string }[] }
      const reqId = /request (\S+) →/.exec(req.stdout)?.[1]
      assert.deepEqual(dbRows.deps, [{ from: waiter.id, to: `external:mesh://acme/rigb:${reqId}` }])
    })
  })
})

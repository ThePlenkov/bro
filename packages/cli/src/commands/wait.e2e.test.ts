/** `bro wait external:<ref>` e2e — the dep-plane watcher
 *  (specs/cross-repo/bro-y5zcw): bounded poll, exit-code verdicts.
 *  Local peer: two real checkouts (the fake bd selects by -C/cwd).
 *  beads-remote peer: the fake dolt clone/pull/sql fixture. */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initRepo,
  inside,
  initTarget,
  installFakeBd,
  installFakeDolt,
  installFakeDoltRemote,
  readBeads,
  runCli,
  writeBeads,
} from './testrepo.ts'
import { scrubEnv, testGit } from '@broject/core'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

const REF = (id: string) => `external:mesh://acme/sibling:${id}`
const FAR = (id: string) => `external:mesh://acme/far:${id}`

/** A mesh/1 envelope row for a fixture store — label-only record, the
 *  shape `postEnvelope` stamps via envelopeLabels. */
function envelope(e: { id: string; kind: string; thread: string; from: string; to: string }) {
  return {
    id: e.id,
    title: `${e.kind} ${e.id}`,
    status: 'open',
    labels: [
      'mesh:v:1',
      `mesh:kind:${e.kind}`,
      `mesh:thread:${e.thread}`,
      `mesh:from:${e.from}`,
      `mesh:to:${e.to}`,
    ],
  }
}

describe('bro wait', () => {
  test('local peer — open times out 4, closed-unshipped is 3, ship frees 0', () => {
    const { root, main } = initRepo('bro-wait-e2e-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const target = initTarget(root, 'sibling')
      const { binDir, db: mainDb } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: mainDb }

      // deliver a request into the sibling's store — installs the
      // peer binding and pins export:<id> for the worker's bd ship
      const req = runCli(['request', 'sibling', 'port the gate'], { cwd: main, env })
      assert.equal(req.code, 0, req.stderr)
      const thread = /request (\S+) →/.exec(req.stdout)?.[1]
      assert.ok(thread, req.stdout)
      const ref = REF(thread)

      // open request, nothing shipped → bounded wait exits 4 and
      // carries the ref back for re-arming
      const pending = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(pending.code, 4, pending.stderr)
      assert.match(pending.stdout, /unsettled.*external:mesh:\/\/acme\/sibling/)
      // progress went to stderr — stage + shipped per poll
      assert.match(pending.stderr, /stage=posted shipped=no/)

      // the far side closed the request bead without shipping it —
      // the dep will never release on its own: actionable, not waiting
      execFileSync('bd', ['-C', target.dir, 'close', thread], {
        env: { ...process.env, ...env },
      })
      const dead = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(dead.code, 3, dead.stderr)
      assert.match(dead.stdout, /closed-unshipped/)

      // the worker ships the capability — the dep's own release rule
      execFileSync('bd', ['-C', target.dir, 'ship', thread], {
        env: { ...process.env, ...env },
      })
      const free = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(free.code, 0, free.stderr)
      assert.match(free.stdout, /wait: free/)

      // --json carries the machine summary
      const j = runCli(['wait', ref, '--every', '0.1', '--timeout', '1', '--json'], {
        cwd: main,
        env,
      })
      assert.equal(j.code, 0, j.stderr)
      const payload = JSON.parse(j.stdout) as {
        verdict: string
        refs: Record<string, { verdict: string; source: string }>
      }
      assert.equal(payload.verdict, 'free')
      assert.equal(payload.refs[ref]?.verdict, 'free')
      assert.equal(payload.refs[ref]?.source, 'live')
    })
  })

  test('reject envelope → actionable 3; accept+reject on one thread stays 3', () => {
    const { root, main } = initRepo('bro-wait-e2e-rej-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const target = initTarget(root, 'sibling')
      const { binDir, db: mainDb } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: mainDb }

      const req = runCli(['request', 'sibling', 'port the gate'], { cwd: main, env })
      assert.equal(req.code, 0, req.stderr)
      const thread = /request (\S+) →/.exec(req.stdout)?.[1]
      assert.ok(thread, req.stdout)
      const ref = REF(thread)
      const me = 'mesh://theplenkov/bro'

      // the requester's own reject on the anchor store — admitted
      // because a local peer's binding attests the STORE, not the
      // author (delivered threads carry the requester's records)
      writeBeads(target.db, [
        ...readBeads(target.db),
        envelope({ id: 'v-rej', kind: 'reject', thread, from: me, to: 'mesh://acme/sibling' }),
      ])
      const rej = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(rej.code, 3, rej.stderr)
      assert.match(rej.stdout, /rejected/)

      // a concurrent accept doesn't launder the reject — the verdict
      // is the envelope SET, not the reduced stage (a human untangles)
      writeBeads(target.db, [
        ...readBeads(target.db),
        envelope({ id: 'v-acc', kind: 'accept', thread, from: me, to: 'mesh://acme/sibling' }),
      ])
      const both = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(both.code, 3, both.stderr)
    })
  })

  test('verdict hygiene — usage, non-external arg, unbound rig, absent bead, gone checkout', () => {
    const { root, main } = initRepo('bro-wait-e2e-bad-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const target = initTarget(root, 'sibling')
      const { binDir, db: mainDb } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: mainDb }

      // no args → usage on stderr, exit 2
      const none = runCli(['wait'], { cwd: main, env })
      assert.equal(none.code, 2)
      assert.match(none.stderr, /Usage: bro wait/)

      // a thread id is not an external ref — point at the thread read
      const plain = runCli(['wait', 'fx-123'], { cwd: main, env })
      assert.equal(plain.code, 2)
      assert.match(plain.stderr, /bro mesh wait/)

      // a rig nobody bound — polling a plane that cannot exist would
      // report "still waiting" forever
      const unbound = runCli(['wait', 'external:mesh://acme/ghost:fx-1'], { cwd: main, env })
      assert.equal(unbound.code, 2)
      assert.match(unbound.stderr, /no peer binding.*mesh:\/\/acme\/ghost/)

      // bound rig, but the request bead never landed on its store
      runCli(['request', 'sibling', 'anchor'], { cwd: main, env })
      const absent = runCli(['wait', REF('fx-ghost'), '--every', '0.1'], { cwd: main, env })
      assert.equal(absent.code, 2)
      assert.match(absent.stderr, /absent on its posting store/)

      // a store the dep names cannot be read — tolerated blips, then
      // unreadable exits 1 (a verdict, never the deadline's doing)
      rmSync(target.dir, { recursive: true, force: true })
      const dead = runCli(['wait', REF('fx-ghost'), '--every', '0.1', '--timeout', '30'], {
        cwd: main,
        env,
      })
      assert.equal(dead.code, 1, dead.stderr)
      assert.match(dead.stdout, /wait: unreadable/)
    })
  })

  test('beads-remote peer — posting-store split, replica annotation, absent replica is unreadable', () => {
    const { root, main } = initRepo('bro-wait-e2e-rem-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const tools = join(root, 'tools')
      const { binDir, db: mainDb } = installFakeBd(tools, [])
      installFakeDolt(tools)
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: mainDb }
      const { remoteDir, publish } = installFakeDoltRemote(root, [])

      const add = runCli(
        ['mesh', 'peers', 'add', 'far', 'mesh://acme/far', remoteDir],
        { cwd: main, env },
      )
      assert.equal(add.code, 0, add.stderr)

      // own-store post — beads-remote keeps the bead on OUR store for
      // the peer to pull; the replica never carries it
      const req = runCli(['mesh', 'request', 'mesh://acme/far', 'remote ask'], { cwd: main, env })
      assert.equal(req.code, 0, req.stderr)
      const thread = /request (\S+) →/.exec(req.stdout)?.[1]
      assert.ok(thread, req.stdout)
      const ref = FAR(thread)

      // no replica yet — the peer plane cannot be read at all:
      // unreadable after the failure budget, naming `bro mesh pull`
      const noReplica = runCli(['wait', ref, '--every', '0.1', '--timeout', '30'], {
        cwd: main,
        env,
      })
      assert.equal(noReplica.code, 1, noReplica.stderr)
      assert.match(noReplica.stderr, /bro mesh pull/)

      const pull = runCli(['mesh', 'pull'], { cwd: main, env })
      assert.equal(pull.code, 0, pull.stderr)

      // replica present, nothing shipped → timeout
      const pending = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(pending.code, 4, pending.stderr)

      // the request bead closed on OUR store without provides: —
      // own-posted closed-unshipped is actionable too
      execFileSync('bd', ['-C', main, 'close', thread], {
        env: { ...process.env, ...env },
      })
      const dead = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(dead.code, 3, dead.stderr)
      assert.match(dead.stdout, /closed-unshipped/)

      // a ghost id on a working plane — absent on the posting store
      const absent = runCli(['wait', FAR('fx-ghost'), '--every', '0.1'], { cwd: main, env })
      assert.equal(absent.code, 2)
      assert.match(absent.stderr, /absent on its posting store/)

      // the capability lands in the peer's published store; one pull
      // later the replica says free — annotated with source + age
      publish([{ id: 'cap-1', status: 'closed', labels: [`provides:${thread}`] }])
      assert.equal(runCli(['mesh', 'pull'], { cwd: main, env }).code, 0)
      const free = runCli(['wait', ref, '--every', '0.1', '--timeout', '1'], { cwd: main, env })
      assert.equal(free.code, 0, free.stderr)
      assert.match(free.stdout, /free.*replica far, synced/)
    })
  })

  test('multi-ref — settled refs report while the wait holds for the rest', () => {
    const { root, main } = initRepo('bro-wait-e2e-multi-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const target = initTarget(root, 'sibling')
      const { binDir, db: mainDb } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: mainDb }

      const threads = ['first ask', 'second ask'].map((title) => {
        const r = runCli(['request', 'sibling', title], { cwd: main, env })
        assert.equal(r.code, 0, r.stderr)
        return /request (\S+) →/.exec(r.stdout)?.[1]!
      })
      const [done, pending] = threads

      // ship only the first — the wait must hold for the second and
      // the timeout summary says which ref is still out
      execFileSync('bd', ['-C', target.dir, 'close', done!], {
        env: { ...process.env, ...env },
      })
      execFileSync('bd', ['-C', target.dir, 'ship', done!], {
        env: { ...process.env, ...env },
      })
      const res = runCli(
        ['wait', REF(done!), REF(pending!), '--every', '0.1', '--timeout', '1', '--json'],
        { cwd: main, env },
      )
      assert.equal(res.code, 4, res.stderr)
      const payload = JSON.parse(res.stdout) as {
        verdict: string
        unsettled: string[]
        refs: Record<string, { verdict: string }>
      }
      assert.equal(payload.verdict, 'timeout')
      assert.deepEqual(payload.unsettled, [REF(pending!)])
      assert.equal(payload.refs[REF(done!)]?.verdict, 'free')
      assert.equal(payload.refs[REF(pending!)]?.verdict, 'waiting')
    })
  })
})

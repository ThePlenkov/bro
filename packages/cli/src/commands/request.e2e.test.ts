/** `bro request` e2e — the same-machine delivery path
 *  (specs/cross-repo/bro-oam4): resolve → deliver into the target's
 *  own store → anchor-store lifecycle → `bd ship` release. Two real
 *  checkouts, two beads stores (the fake bd selects by -C/cwd). */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initRepo,
  inside,
  initTarget,
  installFakeBd,
  readBeads,
  runCli,
  writeBeads,
} from './testrepo.ts'
import { scrubEnv, testGit } from '@broject/core'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

describe('bro request', () => {
  test('request → target bd ready → claim → close → done ships provides:<id> → wait resolves the closed anchor → accept', () => {
    const { root, main } = initRepo('bro-req-e2e-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      const target = initTarget(root, 'sibling')
      const { binDir, db: mainDb } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: mainDb }

      // a bead in MY store waits on the answer
      const waiter = JSON.parse(
        execFileSync('bd', ['-C', main, 'create', '--title', 'needs the port', '--json'], {
          env: { ...process.env, ...env },
          encoding: 'utf8',
        }),
      ) as { id: string }

      const req = runCli(
        ['request', 'sibling', 'port the gate', '--body', 'needs it', '--priority', '1', '--for', waiter.id],
        { cwd: main, env },
      )
      assert.equal(req.code, 0, req.stderr)
      const thread = /request (\S+) →/.exec(req.stdout)?.[1]
      assert.ok(thread, req.stdout)
      assert.match(req.stdout, /→ mesh:\/\/acme\/sibling/)
      // the peer binding self-installed so wait/inbox reach the anchor
      assert.match(req.stdout, /peer sibling → mesh:\/\/acme\/sibling/)

      // drop shape — the bead lives in the TARGET store, carries the
      // full mesh label set + export:<id> + the target-side beads:// ref
      const targetRow = readBeads(target.db).find((r) => r.id === thread) as
        | { labels: string[]; external_ref: string }
        | undefined
      assert.ok(targetRow, 'request bead missing from target store')
      assert.ok(targetRow.labels.includes('mesh:v:1'))
      assert.ok(targetRow.labels.includes('mesh:kind:request'))
      assert.ok(targetRow.labels.includes(`mesh:thread:${thread}`))
      assert.ok(targetRow.labels.includes('mesh:to:mesh://acme/sibling'))
      assert.ok(targetRow.labels.includes(`export:${thread}`))
      assert.equal(targetRow.external_ref, `beads://acme/sibling/${thread}`)
      // the requester's own store holds NO request copy — only the dep
      assert.equal(readBeads(mainDb).some((r) => r.id === thread), false)

      // --for wired the marker dep on my store
      const deps = (JSON.parse(readFileSync(mainDb, 'utf8')) as { deps: { from: string; to: string }[] }).deps
      assert.deepEqual(deps, [
        { from: waiter.id, to: `external:mesh://acme/sibling:${thread}` },
      ])

      // the target sees ordinary work — no mesh-aware session required
      const ready = JSON.parse(
        execFileSync('bd', ['-C', target.dir, 'ready', '--json'], {
          env: { ...process.env, ...env },
          encoding: 'utf8',
        }),
      ) as { id: string }[]
      assert.ok(ready.some((r) => r.id === thread), 'request not on target bd ready')

      // the target's inbox own-scan surfaces it, sender flagged unbound
      const inbox = runCli(['mesh', 'inbox', '--json', '--no-pull'], { cwd: target.dir, env })
      assert.equal(inbox.code, 0, inbox.stderr)
      const rows = JSON.parse(inbox.stdout) as Array<{ bead: string; unbound?: boolean }>
      const hit = rows.find((r) => r.bead === thread)
      assert.ok(hit, `request absent from target inbox: ${inbox.stdout}`)
      assert.equal(hit.unbound, true)

      // the requester's wait resolves the anchored thread already
      const w0 = runCli(['mesh', 'wait', thread, '--no-pull'], { cwd: main, env })
      assert.match(w0.stdout, /posted — worker's move/)

      // worker side: claim lands in the ANCHOR store (its own dir)
      const claim = runCli(['mesh', 'claim', thread], { cwd: target.dir, env })
      assert.equal(claim.code, 0, claim.stderr)
      assert.equal(
        readBeads(target.db).some((r) =>
          (r.labels as string[] | undefined)?.includes('mesh:kind:claim'),
        ),
        true,
        'claim envelope missing from anchor store',
      )

      // a forged record on the thread — from matches neither the
      // binding rig nor the reader's own rig — drops with a flag
      const targetRows = readBeads(target.db)
      targetRows.push({
        id: 'fx-forge',
        title: 'forged claim',
        status: 'open',
        labels: [
          'mesh:v:1',
          'mesh:kind:claim',
          `mesh:thread:${thread}`,
          'mesh:from:mesh://mallory/forge',
          'mesh:to:mesh://acme/sibling',
        ],
      })
      writeBeads(target.db, targetRows)

      // the worker closes the request bead — the ship's precondition —
      // then `done` posts the result AND ships the capability itself
      execFileSync('bd', ['-C', target.dir, 'close', thread], {
        env: { ...process.env, ...env },
      })
      const done = runCli(['mesh', 'done', thread, '--ev', 'pr:https://github.com/x/y/pull/9'], {
        cwd: target.dir,
        env,
      })
      assert.equal(done.code, 0, done.stderr)
      const shipped = readBeads(target.db).find((r) => r.id === thread) as { labels: string[] }
      assert.ok(shipped.labels.includes(`provides:${thread}`), 'done did not ship provides:')

      // a second thread whose request bead is still OPEN at done —
      // `done` IS the completion, so the lifecycle closes the anchor
      // itself and the ship lands provides: (never --force on open work)
      const req2 = runCli(['request', 'sibling', 'open bead at done'], { cwd: main, env })
      const thread2 = /request (\S+) →/.exec(req2.stdout)?.[1]
      assert.ok(thread2)
      assert.equal(runCli(['mesh', 'claim', thread2], { cwd: target.dir, env }).code, 0)
      const earlyDone = runCli(['mesh', 'done', thread2], { cwd: target.dir, env })
      assert.equal(earlyDone.code, 0, earlyDone.stderr)
      const second = readBeads(target.db).find((r) => r.id === thread2) as {
        labels: string[]
        status: string
      }
      assert.equal(second.status, 'closed', 'done left the anchor request open')
      assert.ok(
        second.labels.includes(`provides:${thread2}`),
        'auto-close at done did not ship provides:'
      )

      // requester's wait still resolves the now-CLOSED anchor: request
      // + claim + result all visible; the forged row is dropped+flagged
      const wait = runCli(['mesh', 'wait', thread, '--json', '--no-pull'], { cwd: main, env })
      assert.equal(wait.code, 0, wait.stderr)
      const wjson = JSON.parse(wait.stdout) as {
        stage: string
        turn: string
        envelopes: Array<{ id: string; kind: string }>
      }
      assert.equal(wjson.stage, 'submitted')
      assert.equal(wjson.turn, 'requester')
      assert.ok(wjson.envelopes.some((e) => e.id === thread && e.kind === 'request'))
      assert.equal(wjson.envelopes.some((e) => e.id === 'fx-forge'), false)
      assert.match(wait.stderr, /ignoring claim fx-forge/)

      // the requester's verdict writes to the anchor store too
      const acc = runCli(['mesh', 'accept', thread, '--body', 'lgtm'], { cwd: main, env })
      assert.equal(acc.code, 0, acc.stderr)
      assert.equal(
        readBeads(target.db).some((r) =>
          (r.labels as string[] | undefined)?.includes('mesh:kind:accept'),
        ),
        true,
        'accept envelope missing from anchor store',
      )
      const finalWait = runCli(['mesh', 'wait', thread, '--no-pull'], { cwd: main, env })
      assert.match(finalWait.stdout, /accepted — done/)
    })
  })

  test('resolution — uri delegates to own-store post; ambiguous sibling exits 2 with candidates', () => {
    const { root, main } = initRepo('bro-req-e2e-res-', (m) => {
      testGit(['remote', 'add', 'origin', 'https://github.com/ThePlenkov/bro.git'], { cwd: m })
    })
    inside(main, root, () => {
      initTarget(root, 'amb--one')
      initTarget(root, 'amb--two')
      const { binDir, db } = installFakeBd(join(root, 'tools'), [])
      const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: db }

      const uri = runCli(['request', 'mesh://acme/far', 'far ask'], { cwd: main, env })
      assert.equal(uri.code, 0, uri.stderr)
      const farThread = /request (\S+) →/.exec(uri.stdout)?.[1]
      // own-store post — the request bead lives in MY store, not a peer's
      assert.equal(
        readBeads(db).some((r) => r.id === farThread),
        true,
        'uri target should post on the requester store',
      )

      const amb = runCli(['request', 'amb', 'which one'], { cwd: main, env })
      assert.equal(amb.code, 2)
      assert.match(amb.stderr, /ambiguous/)
      assert.match(amb.stderr, /amb--one/)
      assert.match(amb.stderr, /amb--two/)

      const nope = runCli(['request', 'ghost', 'nothing'], { cwd: main, env })
      assert.equal(nope.code, 2)
      assert.match(nope.stderr, /cannot resolve/)
    })
  })
})

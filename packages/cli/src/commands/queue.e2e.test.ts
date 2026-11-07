/** `bro queue` e2e — the frame-scoped intake queue (bro-oy3k1.2) over
 *  the spawned CLI + fake bd: rank order, bump/--to, promote-to-frame,
 *  and dequeue are the observable contract; label plumbing is asserted
 *  through behavior, never by reading rows directly. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bead, e2eRepo, runCli, FAKE_BEAD } from './testrepo.ts'

const fixture = (rows: Array<Record<string, unknown>> = []) => e2eRepo('bro-queue-e2e-', rows)

describe('bro queue', () => {
  test('intake → ls: rank order, queue:root scope without a frame', () => {
    const { main, db, env: e } = fixture()
    assert.equal(runCli(['queue', 'first thing'], { cwd: main, env: e }).code, 0)
    assert.equal(runCli(['queue', 'second thing'], { cwd: main, env: e }).code, 0)
    const r = runCli(['queue', 'ls'], { cwd: main, env: e })
    assert.equal(r.code, 0, r.stderr)
    const rows = r.stdout.trim().split('\n').slice(1)
    assert.equal(rows.length, 2)
    assert.match(rows[0]!, /first thing/)
    assert.match(rows[1]!, /second thing/)
    assert.ok(Number(rows[0]!.split('\t')[0]) < Number(rows[1]!.split('\t')[0]))
    // label plumbing lands on the bead, not a side file
    const item = bead(db, rows[0]!.split('\t')[1]!)
    assert.deepEqual(
      (item?.labels as string[]).filter((l) => l.startsWith('queue:')),
      ['queue:root'],
    )
  })

  test('bump floats to top; --to lands between ranks', () => {
    const { main, db, env: e } = fixture()
    runCli(['queue', 'a'], { cwd: main, env: e })
    runCli(['queue', 'b'], { cwd: main, env: e })
    runCli(['queue', 'c'], { cwd: main, env: e })
    const rows = () =>
      runCli(['queue', 'ls'], { cwd: main, env: e })
        .stdout.trim()
        .split('\n')
        .slice(1)
    const title = (l: string) => l.split('\t')[2]!
    const bId = rows().find((l) => title(l) === 'b')!.split('\t')[1]!
    const b = runCli(['queue', 'bump', bId], { cwd: main, env: e })
    assert.equal(b.code, 0, b.stderr)
    assert.equal(title(rows()[0]!), 'b')
    // --to 15 lands between a(10) and c(30)
    const c = runCli(['queue', 'bump', bId, '--to', '15'], { cwd: main, env: e })
    assert.equal(c.code, 0, c.stderr)
    assert.deepEqual(rows().map(title), ['a', 'b', 'c'])
  })

  test('drill promotes the item into a frame and closes the bead', () => {
    const { main, db, env: e } = fixture()
    runCli(['queue', 'investigate flakiness'], { cwd: main, env: e })
    const id = runCli(['queue', 'ls'], { cwd: main, env: e })
      .stdout.split('\n')[1]!
      .split('\t')[1]!
    const r = runCli(['queue', 'drill', id], { cwd: main, env: e })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /drill ↓ fx-/)
    const item = bead(db, id)
    assert.equal(item?.status, 'closed')
    assert.match(String(item?.close_reason), /promoted → fx-/)
    // the promoted item leaves the queue listing
    const open = runCli(['queue', 'ls'], { cwd: main, env: e })
    assert.doesNotMatch(open.stdout, new RegExp(id))
  })

  test('rm dequeues without closing; foreign-queue id refuses', () => {
    const { main, db, env: e } = fixture()
    runCli(['queue', 'park me'], { cwd: main, env: e })
    const id = runCli(['queue', 'ls'], { cwd: main, env: e })
      .stdout.split('\n')[1]!
      .split('\t')[1]!
    const r = runCli(['queue', 'rm', id], { cwd: main, env: e })
    assert.equal(r.code, 0, r.stderr)
    const row = bead(db, id)
    assert.equal(row?.status, 'open')
    assert.deepEqual(((row?.labels ?? []) as string[]).filter((l) => l.startsWith('q')), [])
    const again = runCli(['queue', 'rm', id], { cwd: main, env: e })
    assert.equal(again.code, 1)
    assert.match(again.stderr, /not on/)
  })

  test('items land under an open drill frame when one is active', () => {
    const frame = {
      ...FAKE_BEAD,
      id: 'fx-fr1',
      title: 'drill frame',
      labels: ['drill'],
      issue_type: 'feature',
    }
    const { main, db, env: e } = fixture([frame])
    const r = runCli(['queue', 'scoped intake'], { cwd: main, env: e })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /→ fx-fr1/)
    const ls = runCli(['queue', 'ls'], { cwd: main, env: e })
    assert.match(ls.stdout, /queue fx-fr1/)
    assert.match(ls.stdout, /scoped intake/)
  })

  test('empty queue reports without error; syntax errors beat beads setup', () => {
    const { main, db, env: e } = fixture()
    const r = runCli(['queue', 'ls'], { cwd: main, env: e })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /empty/)
    const bad = runCli(['queue', '--bogus'], { cwd: main, env: e })
    assert.equal(bad.code, 2)
  })
})

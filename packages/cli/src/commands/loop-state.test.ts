import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside } from './testrepo.ts'
import {
  beginLoopRun,
  collectLoopRuns,
  endLoopRun,
  loopRunLog,
  loopRunsDir,
  reapLoopRuns,
  type LoopRunRecord,
} from './loop-state.ts'

const rec = (main: string, over: Partial<LoopRunRecord> = {}): LoopRunRecord => ({
  beadId: 'bro-x1',
  slug: 'bro-x1',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  worktree: join(main, 'wt'),
  log: loopRunLog(main, 'bro-x1') ?? '',
  ...over,
})

describe('loop run records', () => {
  test('the plane lives at <git-common>/bro/loop', () => {
    const { root, main } = initRepo('bro-loopstate-')
    inside(main, root, () => {
      assert.equal(loopRunsDir(main), join(main, '.git', 'bro', 'loop'))
      assert.equal(
        loopRunLog(main, 'bro-x1'),
        join(main, '.git', 'bro', 'loop', 'bro-x1.log')
      )
    })
  })

  test('begin → collect reports the spawn running; end removes the record', () => {
    const { root, main } = initRepo('bro-loopstate-')
    inside(main, root, () => {
      beginLoopRun(main, rec(main))
      const [r] = collectLoopRuns(main)
      assert.equal(r?.beadId, 'bro-x1')
      assert.equal(r?.state, 'running')
      assert.equal(r?.pid, process.pid)
      assert.ok(typeof r?.silentMs === 'number' && r.silentMs >= 0)
      endLoopRun(main, 'bro-x1')
      assert.deepEqual(collectLoopRuns(main), [])
    })
  })

  test('the log mtime is the silence signal — an old log reads stale', () => {
    const { root, main } = initRepo('bro-loopstate-')
    inside(main, root, () => {
      const r = rec(main)
      beginLoopRun(main, r)
      writeFileSync(r.log, 'agent output\n')
      const past = new Date(Date.now() - 50 * 60_000)
      utimesSync(r.log, past, past)
      const [v] = collectLoopRuns(main)
      assert.ok(v !== undefined && v.silentMs !== null && v.silentMs >= 50 * 60_000)
    })
  })

  test('a dead pid reads as residue, and reap clears it — a live one survives', () => {
    const { root, main } = initRepo('bro-loopstate-')
    inside(main, root, () => {
      // pid 0 is dead by contract (kill(0) would target the group)
      beginLoopRun(main, rec(main, { slug: 'dead-one', beadId: 'dead-one', pid: 0 }))
      beginLoopRun(main, rec(main, { slug: 'live-one', beadId: 'live-one' }))
      const runs = collectLoopRuns(main)
      assert.equal(runs.find((r) => r.slug === 'dead-one')?.state, 'dead')
      assert.equal(runs.find((r) => r.slug === 'live-one')?.state, 'running')
      reapLoopRuns(main)
      const after = collectLoopRuns(main)
      assert.deepEqual(after.map((r) => r.slug), ['live-one'])
    })
  })

  test('unparseable records report as residue and reap, not throw', () => {
    const { root, main } = initRepo('bro-loopstate-')
    inside(main, root, () => {
      const home = loopRunsDir(main)!
      beginLoopRun(main, rec(main)) // also creates the dir
      writeFileSync(join(home, 'junk.json'), '{not json')
      const junk = collectLoopRuns(main).find((r) => r.slug === 'junk')
      assert.equal(junk?.state, 'dead')
      assert.equal(junk?.pid, null)
      reapLoopRuns(main)
      assert.ok(!existsSync(join(home, 'junk.json')))
      assert.ok(existsSync(join(home, 'bro-x1.json')))
    })
  })

  test('outside a repo the plane is empty and writes are silent no-ops', () => {
    assert.deepEqual(collectLoopRuns('/nonexistent-dir'), [])
    beginLoopRun('/nonexistent-dir', rec('/nonexistent-dir'))
  })

  test('a record round-trips its fields — pidStart survives the write', () => {
    const { root, main } = initRepo('bro-loopstate-')
    inside(main, root, () => {
      beginLoopRun(main, rec(main, { pidStart: '123456' }))
      const raw = JSON.parse(
        readFileSync(join(loopRunsDir(main)!, 'bro-x1.json'), 'utf8')
      ) as Record<string, unknown>
      assert.equal(raw.pidStart, '123456')
      assert.equal(raw.log, rec(main).log)
      assert.equal(raw.beadId, 'bro-x1')
    })
  })
})

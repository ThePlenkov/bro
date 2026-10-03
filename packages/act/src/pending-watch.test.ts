import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listWatches,
  watchBegin,
  watchEnd,
  watchRetire,
  type PendingWatch,
} from './pending-watch.ts'

const base: Omit<PendingWatch, 'pid' | 'startedAt'> = {
  pr: 42,
  link: '[#42](https://github.com/o/r/pull/42)',
  merge: true,
  timeoutMin: 45,
}

const dirs: string[] = []
after(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-watch-'))
  execFileSync('git', ['init', '-q', dir])
  dirs.push(dir)
  return dir
}

describe('pending-watch markers', () => {
  test('outside a git repo everything is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-watch-nogit-'))
    dirs.push(dir)
    assert.equal(watchBegin(dir, base), null)
    assert.deepEqual(listWatches(dir), [])
    watchEnd(null)
  })

  test('begin writes a marker listWatches reports as alive (own pid)', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, true)
    assert.equal(listed[0]!.watch.pr, 42)
    assert.equal(listed[0]!.watch.pid, process.pid)
    assert.equal(listed[0]!.watch.merge, true)
  })

  test('end removes the marker', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.equal(listWatches(dir).length, 1)
    watchEnd(path)
    assert.equal(listWatches(dir).length, 0)
  })

  test('a dead pid reports alive:false — the stale promise', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    // a pid this high cannot exist — dead on every host
    w.pid = 2_000_000_000
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, false)
    assert.equal(watchRetire(listed[0]!.file), true)
    // a racing retire loses the claim — the stale promise reports once
    assert.equal(watchRetire(listed[0]!.file), false)
    assert.equal(listWatches(dir).length, 0)
  })

  test('a live pid with a different start identity reports alive:false', (t) => {
    if (!existsSync('/proc')) {
      t.skip('pid start identity needs /proc')
      return
    }
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.pidStart = '1' // boot-time start — never this watcher's identity
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, false)
  })

  test('TTL-expired markers are pruned, not listed', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.startedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    assert.equal(listWatches(dir).length, 0)
    // pruned means gone from disk, not merely omitted from the listing
    assert.equal(existsSync(path!), false)
  })

  test('malformed marker files are pruned, not listed', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    writeFileSync(path!, 'not json')
    assert.equal(listWatches(dir).length, 0)
    assert.equal(existsSync(path!), false)
  })

  test('a tmp mid-publication is kept; only abandoned residue is pruned', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const tmp = `${path!}.tmp`
    writeFileSync(tmp, 'partial')
    // fresh tmp — a writeFileSync→renameSync may be in flight
    assert.equal(listWatches(dir).length, 1)
    assert.equal(existsSync(tmp), true)
    // past the TTL it is crash residue, not an in-flight publish
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(tmp, old, old)
    assert.equal(listWatches(dir).length, 1)
    assert.equal(existsSync(tmp), false)
  })

  test('two waits on the same PR in one process each own a marker', () => {
    const dir = repo()
    const first = watchBegin(dir, base)
    const second = watchBegin(dir, { ...base, merge: false })
    assert.ok(first)
    assert.ok(second)
    assert.notEqual(first, second)
    assert.equal(listWatches(dir).length, 2)
    watchEnd(first)
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.file, second)
    watchEnd(second)
  })

  test('a configured timeout longer than a day extends the marker TTL', () => {
    const dir = repo()
    const path = watchBegin(dir, { ...base, timeoutMin: 3 * 24 * 60 })
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.startedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, true)
    w.startedAt = Date.now() - 4 * 24 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    assert.equal(listWatches(dir).length, 0)
  })

  test('begin retires a dead-pid marker for the same PR', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    // a second marker from another (now dead) process watching the same PR
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({ ...base, pid: 2_000_000_000, startedAt: Date.now() })
    )
    const next = watchBegin(dir, { ...base, merge: false })
    assert.ok(next)
    assert.equal(existsSync(stale), false)
    // the dead marker is retired; both live waits keep their own
    const listed = listWatches(dir)
    assert.equal(listed.length, 2)
    assert.ok(listed.every((l) => l.watch.pid === process.pid))
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-watch-'))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

describe('pending-watch markers', () => {
  test('outside a git repo everything is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-watch-nogit-'))
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
    watchRetire(listed[0]!.file)
    assert.equal(listWatches(dir).length, 0)
  })

  test('TTL-expired markers are pruned, not listed', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.startedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    assert.equal(listWatches(dir).length, 0)
  })

  test('malformed marker files are pruned, not listed', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    writeFileSync(path!, 'not json')
    assert.equal(listWatches(dir).length, 0)
    assert.equal(existsSync(path!), false)
  })

  test('interrupted-write tmp residue is pruned', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    writeFileSync(`${path!}.tmp`, 'partial')
    assert.equal(listWatches(dir).length, 1)
    assert.equal(existsSync(`${path!}.tmp`), false)
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
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.watch.pid, process.pid)
  })
})

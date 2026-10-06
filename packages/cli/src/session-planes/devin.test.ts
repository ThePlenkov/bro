import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countDevinSessions, devinLocksDir, devinSessionPlane } from './devin.ts'

const withLockDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-devin-locks-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('devinSessionPlane', () => {
  test('detects the devin cli and nothing else', () => {
    assert.equal(devinSessionPlane.kind, 'devin')
    assert.equal(devinSessionPlane.detectsCli('devin'), true)
    assert.equal(devinSessionPlane.detectsCli('opencode'), false)
  })

  test('countLive scans the configured lockDir plus the worker env dir', () => {
    withLockDir((dir) => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid))
      assert.equal(devinSessionPlane.countLive({ lockDir: dir }), 1)
    })
  })

  test('a spec.env XDG override makes countLive scan BOTH dirs', () => {
    withLockDir((dir) => {
      const xdg = mkdtempSync(join(tmpdir(), 'bro-devin-xdg-'))
      try {
        const workerDir = join(xdg, 'devin', 'cli', 'session_locks')
        mkdirSync(workerDir, { recursive: true })
        // one lock in the spawner's dir, one in the worker's — both count
        writeFileSync(join(dir, 'a.lock'), String(process.pid))
        writeFileSync(join(workerDir, 'b.lock'), String(process.pid))
        assert.equal(
          devinSessionPlane.countLive({ lockDir: dir }, { XDG_DATA_HOME: xdg }),
          1 // same pid — dedupes
        )
      } finally {
        rmSync(xdg, { recursive: true, force: true })
      }
    })
  })
})

describe('countDevinSessions', () => {
  test('counts unique live pids — duped locks and dead pids collapse', () => {
    withLockDir((dir) => {
      // two locks, one live process (a resumed session's residue) — counts once
      writeFileSync(join(dir, 'a.lock'), String(process.pid))
      writeFileSync(join(dir, 'b.lock'), String(process.pid))
      // a pid guaranteed dead — the just-reaped child's pid
      const dead = spawnSync('true', [], { stdio: 'ignore' }).pid
      writeFileSync(join(dir, 'dead.lock'), String(dead))
      // non-numeric content and non-lock files are skipped entirely
      writeFileSync(join(dir, 'junk.lock'), 'not-a-pid')
      writeFileSync(join(dir, 'note.txt'), String(process.pid))
      // strict pid parse — '123abc' is NOT 123; a trailing-garbage lock
      // must not collapse onto an innocent process's pid
      writeFileSync(join(dir, 'partial.lock'), `${process.pid}garbage`)
      assert.equal(countDevinSessions([dir]), 1)
    })
  })

  test('a missing lock dir reads as zero sessions', () => {
    assert.equal(countDevinSessions([join(tmpdir(), 'bro-devin-locks-absent-')]), 0)
  })

  test('an unreadable lock dir fails closed — refuse, never pretend zero', () => {
    // a path where readdirSync fails non-ENOENT: a file posing as the dir
    const file = join(mkdtempSync(join(tmpdir(), 'bro-devin-nodir-')), 'notdir')
    writeFileSync(file, 'x')
    assert.throws(() => countDevinSessions([file]), /not a directory|ENOTDIR/)
  })
})

describe('devinLocksDir', () => {
  test('explicit override wins; XDG_DATA_HOME otherwise', () => {
    assert.equal(devinLocksDir({ lockDir: '/tmp/x' }), '/tmp/x')
    assert.equal(
      devinLocksDir({}, { XDG_DATA_HOME: '/tmp/xdg' }),
      join('/tmp/xdg', 'devin', 'cli', 'session_locks')
    )
    assert.equal(
      devinLocksDir({}, { HOME: '/tmp/home' }),
      join('/tmp/home', '.local', 'share', 'devin', 'cli', 'session_locks')
    )
  })
})

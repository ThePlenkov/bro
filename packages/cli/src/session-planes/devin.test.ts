import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countDevinSessions,
  countDevinWorkers,
  devinLocksDir,
  devinPidIsWorker,
  devinSessionPlane,
} from './devin.ts'

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

describe('devinPidIsWorker', () => {
  /** A fake /proc tree — <pid>/environ and <pid>/fd/0 as the test
   *  scripts them; absent files read as "no data" like on macOS. */
  const withProc = (fn: (procDir: string, mk: (pid: number, environ: string | null, stdinTo: string | null) => void) => void): void => {
    const procDir = mkdtempSync(join(tmpdir(), 'bro-proc-'))
    const mk = (pid: number, environ: string | null, stdinTo: string | null): void => {
      const dir = join(procDir, String(pid))
      mkdirSync(join(dir, 'fd'), { recursive: true })
      if (environ !== null) {
        writeFileSync(join(dir, 'environ'), environ)
      }
      if (stdinTo !== null) {
        symlinkSync(stdinTo, join(dir, 'fd', '0'))
      }
    }
    try {
      fn(procDir, mk)
    } finally {
      rmSync(procDir, { recursive: true, force: true })
    }
  }

  test('the BRO_AGENT_ID env badge classifies a worker — NUL-anchored', () => {
    withProc((procDir, mk) => {
      mk(101, 'PATH=/bin\0BRO_AGENT_ID=native-abc\0HOME=/h\0', '/dev/pts/3')
      assert.equal(devinPidIsWorker(101, procDir), true)
      // a lookalike suffix must not alias — the anchor rejects XBRO_AGENT_ID
      mk(102, 'PATH=/bin\0XBRO_AGENT_ID=spoof\0', '/dev/pts/3')
      assert.equal(devinPidIsWorker(102, procDir), false)
    })
  })

  test('non-pty stdin classifies a worker, a pty does not', () => {
    withProc((procDir, mk) => {
      mk(201, 'PATH=/bin\0', 'pipe:[1234]')
      assert.equal(devinPidIsWorker(201, procDir), true)
      mk(202, 'PATH=/bin\0', '/dev/null')
      assert.equal(devinPidIsWorker(202, procDir), true)
      mk(203, 'PATH=/bin\0', '/dev/pts/2')
      assert.equal(devinPidIsWorker(203, procDir), false)
    })
  })

  test('no verifiable data is NOT a worker — undercount never invents workers', () => {
    withProc((procDir, mk) => {
      mk(301, null, null) // no environ, no fd/0 — macOS-equivalent blind
      assert.equal(devinPidIsWorker(301, procDir), false)
      mk(302, 'PATH=/bin\0', null) // environ read, no badge, stdin unknown
      assert.equal(devinPidIsWorker(302, procDir), false)
    })
  })
})

describe('countDevinWorkers', () => {
  test('counts only worker-classified live pids', () => {
    withLockDir((dir) => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid))
      const workers = new Set<number>()
      const isWorker = (pid: number): boolean => workers.has(pid)
      assert.equal(countDevinWorkers([dir], isWorker), 0)
      workers.add(process.pid)
      assert.equal(countDevinWorkers([dir], isWorker), 1)
    })
  })

  test('a real spawned child carrying BRO_AGENT_ID reads as a worker', async () => {
    const child = spawn('sleep', ['30'], {
      stdio: 'ignore',
      env: { ...process.env, BRO_AGENT_ID: 'native-test' },
    })
    try {
      withLockDir((dir) => {
        writeFileSync(join(dir, 'w.lock'), String(child.pid))
        assert.equal(countDevinWorkers([dir]), 1)
      })
    } finally {
      child.kill('SIGKILL')
    }
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

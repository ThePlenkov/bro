import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpawnError } from '@broject/core'
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

  test('terminal devices beyond /dev/pts still read interactive', () => {
    withProc((procDir, mk) => {
      // the controlling-terminal alias, a virtual console, the system
      // console, a serial console — all interactive, never workers
      for (const [pid, dev] of [
        [401, '/dev/tty'],
        [402, '/dev/tty1'],
        [403, '/dev/console'],
        [404, '/dev/ttyS0'],
      ] as const) {
        mk(pid, 'PATH=/bin\0', dev)
        assert.equal(devinPidIsWorker(pid, procDir), false, `${dev} must not be a worker`)
      }
      mk(405, 'PATH=/bin\0', 'socket:[99]')
      assert.equal(devinPidIsWorker(405, procDir), true)
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
    if (!child.pid) throw new Error('spawn failed to create child process')
    try {
      withLockDir((dir) => {
        writeFileSync(join(dir, 'w.lock'), String(child.pid))
        assert.equal(countDevinWorkers([dir]), 1)
      })
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a landed worker retires its own reservation slot — no double count', () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    if (!child.pid) throw new Error('spawn failed to create child process')
    const pid = child.pid
    try {
      // scripted /proc, not the real child's environ: spawn() resolves
      // at fork — until execve lands, /proc/<pid>/environ still reads
      // the PARENT's env (no badge → the sweep misses the landing),
      // which is the flake this test carried under full-suite load
      withProc((procDir, mk) => {
        mk(pid, 'PATH=/bin\0BRO_AGENT_ID=native-landed\0HOME=/h\0', null)
        withLockDir((dir) => {
          writeFileSync(join(dir, 'w.lock'), String(pid))
          const resv = mkdtempSync(join(tmpdir(), 'bro-devin-slots-'))
          try {
            const landed = join(resv, 'native-landed-a1b2c3d4.slot')
            const inflight = join(resv, 'native-inflight-e5f6a7b8.slot')
            writeFileSync(landed, String(Date.now()))
            writeFileSync(inflight, String(Date.now()))
            assert.equal(countDevinSessions([dir], resv, procDir), 1)
            // the landed spawn's slot is gone; an unrelated in-flight
            // claim stays for the tally
            assert.equal(existsSync(landed), false)
            assert.equal(existsSync(inflight), true)
          } finally {
            rmSync(resv, { recursive: true, force: true })
          }
        })
      })
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('no /proc + live sessions → the worker count fails closed', () => {
    withLockDir((dir) => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid))
      const absent = join(tmpdir(), 'bro-proc-absent-')
      assert.throws(
        () => countDevinWorkers([dir], devinPidIsWorker, undefined, absent),
        (e: unknown) => e instanceof SpawnError && e.kind === 'unavailable'
      )
      // an injected classifier doesn't probe /proc — no throw
      assert.equal(countDevinWorkers([dir], () => false, undefined, absent), 0)
    })
    // zero live sessions are verifiably zero workers on any host
    assert.equal(
      countDevinWorkers([join(tmpdir(), 'bro-devin-locks-absent-')], devinPidIsWorker, undefined, 'nope'),
      0
    )
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

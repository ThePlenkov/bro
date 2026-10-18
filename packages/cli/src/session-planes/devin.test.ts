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
import { tmpDir } from '../commands/testrepo.ts'
import {
  countDevinSessions,
  countDevinWorkers,
  devinLocksDir,
  devinLogsDir,
  devinPidIsSession,
  devinPidIsWorker,
  devinSessionPlane,
  devinSessionTranscript,
  devinTranscriptsDir,
  listDevinSessions,
  renderDevinTranscript,
} from './devin.ts'

const withLockDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-devin-locks-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A fake /proc tree — <pid>/environ, <pid>/fd/0 and <pid>/cmdline as
 *  the test scripts them; absent files read as "no data" like on
 *  macOS. cmdline defaults to a devin-looking argv so identity checks
 *  pass unless the test scripts otherwise. */
const withProc = (fn: (procDir: string, mk: (pid: number, environ: string | null, stdinTo: string | null, cmdline?: string | null) => void) => void): void => {
  const procDir = mkdtempSync(join(tmpdir(), 'bro-proc-'))
  const mk = (
    pid: number,
    environ: string | null,
    stdinTo: string | null,
    cmdline: string | null = 'devin\0acp\0'
  ): void => {
    const dir = join(procDir, String(pid))
    mkdirSync(join(dir, 'fd'), { recursive: true })
    if (environ !== null) {
      writeFileSync(join(dir, 'environ'), environ)
    }
    if (stdinTo !== null) {
      symlinkSync(stdinTo, join(dir, 'fd', '0'))
    }
    if (cmdline !== null) {
      writeFileSync(join(dir, 'cmdline'), cmdline)
    } else {
      rmSync(join(dir, 'cmdline'), { force: true })
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
    withProc((procDir, mk) => {
      mk(process.pid, null, null)
      withLockDir((dir) => {
        writeFileSync(join(dir, 'a.lock'), String(process.pid))
        assert.equal(devinSessionPlane.countLive({ lockDir: dir, procDir }), 1)
      })
    })
  })

  test('a spec.env XDG override makes countLive scan BOTH dirs', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null)
      withLockDir((dir) => {
        const xdg = mkdtempSync(join(tmpdir(), 'bro-devin-xdg-'))
        try {
          const workerDir = join(xdg, 'devin', 'cli', 'session_locks')
          mkdirSync(workerDir, { recursive: true })
          // one lock in the spawner's dir, one in the worker's — both count
          writeFileSync(join(dir, 'a.lock'), String(process.pid))
          writeFileSync(join(workerDir, 'b.lock'), String(process.pid))
          assert.equal(
            devinSessionPlane.countLive(
              { lockDir: dir, procDir },
              { XDG_DATA_HOME: xdg }
            ),
            1 // same pid — dedupes
          )
        } finally {
          rmSync(xdg, { recursive: true, force: true })
        }
      })
    })
  })
})

describe('countDevinSessions', () => {
  test('counts unique live pids — duped locks and dead pids collapse', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null)
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
        assert.equal(countDevinSessions([dir], undefined, procDir), 1)
      })
    })
  })

  test('a live pid that is not devin is a recycled lock — not counted', () => {
    withProc((procDir, mk) => {
      withLockDir((dir) => {
        writeFileSync(join(dir, 'stale.lock'), String(process.pid))
        // the pid is alive but belongs to an unrelated process —
        // pid-reuse after reboot/crash leaves the lock pointing at it
        mk(process.pid, null, null, 'snapfuse\0mount\0/var/lib/snapd\0')
        assert.equal(countDevinSessions([dir], undefined, procDir), 0)
        // the same pid carrying the devin cli counts again
        mk(process.pid, null, null, 'devin\0acp\0--model\0swe-2-max\0')
        assert.equal(countDevinSessions([dir], undefined, procDir), 1)
        // an unreadable cmdline (no file) cannot prove devin either
        mk(process.pid, null, null, null)
        assert.equal(countDevinSessions([dir], undefined, procDir), 0)
      })
    })
  })

  test('a host with no procDir keeps pidAlive-only liveness — fail-open', () => {
    withLockDir((dir) => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid))
      const absent = join(tmpdir(), 'bro-proc-absent-')
      assert.equal(countDevinSessions([dir], undefined, absent), 1)
    })
  })

  test('a missing lock dir reads as zero sessions', () => {
    assert.equal(countDevinSessions([join(tmpdir(), 'bro-devin-locks-absent-')]), 0)
  })

  test('an unreadable lock dir fails closed — refuse, never pretend zero', () => {
    // a path where readdirSync fails non-ENOENT: a file posing as the dir
    const file = join(tmpDir('bro-devin-nodir-'), 'notdir')
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

describe('devinPidIsSession', () => {
  test('devin argv identifies the cli; foreign cmdlines do not', () => {
    withProc((procDir, mk) => {
      mk(501, null, null, 'devin\0acp\0--model\0swe-2-max\0')
      assert.equal(devinPidIsSession(501, procDir), true)
      // versioned binary path as argv0
      mk(502, null, null, '/home/u/.local/share/devin/cli/bin/devin\0-p\0hi\0')
      assert.equal(devinPidIsSession(502, procDir), true)
      // node/bun launching the script inside the devin install tree
      mk(503, null, null, 'node\0/home/u/.local/share/devin/cli/_versions/1/dist/index.js\0acp\0')
      assert.equal(devinPidIsSession(503, procDir), true)
      // recycled pids — the observed phantoms
      mk(504, null, null, 'snapfuse\0mount\0/var/lib/snapd\0')
      assert.equal(devinPidIsSession(504, procDir), false)
      mk(505, null, null, '/usr/bin/herdr\0server\0')
      assert.equal(devinPidIsSession(505, procDir), false)
      // a /devin/ path in a later argv element is not the binary
      mk(507, null, null, 'git\0-C\0/home/u/devin/repo\0status\0')
      assert.equal(devinPidIsSession(507, procDir), false)
      mk(508, null, null, 'cat\0/tmp/devin/config.json\0')
      assert.equal(devinPidIsSession(508, procDir), false)
      // no cmdline file — unverifiable, not devin
      mk(506, null, null, null)
      assert.equal(devinPidIsSession(506, procDir), false)
    })
  })
})

describe('countDevinWorkers', () => {
  test('counts only worker-classified live pids', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null)
      withLockDir((dir) => {
        writeFileSync(join(dir, 'a.lock'), String(process.pid))
        const workers = new Set<number>()
        const isWorker = (pid: number): boolean => workers.has(pid)
        assert.equal(countDevinWorkers([dir], isWorker, undefined, procDir), 0)
        workers.add(process.pid)
        assert.equal(countDevinWorkers([dir], isWorker, undefined, procDir), 1)
      })
    })
  })

  test('a real spawned child carrying BRO_AGENT_ID reads as a worker', async () => {
    const child = spawn('sleep', ['30'], {
      stdio: 'ignore',
      env: { ...process.env, BRO_AGENT_ID: 'native-test' },
    })
    if (!child.pid) throw new Error('spawn failed to create child process')
    try {
      // scripted /proc for BOTH probes — the real child's environ races
      // execve, and a `sleep` cmdline is not the devin cli's
      withProc((procDir, mk) => {
        mk(child.pid!, 'PATH=/bin\0BRO_AGENT_ID=native-test\0HOME=/h\0', 'pipe:[1]')
        withLockDir((dir) => {
          writeFileSync(join(dir, 'w.lock'), String(child.pid))
          assert.equal(
            countDevinWorkers(
              [dir],
              (pid) => devinPidIsWorker(pid, procDir),
              undefined,
              procDir
            ),
            1
          )
        })
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

describe('listDevinSessions', () => {
  test('live locks yield rows named for the session — dead, duped, and junk locks collapse', () => {
    withProc((procDir, mk) => {
      mk(process.pid, 'PATH=/bin\0', '/dev/pts/1')
      withLockDir((dir) => {
        writeFileSync(join(dir, 'sess-a.lock'), String(process.pid))
        const dead = spawnSync('true', [], { stdio: 'ignore' }).pid
        writeFileSync(join(dir, 'dead.lock'), String(dead))
        writeFileSync(join(dir, 'junk.lock'), 'not-a-pid')
        writeFileSync(join(dir, 'note.txt'), String(process.pid))
        const rows = listDevinSessions([dir], procDir)
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.name, 'sess-a')
        assert.equal(rows[0]!.pid, process.pid)
        // a pty stdin, no badge — the same undercount contract the
        // worker lane holds: live, but not verifiably a worker
        assert.equal(rows[0]!.worker, false)
        assert.equal(rows[0]!.agentId, undefined)
      })
    })
  })

  test('a duped lock for one pid yields one row', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null)
      withLockDir((dir) => {
        writeFileSync(join(dir, 'a.lock'), String(process.pid))
        writeFileSync(join(dir, 'b.lock'), String(process.pid))
        const rows = listDevinSessions([dir], procDir)
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.pid, process.pid)
      })
    })
  })

  test('a real spawned worker carries its BRO_AGENT_ID badge into the row', async () => {
    const child = spawn('sleep', ['30'], {
      stdio: 'ignore',
      env: { ...process.env, BRO_AGENT_ID: 'native-xyz' },
    })
    if (!child.pid) throw new Error('spawn failed to create child process')
    try {
      // scripted /proc — real environ races execve, and `sleep` is not
      // the devin cli's cmdline
      withProc((procDir, mk) => {
        mk(child.pid!, 'PATH=/bin\0BRO_AGENT_ID=native-xyz\0HOME=/h\0', 'pipe:[1]')
        withLockDir((dir) => {
          writeFileSync(join(dir, 'w.lock'), String(child.pid))
          const rows = listDevinSessions([dir], procDir)
          assert.equal(rows.length, 1)
          assert.equal(rows[0]!.worker, true)
          assert.equal(rows[0]!.agentId, 'native-xyz')
        })
      })
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a recycled pid yields no row — the stale lock folds out', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null, 'herdr\0server\0')
      withLockDir((dir) => {
        writeFileSync(join(dir, 'stale.lock'), String(process.pid))
        assert.equal(listDevinSessions([dir], procDir).length, 0)
      })
    })
  })

  test('the plane wires listLive over the configured lockDir', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null)
      withLockDir((dir) => {
        writeFileSync(join(dir, 'x.lock'), String(process.pid))
        const rows = devinSessionPlane.listLive!({ lockDir: dir, procDir })
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.name, 'x')
      })
    })
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

describe('devinLogsDir', () => {
  test('explicit override wins; a lockDir override confines the default inside it', () => {
    assert.equal(devinLogsDir({ logsDir: '/tmp/l' }), '/tmp/l')
    assert.equal(
      devinLogsDir({}, { XDG_DATA_HOME: '/tmp/xdg' }),
      join('/tmp/xdg', 'devin', 'cli', 'session_locks', '..', 'logs')
    )
    // lockDir overridden without logsDir — a '../logs' sibling would
    // escape the chosen root; the default nests inside the override
    assert.equal(devinLogsDir({ lockDir: '/tmp/locks' }), join('/tmp/locks', 'logs'))
  })
})

describe('devinTranscriptsDir', () => {
  test('explicit override wins; a lockDir override confines the default inside it', () => {
    assert.equal(devinTranscriptsDir({ transcriptsDir: '/tmp/t' }), '/tmp/t')
    assert.equal(
      devinTranscriptsDir({}, { XDG_DATA_HOME: '/tmp/xdg' }),
      join('/tmp/xdg', 'devin', 'cli', 'session_locks', '..', 'transcripts')
    )
    assert.equal(
      devinTranscriptsDir({ lockDir: '/tmp/locks' }),
      join('/tmp/locks', 'transcripts')
    )
  })
})

describe('devinSessionTranscript', () => {
  test('resolves <name>.json when the file exists, undefined otherwise', () => {
    withLockDir((dir) => {
      writeFileSync(join(dir, 'sess-a.json'), '{}')
      assert.equal(devinSessionTranscript('sess-a', dir), join(dir, 'sess-a.json'))
      assert.equal(devinSessionTranscript('sess-b', dir), undefined)
    })
  })
})

const TRANSCRIPT = JSON.stringify({
  schema_version: 'ATIF-v1.7',
  session_id: 'sess-x',
  steps: [
    {
      step_id: 1,
      timestamp: '2026-10-16T20:00:00.000Z',
      source: 'system',
      message: '<additional_metadata>noise</additional_metadata>',
    },
    {
      step_id: 2,
      timestamp: '2026-10-16T20:01:00.000Z',
      source: 'agent',
      message: 'checking the provider template',
    },
    {
      step_id: 3,
      timestamp: '2026-10-16T20:01:05.000Z',
      source: 'agent',
      message: '',
      tool_calls: [
        {
          tool_call_id: 'exec:1',
          function_name: 'exec',
          arguments: { command: 'grep -rn loadAgentEnv packages/cli/src' },
        },
      ],
    },
    {
      step_id: 4,
      timestamp: '2026-10-16T20:02:00.000Z',
      source: 'user',
      message: 'ship it',
    },
    {
      step_id: 5,
      timestamp: '2026-10-16T20:03:00.000Z',
      source: 'system',
      message: '',
      tool_calls: [{ tool_call_id: 'exec:2', function_name: 'exec', arguments: { command: 'internal' } }],
    },
    {
      timestamp: '2026-10-16T20:04:00.000Z',
      source: 'agent',
      message: 'a step with no numeric step_id',
    },
  ],
})

describe('renderDevinTranscript', () => {
  test('renders messages and tool calls, elides system steps — tool calls included', () => {
    const r = renderDevinTranscript(TRANSCRIPT)
    assert.ok(r !== undefined)
    assert.equal(r.watermark, 5)
    const text = r.lines.join('\n')
    assert.match(text, /\[20:01:00\] agent: checking the provider template/)
    assert.match(text, /\[20:01:05\] → exec\(grep -rn loadAgentEnv packages\/cli\/src\)/)
    assert.match(text, /\[20:02:00\] user: ship it/)
    assert.match(text, /\[20:04:00\] agent: a step with no numeric step_id/)
    assert.doesNotMatch(text, /additional_metadata/)
    assert.doesNotMatch(text, /exec\(internal\)/)
    assert.match(text, /2 system steps elided/)
  })

  test('fromStepId resumes a follow watermark — id-less steps do not reprint', () => {
    const r = renderDevinTranscript(TRANSCRIPT, 3)
    assert.ok(r !== undefined)
    assert.equal(r.watermark, 5)
    assert.deepEqual(r.lines, [
      '[20:02:00] user: ship it',
      '[transcript] (1 system steps elided)',
    ])
  })

  test('a mid-rewrite torn JSON reports undefined instead of throwing', () => {
    assert.equal(renderDevinTranscript(TRANSCRIPT.slice(0, 40)), undefined)
    assert.equal(renderDevinTranscript('{"steps": null}'), undefined)
  })
})

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { SpawnError } from '@broject/core';
/** A scratch dir swept on exit — the fixture-leak contract: a test
 *  that dies leaves nothing behind. */
const tmpDirs: string[] = [];
let tmpSweepArmed = false;
function tmpDir(prefix: string): string {
  if (!tmpSweepArmed) {
    tmpSweepArmed = true;
    process.once('exit', () => {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

import {
  countDevinSessions,
  countDevinWorkers,
  devinLocksDir,
  devinLogsDir,
  devinPidIsBatch,
  devinPidIsWorker,
  devinSessionPlane,
  devinSessionTranscript,
  devinTranscriptsDir,
  listDevinSessions,
  renderDevinTranscript,
} from './plane.ts';

const withLockDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-devin-locks-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A fake /proc tree — <pid>/environ and <pid>/fd/0 as the test
 *  scripts them; absent files read as "no data" like on macOS. `tty`
 *  (a controlling-terminal device number) additionally scripts
 *  <pid>/stat — without it the tty probe reads "no data" and the
 *  stdin probe decides. */
/** A /proc starttime (field 22, jiffies since boot) reading as
 *  "started now" — the lock-bound check converts it against this
 *  host's real uptime, so the fixture scripts the real clock. */
const nowJiffies = (): number => Math.round(uptime() * 100);

const withProc = (
  fn: (
    procDir: string,
    mk: (
      pid: number,
      environ: string | null,
      stdinTo: string | null,
      argv0?: string,
      tty?: number,
      startJiffies?: number
    ) => void
  ) => void
): void => {
  const procDir = mkdtempSync(join(tmpdir(), 'bro-proc-'));
  const mk = (
    pid: number,
    environ: string | null,
    stdinTo: string | null,
    argv0 = 'devin',
    tty?: number,
    startJiffies?: number
  ): void => {
    const dir = join(procDir, String(pid));
    mkdirSync(join(dir, 'fd'), { recursive: true });
    if (environ !== null) {
      writeFileSync(join(dir, 'environ'), environ);
    }
    if (stdinTo !== null) {
      symlinkSync(stdinTo, join(dir, 'fd', '0'));
    }
    if (tty !== undefined || startJiffies !== undefined) {
      // the real shape: pid (comm) state ppid pgrp session tty_nr …
      // …starttime(22) — the comm may wrap in parens and hold spaces,
      // so both parsers go after the last ')' and index the tail:
      // tty_nr is rest[4] (field 7), starttime rest[19] (field 22).
      // Assign by index — a hand-counted zero run landing the start a
      // field off reads as 0, and the pin fails open unseen.
      const rest = Array.from({ length: 20 }, () => '0');
      rest[0] = 'S'; // state
      rest[1] = '1'; // ppid
      rest[2] = '1'; // pgrp
      rest[3] = '1'; // session
      rest[4] = String(tty ?? 0); // tty_nr — field 7
      rest[19] = String(startJiffies ?? 0); // starttime — field 22
      writeFileSync(join(dir, 'stat'), `${pid} (devin acp) ${rest.join(' ')}\n`);
    }
    // the identity the live-session count checks: argv[0] is the cli
    writeFileSync(join(dir, 'cmdline'), `${argv0}\0--flag\0`);
  };
  try {
    fn(procDir, mk);
  } finally {
    rmSync(procDir, { recursive: true, force: true });
  }
};

/** A fake /proc where the test process reads as the devin cli —
 *  the identity the live-session count checks (a lock's pid must still
 *  BE a devin process). */
const withDevinProc = (fn: (procDir: string) => void): void => {
  withProc((procDir, mk) => {
    mk(process.pid, 'PATH=/bin\0', null, 'devin');
    fn(procDir);
  });
};

/** A live process that reads as the devin cli — the live-session
 *  count checks the process identity (argv[0]), so the fixture must BE
 *  named devin: a lock's pid must still be the cli that wrote it. */
const spawnDevinCli = (env: Record<string, string> = {}): ChildProcess => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-devin-bin-'));
  const bin = join(dir, 'devin');
  symlinkSync('/bin/sleep', bin);
  return spawn(bin, ['30'], { stdio: 'ignore', env: { ...process.env, ...env } });
};

/** An `lstart=,command=` row as ps prints it — `day mon dd hh:mm:ss
 *  yyyy` (the 5-token spelling; a same-year row drops the year on
 *  some ps builds) followed by the space-joined argv. The start must
 *  be a REAL time — an epoch-0 row `Date.parse`s to a negative,
 *  TZ-shifted startMs, which is no honest live-session fixture. */
const psRow = (startMs: number, argv0: string): string => {
  const d = new Date(startMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getMonth()
  ];
  return `${day} ${mon} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()} ${argv0}`;
};

describe('devinSessionPlane', () => {
  test('detects the devin cli and nothing else', () => {
    assert.equal(devinSessionPlane.kind, 'devin');
    assert.equal(devinSessionPlane.detectsCli('devin'), true);
    assert.equal(devinSessionPlane.detectsCli('opencode'), false);
  });

  test('countLive scans the configured lockDir plus the worker env dir', () => {
    withDevinProc(procDir => {
      withLockDir(dir => {
        writeFileSync(join(dir, 'a.lock'), String(process.pid));
        assert.equal(devinSessionPlane.countLive({ lockDir: dir, procDir }), 1);
      });
    });
  });

  test('a spec.env XDG override makes countLive scan BOTH dirs', () => {
    withDevinProc(procDir => {
      withLockDir(dir => {
        const xdg = mkdtempSync(join(tmpdir(), 'bro-devin-xdg-'));
        try {
          const workerDir = join(xdg, 'devin', 'cli', 'session_locks');
          mkdirSync(workerDir, { recursive: true });
          // one lock in the spawner's dir, one in the worker's — both count
          writeFileSync(join(dir, 'a.lock'), String(process.pid));
          writeFileSync(join(workerDir, 'b.lock'), String(process.pid));
          assert.equal(
            devinSessionPlane.countLive({ lockDir: dir, procDir }, { XDG_DATA_HOME: xdg }),
            1 // same pid — dedupes
          );
        } finally {
          rmSync(xdg, { recursive: true, force: true });
        }
      });
    });
  });
});

describe('countDevinSessions', () => {
  test('counts unique live pids — duped locks and dead pids collapse', () => {
    withDevinProc(procDir => {
      withLockDir(dir => {
        // two locks, one live process (a resumed session's residue) — counts once
        writeFileSync(join(dir, 'a.lock'), String(process.pid));
        writeFileSync(join(dir, 'b.lock'), String(process.pid));
        // a pid guaranteed dead — the just-reaped child's pid
        const dead = spawnSync('true', [], { stdio: 'ignore' }).pid;
        writeFileSync(join(dir, 'dead.lock'), String(dead));
        // non-numeric content and non-lock files are skipped entirely
        writeFileSync(join(dir, 'junk.lock'), 'not-a-pid');
        writeFileSync(join(dir, 'note.txt'), String(process.pid));
        // strict pid parse — '123abc' is NOT 123; a trailing-garbage lock
        // must not collapse onto an innocent process's pid
        writeFileSync(join(dir, 'partial.lock'), `${process.pid}garbage`);
        assert.equal(countDevinSessions([dir], undefined, procDir), 1);
      });
    });
  });

  test('a RECYCLED pid is not a devin session — the lock is stale', () => {
    withProc((procDir, mk) => {
      withLockDir(dir => {
        // the session died and the number now belongs to another program
        mk(process.pid, 'PATH=/bin\0', null, '/usr/sbin/tailscaled');
        writeFileSync(join(dir, 'recycled.lock'), String(process.pid));
        assert.equal(countDevinSessions([dir], undefined, procDir), 0);
      });
    });
  });

  test('another CLI sharing the lock dir is not a devin session', () => {
    withProc((procDir, mk) => {
      withLockDir(dir => {
        // `pi` writes devin-shaped locks into the same directory — its
        // sessions draw on a different account
        mk(process.pid, 'PATH=/bin\0', null, 'omp');
        writeFileSync(join(dir, 'foreign.lock'), String(process.pid));
        assert.equal(countDevinSessions([dir], undefined, procDir), 0);
      });
    });
  });

  test('an unreadable pid entry counts — the count fails closed', () => {
    withProc(procDir => {
      withLockDir(dir => {
        // present but unreadable (a directory where the file belongs):
        // the identity cannot be disproved — count it
        rmSync(join(procDir, String(process.pid), 'cmdline'), { force: true });
        mkdirSync(join(procDir, String(process.pid), 'cmdline'), { recursive: true });
        writeFileSync(join(dir, 'blind.lock'), String(process.pid));
        assert.equal(countDevinSessions([dir], undefined, procDir), 1);
      });
    });
  });

  test('a pid that is GONE is not a session — the lock outlived it', () => {
    withProc(procDir => {
      withLockDir(dir => {
        // no /proc entry for the pid: the session died, the lock stayed
        rmSync(join(procDir, String(process.pid)), { recursive: true, force: true });
        writeFileSync(join(dir, 'gone.lock'), String(process.pid));
        assert.equal(countDevinSessions([dir], undefined, procDir), 0);
      });
    });
  });

  test('a pid recycled into ANOTHER devin process is stale — its start postdates the lock', () => {
    withProc((procDir, mk) => {
      withLockDir(dir => {
        // devin argv[0] passes the comm check — the serve-churn shape
        // (bro-q0v0e): a dead session's number landed on `devin acp` /
        // `devin rm`. The lock's own write bound is what proves it a
        // stranger: this pid started minutes after the file changed.
        mk(process.pid, 'PATH=/bin\0', null, 'devin', undefined, nowJiffies());
        const lock = join(dir, 'recycled.lock');
        writeFileSync(lock, String(process.pid));
        const aged = new Date(Date.now() - 10 * 60_000);
        utimesSync(lock, aged, aged);
        assert.equal(countDevinSessions([dir], undefined, procDir), 0);
      });
    });
  });

  test('a start inside the skew bound still counts — the lock/child race is not staleness', () => {
    withProc((procDir, mk) => {
      withLockDir(dir => {
        // observed live: a `devin --resume`'s acp child can start a
        // second or two after the lock lands — the pin's tolerance is
        // 60s, and 30s inside it stays a session
        mk(process.pid, 'PATH=/bin\0', null, 'devin', undefined, nowJiffies());
        const lock = join(dir, 'resumed.lock');
        writeFileSync(lock, String(process.pid));
        const aged = new Date(Date.now() - 30_000);
        utimesSync(lock, aged, aged);
        assert.equal(countDevinSessions([dir], undefined, procDir), 1);
      });
    });
  });

  test('a lock the count just watched being written counts — the start precedes it', () => {
    withProc((procDir, mk) => {
      withLockDir(dir => {
        // a real session: process started, devin wrote its lock — the
        // pid's start sits before the file's change bound. Clamp at
        // jiffy 1: a host up under ten minutes has no ten-minute-old
        // pid, and a negative start reads as unparseable → fail-open,
        // which would pass without exercising the pin. A boot-time
        // start still precedes the just-written lock's bound.
        mk(
          process.pid,
          'PATH=/bin\0',
          null,
          'devin',
          undefined,
          Math.max(1, nowJiffies() - 60_000)
        );
        writeFileSync(join(dir, 'live.lock'), String(process.pid));
        assert.equal(countDevinSessions([dir], undefined, procDir), 1);
      });
    });
  });

  test('no pid stat — the start pin is unverifiable and the pid stays counted', () => {
    withProc((procDir, mk) => {
      withLockDir(dir => {
        // argv0 reads devin but /proc/<pid>/stat is absent (a macOS
        // fixture shape): nothing can prove staleness — the pin must
        // not invent it
        mk(process.pid, 'PATH=/bin\0', null, 'devin');
        const lock = join(dir, 'blind.lock');
        writeFileSync(lock, String(process.pid));
        const aged = new Date(Date.now() - 10 * 60_000);
        utimesSync(lock, aged, aged);
        assert.equal(countDevinSessions([dir], undefined, procDir), 1);
      });
    });
  });

  test('a missing lock dir reads as zero sessions', () => {
    assert.equal(countDevinSessions([join(tmpdir(), 'bro-devin-locks-absent-')]), 0);
  });

  test('an unreadable lock dir fails closed — refuse, never pretend zero', () => {
    // a path where readdirSync fails non-ENOENT: a file posing as the dir
    const file = join(tmpDir('bro-devin-nodir-'), 'notdir');
    writeFileSync(file, 'x');
    assert.throws(() => countDevinSessions([file]), /not a directory|ENOTDIR/);
  });
});

describe('the no-/proc ps identity fallback (spec bro-74y7n)', () => {
  /** A procDir that cannot exist — the ps path's only gate. */
  const absentProc = (): string => join(tmpdir(), 'bro-proc-absent-');

  test('a devin argv0 counts; a foreign argv0 is a recycled pid — stale', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid));
      const now = Date.now();
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => psRow(now, 'devin')),
        1
      );
      // the session died, the number now belongs to another program —
      // the phantom the /proc cmdline check catches on linux, caught
      // here by argv[0]
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => psRow(now, 'tailscaled')),
        0
      );
    });
  });

  test('an argv0 may arrive as a path — the basename carries the identity', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid));
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () =>
          psRow(Date.now(), '/usr/local/bin/devin')
        ),
        1
      );
    });
  });

  test('a ps that cannot answer counts — the count fails closed', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid));
      // a failed spawn / nonzero exit — a live pid ps fails to match
      // is indistinguishable from no ps at all; NEVER 'gone'
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => undefined),
        1
      );
    });
  });

  test('a clean run naming no such pid reads the lock stale', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'gone.lock'), String(process.pid));
      // empty stdout on a successful run: the pid died between the
      // liveness probe and the ps call — proven gone, not unverifiable
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => ''),
        0
      );
    });
  });

  test('a row ps printed but cannot be split still counts — unverifiable is not stale', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'weird.lock'), String(process.pid));
      // no Date.parse-able lstart prefix — neither fact can be trusted
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => 'total garbage'),
        1
      );
    });
  });

  test('a devin argv0 whose lstart postdates the lock bound is a stranger', () => {
    withLockDir(dir => {
      // devin argv0 passes the identity check — the serve-churn shape
      // (bro-q0v0e). The lock's write bound is what proves it a
      // stranger: this pid started minutes after the file changed.
      const lock = join(dir, 'recycled.lock');
      writeFileSync(lock, String(process.pid));
      const aged = new Date(Date.now() - 10 * 60_000);
      utimesSync(lock, aged, aged);
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => psRow(Date.now(), 'devin')),
        0
      );
    });
  });

  test('a start inside the skew bound counts — the lock/child race is not staleness', () => {
    withLockDir(dir => {
      const lock = join(dir, 'resumed.lock');
      writeFileSync(lock, String(process.pid));
      const aged = new Date(Date.now() - 30_000);
      utimesSync(lock, aged, aged);
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => psRow(Date.now(), 'devin')),
        1
      );
    });
  });

  test('one lock costs ONE ps call — identity and the start pin read the same row', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid));
      let calls = 0;
      const ps = (): string => {
        calls += 1;
        // a SECOND read could already see the number recycled — the
        // verdict must come off the first row alone (same-pid TOCTOU)
        return calls === 1 ? psRow(Date.now(), 'devin') : psRow(Date.now(), 'tailscaled');
      };
      assert.equal(countDevinSessions([dir], undefined, absentProc(), ps), 1);
      assert.equal(calls, 1);
    });
  });

  test('a live session whose row carries no lstart stays counted', () => {
    withLockDir(dir => {
      // a bare program name is not a split-able row — no parseable
      // lstart prefix means the argv boundary cannot be trusted
      // either, so the pin fails open like an absent /proc/<pid>/stat
      const lock = join(dir, 'nostart.lock');
      writeFileSync(lock, String(process.pid));
      const aged = new Date(Date.now() - 10 * 60_000);
      utimesSync(lock, aged, aged);
      assert.equal(
        countDevinSessions([dir], undefined, absentProc(), () => 'devin'),
        1
      );
    });
  });

  test('listDevinSessions rows a ps-verified live pid — classifier facts stay unverifiable', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'sess.lock'), String(process.pid));
      const rows = listDevinSessions([dir], absentProc(), () => psRow(Date.now(), 'devin'));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.name, 'sess');
      // environ/fd have no ps spelling — the row degrades per the
      // undercount contract, never inventing a worker
      assert.equal(rows[0]!.worker, false);
      assert.equal(rows[0]!.agentId, undefined);
    });
  });

  test('the real ps answers for a live devin-named child — and against a foreign one', () => {
    // integration through the real `ps` binary — argv[0] is the
    // invoked path's basename on any host, but CI runs linux. The
    // fixture must carry the NAME 'devin' on a binary that stays
    // alive: a symlinked sleep dies on the multicall's unknown applet
    // — a copy of the node binary named devin is the honest shape
    // (node renames its comm to node-MainThread, which is exactly why
    // the probe reads argv[0] and not comm)
    if (process.platform !== 'linux') {
      return;
    }
    const bindir = mkdtempSync(join(tmpdir(), 'bro-devin-bin-'));
    const bin = join(bindir, 'devin');
    try {
      linkSync(process.execPath, bin);
    } catch {
      copyFileSync(process.execPath, bin); // cross-device tmp — no hardlink
    }
    const devin = spawn(bin, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    if (!devin.pid || !sleeper.pid) {
      throw new Error('spawn failed to create child process');
    }
    try {
      withLockDir(dir => {
        writeFileSync(join(dir, 'live.lock'), String(devin.pid));
        writeFileSync(join(dir, 'stale.lock'), String(sleeper.pid));
        assert.equal(countDevinSessions([dir], undefined, absentProc()), 1);
      });
    } finally {
      devin.kill('SIGKILL');
      sleeper.kill('SIGKILL');
      rmSync(bindir, { recursive: true, force: true });
    }
  });
});

describe('devinPidIsWorker', () => {
  test('BRO_HOOKS=0 marks a machine backend service child as not a worker', () => {
    withProc((procDir, mk) => {
      mk(601, 'PATH=/bin\0BRO_HOOKS=0\0', 'pipe:[1]');
      assert.equal(devinPidIsWorker(601, procDir), false);
      // BRO_AGENT_ID takes precedence — a real bro worker must count even if it inherits BRO_HOOKS=0
      mk(602, 'PATH=/bin\0BRO_HOOKS=0\0BRO_AGENT_ID=abc\0', 'pipe:[1]');
      assert.equal(devinPidIsWorker(602, procDir), true);
      // lookalikes must not trigger the exclusion (NUL-anchored like BRO_AGENT_ID)
      mk(603, 'PATH=/bin\0XBRO_HOOKS=0\0', 'pipe:[1]');
      assert.equal(devinPidIsWorker(603, procDir), true);
      mk(604, 'PATH=/bin\0BRO_HOOKS=00\0', 'pipe:[1]');
      assert.equal(devinPidIsWorker(604, procDir), true);
    });
  });

  test('the BRO_AGENT_ID env badge classifies a worker — NUL-anchored', () => {
    withProc((procDir, mk) => {
      mk(101, 'PATH=/bin\0BRO_AGENT_ID=native-abc\0HOME=/h\0', '/dev/pts/3');
      assert.equal(devinPidIsWorker(101, procDir), true);
      // a lookalike suffix must not alias — the anchor rejects XBRO_AGENT_ID
      mk(102, 'PATH=/bin\0XBRO_AGENT_ID=spoof\0', '/dev/pts/3');
      assert.equal(devinPidIsWorker(102, procDir), false);
    });
  });

  test('non-pty stdin classifies a worker, a pty does not', () => {
    withProc((procDir, mk) => {
      mk(201, 'PATH=/bin\0', 'pipe:[1234]');
      assert.equal(devinPidIsWorker(201, procDir), true);
      mk(202, 'PATH=/bin\0', '/dev/null');
      assert.equal(devinPidIsWorker(202, procDir), true);
      mk(203, 'PATH=/bin\0', '/dev/pts/2');
      assert.equal(devinPidIsWorker(203, procDir), false);
    });
  });

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
        mk(pid, 'PATH=/bin\0', dev);
        assert.equal(devinPidIsWorker(pid, procDir), false, `${dev} must not be a worker`);
      }
      mk(405, 'PATH=/bin\0', 'socket:[99]');
      assert.equal(devinPidIsWorker(405, procDir), true);
    });
  });

  test('no verifiable data is NOT a worker — undercount never invents workers', () => {
    withProc((procDir, mk) => {
      mk(301, null, null); // no environ, no fd/0 — macOS-equivalent blind
      assert.equal(devinPidIsWorker(301, procDir), false);
      mk(302, 'PATH=/bin\0', null); // environ read, no badge, stdin unknown
      assert.equal(devinPidIsWorker(302, procDir), false);
    });
  });

  test("the REPL's spawned acp child — piped fd/0 but the REPL's terminal — is not a worker", () => {
    withProc((procDir, mk) => {
      // the devin CLI's chisel_acp_client child holds the session lock
      // with a piped fd/0 while sharing the REPL's controlling terminal
      // (observed 2026-11-04: two such children read as 'devin workers:
      // 2/1 live' and walled the whole devin spawn lane)
      mk(501, 'PATH=/bin\0', 'pipe:[33601833]', 'devin', 34822);
      assert.equal(devinPidIsWorker(501, procDir), false);
      // the REPL itself reads interactive on either probe
      mk(502, 'PATH=/bin\0', '/dev/pts/6', 'devin', 34822);
      assert.equal(devinPidIsWorker(502, procDir), false);
    });
  });

  test('the worker badge still wins over a controlling terminal', () => {
    withProc((procDir, mk) => {
      mk(511, 'PATH=/bin\0BRO_AGENT_ID=native-abc\0', 'pipe:[2]', 'devin', 34822);
      assert.equal(devinPidIsWorker(511, procDir), true);
    });
  });

  test('a terminal-less pid with piped stdin is still a spawned worker', () => {
    withProc((procDir, mk) => {
      mk(521, 'PATH=/bin\0', 'pipe:[42]', 'devin', 0);
      assert.equal(devinPidIsWorker(521, procDir), true);
    });
  });
});

describe('devinPidIsBatch (spec bro-9h86l)', () => {
  test('the supervisor marker in the worker env classifies the fleet lane', () => {
    withProc((procDir, mk) => {
      // a fleet spawn — the marker the fleet sets on every spawn
      mk(501, 'PATH=/bin\0BRO_BATCH=1\0BRO_PR=599\0', 'pipe:[1]');
      assert.equal(devinPidIsBatch(501, procDir), true);
      mk(502, 'PATH=/bin\0BRO_BATCH=1\0', 'pipe:[1]');
      assert.equal(devinPidIsBatch(502, procDir), true);
      // an EMPTY marker is not a marker — the spawn side says so too
      mk(506, 'PATH=/bin\0BRO_BATCH=\0', 'pipe:[1]');
      assert.equal(devinPidIsBatch(506, procDir), false);
      // the operator's own session — no marker
      mk(503, 'PATH=/bin\0HOME=/h\0', 'pipe:[1]');
      assert.equal(devinPidIsBatch(503, procDir), false);
    });
  });

  test('NUL-anchored — a lookalike suffix does not classify', () => {
    withProc((procDir, mk) => {
      mk(504, 'PATH=/bin\0XBRO_BATCH=spoof\0', 'pipe:[1]');
      assert.equal(devinPidIsBatch(504, procDir), false);
    });
  });

  test("an unclassifiable live worker counts as the fleet's — the cap fails closed", () => {
    withProc((procDir, mk) => {
      // the environ EXISTS but cannot be read: the pid is a live session
      // it cannot classify, and a quota that cannot be established must
      // not be passed silently. (A directory where the file belongs
      // gives EISDIR — "present, unreadable", not "gone".)
      mk(505, null, null);
      mkdirSync(join(procDir, '505', 'environ'), { recursive: true });
      assert.equal(devinPidIsBatch(505, procDir), true);
    });
  });

  test('a pid that is GONE counts for nobody', () => {
    withProc((procDir, mk) => {
      // no environ file at all: the process exited between the liveness
      // check and the read — it holds no slot
      mk(507, null, null);
      assert.equal(devinPidIsBatch(507, procDir), false);
    });
  });
});

describe('countDevinWorkers', () => {
  test('counts only worker-classified live pids', () => {
    withDevinProc(procDir => {
      withLockDir(dir => {
        writeFileSync(join(dir, 'a.lock'), String(process.pid));
        const workers = new Set<number>();
        const isWorker = (pid: number): boolean => workers.has(pid);
        assert.equal(countDevinWorkers([dir], isWorker, undefined, procDir), 0);
        workers.add(process.pid);
        assert.equal(countDevinWorkers([dir], isWorker, undefined, procDir), 1);
      });
    });
  });

  test('a real spawned child carrying BRO_AGENT_ID reads as a worker', async () => {
    const child = spawnDevinCli({ BRO_AGENT_ID: 'native-test' });
    if (!child.pid) throw new Error('spawn failed to create child process');
    try {
      withLockDir(dir => {
        writeFileSync(join(dir, 'w.lock'), String(child.pid));
        assert.equal(countDevinWorkers([dir]), 1);
      });
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('a landed worker retires its own reservation slot — no double count', () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    if (!child.pid) throw new Error('spawn failed to create child process');
    const pid = child.pid;
    try {
      // scripted /proc, not the real child's environ: spawn() resolves
      // at fork — until execve lands, /proc/<pid>/environ still reads
      // the PARENT's env (no badge → the sweep misses the landing),
      // which is the flake this test carried under full-suite load
      withProc((procDir, mk) => {
        mk(pid, 'PATH=/bin\0BRO_AGENT_ID=native-landed\0HOME=/h\0', null);
        withLockDir(dir => {
          writeFileSync(join(dir, 'w.lock'), String(pid));
          const resv = mkdtempSync(join(tmpdir(), 'bro-devin-slots-'));
          try {
            const landed = join(resv, 'native-landed-a1b2c3d4.slot');
            const inflight = join(resv, 'native-inflight-e5f6a7b8.slot');
            writeFileSync(landed, String(Date.now()));
            writeFileSync(inflight, String(Date.now()));
            assert.equal(countDevinSessions([dir], resv, procDir), 1);
            // the landed spawn's slot is gone; an unrelated in-flight
            // claim stays for the tally
            assert.equal(existsSync(landed), false);
            assert.equal(existsSync(inflight), true);
          } finally {
            rmSync(resv, { recursive: true, force: true });
          }
        });
      });
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('no /proc + live sessions → the worker count fails closed', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'a.lock'), String(process.pid));
      const absent = join(tmpdir(), 'bro-proc-absent-');
      // the lock's pid must be a LIVE devin session for the gate to be
      // reached at all — a no-/proc host answers identity over the ps
      // probe, scripted here (spec bro-74y7n)
      const devinPs = (): string => psRow(Date.now(), 'devin --resume');
      assert.throws(
        () => countDevinWorkers([dir], devinPidIsWorker, undefined, absent, devinPs),
        (e: unknown) => e instanceof SpawnError && e.kind === 'unavailable'
      );
      // an injected classifier doesn't probe /proc — no throw
      assert.equal(
        countDevinWorkers([dir], () => false, undefined, absent, devinPs),
        0
      );
    });
    // zero live sessions are verifiably zero workers on any host
    assert.equal(
      countDevinWorkers(
        [join(tmpdir(), 'bro-devin-locks-absent-')],
        devinPidIsWorker,
        undefined,
        'nope'
      ),
      0
    );
  });
});

describe('listDevinSessions', () => {
  test('live locks yield rows named for the session — dead, duped, and junk locks collapse', () => {
    withProc((procDir, mk) => {
      mk(process.pid, 'PATH=/bin\0', '/dev/pts/1');
      withLockDir(dir => {
        writeFileSync(join(dir, 'sess-a.lock'), String(process.pid));
        const dead = spawnSync('true', [], { stdio: 'ignore' }).pid;
        writeFileSync(join(dir, 'dead.lock'), String(dead));
        writeFileSync(join(dir, 'junk.lock'), 'not-a-pid');
        writeFileSync(join(dir, 'note.txt'), String(process.pid));
        const rows = listDevinSessions([dir], procDir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.name, 'sess-a');
        assert.equal(rows[0]!.pid, process.pid);
        // a pty stdin, no badge — the same undercount contract the
        // worker lane holds: live, but not verifiably a worker
        assert.equal(rows[0]!.worker, false);
        assert.equal(rows[0]!.agentId, undefined);
      });
    });
  });

  test('a stale (recycled-pid) lock yields no row — the write bound rejects it', () => {
    withProc((procDir, mk) => {
      mk(process.pid, 'PATH=/bin\0', null, 'devin', undefined, nowJiffies());
      withLockDir(dir => {
        const lock = join(dir, 'phantom.lock');
        writeFileSync(lock, String(process.pid));
        const aged = new Date(Date.now() - 10 * 60_000);
        utimesSync(lock, aged, aged);
        assert.equal(listDevinSessions([dir], procDir).length, 0);
      });
    });
  });

  test('a duped lock for one pid yields one row', () => {
    withProc((procDir, mk) => {
      mk(process.pid, null, null);
      withLockDir(dir => {
        writeFileSync(join(dir, 'a.lock'), String(process.pid));
        writeFileSync(join(dir, 'b.lock'), String(process.pid));
        const rows = listDevinSessions([dir], procDir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.pid, process.pid);
      });
    });
  });

  test('a real spawned worker carries its BRO_AGENT_ID badge into the row', async () => {
    const child = spawnDevinCli({ BRO_AGENT_ID: 'native-xyz' });
    if (!child.pid) throw new Error('spawn failed to create child process');
    try {
      withLockDir(dir => {
        writeFileSync(join(dir, 'w.lock'), String(child.pid));
        const rows = listDevinSessions([dir]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.worker, true);
        assert.equal(rows[0]!.agentId, 'native-xyz');
      });
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('the plane wires listLive over the configured lockDir', () => {
    withDevinProc(procDir => {
      withLockDir(dir => {
        writeFileSync(join(dir, 'x.lock'), String(process.pid));
        const rows = devinSessionPlane.listLive!({ lockDir: dir, procDir });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.name, 'x');
      });
    });
  });
});

describe('devinLocksDir', () => {
  test('explicit override wins; XDG_DATA_HOME otherwise', () => {
    assert.equal(devinLocksDir({ lockDir: '/tmp/x' }), '/tmp/x');
    assert.equal(
      devinLocksDir({}, { XDG_DATA_HOME: '/tmp/xdg' }),
      join('/tmp/xdg', 'devin', 'cli', 'session_locks')
    );
    assert.equal(
      devinLocksDir({}, { HOME: '/tmp/home' }),
      join('/tmp/home', '.local', 'share', 'devin', 'cli', 'session_locks')
    );
  });
});

describe('devinLogsDir', () => {
  test('explicit override wins; a lockDir override confines the default inside it', () => {
    assert.equal(devinLogsDir({ logsDir: '/tmp/l' }), '/tmp/l');
    assert.equal(
      devinLogsDir({}, { XDG_DATA_HOME: '/tmp/xdg' }),
      join('/tmp/xdg', 'devin', 'cli', 'session_locks', '..', 'logs')
    );
    // lockDir overridden without logsDir — a '../logs' sibling would
    // escape the chosen root; the default nests inside the override
    assert.equal(devinLogsDir({ lockDir: '/tmp/locks' }), join('/tmp/locks', 'logs'));
  });
});

describe('devinTranscriptsDir', () => {
  test('explicit override wins; a lockDir override confines the default inside it', () => {
    assert.equal(devinTranscriptsDir({ transcriptsDir: '/tmp/t' }), '/tmp/t');
    assert.equal(
      devinTranscriptsDir({}, { XDG_DATA_HOME: '/tmp/xdg' }),
      join('/tmp/xdg', 'devin', 'cli', 'session_locks', '..', 'transcripts')
    );
    assert.equal(devinTranscriptsDir({ lockDir: '/tmp/locks' }), join('/tmp/locks', 'transcripts'));
  });
});

describe('devinSessionTranscript', () => {
  test('resolves <name>.json when the file exists, undefined otherwise', () => {
    withLockDir(dir => {
      writeFileSync(join(dir, 'sess-a.json'), '{}');
      assert.equal(devinSessionTranscript('sess-a', dir), join(dir, 'sess-a.json'));
      assert.equal(devinSessionTranscript('sess-b', dir), undefined);
    });
  });
});

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
      tool_calls: [
        { tool_call_id: 'exec:2', function_name: 'exec', arguments: { command: 'internal' } },
      ],
    },
    {
      timestamp: '2026-10-16T20:04:00.000Z',
      source: 'agent',
      message: 'a step with no numeric step_id',
    },
  ],
});

describe('renderDevinTranscript', () => {
  test('renders messages and tool calls, elides system steps — tool calls included', () => {
    const r = renderDevinTranscript(TRANSCRIPT);
    assert.ok(r !== undefined);
    assert.equal(r.watermark, 5);
    const text = r.lines.join('\n');
    assert.match(text, /\[20:01:00\] agent: checking the provider template/);
    assert.match(text, /\[20:01:05\] → exec\(grep -rn loadAgentEnv packages\/cli\/src\)/);
    assert.match(text, /\[20:02:00\] user: ship it/);
    assert.match(text, /\[20:04:00\] agent: a step with no numeric step_id/);
    assert.doesNotMatch(text, /additional_metadata/);
    assert.doesNotMatch(text, /exec\(internal\)/);
    assert.match(text, /2 system steps elided/);
  });

  test('fromStepId resumes a follow watermark — id-less steps do not reprint', () => {
    const r = renderDevinTranscript(TRANSCRIPT, 3);
    assert.ok(r !== undefined);
    assert.equal(r.watermark, 5);
    assert.deepEqual(r.lines, ['[20:02:00] user: ship it', '[transcript] (1 system steps elided)']);
  });

  test('a mid-rewrite torn JSON reports undefined instead of throwing', () => {
    assert.equal(renderDevinTranscript(TRANSCRIPT.slice(0, 40)), undefined);
    assert.equal(renderDevinTranscript('{"steps": null}'), undefined);
  });
});

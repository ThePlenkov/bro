import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalProbeCtx } from '@broject/core';
import { devinExternalActivity } from './plane.ts';

/** A fake /proc tree — same shape plane.test.ts scripts: <pid>/environ,
 *  <pid>/fd/0, <pid>/cmdline (the live-session identity check). */
const withProc = (
  fn: (
    procDir: string,
    mk: (pid: number, environ: string | null, stdinTo: string | null, argv0?: string) => void
  ) => void
): void => {
  const procDir = mkdtempSync(join(tmpdir(), 'bro-proc-'));
  const mk = (
    pid: number,
    environ: string | null,
    stdinTo: string | null,
    argv0 = 'devin'
  ): void => {
    const dir = join(procDir, String(pid));
    mkdirSync(join(dir, 'fd'), { recursive: true });
    if (environ !== null) {
      writeFileSync(join(dir, 'environ'), environ);
    }
    if (stdinTo !== null) {
      symlinkSync(stdinTo, join(dir, 'fd', '0'));
    }
    writeFileSync(join(dir, 'cmdline'), `${argv0}\0--flag\0`);
  };
  try {
    fn(procDir, mk);
  } finally {
    rmSync(procDir, { recursive: true, force: true });
  }
};

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** A probe ctx pinning every state dir to scratch dirs. */
function ctx(
  dirs: { lockDir: string; procDir: string; logsDir: string; transcriptsDir: string },
  holdMs = 480_000
): ExternalProbeCtx {
  return {
    dir: tmp('bro-ext-root-'),
    agents: { devin: dirs },
    env: {},
    holdMs,
    now: Date.now(),
  };
}

function dirs(): { lockDir: string; procDir: string; logsDir: string; transcriptsDir: string } {
  return {
    lockDir: tmp('bro-ext-locks-'),
    procDir: '',
    logsDir: tmp('bro-ext-logs-'),
    transcriptsDir: tmp('bro-ext-trans-'),
  };
}

describe('devinExternalActivity (spec bro-eqi2d)', () => {
  test('a bro-badged worker is not external — BRO_AGENT_ID and BRO_HOOKS=0 both exclude', () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      mk(process.pid, 'PATH=/bin\0BRO_AGENT_ID=native-x\0', null);
      writeFileSync(join(d.lockDir, 'a.lock'), String(process.pid));
      const r = devinExternalActivity(ctx(d));
      assert.equal(r.active, false);
      rmSync(join(procDir, String(process.pid), 'environ'));
      writeFileSync(join(procDir, String(process.pid), 'environ'), 'BRO_HOOKS=0\0PATH=/bin\0');
      assert.equal(devinExternalActivity(ctx(d)).active, false);
    });
  });

  test('a live interactive session inside the hold window blocks', () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      // a pty stdin, no badge — an interactive foreign session
      mk(process.pid, 'PATH=/bin\0', '/dev/pts/2');
      writeFileSync(join(d.lockDir, 'peach.lock'), String(process.pid));
      const r = devinExternalActivity(ctx(d));
      assert.equal(r.active, true);
      assert.match(r.detail ?? '', /interactive devin session 'peach'.*pid/);
    });
  });

  test("a foreign headless session is external too — worker or not, it is not bro's", () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      mk(process.pid, 'PATH=/bin\0', 'pipe:[9]');
      writeFileSync(join(d.lockDir, 'worker.lock'), String(process.pid));
      const r = devinExternalActivity(ctx(d));
      assert.equal(r.active, true);
      assert.match(r.detail ?? '', /devin session 'worker'/);
    });
  });

  test('a session past the idle window releases — transcript mtime is the stamp', () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      mk(process.pid, 'PATH=/bin\0', '/dev/pts/2');
      writeFileSync(join(d.lockDir, 'peach.lock'), String(process.pid));
      // a transcript written long ago — the session is live but idle
      const stale = join(d.transcriptsDir, 'peach.json');
      writeFileSync(stale, '{}');
      const old = new Date(Date.now() - 3600_000);
      utimesSync(stale, old, old);
      const r = devinExternalActivity(ctx(d));
      assert.equal(r.active, false);
      // and a FRESH transcript holds the guard
      const fresh = new Date();
      utimesSync(stale, fresh, fresh);
      assert.equal(devinExternalActivity(ctx(d)).active, true);
    });
  });

  test('the session log mtime is the other activity stamp', () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      mk(process.pid, 'PATH=/bin\0', '/dev/pts/2');
      writeFileSync(join(d.lockDir, 'peach.lock'), String(process.pid));
      // a stale transcript but a fresh output log — still active
      const stale = join(d.transcriptsDir, 'peach.json');
      writeFileSync(stale, '{}');
      const old = new Date(Date.now() - 3600_000);
      utimesSync(stale, old, old);
      writeFileSync(join(d.logsDir, `devin_20260101_${process.pid}.log`), 'x');
      assert.equal(devinExternalActivity(ctx(d)).active, true);
    });
  });

  test('an unreadable environ counts external — ownership cannot be proven', () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      mk(process.pid, null, null);
      // environ present but unreadable (a directory) — EISDIR, not absent
      mkdirSync(join(procDir, String(process.pid), 'environ'), { recursive: true });
      writeFileSync(join(d.lockDir, 'blind.lock'), String(process.pid));
      assert.equal(devinExternalActivity(ctx(d)).active, true);
    });
  });

  test("a dead pid's lock is not a live session", () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      const dead = spawnSync('true', [], { stdio: 'ignore' }).pid;
      mk(dead, 'PATH=/bin\0', '/dev/pts/2');
      rmSync(join(procDir, String(dead)), { recursive: true, force: true });
      writeFileSync(join(d.lockDir, 'dead.lock'), String(dead));
      assert.equal(devinExternalActivity(ctx(d)).active, false);
    });
  });

  test("a resumed session — the second lock's transcript carries the live stamp", () => {
    withProc((procDir, mk) => {
      const d = dirs();
      d.procDir = procDir;
      mk(process.pid, 'PATH=/bin\0', '/dev/pts/2');
      writeFileSync(join(d.lockDir, 'aaa.lock'), String(process.pid));
      writeFileSync(join(d.lockDir, 'zzz.lock'), String(process.pid));
      // the FIRST (sorted) name's transcript is ancient; the resumed
      // name's is fresh — reading only one lock name misses it
      const staleT = join(d.transcriptsDir, 'aaa.json');
      writeFileSync(staleT, '{}');
      const old = new Date(Date.now() - 3600_000);
      utimesSync(staleT, old, old);
      writeFileSync(join(d.transcriptsDir, 'zzz.json'), '{}');
      assert.equal(devinExternalActivity(ctx(d)).active, true);
    });
  });

  test("a worker-env XDG redirect — stamps searched beside the worker's locks", () => {
    withProc((procDir, mk) => {
      const spawnerXdg = tmp('bro-ext-xdg-');
      const workerXdg = tmp('bro-ext-xdgw-');
      const wLocks = join(workerXdg, 'devin', 'cli', 'session_locks');
      const wTrans = join(workerXdg, 'devin', 'cli', 'transcripts');
      try {
        for (const d of [join(spawnerXdg, 'devin', 'cli', 'session_locks'), wLocks, wTrans]) {
          mkdirSync(d, { recursive: true });
        }
        mk(process.pid, 'PATH=/bin\0', '/dev/pts/2');
        writeFileSync(join(wLocks, 'peach.lock'), String(process.pid));
        // a stale transcript under the WORKER's data dir proves idle —
        // the spawner's dirs alone read "no stamp" = active forever
        const tr = join(wTrans, 'peach.json');
        writeFileSync(tr, '{}');
        const old = new Date(Date.now() - 3600_000);
        utimesSync(tr, old, old);
        const c: ExternalProbeCtx = {
          dir: tmp('bro-ext-root-'),
          agents: { devin: { procDir } },
          env: { XDG_DATA_HOME: spawnerXdg },
          workerEnv: { XDG_DATA_HOME: workerXdg },
          holdMs: 480_000,
          now: Date.now(),
        };
        assert.equal(devinExternalActivity(c).active, false);
        // a fresh stamp there holds the guard
        const fresh = new Date();
        utimesSync(tr, fresh, fresh);
        assert.equal(devinExternalActivity(c).active, true);
      } finally {
        rmSync(spawnerXdg, { recursive: true, force: true });
        rmSync(workerXdg, { recursive: true, force: true });
      }
    });
  });

  test('no devin install → quiet', () => {
    const d = dirs();
    d.procDir = tmp('bro-ext-proc-');
    assert.equal(devinExternalActivity(ctx(d)).active, false);
  });
});

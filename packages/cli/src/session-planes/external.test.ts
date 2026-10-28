import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalProbeCtx } from '@broject/core';
import { foreignOpencodePids, opencodeExternalActivity } from './opencode.ts';
import { markersExternalActivity } from './markers.ts';
import { copilotExternalActivity, writeCopilotCount } from './copilot.ts';
import { procStat, writeAgentRegistry } from '@broject/core';
import { initRepo } from '../commands/testrepo.ts';

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const CTX = (over: Partial<ExternalProbeCtx>): ExternalProbeCtx => ({
  dir: tmp('bro-ext-root-'),
  agents: {},
  env: {},
  holdMs: 480_000,
  now: Date.now(),
  ...over,
});

/** A scripted /proc for opencode — <pid>/cmdline + <pid>/environ; the
 *  pid is process.pid (a live pid the liveness check accepts). */
function mkOpencodeProc(
  procDir: string,
  pid: number,
  argv: string[],
  environ: string | null
): void {
  const dir = join(procDir, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  if (environ !== null) {
    writeFileSync(join(dir, 'environ'), environ);
  }
}

describe('opencode external plane (spec bro-eqi2d)', () => {
  test('a live foreign opencode with fresh state blocks; stale releases', () => {
    const procDir = tmp('bro-oc-proc-');
    const dataDir = tmp('bro-oc-data-');
    try {
      mkOpencodeProc(
        procDir,
        process.pid,
        ['/usr/bin/opencode', '--session', 'ses_x'],
        'PATH=/bin\0'
      );
      const agents = { opencode: { procDir, dataDir } };
      // no state files at all → live but cannot prove idle → active
      assert.equal(opencodeExternalActivity(CTX({ agents })).active, true);
      // fresh wal → active
      writeFileSync(join(dataDir, 'opencode.db-wal'), 'x');
      assert.equal(opencodeExternalActivity(CTX({ agents })).active, true);
      // stale wal → idle → released
      const old = new Date(Date.now() - 3600_000);
      utimesSync(join(dataDir, 'opencode.db-wal'), old, old);
      const r = opencodeExternalActivity(CTX({ agents }));
      assert.equal(r.active, false);
      assert.equal(r.activityAtMs, old.getTime());
    } finally {
      rmSync(procDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a bro-badged opencode worker does not count; `serve` is not a session', () => {
    const procDir = tmp('bro-oc-proc-');
    try {
      mkOpencodeProc(
        procDir,
        process.pid,
        ['opencode', '--session', 'ses_x'],
        'BRO_AGENT_ID=n-x\0'
      );
      mkOpencodeProc(procDir, process.ppid, ['opencode', 'serve', '--service'], 'PATH=/bin\0');
      assert.deepEqual(foreignOpencodePids(procDir), []);
    } finally {
      rmSync(procDir, { recursive: true, force: true });
    }
  });

  test('an unreadable environ counts external — ownership cannot be proven', () => {
    const procDir = tmp('bro-oc-proc-');
    try {
      // no environ file → cannot prove bro's → external
      mkOpencodeProc(procDir, process.pid, ['opencode'], null);
      assert.deepEqual(foreignOpencodePids(procDir), [process.pid]);
    } finally {
      rmSync(procDir, { recursive: true, force: true });
    }
  });

  test('no /proc tree → quiet', () => {
    const agents = { opencode: { procDir: join(tmpdir(), 'bro-oc-absent-') } };
    assert.equal(opencodeExternalActivity(CTX({ agents })).active, false);
  });
});

describe('session-markers external plane (spec bro-eqi2d)', () => {
  /** A hooks dir with a marker — line1 `<millis> [pid start]` like the
   *  writers stamp; process.pid is a live owner. */
  const withHooks = (
    fn: (dir: string, agents: Record<string, Record<string, unknown>>) => void
  ): void => {
    const hooksDir = tmp('bro-ext-hooks-');
    const procDir = tmp('bro-ext-proc-');
    try {
      fn(hooksDir, { 'session-markers': { hooksDir, procDir } });
    } finally {
      rmSync(hooksDir, { recursive: true, force: true });
      rmSync(procDir, { recursive: true, force: true });
    }
  };

  const procEntry = (procDir: string, pid: number, environ: string): void => {
    const dir = join(procDir, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'environ'), environ);
  };

  test('a live foreign-owned .work marker inside the window blocks', () => {
    withHooks((hooksDir, agents) => {
      procEntry(agents['session-markers']!['procDir'] as string, process.pid, 'PATH=/bin\0');
      writeFileSync(
        join(hooksDir, 'sess-1.work'),
        `${Date.now()} ${process.pid} ${procStat(process.pid)?.start ?? ''}\nbro-x\n`
      );
      const r = markersExternalActivity(CTX({ agents }));
      assert.equal(r.active, true);
      assert.match(r.detail ?? '', /session 'sess-1' armed work/);
    });
  });

  test('a bro-owned marker does not count — BRO_AGENT_ID on the owner', () => {
    withHooks((hooksDir, agents) => {
      procEntry(agents['session-markers']!['procDir'] as string, process.pid, 'BRO_AGENT_ID=n-x\0');
      writeFileSync(
        join(hooksDir, 'agent-n-x.work'),
        `${Date.now()} ${process.pid} ${procStat(process.pid)?.start ?? ''}\nfx-1\n`
      );
      assert.equal(markersExternalActivity(CTX({ agents })).active, false);
    });
  });

  test('a stale foreign marker releases — the arm stamp is the activity bound', () => {
    withHooks((hooksDir, agents) => {
      const procDir = agents['session-markers']!['procDir'] as string;
      procEntry(procDir, process.pid, 'PATH=/bin\0');
      const p = join(hooksDir, 'sess-1.work');
      writeFileSync(
        p,
        `${Date.now() - 3600_000} ${process.pid} ${procStat(process.pid)?.start ?? ''}\nbro-x\n`
      );
      const old = new Date(Date.now() - 3600_000);
      utimesSync(p, old, old);
      assert.equal(markersExternalActivity(CTX({ agents })).active, false);
    });
  });

  test('an ownerless marker never counts — no verifiable agent', () => {
    withHooks((hooksDir, agents) => {
      writeFileSync(join(hooksDir, 'human-1.work'), `${Date.now()}\nbro-x\n`);
      assert.equal(markersExternalActivity(CTX({ agents })).active, false);
    });
  });

  test('a dead owner is residue, not a session', () => {
    withHooks((hooksDir, agents) => {
      // pid 1 start '0' — pidAlive's starttime check fails on a real proc
      writeFileSync(join(hooksDir, 'dead-1.work'), `${Date.now()} 1 0\nbro-x\n`);
      assert.equal(markersExternalActivity(CTX({ agents })).active, false);
    });
  });
});

describe('copilot external plane (spec bro-eqi2d)', () => {
  test("foreign live task ids block; the registry's own taskId does not", () => {
    const { root, main } = initRepo('bro-ext-cp-');
    const resDir = tmp('bro-ext-cp-res-');
    try {
      writeAgentRegistry(main, {
        'fx-1': {
          agentId: 'cp-a',
          backend: 'copilot',
          spawnedAt: new Date().toISOString(),
          taskId: 't-own',
        },
      } as never);
      writeCopilotCount(resDir, ['t-own'], Date.now());
      const agents = { copilot: { reservationsDir: resDir } };
      assert.equal(copilotExternalActivity(CTX({ dir: main, agents })).active, false);
      writeCopilotCount(resDir, ['t-own', 't-foreign'], Date.now());
      const r = copilotExternalActivity(CTX({ dir: main, agents }));
      assert.equal(r.active, true);
      assert.match(r.detail ?? '', /t-foreign/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(resDir, { recursive: true, force: true });
    }
  });

  test('no cache → quiet (cannot see the remote)', () => {
    const agents = { copilot: { reservationsDir: tmp('bro-ext-cp-res-') } };
    assert.equal(copilotExternalActivity(CTX({ agents })).active, false);
  });
});

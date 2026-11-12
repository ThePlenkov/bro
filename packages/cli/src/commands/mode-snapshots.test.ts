import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODE_SNAPSHOT_EVENTS,
  readModeSnapshot,
  sessionProject,
  snapshotFresh,
  type ProbeResult,
} from '@broject/core';
import { initRepo } from './testrepo.ts';
import { renderModeSnapshots } from './mode-snapshots.ts';

/** Hermetic env: XDG_STATE_HOME pinned to a throwaway dir so snapshot
 *  files never touch the host's real state. */
function envFixture(): { root: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'bro-mode-snap-'));
  return {
    root,
    env: { XDG_STATE_HOME: root } as NodeJS.ProcessEnv,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const settled = (lines: string[]): ProbeResult => ({ lines, settled: true });

describe('renderModeSnapshots', () => {
  test('settled sweep writes every event file + stamp and pins a nobody identity', async () => {
    const f = envFixture();
    const repo = initRepo('bro-ms-');
    const seen: { agentId: string | undefined }[] = [];
    try {
      process.env.BRO_AGENT_ID = 'worker-7';
      const result = await renderModeSnapshots(repo.main, 'code', f.env, async ctx => {
        assert.equal(ctx.sessionId, '');
        assert.equal(ctx.mode, 'code');
        seen.push({ agentId: process.env.BRO_AGENT_ID });
        return settled(['line-a', 'line-b']);
      });
      assert.ok(result !== null && result.ok);
      assert.equal(result.lines, 2);
      assert.deepEqual([...result.events].sort(), [...MODE_SNAPSHOT_EVENTS].sort());
      // the sweep ran as an identity that owns no mailbox drops
      assert.match(seen[0]?.agentId ?? '', /^snapshot-render-\d+$/);
      // and the caller's env is restored afterwards
      assert.equal(process.env.BRO_AGENT_ID, 'worker-7');
      const project = sessionProject(repo.main);
      assert.ok(project !== undefined);
      for (const event of MODE_SNAPSHOT_EVENTS) {
        assert.equal(readModeSnapshot(f.env, project, 'code', event), 'line-a\nline-b');
      }
      assert.equal(snapshotFresh(f.env, project, 'code'), true);
    } finally {
      delete process.env.BRO_AGENT_ID;
      f.cleanup();
    }
  });

  test('unsettled sweep writes nothing — no stamp, no event files', async () => {
    const f = envFixture();
    const repo = initRepo('bro-ms-');
    try {
      const result = await renderModeSnapshots(repo.main, 'plan', f.env, async () => ({
        lines: ['partial'],
        settled: false,
      }));
      assert.ok(result !== null);
      assert.equal(result.ok, false);
      assert.equal(result.events.length, 0);
      const project = sessionProject(repo.main);
      assert.ok(project !== undefined);
      assert.equal(snapshotFresh(f.env, project, 'plan'), false);
      assert.equal(readModeSnapshot(f.env, project, 'plan', 'session-start'), undefined);
    } finally {
      f.cleanup();
    }
  });

  test('thrown sweep fails open and restores a previously-unset BRO_AGENT_ID', async () => {
    const f = envFixture();
    const repo = initRepo('bro-ms-');
    delete process.env.BRO_AGENT_ID;
    try {
      const result = await renderModeSnapshots(repo.main, 'review', f.env, async () => {
        throw new Error('probe wedged');
      });
      assert.ok(result !== null);
      assert.equal(result.ok, false);
      assert.equal(process.env.BRO_AGENT_ID, undefined);
      const project = sessionProject(repo.main);
      assert.ok(project !== undefined);
      assert.equal(snapshotFresh(f.env, project, 'review'), false);
    } finally {
      f.cleanup();
    }
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ledgerFacade,
  sessionProject,
  writeAgentRegistry,
  type LedgerFacade,
  type LedgerSessionRow,
  type SessionRow,
} from '@broject/core';
import { PLUGINS } from '../plugins.ts';
import { capture, initRepo } from './testrepo.ts';
import {
  beadResolver,
  collectSessionViews,
  deriveSessionState,
  runSessionsCommand,
  sessionBootTimeMs,
  sessionTableLines,
} from './sessions.ts';

/** Hermetic ledger: a real sqlite store under a throwaway dir with the
 *  spool drain disabled (BRO_HOOK_SPOOL=0) so the host's live spool can
 *  never leak rows into a fixture. */
function ledgerFixture(): { dir: string; ledger: LedgerFacade; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-sessions-'));
  const env = { BRO_HOOK_SPOOL: '0', XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
  return {
    dir,
    ledger: ledgerFacade({ dbPath: join(dir, 'ledger.db'), env }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const BOOT = T0 - 60 * 60 * 1000; // "now" is one hour after boot

function sess(
  partial: Partial<LedgerSessionRow> & { host: string; sid: string }
): LedgerSessionRow {
  return {
    kind: 'session',
    mode: 'observe',
    state: 'live',
    lastSeen: T0 - 60_000,
    ...partial,
  };
}

/** A stored SessionRow (read shape — nulls, not undefined). */
function srow(partial: Partial<SessionRow> & { host: string; sid: string }): SessionRow {
  return {
    project: null,
    cwd: null,
    branch: null,
    mode: 'observe',
    state: 'live',
    pid: null,
    pidStart: null,
    started: null,
    lastSeen: T0 - 60_000,
    spawnedBy: null,
    ...partial,
  };
}

describe('bro sessions', () => {
  test('lists every ledger session, most recently seen first', async () => {
    const f = ledgerFixture();
    try {
      await f.ledger.append([
        sess({ host: 'claude', sid: 's-old', lastSeen: T0 - 3_600_000 }),
        sess({ host: 'codex', sid: 's-new', lastSeen: T0 - 30_000, mode: 'code' }),
      ]);
      const views = await collectSessionViews(f.ledger, { now: T0, bootTimeMs: BOOT });
      assert.equal(views.rows.length, 2);
      assert.equal(views.rows[0]!.sid, 's-new');
      assert.equal(views.rows[0]!.host, 'codex');
      assert.equal(views.rows[0]!.mode, 'code');
      assert.equal(views.rows[1]!.sid, 's-old');
    } finally {
      f.cleanup();
    }
  });

  test('deriveSessionState: live stays live, pre-boot live is interrupted', () => {
    const live = srow({ host: 'h', sid: 'a', lastSeen: T0 - 1000 });
    const stale = srow({ host: 'h', sid: 'b', lastSeen: BOOT - 1 });
    const ended = srow({ host: 'h', sid: 'c', state: 'ended', lastSeen: BOOT - 1 });
    assert.equal(deriveSessionState(live, BOOT), 'live');
    assert.equal(deriveSessionState(stale, BOOT), 'interrupted');
    // a writer's non-live verdict is never re-derived
    assert.equal(deriveSessionState(ended, BOOT), 'ended');
  });

  test('sessionBootTimeMs derives boot from uptime', () => {
    const now = 1_000_000_000;
    assert.equal(sessionBootTimeMs(now, 120), now - 120_000);
  });

  test('table carries host/sid/state/mode/agent/bead/worktree/branch/started/seen', async () => {
    const f = ledgerFixture();
    try {
      await f.ledger.append([
        sess({
          host: 'claude',
          sid: 'abcdef1234567890',
          cwd: '/home/x/proj',
          branch: 'main',
          spawnedBy: 'agent-7',
          started: T0 - 3_600_000,
          lastSeen: T0 - 30_000,
        }),
      ]);
      const views = await collectSessionViews(f.ledger, {
        now: T0,
        bootTimeMs: BOOT,
        beadFor: () => 'bro-x.1',
      });
      const [header, row] = sessionTableLines(views.rows, T0);
      for (const col of [
        'HOST',
        'SID',
        'STATE',
        'MODE',
        'AGENT',
        'BEAD',
        'WORKTREE',
        'BRANCH',
        'STARTED',
        'SEEN',
      ]) {
        assert.ok(header!.includes(col), `missing column ${col}`);
      }
      assert.ok(row!.includes('claude'));
      assert.ok(row!.includes('abcdef123456'));
      assert.ok(row!.includes('agent-7'));
      assert.ok(row!.includes('bro-x.1'));
      assert.ok(row!.includes('/home/x/proj'));
      assert.ok(row!.includes('main'));
      assert.ok(row!.includes('live'));
    } finally {
      f.cleanup();
    }
  });

  test('beadResolver maps spawnedBy agentId → molStep via agents.json', async () => {
    const { root, main } = initRepo('bro-sessions-bead-');
    try {
      writeAgentRegistry(main, {
        'step-one': { agentId: 'agent-1', backend: 'native', spawnedAt: '2026-11-20T10:00:00Z' },
        'step-two': { agentId: 'agent-2', backend: 'native', spawnedAt: '2026-11-20T10:00:00Z' },
      });
      const f = ledgerFixture();
      try {
        await f.ledger.append([
          sess({ host: 'devin', sid: 's1', cwd: main, spawnedBy: 'agent-2', lastSeen: T0 }),
          sess({ host: 'devin', sid: 's2', cwd: main, spawnedBy: 'agent-unknown', lastSeen: T0 }),
          sess({ host: 'devin', sid: 's3', cwd: main, lastSeen: T0 }),
          sess({
            host: 'devin',
            sid: 's4',
            cwd: join(root, 'gone'),
            spawnedBy: 'agent-1',
            lastSeen: T0,
          }),
        ]);
        const warnings: string[] = [];
        const beadFor = beadResolver(warnings);
        const views = await collectSessionViews(f.ledger, {
          now: T0,
          bootTimeMs: BOOT,
          beadFor,
        });
        const bySid = new Map(views.rows.map(r => [r.sid, r]));
        assert.equal(bySid.get('s1')!.bead, 'step-two');
        // unknown agent / no spawnedBy / dead cwd all render unresolved
        assert.equal(bySid.get('s2')!.bead, undefined);
        assert.equal(bySid.get('s3')!.bead, undefined);
        assert.equal(bySid.get('s4')!.bead, undefined);
      } finally {
        f.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unreadable agents.json surfaces a warning, not a crash', async () => {
    const { root, main } = initRepo('bro-sessions-warn-');
    try {
      // a directory where agents.json should be — readAgentRegistry throws
      // on a non-git cwd only if path resolution fails; corrupt JSON is the
      // deterministic throw. agents.json lives under <common>/bro/ — plant
      // corrupt bytes there.
      mkdirSync(join(main, '.git', 'bro'), { recursive: true });
      writeFileSync(join(main, '.git', 'bro', 'agents.json'), '{not json');
      const f = ledgerFixture();
      try {
        await f.ledger.append([
          sess({ host: 'devin', sid: 's1', cwd: main, spawnedBy: 'agent-1', lastSeen: T0 }),
        ]);
        const out = await capture(() =>
          runSessionsCommand(['--json'], {
            dir: main,
            ledger: f.ledger,
            now: T0,
            bootTimeMs: BOOT,
          })
        );
        assert.equal(out.code, 0);
        const payload = JSON.parse(out.out.join('\n')) as {
          sessions: Array<{ sid: string; bead: string | null }>;
          warnings: string[];
        };
        assert.equal(payload.sessions[0]!.bead, null);
        assert.ok(payload.warnings.some(w => w.includes('agent registry unreadable')));
      } finally {
        f.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runSessionsCommand --json emits the contract payload', async () => {
    const f = ledgerFixture();
    try {
      await f.ledger.append([
        sess({ host: 'claude', sid: 's-live', lastSeen: T0 - 5_000 }),
        sess({ host: 'codex', sid: 's-dead', lastSeen: BOOT - 1 }),
      ]);
      const out = await capture(() =>
        runSessionsCommand(['--json'], { ledger: f.ledger, now: T0, bootTimeMs: BOOT })
      );
      assert.equal(out.code, 0);
      const payload = JSON.parse(out.out.join('\n')) as {
        sessions: Array<Record<string, unknown>>;
        warnings: string[];
      };
      assert.equal(payload.sessions.length, 2);
      const live = payload.sessions.find(s => s.sid === 's-live')!;
      const dead = payload.sessions.find(s => s.sid === 's-dead')!;
      assert.equal(live.state, 'live');
      assert.equal(dead.state, 'interrupted');
      assert.equal(typeof live.lastSeen, 'number');
      assert.ok('bead' in live);
    } finally {
      f.cleanup();
    }
  });

  test('--host and --live filters narrow the listing', async () => {
    const f = ledgerFixture();
    try {
      await f.ledger.append([
        sess({ host: 'claude', sid: 's1', lastSeen: T0 - 5_000 }),
        sess({ host: 'codex', sid: 's2', lastSeen: BOOT - 1 }),
        sess({ host: 'codex', sid: 's3', lastSeen: T0 - 9_000 }),
      ]);
      const hostOnly = await capture(() =>
        runSessionsCommand(['--json', '--host', 'codex'], {
          ledger: f.ledger,
          now: T0,
          bootTimeMs: BOOT,
        })
      );
      const hostPayload = JSON.parse(hostOnly.out.join('\n')) as {
        sessions: Array<{ sid: string }>;
      };
      assert.deepEqual(hostPayload.sessions.map(s => s.sid).sort(), ['s2', 's3']);
      const liveOnly = await capture(() =>
        runSessionsCommand(['--json', '--live'], {
          ledger: f.ledger,
          now: T0,
          bootTimeMs: BOOT,
        })
      );
      const livePayload = JSON.parse(liveOnly.out.join('\n')) as {
        sessions: Array<{ sid: string }>;
      };
      assert.deepEqual(livePayload.sessions.map(s => s.sid).sort(), ['s1', 's3']);
    } finally {
      f.cleanup();
    }
  });

  test('--project scopes to the current project id (worktrees fold)', async () => {
    const { root, main } = initRepo('bro-sessions-proj-');
    try {
      const project = sessionProject(main);
      assert.ok(project !== undefined);
      const f = ledgerFixture();
      try {
        await f.ledger.append([
          sess({ host: 'claude', sid: 'in-proj', project: project!, cwd: main, lastSeen: T0 }),
          sess({
            host: 'claude',
            sid: 'other-proj',
            project: 'deadbeefcafe',
            cwd: '/elsewhere',
            lastSeen: T0,
          }),
          sess({ host: 'claude', sid: 'no-proj', lastSeen: T0 }),
        ]);
        const out = await capture(() =>
          runSessionsCommand(['--json', '--project'], {
            dir: main,
            ledger: f.ledger,
            now: T0,
            bootTimeMs: BOOT,
          })
        );
        assert.equal(out.code, 0);
        const payload = JSON.parse(out.out.join('\n')) as { sessions: Array<{ sid: string }> };
        assert.deepEqual(
          payload.sessions.map(s => s.sid),
          ['in-proj']
        );
      } finally {
        f.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('empty ledger prints the empty line, not a crash', async () => {
    const f = ledgerFixture();
    try {
      const out = await capture(() =>
        runSessionsCommand([], { ledger: f.ledger, now: T0, bootTimeMs: BOOT })
      );
      assert.equal(out.code, 0);
      assert.ok(out.out.join('\n').includes('no sessions recorded'));
      const live = await capture(() =>
        runSessionsCommand(['--live'], { ledger: f.ledger, now: T0, bootTimeMs: BOOT })
      );
      assert.ok(live.out.join('\n').includes('no live sessions'));
    } finally {
      f.cleanup();
    }
  });

  test('usage errors: --project+--all, stray positional, empty --host', async () => {
    const f = ledgerFixture();
    try {
      for (const argv of [['--project', '--all'], ['bogus'], ['--host='], ['--unknown']]) {
        const out = await capture(() =>
          runSessionsCommand(argv, { ledger: f.ledger, now: T0, bootTimeMs: BOOT })
        );
        assert.equal(out.code, 2, `argv ${argv.join(' ')} should exit 2`);
      }
    } finally {
      f.cleanup();
    }
  });

  test('--help prints usage and exits 0', async () => {
    const out = await capture(() => runSessionsCommand(['--help'], {}));
    assert.equal(out.code, 0);
    assert.ok(out.out.join('\n').includes('usage: bro sessions'));
  });
});

describe('sessions plugin registration', () => {
  test('sessions is a fleet-group plugin with a resolvable json contract', () => {
    const p = PLUGINS.find(x => x.name === 'sessions');
    assert.ok(p, 'sessions plugin missing');
    assert.equal(p!.group, 'fleet');
    assert.equal(p!.contract?.json, 'schemas/cli/sessions.schema.json');
    assert.ok(p!.contract?.flags?.['--json']);
    assert.ok(p!.contract?.flags?.['--project']);
    assert.ok(p!.contract?.flags?.['--host <h>']);
    assert.ok(p!.contract?.flags?.['--live']);
  });

  test('fleet hosts subcommand is declared on the fleet contract', () => {
    const fleet = PLUGINS.find(x => x.name === 'fleet');
    assert.ok(fleet);
    const hosts = fleet!.contract?.subs?.hosts;
    assert.ok(hosts, 'fleet contract missing subs.hosts');
    assert.equal(hosts!.json, 'schemas/cli/fleet-hosts.schema.json');
    assert.ok(hosts!.flags?.['--json']);
  });
});

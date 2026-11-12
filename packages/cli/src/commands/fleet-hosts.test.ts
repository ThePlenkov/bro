import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookStat, InstallRow, LedgerFacade, SessionRow } from '@broject/core';
import { capture } from './testrepo.ts';
import {
  collectFleetHosts,
  fleetHostsLines,
  hostStatusFor,
  runFleetHostsCommand,
} from './fleet-hosts.ts';

const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const BOOT = T0 - 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Stub facade — stats() can't be seeded through append() (the daily
 *  rollup only runs on the spool-ingest path), so the board's tests
 *  drive a hand-built facade; the sqlite layer itself is F1a's tested
 *  surface. */
function stubLedger(parts: {
  installs?: InstallRow[];
  sessions?: SessionRow[];
  stats?: HookStat[];
}): LedgerFacade {
  return {
    append: async () => {},
    sessions: async () => parts.sessions ?? [],
    installs: async () => parts.installs ?? [],
    stats: async () => parts.stats ?? [],
    setMode: async () => {},
  };
}

function sess(partial: Partial<SessionRow> & { host: string; sid: string }): SessionRow {
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

function install(partial: Partial<InstallRow> & { host: string }): InstallRow {
  return {
    adapterVersion: '0.4.0',
    pluginRoot: `/plugins/${partial.host}`,
    firstSeen: T0 - 30 * DAY,
    lastSeen: T0 - HOUR,
    ...partial,
  };
}

describe('hostStatusFor', () => {
  test('firing < 24h, quiet < 7d, silent beyond', () => {
    assert.equal(hostStatusFor(T0 - HOUR, T0), 'firing');
    assert.equal(hostStatusFor(T0 - 23 * HOUR, T0), 'firing');
    assert.equal(hostStatusFor(T0 - 25 * HOUR, T0), 'quiet');
    assert.equal(hostStatusFor(T0 - 6 * DAY, T0), 'quiet');
    assert.equal(hostStatusFor(T0 - 8 * DAY, T0), 'silent');
  });
});

describe('collectFleetHosts', () => {
  test('folds installs + sessions + stats into one row per host', async () => {
    const ledger = stubLedger({
      installs: [
        install({ host: 'claude', lastSeen: T0 - 2 * HOUR, adapterVersion: '0.4.0' }),
        install({
          host: 'claude',
          pluginRoot: '/plugins/claude-alt',
          lastSeen: T0 - 10 * DAY,
          adapterVersion: '0.3.0',
        }),
        install({ host: 'codex', lastSeen: T0 - 30 * DAY, adapterVersion: '1.2.3' }),
      ],
      sessions: [
        sess({ host: 'claude', sid: 's1', lastSeen: T0 - 30_000 }),
        sess({ host: 'claude', sid: 's2', lastSeen: BOOT - 1, state: 'live' }), // interrupted
        sess({
          host: 'codex',
          sid: 's3',
          project: 'projhash1',
          cwd: '/home/x/bro',
          lastSeen: T0 - DAY,
        }),
      ],
      stats: [
        {
          day: '2026-11-19',
          host: 'claude',
          event: 'PreToolUse',
          n: 10,
          p50: 12,
          p95: 40,
          timeouts: 1,
          errors: 0,
        },
        {
          day: '2026-11-20',
          host: 'claude',
          event: 'PostToolUse',
          n: 4,
          p50: 20,
          p95: 90,
          timeouts: 0,
          errors: 2,
        },
        {
          day: '2026-11-18',
          host: 'claude',
          event: 'SessionStart',
          n: 1,
          p50: null,
          p95: null,
          timeouts: 0,
          errors: 1,
        },
      ],
    });
    const p = await collectFleetHosts(ledger, { now: T0, bootTimeMs: BOOT });
    assert.equal(p.hosts.length, 2);
    // sorted by lastSeen desc — claude fired 2h ago, codex 30d ago
    const claude = p.hosts.find(h => h.host === 'claude')!;
    const codex = p.hosts.find(h => h.host === 'codex')!;
    assert.equal(p.hosts[0]!.host, 'claude');
    assert.equal(claude.status, 'firing');
    assert.equal(claude.adapter, '0.4.0'); // freshest install row wins
    assert.deepEqual(claude.pluginRoots.sort(), ['/plugins/claude', '/plugins/claude-alt']);
    assert.equal(claude.sessions, 2);
    assert.equal(claude.liveSessions, 1); // s2 derived interrupted
    assert.equal(claude.events, 15);
    assert.equal(claude.p95, 90); // worst daily p95
    assert.equal(claude.timeouts, 1);
    assert.equal(claude.errors, 3);
    assert.equal(claude.lastErrorDay, '2026-11-20');
    // codex's install is 30d stale but its session fired 1d ago —
    // lastSeen is the max across all three sources → quiet, not silent
    assert.equal(codex.status, 'quiet');
    assert.equal(codex.sessions, 1);
    assert.equal(codex.events, 0);
  });

  test('a stats-only host still appears (append()-fed ledger edge)', async () => {
    const ledger = stubLedger({
      stats: [
        {
          day: '2026-11-20',
          host: 'kilo',
          event: 'SessionStart',
          n: 3,
          p50: 5,
          p95: 9,
          timeouts: 0,
          errors: 0,
        },
      ],
    });
    const p = await collectFleetHosts(ledger, { now: T0, bootTimeMs: BOOT });
    assert.equal(p.hosts.length, 1);
    assert.equal(p.hosts[0]!.host, 'kilo');
    assert.equal(p.hosts[0]!.status, 'firing'); // stats day-end counts as seen
    assert.equal(p.hosts[0]!.events, 3);
  });

  test('sessions group per project; null project falls back to cwd bucket', async () => {
    const ledger = stubLedger({
      sessions: [
        sess({ host: 'claude', sid: 'a', project: 'p1', cwd: '/home/x/bro', lastSeen: T0 - 1000 }),
        sess({
          host: 'codex',
          sid: 'b',
          project: 'p1',
          cwd: '/home/x/bro-wt',
          lastSeen: T0 - 2000,
        }),
        sess({ host: 'devin', sid: 'c', project: null, cwd: '/tmp/loose', lastSeen: T0 - 3000 }),
        sess({ host: 'pi', sid: 'd', project: null, cwd: null, lastSeen: T0 - 4000 }),
      ],
    });
    const p = await collectFleetHosts(ledger, { now: T0, bootTimeMs: BOOT });
    assert.equal(p.projects.length, 3);
    const p1 = p.projects.find(x => x.project === 'p1')!;
    assert.equal(p1.sessions, 2);
    assert.deepEqual(p1.hosts, ['claude', 'codex']);
    // most-recent session's cwd basename + short project id
    assert.equal(p1.label, 'bro (p1)');
    const loose = p.projects.find(x => x.project === null && x.label.includes('loose'))!;
    assert.equal(loose.sessions, 1);
    const none = p.projects.find(x => x.label === '—')!;
    assert.equal(none.sessions, 1);
  });

  test('a real "none" project never merges into the no-project bucket', async () => {
    const ledger = stubLedger({
      sessions: [
        sess({ host: 'claude', sid: 'a', project: 'none', cwd: null, lastSeen: T0 - 1000 }),
        sess({ host: 'pi', sid: 'b', project: null, cwd: null, lastSeen: T0 - 2000 }),
      ],
    });
    const p = await collectFleetHosts(ledger, { now: T0, bootTimeMs: BOOT });
    assert.equal(p.projects.length, 2);
    const named = p.projects.find(x => x.project === 'none')!;
    assert.equal(named.sessions, 1);
    assert.equal(named.label, 'none');
    const bucket = p.projects.find(x => x.label === '—')!;
    assert.equal(bucket.sessions, 1);
    assert.equal(bucket.project, null);
  });

  test('the freshest install row with no version clears the adapter', async () => {
    const ledger = stubLedger({
      installs: [
        install({ host: 'claude', lastSeen: T0 - 10 * DAY, adapterVersion: '0.3.0' }),
        install({
          host: 'claude',
          pluginRoot: '/plugins/claude-new',
          lastSeen: T0 - HOUR,
          adapterVersion: null,
        }),
      ],
    });
    const p = await collectFleetHosts(ledger, { now: T0, bootTimeMs: BOOT });
    assert.equal(p.hosts.length, 1);
    assert.equal(p.hosts[0]!.adapter, undefined);
  });

  test('a failed spool drain surfaces as a staleness warning', async () => {
    const ledger: LedgerFacade = { ...stubLedger({}), drainWarning: () => 'disk is gone' };
    const p = await collectFleetHosts(ledger, { now: T0, bootTimeMs: BOOT });
    assert.ok(p.warnings.some(w => w.includes('may be stale')));
  });

  test('empty ledger renders honest empty lines', async () => {
    const p = await collectFleetHosts(stubLedger({}), { now: T0, bootTimeMs: BOOT });
    const lines = fleetHostsLines(p, T0);
    assert.ok(lines.join('\n').includes('no hosts in the ledger'));
    assert.ok(lines.join('\n').includes('no sessions in the ledger'));
  });
});

describe('runFleetHostsCommand', () => {
  test('human table + stderr footer note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fleet-hosts-'));
    try {
      const ledger = stubLedger({
        installs: [install({ host: 'claude', lastSeen: T0 - 5 * 60_000 })],
        sessions: [sess({ host: 'claude', sid: 's1', project: 'abc123', cwd: '/home/x/bro' })],
        stats: [
          {
            day: '2026-11-20',
            host: 'claude',
            event: 'SessionStart',
            n: 2,
            p50: 8,
            p95: 15,
            timeouts: 0,
            errors: 0,
          },
        ],
      });
      const out = await capture(() =>
        runFleetHostsCommand(dir, [], { ledger, now: T0, bootTimeMs: BOOT })
      );
      assert.equal(out.code, 0);
      const text = out.out.join('\n');
      assert.ok(text.includes('claude'));
      assert.ok(text.includes('firing'));
      assert.ok(text.includes('bro'));
      // the honest-limitation footer rides stderr, not the table
      assert.ok(out.err.join('\n').includes('wired-but-never-fired'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json emits {hosts, projects, generatedAt, warnings}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fleet-hosts-'));
    try {
      const ledger = stubLedger({
        installs: [install({ host: 'codex', lastSeen: T0 - 10 * DAY })],
        sessions: [],
        stats: [],
      });
      const out = await capture(() =>
        runFleetHostsCommand(dir, ['--json'], { ledger, now: T0, bootTimeMs: BOOT })
      );
      assert.equal(out.code, 0);
      const payload = JSON.parse(out.out.join('\n')) as {
        hosts: Array<{ host: string; status: string }>;
        projects: unknown[];
        generatedAt: number;
        warnings: string[];
      };
      assert.equal(payload.hosts[0]!.host, 'codex');
      assert.equal(payload.hosts[0]!.status, 'silent');
      assert.equal(payload.generatedAt, T0);
      assert.deepEqual(payload.warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stray positional is a usage error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fleet-hosts-'));
    try {
      const out = await capture(() =>
        runFleetHostsCommand(dir, ['bogus'], { ledger: stubLedger({}), now: T0, bootTimeMs: BOOT })
      );
      assert.equal(out.code, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ledger failure exits 1 with a readable error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fleet-hosts-'));
    try {
      const broken: LedgerFacade = {
        append: async () => {},
        sessions: async () => {
          throw new Error('sqlite locked');
        },
        installs: async () => [],
        stats: async () => [],
        setMode: async () => {},
      };
      const out = await capture(() =>
        runFleetHostsCommand(dir, [], { ledger: broken, now: T0, bootTimeMs: BOOT })
      );
      assert.equal(out.code, 1);
      assert.ok(out.err.join('\n').includes('ledger unavailable'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--help prints usage and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fleet-hosts-'));
    try {
      const out = await capture(() => runFleetHostsCommand(dir, ['--help'], {}));
      assert.equal(out.code, 0);
      assert.ok(out.out.join('\n').includes('usage: bro fleet hosts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

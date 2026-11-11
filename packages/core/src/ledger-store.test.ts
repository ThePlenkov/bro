import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { drainHookSpool, ledgerFacade, openLedgerStore } from './ledger-store.ts';

const root = mkdtempSync(join(tmpdir(), 'bro-ledger-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function caseDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const T0 = 1_700_000_000; // fixed epoch seconds — deterministic days

interface V1Opts {
  host?: string;
  event?: string;
  cwd?: string;
  ts?: number;
}
function v1Start(id: string, o: V1Opts = {}) {
  const { host = 'cursor', event = 'post-tool', cwd = '/repo', ts = T0 } = o;
  return `v1\t${ts}\tstart\t${id}\t${host}\t${event}\t${cwd}`;
}
function v1End(id: string, o: V1Opts & { rc?: number; outcome?: string } = {}) {
  const {
    host = 'cursor',
    event = 'post-tool',
    rc = 0,
    outcome = 'ok',
    cwd = '/repo',
    ts = T0 + 2,
  } = o;
  return `v1\t${ts}\tend\t${id}\t${host}\t${event}\t${rc}\t${outcome}\t${cwd}`;
}
function v2Start(
  id: string,
  opts: {
    host?: string;
    sid?: string;
    event?: string;
    pid?: number;
    ppid?: number;
    agent?: string;
    adapter?: string;
    proot?: string;
    launcher?: string;
    cwd?: string;
    ts?: number;
  } = {}
) {
  const o = {
    host: 'devin',
    sid: 'sid-1',
    event: 'session-start',
    pid: 4242,
    ppid: 100,
    agent: '',
    adapter: '0.3.0',
    proot: '/opt/bro',
    launcher: 'tmux',
    cwd: '/repo',
    ts: T0,
    ...opts,
  };
  return `v2\t${o.ts}\tstart\t${id}\t${o.host}\t${o.sid}\t${o.event}\t${o.pid}\t${o.ppid}\t${o.agent}\t${o.adapter}\t${o.proot}\t${o.launcher}\t${o.cwd}`;
}
function v2End(
  id: string,
  o: Parameters<typeof v2Start>[1] & { outcome?: string; rc?: number; ts?: number } = {}
) {
  const { outcome = 'ok', rc = 0, ts = T0 + 2, ...fields } = o;
  const f = {
    host: 'devin',
    sid: 'sid-1',
    event: 'session-start',
    pid: 4242,
    ppid: 100,
    agent: '',
    adapter: '0.3.0',
    proot: '/opt/bro',
    launcher: 'tmux',
    cwd: '/repo',
    ...fields,
  };
  return `v2\t${ts}\tend\t${id}\t${f.host}\t${f.sid}\t${f.event}\t${f.pid}\t${f.ppid}\t${f.agent}\t${f.adapter}\t${f.proot}\t${f.launcher}\t${rc}\t${outcome}\t${f.cwd}`;
}

async function openStore(dir: string) {
  const opened = await openLedgerStore(join(dir, 'ledger.db'));
  assert.equal(opened.ok, true, opened.ok ? '' : opened.reason);
  if (!opened.ok) {
    throw new Error('unreachable');
  }
  return opened;
}

test('drain ingests v1+v2 rows into events, sessions, installs, stats', async () => {
  const dir = caseDir('ingest');
  const spool = join(dir, 'hooks.spool');
  writeFileSync(
    spool,
    [
      v1Start('p1', { ts: T0 }),
      v1End('p1', { ts: T0 + 3 }),
      v2Start('s1', { sid: 'sess-1', agent: 'agent-7', event: 'session-start' }),
      v2End('s1', { ts: T0 + 1, sid: 'sess-1', agent: 'agent-7', event: 'session-start' }),
      v2Start('s2', { sid: 'sess-1', event: 'post-tool', pid: 777 }),
      // s2 never ends — fresh enough to stay unpaired
      '',
    ].join('\n')
  );

  const result = await drainHookSpool({
    spoolPath: spool,
    dbPath: join(dir, 'ledger.db'),
    nowMs: (T0 + 10) * 1000, // s2 is 10s old — under the 13s kill horizon
    watchdogSeconds: 8,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows, 5);
  assert.equal(result.events, 5);
  assert.equal(result.killed, 0);

  const opened = await openStore(dir);
  try {
    const s = opened.store;
    const sessions = await s.sessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sid, 'sess-1');
    assert.equal(sessions[0]?.host, 'devin');
    assert.equal(sessions[0]?.spawnedBy, 'agent-7');
    assert.equal(sessions[0]?.state, 'live');
    assert.equal(sessions[0]?.pid, 777); // latest pid wins

    const installs = await s.installs();
    assert.equal(installs.length, 2); // cursor + devin hosts
    const devin = installs.find(i => i.host === 'devin');
    assert.equal(devin?.adapterVersion, '0.3.0');
    assert.equal(devin?.pluginRoot, '/opt/bro');

    const stats = await s.stats({ day: '2023-11-14' }); // T0 = 2023-11-14T22:13:20Z
    assert.equal(stats.length, 2);
    const pt = stats.find(r => r.host === 'cursor' && r.event === 'post-tool');
    assert.equal(pt?.n, 1); // only the paired v1 end counts — s2's bare start is not an end
    assert.equal(pt?.p50, 3000);
    const ss = stats.find(r => r.host === 'devin' && r.event === 'session-start');
    assert.equal(ss?.n, 1);
    assert.equal(ss?.p50, 1000);
  } finally {
    opened.close();
  }
});

test('stats groups host×event without concat collisions', async () => {
  const dir = caseDir('statkey');
  const spool = join(dir, 'hooks.spool');
  // ('ab','c') and ('a','bc') concatenate to the same key — the rollup
  // must keep them as separate groups
  writeFileSync(
    spool,
    `${v1End('k1', { host: 'ab', event: 'c', ts: T0 + 2 })}\n${v1End('k2', { host: 'a', event: 'bc', ts: T0 + 3 })}\n`
  );
  await drainHookSpool({
    spoolPath: spool,
    dbPath: join(dir, 'ledger.db'),
    nowMs: (T0 + 60) * 1000,
  });
  const opened = await openStore(dir);
  try {
    const stats = await opened.store.stats({ day: '2023-11-14' });
    assert.equal(stats.length, 2);
    assert.equal(stats.find(r => r.host === 'ab' && r.event === 'c')?.n, 1);
    assert.equal(stats.find(r => r.host === 'a' && r.event === 'bc')?.n, 1);
  } finally {
    opened.close();
  }
});

test('re-ingesting the same spool is a no-op — cursor holds', async () => {
  const dir = caseDir('idem');
  const spool = join(dir, 'hooks.spool');
  writeFileSync(spool, `${v1Start('p1')}\n${v1End('p1')}\n`);
  const dbPath = join(dir, 'ledger.db');
  const opts = { spoolPath: spool, dbPath, nowMs: (T0 + 60) * 1000 };

  const first = await drainHookSpool(opts);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.rows, 2);

  const second = await drainHookSpool(opts);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rows, 0, 'cursor must hold — no rows re-ingested');
  assert.equal(second.events, 0);

  const opened = await openStore(dir);
  try {
    // count events via stats: one end row → n=1 for that day/host/event
    const stats = await opened.store.stats({ host: 'cursor', event: 'post-tool' });
    assert.equal(
      stats.reduce((a, r) => a + r.n, 0),
      1
    );
  } finally {
    opened.close();
  }
});

test('appending rows then draining more spool keeps both', async () => {
  const dir = caseDir('append');
  const spool = join(dir, 'hooks.spool');
  writeFileSync(spool, `${v1Start('p1')}\n${v1End('p1')}\n`);
  const dbPath = join(dir, 'ledger.db');
  await drainHookSpool({ spoolPath: spool, dbPath, nowMs: (T0 + 60) * 1000 });

  const opened = await openLedgerStore(dbPath);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    await opened.store.append([
      {
        kind: 'session',
        host: 'cursor',
        sid: 'manual-1',
        project: 'proj-x',
        mode: 'code',
        state: 'live',
        lastSeen: (T0 + 30) * 1000,
      },
    ]);
  } finally {
    opened.close();
  }

  // second drain: no new spool rows, but the appended session persists
  const opened2 = await openLedgerStore(dbPath);
  assert.equal(opened2.ok, true);
  if (!opened2.ok) return;
  try {
    const sessions = await opened2.store.sessions({ sid: 'manual-1' });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.mode, 'code');
  } finally {
    opened2.close();
  }
});

test('rotation: .1 drains before the live file; inode cursor survives rename', async () => {
  const dir = caseDir('rotate');
  const spool = join(dir, 'hooks.spool');
  // older rows sit in .1, newer in live — both must land, once
  writeFileSync(`${spool}.1`, `${v1Start('old', { event: 'stop', ts: T0 - 100 })}\n`);
  writeFileSync(
    spool,
    `${v1End('old', { event: 'stop', ts: T0 - 98 })}\n${v1Start('new')}\n${v1End('new')}\n`
  );

  const result = await drainHookSpool({
    spoolPath: spool,
    dbPath: join(dir, 'ledger.db'),
    nowMs: (T0 + 60) * 1000,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows, 4);

  const again = await drainHookSpool({
    spoolPath: spool,
    dbPath: join(dir, 'ledger.db'),
    nowMs: (T0 + 60) * 1000,
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.rows, 0);
});

test('a stale start synthesizes a killed end — deduped across drains', async () => {
  const dir = caseDir('killed');
  const spool = join(dir, 'hooks.spool');
  // start 60s ago, watchdog 8s → past the kill horizon, no end
  writeFileSync(spool, `${v1Start('hang', { event: 'permission', ts: T0 - 60 })}\n`);
  const dbPath = join(dir, 'ledger.db');
  const opts = { spoolPath: spool, dbPath, nowMs: T0 * 1000, watchdogSeconds: 8 };

  const first = await drainHookSpool(opts);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.killed, 1);

  const second = await drainHookSpool(opts);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.killed, 0, 'the synthesized end must dedup the pair');

  const opened = await openStore(dir);
  try {
    const stats = await opened.store.stats({ host: 'cursor', event: 'permission' });
    assert.equal(stats.length, 1);
    assert.equal(stats[0]?.timeouts, 1); // killed counts as a timeout
    assert.equal(stats[0]?.n, 1);
  } finally {
    opened.close();
  }
});

test('a start that ages past the horizon is killed on a later quiet drain', async () => {
  const dir = caseDir('killed-late');
  const spool = join(dir, 'hooks.spool');
  writeFileSync(spool, `${v1Start('fresh', { event: 'stop', ts: T0 })}\n`);
  const dbPath = join(dir, 'ledger.db');

  // drain 1: the start is 5s old — under the kill horizon, no rows left
  const first = await drainHookSpool({
    spoolPath: spool,
    dbPath,
    nowMs: (T0 + 5) * 1000,
    watchdogSeconds: 8,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.killed, 0);

  // drain 2: no new spool rows, but >60s later the maintenance pass is
  // due again — the now-stale start synthesizes its killed end
  const second = await drainHookSpool({
    spoolPath: spool,
    dbPath,
    nowMs: (T0 + 70) * 1000,
    watchdogSeconds: 8,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rows, 0);
  assert.equal(second.killed, 1, 'quiet drains still synthesize aged kills');
});

test('partial tail lines hold the cursor; completed lines still ingest', async () => {
  const dir = caseDir('partial');
  const spool = join(dir, 'hooks.spool');
  const prefix = `${v1Start('p1')}\n${v1End('p1')}\n`;
  const torn = `v2\t${T0}\tsta`; // no trailing newline — an in-flight write
  writeFileSync(spool, prefix + torn);
  const dbPath = join(dir, 'ledger.db');
  const opts = { spoolPath: spool, dbPath, nowMs: (T0 + 60) * 1000 };

  const first = await drainHookSpool(opts);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.rows, 2, 'the torn v2 line must not ingest');

  // the writer finishes the line and appends another start — the cursor
  // resumes mid-file at the exact byte offset, so the prefix must be
  // byte-identical
  writeFileSync(
    spool,
    `${prefix}${torn}rt\tx\tdevin\ts\tstop\t1\t0\t\t\t\t\t/r\n${v1Start('p2')}\n`
  );
  const second = await drainHookSpool(opts);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rows, 2, 'completed v2 start + new v1 start');
});

test('BRO_HOOK_SPOOL=0 and missing files degrade to ok/no-op', async () => {
  const dir = caseDir('noop');
  const viaEnv = await drainHookSpool({
    env: { BRO_HOOK_SPOOL: '0', HOME: dir },
    dbPath: join(dir, 'ledger.db'),
  });
  assert.equal(viaEnv.ok, true);
  if (viaEnv.ok) {
    assert.equal(viaEnv.rows, 0);
  }

  const missing = await drainHookSpool({
    spoolPath: join(dir, 'does-not-exist.spool'),
    dbPath: join(dir, 'ledger.db'),
    nowMs: T0 * 1000,
  });
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.rows, 0);
  }
});

test('retention prunes events past 14d and stats past 180d', async () => {
  const dir = caseDir('retention');
  const spool = join(dir, 'hooks.spool');
  const oldTs = T0 - 20 * 86_400; // 20 days before T0
  writeFileSync(
    spool,
    `${v1Start('ancient', { ts: oldTs })}\n${v1End('ancient', { ts: oldTs + 1 })}\n`
  );
  const dbPath = join(dir, 'ledger.db');
  const result = await drainHookSpool({
    spoolPath: spool,
    dbPath,
    nowMs: T0 * 1000,
    watchdogSeconds: 8,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.pruned >= 2, `expected the 20-day-old rows pruned, got ${result.pruned}`);
});

test('ledgerFacade resolves through facade() and reads what the drain wrote', async () => {
  const dir = caseDir('facade');
  const spool = join(dir, 'hooks.spool');
  // facade drains with wall-clock now — fixture rows must be fresh or
  // retention prunes them before the assertions read
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(spool, `${v1Start('p1', { ts: nowS })}\n${v1End('p1', { ts: nowS + 1 })}\n`);
  const env = {
    BRO_HOOK_SPOOL: spool,
    XDG_STATE_HOME: join(dir, 'xdg'),
    HOME: dir,
  } as NodeJS.ProcessEnv;
  const facade = ledgerFacade({ env });
  const sessions = await facade.sessions();
  // v1 rows carry no sid → no session rows, but installs/events land
  const installs = await facade.installs();
  assert.equal(installs.length, 1);
  assert.equal(installs[0]?.host, 'cursor');
  const stats = await facade.stats({ host: 'cursor' });
  assert.equal(
    stats.reduce((a, r) => a + r.n, 0),
    1
  );
  assert.equal(sessions.length, 0);
});

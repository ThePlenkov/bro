import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  type HookSpoolRow,
  readHookSpool,
  renderHookSpoolStatus,
  rotateHookSpool,
} from './hook-spool.ts';

const root = mkdtempSync(join(tmpdir(), 'bro-hook-spool-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function spoolPath(): string {
  const dir = mkdtempSync(join(root, 'case-'));
  return join(dir, 'hooks.spool');
}

interface StartFixture {
  ts: number;
  id: string;
  host?: string;
  event?: string;
  cwd?: string;
}

interface EndFixture extends StartFixture {
  outcome?: string;
  rc?: number;
}

function start({ ts, id, host = 'cursor', event = 'post-tool', cwd = '/repo' }: StartFixture) {
  return `v1\t${ts}\tstart\t${id}\t${host}\t${event}\t${cwd}`;
}

function end({
  ts,
  id,
  outcome = 'ok',
  rc = 0,
  host = 'cursor',
  event = 'post-tool',
  cwd = '/repo',
}: EndFixture) {
  return `v1\t${ts}\tend\t${id}\t${host}\t${event}\t${rc}\t${outcome}\t${cwd}`;
}

test('rotation replaces .1 after the spool grows past 1 MiB', () => {
  const path = spoolPath();
  const body = `${start({ ts: 100, id: 'id' })}\n${'x'.repeat(1024 * 1024 + 1)}`;
  writeFileSync(path, body);
  writeFileSync(`${path}.1`, 'previous spool');

  rotateHookSpool({ BRO_HOOK_SPOOL: path });

  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(`${path}.1`, 'utf8'), body);
});

const EMPTY_OUTCOMES = { ok: 0, nonzero: 0, watchdog: 0, 'no-cli': 0, fastpath: 0, killed: 0 };

test('the reader merges a start in .1 with its end in the current spool', () => {
  const path = spoolPath();
  writeFileSync(`${path}.1`, `${start({ ts: 100, id: 'shared' })}\n`);
  writeFileSync(path, `${end({ ts: 103, id: 'shared' })}\n`);

  assert.deepEqual(readHookSpool(path, { sinceMs: 0, nowMs: 200_000 }), [
    {
      host: 'cursor',
      event: 'post-tool',
      count: 1,
      p50: 3,
      p95: 3,
      outcomes: { ...EMPTY_OUTCOMES, ok: 1 },
      killed: 0,
    },
  ]);
});

test('tabs in cwd and malformed lines do not break valid records', () => {
  const path = spoolPath();
  writeFileSync(
    path,
    [
      'garbage',
      'v2\tbad\tstart\tbad\tcursor\tpost-tool\t/repo',
      start({ ts: 100, id: 'tabbed', cwd: '/repo\twith\ttabs' }),
      end({ ts: 102, id: 'tabbed', cwd: '/repo\twith\ttabs' }),
      '',
    ].join('\n')
  );

  const rows = readHookSpool(path, { sinceMs: 0, nowMs: 200_000 });
  assert.equal(rows.length, 1);
  assert.equal(rows.at(0)?.count, 1);
  assert.equal(rows.at(0)?.p50, 2);
});

test('fixed durations use linear p50 and p95 percentiles', () => {
  const path = spoolPath();
  const records = [1, 2, 3, 4].flatMap((duration, index) => [
    start({ ts: 100, id: `id-${index}` }),
    end({ ts: 100 + duration, id: `id-${index}` }),
  ]);
  writeFileSync(path, `${records.join('\n')}\n`);

  const row = readHookSpool(path, { sinceMs: 0, nowMs: 200_000 }).at(0);
  assert.equal(row?.p50, 2.5);
  assert.ok(Math.abs((row?.p95 ?? 0) - 3.85) < 1e-10);
});

test('a start-only record becomes killed only after the watchdog threshold', () => {
  const path = spoolPath();
  writeFileSync(path, `${start({ ts: 100, id: 'left-open' })}\n`);

  const before = readHookSpool(path, {
    sinceMs: 0,
    nowMs: 113_000,
    watchdogSeconds: 8,
  });
  const afterThreshold = readHookSpool(path, {
    sinceMs: 0,
    nowMs: 113_001,
    watchdogSeconds: 8,
  });
  assert.equal(before.length, 0);
  assert.equal(afterThreshold.at(0)?.killed, 1);
});

test('status JSON is an array of host/event rows and no-cli is counted', () => {
  const path = spoolPath();
  writeFileSync(
    path,
    [
      start({ ts: 100, id: 'ok' }),
      end({ ts: 102, id: 'ok' }),
      end({
        ts: 103,
        id: 'no-cli-id',
        outcome: 'no-cli',
        host: 'unknown',
        event: 'permission',
      }),
      '',
    ].join('\n')
  );

  const output = renderHookSpoolStatus(
    ['status', '--since', '1h', '--json'],
    { BRO_HOOK_SPOOL: path },
    200_000
  );
  const rows = JSON.parse(output) as HookSpoolRow[];
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows, [
    {
      host: 'cursor',
      event: 'post-tool',
      count: 1,
      p50: 2,
      p95: 2,
      outcomes: { ...EMPTY_OUTCOMES, ok: 1 },
      killed: 0,
    },
    {
      host: 'unknown',
      event: 'permission',
      count: 1,
      p50: null,
      p95: null,
      outcomes: { ...EMPTY_OUTCOMES, 'no-cli': 1 },
      killed: 0,
    },
  ]);
});

// v2 rows carry sid/pid/ppid/agent/adapter/proot/launcher between host
// and event — the reader only needs id/host/event/rc/outcome, so the
// enriched fields are skipped by position, never parsed
function v2Start({ ts, id, host = 'cursor', event = 'post-tool', cwd = '/repo' }: StartFixture) {
  return `v2\t${ts}\tstart\t${id}\t${host}\tsid-1\t${event}\t123\t1\tagent-1\t0.3.0\t/plugin\ttmux\t${cwd}`;
}

function v2End({
  ts,
  id,
  outcome = 'ok',
  rc = 0,
  host = 'cursor',
  event = 'post-tool',
  cwd = '/repo',
}: EndFixture) {
  return `v2\t${ts}\tend\t${id}\t${host}\tsid-1\t${event}\t123\t1\tagent-1\t0.3.0\t/plugin\ttmux\t${rc}\t${outcome}\t${cwd}`;
}

test('v2 rows aggregate alongside v1 — mixed spool stays one table', () => {
  const path = spoolPath();
  writeFileSync(
    path,
    [
      start({ ts: 100, id: 'v1-ok' }),
      end({ ts: 102, id: 'v1-ok' }),
      v2Start({ ts: 100, id: 'v2-ok' }),
      v2End({ ts: 105, id: 'v2-ok' }),
      '',
    ].join('\n')
  );

  const rows = readHookSpool(path, { sinceMs: 0, nowMs: 200_000 });
  assert.equal(rows.length, 1);
  assert.equal(rows.at(0)?.count, 2);
  assert.equal(rows.at(0)?.outcomes.ok, 2);
});

test('v2 fastpath ends count in their own bucket; canonical aliases fold', () => {
  const path = spoolPath();
  writeFileSync(
    path,
    [
      v2Start({ ts: 100, id: 'fp', event: 'post-tool' }),
      v2End({ ts: 100, id: 'fp', event: 'post-tool', outcome: 'fastpath' }),
      v2End({ ts: 101, id: 'to', event: 'stop', outcome: 'timeout', host: 'devin' }),
      v2End({ ts: 102, id: 'err', event: 'stop', outcome: 'error', host: 'devin' }),
      v2End({ ts: 103, id: 'kil', event: 'stop', outcome: 'killed', host: 'devin' }),
      '',
    ].join('\n')
  );

  const rows = readHookSpool(path, { sinceMs: 0, nowMs: 200_000 });
  const cursor = rows.find(r => r.host === 'cursor');
  const devin = rows.find(r => r.host === 'devin');
  assert.equal(cursor?.outcomes.fastpath, 1);
  assert.equal(devin?.outcomes.watchdog, 1); // timeout → watchdog
  assert.equal(devin?.outcomes.nonzero, 1); // error → nonzero
  assert.equal(devin?.outcomes.killed, 1);
});

test('missing or disabled spool reports no recorded runs', () => {
  const missing = spoolPath();
  assert.equal(
    renderHookSpoolStatus(['status'], { BRO_HOOK_SPOOL: missing }, 100_000),
    'no hook runs recorded'
  );
  assert.equal(
    renderHookSpoolStatus(['status'], { BRO_HOOK_SPOOL: '0' }, 100_000),
    'no hook runs recorded'
  );
});

test('empty JSON status reports an empty array', () => {
  const missing = spoolPath();
  assert.equal(
    renderHookSpoolStatus(['status', '--json'], { BRO_HOOK_SPOOL: missing }, 100_000),
    '[]'
  );
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendHookSpoolRows,
  formatSpoolRow,
  hookSpoolFiles,
  isSpoolOutcome,
  parseSpoolLine,
  resolveHookSpoolPath,
  SPOOL_OUTCOMES,
  type SpoolRow,
} from './hook-spool.ts';

test('v1 start and end rows parse with cwd re-joined', () => {
  const start = parseSpoolLine(
    'v1\t1700000000\tstart\tabc-1\tcursor\tpost-tool\t/repo\twith\ttabs'
  );
  assert.deepEqual(start, {
    version: 1,
    ts: 1700000000,
    phase: 'start',
    id: 'abc-1',
    host: 'cursor',
    event: 'post-tool',
    cwd: '/repo\twith\ttabs',
  });
  const end = parseSpoolLine(
    'v1\t1700000002\tend\tabc-1\tcursor\tpost-tool\t0\tok\t/repo\twith\ttabs'
  );
  assert.equal(end?.phase, 'end');
  assert.equal(end?.rc, 0);
  assert.equal(end?.outcome, 'ok');
  assert.equal(end?.cwd, '/repo\twith\ttabs');
});

test('v2 rows carry the enriched fields', () => {
  const row = parseSpoolLine(
    'v2\t1700000000\tstart\tabc-1\tdevin\tsid-9\tsession-start\t4242\t100\tagent-x\t0.3.0\t/opt/bro\ttmux\t/work/repo'
  );
  assert.deepEqual(row, {
    version: 2,
    ts: 1700000000,
    phase: 'start',
    id: 'abc-1',
    host: 'devin',
    sid: 'sid-9',
    event: 'session-start',
    pid: 4242,
    ppid: 100,
    agent: 'agent-x',
    adapter: '0.3.0',
    pluginRoot: '/opt/bro',
    launcher: 'tmux',
    cwd: '/work/repo',
  });
});

test('v2 end rows place rc and outcome before the cwd tail', () => {
  const row = parseSpoolLine(
    'v2\t1700000003\tend\tabc-1\tdevin\tsid-9\tpost-tool\t4242\t100\tagent-x\t0.3.0\t/opt/bro\ttmux\t0\tfastpath\t/work/repo\ttabbed'
  );
  assert.equal(row?.rc, 0);
  assert.equal(row?.outcome, 'fastpath');
  assert.equal(row?.cwd, '/work/repo\ttabbed');
});

test('v2 empty enrichment fields normalize to undefined', () => {
  const row = parseSpoolLine(
    'v2\t1700000000\tstart\tabc-1\tunknown\t\tpost-tool\t1\t0\t\t\t\t\t/repo'
  );
  assert.equal(row?.sid, undefined);
  assert.equal(row?.agent, undefined);
  assert.equal(row?.adapter, undefined);
  assert.equal(row?.pluginRoot, undefined);
  assert.equal(row?.launcher, undefined);
  assert.equal(row?.pid, 1);
});

test('malformed and foreign rows are skipped, never fatal', () => {
  for (const line of [
    '',
    'garbage',
    'v3\t1700000000\tstart\tid\thost\tevent\t/repo',
    'v1\tnotanumber\tstart\tid\thost\tevent\t/repo',
    'v1\t1700000000\tbogus\tid\thost\tevent\t/repo',
    'v1\t1700000000\tstart\t\thost\tevent\t/repo', // missing id
    'v1\t1700000000\tend\tid\thost\tevent\tabc\tok\t/repo', // non-numeric rc
    'v1\t1700000000\tend\tid\thost\tevent\t0\tbogus-outcome\t/repo',
    'v2\t1700000000\tend\tid\thost\tsid\tevent\t1\t0\tagent\tad\tproot\tlauncher\tx\tok\t/repo', // non-numeric rc
  ]) {
    assert.equal(parseSpoolLine(line), undefined, line);
  }
});

test('canonical and writer outcomes are all recognized', () => {
  for (const outcome of SPOOL_OUTCOMES) {
    assert.equal(isSpoolOutcome(outcome), true, outcome);
    const row = parseSpoolLine(
      `v2\t1\tend\tid\thost\tsid\tevent\t1\t0\t\t\t\t\t0\t${outcome}\t/repo`
    );
    assert.equal(row?.outcome, outcome, outcome);
  }
  assert.equal(isSpoolOutcome('bogus'), false);
  assert.equal(isSpoolOutcome(undefined), false);
});

test('a CRLF line ending does not corrupt the row', () => {
  const row = parseSpoolLine('v1\t1700000000\tstart\tid\tcursor\tpost-tool\t/repo\r');
  assert.equal(row?.cwd, '/repo');
});

test('resolveHookSpoolPath honors the env contract', () => {
  assert.equal(resolveHookSpoolPath({ BRO_HOOK_SPOOL: '0' }), null);
  assert.equal(
    resolveHookSpoolPath({ BRO_HOOK_SPOOL: '/tmp/x.spool', HOME: '/h' }),
    '/tmp/x.spool'
  );
  assert.equal(
    resolveHookSpoolPath({ XDG_STATE_HOME: '/xdg', HOME: '/h' }),
    '/xdg/bro/hooks.spool'
  );
  assert.equal(resolveHookSpoolPath({ HOME: '/h' }), '/h/.local/state/bro/hooks.spool');
});

test('hookSpoolFiles drains the rotated file before the live one', () => {
  assert.deepEqual(hookSpoolFiles('/s/hooks.spool'), ['/s/hooks.spool.1', '/s/hooks.spool']);
});

// --- writer (bro-izpyk.9) ------------------------------------------------------
// formatSpoolRow/appendHookSpoolRows are the Node-side Tier-0 writer the
// in-process adapters' `bro hooks` path uses — run.sh's contract, so the
// round-trip through parseSpoolLine IS the assertion.

// synthetic host slugs — core tests exercise the wire contract, the
// real adapter names belong to the CLI/plugin layer
const V2_START: SpoolRow = {
  version: 2,
  ts: 1700000000,
  phase: 'start',
  id: 'p-1',
  host: 'xhost',
  sid: 'sess-9',
  event: 'session-start',
  pid: 4242,
  ppid: 100,
  agent: 'agent-x',
  adapter: '0.3.0',
  pluginRoot: '/opt/bro',
  launcher: 'tmux',
  cwd: '/work/repo',
};

test('formatSpoolRow round-trips a full v2 pair through parseSpoolLine', () => {
  const start = parseSpoolLine(formatSpoolRow(V2_START).trimEnd());
  assert.deepEqual(start, V2_START);
  const end: SpoolRow = { ...V2_START, ts: 1700000005, phase: 'end', rc: 0, outcome: 'ok' };
  assert.deepEqual(parseSpoolLine(formatSpoolRow(end).trimEnd()), end);
});

test('formatSpoolRow emits absent v2 enrichments as empty fields', () => {
  const row = parseSpoolLine(
    formatSpoolRow({
      version: 2,
      ts: 1,
      phase: 'start',
      id: 'i',
      host: 'yhost',
      event: 'post-tool',
      cwd: '/r',
    }).trimEnd()
  );
  assert.deepEqual(row, {
    version: 2,
    ts: 1,
    phase: 'start',
    id: 'i',
    host: 'yhost',
    event: 'post-tool',
    cwd: '/r',
    // every enrichment slot parsed to undefined — not a column shift
    sid: undefined,
    pid: undefined,
    ppid: undefined,
    agent: undefined,
    adapter: undefined,
    pluginRoot: undefined,
    launcher: undefined,
  });
});

test('formatSpoolRow writes the v1 layout too', () => {
  const row: SpoolRow = {
    version: 1,
    ts: 2,
    phase: 'end',
    id: 'i',
    host: 'cursor',
    event: 'post-tool',
    rc: 0,
    outcome: 'ok',
    cwd: '/r',
  };
  assert.deepEqual(parseSpoolLine(formatSpoolRow(row).trimEnd()), row);
});

test('formatSpoolRow strips tab/newline from mid-row fields', () => {
  const row: SpoolRow = {
    version: 2,
    ts: 1,
    phase: 'start',
    id: 'i\td',
    host: 'op\nencode',
    event: 'ev\r',
    cwd: '/r',
  };
  const line = formatSpoolRow(row);
  assert.equal(line.split('\t').length, 14, line);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.includes('i\td'), false);
});

test('appendHookSpoolRows appends a parseable batch and honors the contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-spool-write-'));
  try {
    const spool = join(dir, 'nested', 'hooks.spool');
    const env = { BRO_HOOK_SPOOL: spool, HOME: dir };
    const pair = [V2_START, { ...V2_START, phase: 'end' as const, rc: 0, outcome: 'ok' as const }];
    assert.equal(appendHookSpoolRows(pair, env), true);
    // the parent dir was created; the file parses row-for-row
    const rows = readFileSync(spool, 'utf8').trim().split('\n').map(parseSpoolLine);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.phase, 'start');
    assert.equal(rows[1]?.outcome, 'ok');
    // a second append extends, never truncates
    assert.equal(appendHookSpoolRows([V2_START], env), true);
    assert.equal(readFileSync(spool, 'utf8').trim().split('\n').length, 3);
    // disabled / empty / unwritable are false, never a throw
    assert.equal(appendHookSpoolRows(pair, { BRO_HOOK_SPOOL: '0' }), false);
    assert.equal(appendHookSpoolRows([], env), false);
    assert.equal(appendHookSpoolRows(pair, { BRO_HOOK_SPOOL: join(dir, 'x\0y') }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

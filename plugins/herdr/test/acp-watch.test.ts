import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpRenderer } from '../../../packages/acp/session/src/index.ts';
import {
  acpWatchLanePath,
  occupyAcpWatchLane,
  parseArgs,
  releaseAcpWatchLane,
  run,
  runFixture,
  Wire,
} from '../src/acp-watch.ts';
import { shellWords } from '../src/lib.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'acp-session.jsonl');
const FAKE = join(HERE, 'fixtures', 'fake-acp-agent.ts');

const plain = (): { lines: string[]; r: AcpRenderer } => {
  const lines: string[] = [];
  return { lines, r: new AcpRenderer(s => lines.push(s), { color: false }) };
};

describe('parseArgs', () => {
  test('defaults — devin acp, cwd, color per NO_COLOR', () => {
    const cli = parseArgs([], { NO_COLOR: '1' } as NodeJS.ProcessEnv);
    assert.equal(cli.cmd, 'devin acp');
    assert.equal(cli.color, false);
  });

  test('flags parse', () => {
    const cli = parseArgs(['--cmd', 'kilo acp', '--prompt', 'hi', '--cwd', '/x']);
    assert.equal(cli.cmd, 'kilo acp');
    assert.equal(cli.prompt, 'hi');
    assert.equal(cli.cwd, '/x');
  });

  test('unknown arg and missing value fail loud', () => {
    assert.throws(() => parseArgs(['--bogus']));
    assert.throws(() => parseArgs(['--cmd']));
    assert.throws(() => parseArgs(['--cmd', '']));
    assert.throws(() => parseArgs(['--prompt', '']));
  });

  test('--permit validates against auto|reads|none, env overrides', () => {
    assert.equal(parseArgs(['--permit', 'reads']).permit, 'reads');
    assert.equal(parseArgs([], { ACP_WATCH_PERMIT: 'none' } as NodeJS.ProcessEnv).permit, 'none');
    assert.throws(() => parseArgs(['--permit', 'yolo']));
    assert.throws(() => parseArgs([], { ACP_WATCH_PERMIT: 'yolo' } as NodeJS.ProcessEnv));
  });

  test('stall watchdog timeout is configurable and must be positive', () => {
    assert.equal(parseArgs(['--stall-timeout-ms', '250']).stallTimeoutMs, 250);
    assert.equal(
      parseArgs([], { ACP_WATCH_STALL_TIMEOUT_MS: '375' } as NodeJS.ProcessEnv).stallTimeoutMs,
      375
    );
    assert.throws(() => parseArgs(['--stall-timeout-ms', '0']));
    assert.throws(() => parseArgs([], { ACP_WATCH_STALL_TIMEOUT_MS: 'nope' } as NodeJS.ProcessEnv));
  });

  test('--cmd splits into argv words — never one shell string', () => {
    const cli = parseArgs(['--cmd', "kilo acp --flag 'a b'"]);
    assert.deepEqual(cli.cmdArgv, ['kilo', 'acp', '--flag', 'a b']);
  });
});

describe('shellWords', () => {
  test('quotes concatenate with bare runs like a shell would', () => {
    assert.deepEqual(shellWords("a'b c'd"), ['ab cd']);
    assert.deepEqual(shellWords('  x  y '), ['x', 'y']);
    assert.deepEqual(shellWords(''), []);
    assert.deepEqual(shellWords('"a\\"b" c'), ['a"b', 'c']);
  });

  test('escapes expand outside single quotes only', () => {
    assert.deepEqual(shellWords('a\\nb'), ['a\nb']);
    assert.deepEqual(shellWords("'a\\nb'"), ['a\\nb']);
  });

  test('empty quoted tokens survive as empty argv', () => {
    assert.deepEqual(shellWords('a "" b'), ['a', '', 'b']);
    assert.deepEqual(shellWords("''"), ['']);
    assert.deepEqual(shellWords("x ''"), ['x', '']);
  });

  test('unclosed quote and trailing backslash are usage errors', () => {
    assert.throws(() => shellWords("a'b"), /unclosed/);
    assert.throws(() => shellWords('"x'), /unclosed/);
    assert.throws(() => shellWords('x\\'), /trailing backslash/);
  });
});

describe('acp-watch cwd lanes', () => {
  test('conflicts name a live owner and release removes only our marker', () => {
    const state = mkdtempSync(join(tmpdir(), 'acp-watch-state-'));
    const cwd = mkdtempSync(join(tmpdir(), 'acp-watch-cwd-'));
    try {
      const first = occupyAcpWatchLane(cwd, state);
      assert.throws(
        () => occupyAcpWatchLane(cwd, state),
        new RegExp(`pid ${process.pid}.*${first.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
      releaseAcpWatchLane(first);
      assert.throws(() => readFileSync(first.marker));
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reclaims a dead marker and does not conflict across cwds', () => {
    const state = mkdtempSync(join(tmpdir(), 'acp-watch-state-'));
    const one = mkdtempSync(join(tmpdir(), 'acp-watch-cwd-'));
    const two = mkdtempSync(join(tmpdir(), 'acp-watch-cwd-'));
    try {
      const dead = acpWatchLanePath(one, state);
      writeFileSync(dead, JSON.stringify({ pid: 999_999_999, startTime: 'old', worktree: one }));
      const reclaimed = occupyAcpWatchLane(one, state);
      const distinct = occupyAcpWatchLane(two, state);
      assert.equal(JSON.parse(readFileSync(reclaimed.marker, 'utf8')).pid, process.pid);
      assert.notEqual(reclaimed.marker, distinct.marker);
      releaseAcpWatchLane(reclaimed);
      releaseAcpWatchLane(distinct);
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(one, { recursive: true, force: true });
      rmSync(two, { recursive: true, force: true });
    }
  });
});

describe('Wire — inbound requests', () => {
  test('session/request_permission answers selected + renders the chip', () => {
    const sent: unknown[] = [];
    const { lines, r } = plain();
    const w = new Wire(m => sent.push(m), r);
    w.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: {
          toolCall: { toolCallId: 't', title: 'Edit x', kind: 'edit' },
          options: [
            { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'o2', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
    );
    assert.deepEqual(sent[0], {
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'o1' } },
    });
    assert.ok(lines.some(l => l.startsWith('⚠ Edit x')));
  });

  test('unadvertised agent→client method → -32601 + visible line', () => {
    const sent: unknown[] = [];
    const { lines, r } = plain();
    const w = new Wire(m => sent.push(m), r);
    w.onLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'terminal/create', params: {} }));
    assert.deepEqual(sent[0], {
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'terminal/create: method not found' },
    });
    assert.ok(lines.some(l => l.includes('terminal/create') && l.includes('method-not-found')));
  });

  test('fs/read_text_file serves the file content', () => {
    const sent: unknown[] = [];
    const { r } = plain();
    const w = new Wire(m => sent.push(m), r);
    w.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'fs/read_text_file',
        params: { path: FIXTURE },
      })
    );
    const res = (sent[0] as { result: { content: string } }).result;
    assert.ok(res.content.includes('sessionId'));
  });
});

describe('Wire — turn boundary', () => {
  test('a response carrying stopReason settles the turn once', () => {
    const { lines, r } = plain();
    const w = new Wire(() => {}, r);
    let settled = 0;
    w.onTurnEnd = reason => {
      settled++;
      r.turnEnd(reason);
    };
    w.onLine(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }));
    w.onLine(JSON.stringify({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } }));
    assert.equal(settled, 1);
    assert.ok(lines.some(l => l.includes('turn complete (end_turn)')));
  });
});

describe('runFixture — recorded wire replay', () => {
  test('the recorded session renders the spec’s update shapes', () => {
    const { lines, r } = plain();
    const code = runFixture(FIXTURE, r);
    assert.equal(code, 0);
    const joined = lines.join('\n');
    // thought dimmed vs message plain — fixture ran colorless so
    // thoughts are bare text here; styling is the unit test's job
    assert.ok(joined.includes('I need to list the files'));
    assert.ok(joined.includes('`/tmp`'));
    // tool lifecycle EDGES only — pending+in_progress are one live
    // edge (⣿), completion re-prints with ✓ and the kind-guided arg
    assert.equal(lines.filter(l => l.includes('⣿')).length, 1);
    assert.ok(joined.includes('✓ Listed ./ [execute] ls -la /tmp'));
    // plan re-rendered checklist
    assert.ok(joined.includes('[x] Inspect the workspace layout'));
    assert.ok(joined.includes('[>] Report findings'));
    // permission chip
    assert.ok(joined.includes('⚠ Edit README.md'));
    // sideband dedupe tallies + turn boundary + closing marker
    assert.ok(joined.includes('── turn complete (end_turn) ──'));
    assert.ok(joined.includes('session ended (fixture replayed)'));
  });
});

describe('run — end-to-end against a fake ACP agent', () => {
  test('a silent child is killed and reports a stall rather than succeeding', async () => {
    const { lines, r } = plain();
    const code = await run(
      {
        cmd: process.execPath,
        cmdArgv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        color: false,
        permit: 'auto',
        stallTimeoutMs: 25,
      },
      r,
      () => {}
    );
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('child stalled (no output for 25ms)')));
  });

  test('handshake → prompt → updates → permission → end_turn → exit 0', async () => {
    const { lines, r } = plain();
    const code = await run(
      {
        cmd: `${process.execPath} ${FAKE}`,
        cmdArgv: [process.execPath, FAKE],
        cwd: process.cwd(),
        prompt: 'do it',
        color: false,
        permit: 'auto',
        stallTimeoutMs: 1000,
      },
      r,
      () => {}
    );
    assert.equal(code, 0);
    const joined = lines.join('\n');
    assert.ok(joined.includes('thinking about the task'));
    assert.ok(joined.includes('✓ Run ls [execute]'));
    assert.ok(joined.includes('⚠ Run ls'));
    assert.ok(joined.includes('Done — the files are listed.'));
    assert.ok(joined.includes('── turn complete (end_turn) ──'));
    assert.ok(joined.includes('session ended'));
  });

  test('a dead command closes with the exit detail, non-zero code', async () => {
    const { lines, r } = plain();
    const code = await run(
      {
        cmd: 'false',
        cmdArgv: ['false'],
        cwd: process.cwd(),
        prompt: 'x',
        color: false,
        permit: 'auto',
      },
      r,
      () => {}
    );
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('session ended')));
  });
});

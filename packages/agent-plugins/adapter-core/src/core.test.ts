/**
 * The adapter core's contract — the parts every client depends on.
 *
 * The core is the shared half of every bro adapter: the CLI ladder, the
 * hook protocol, the board read. These tests pin the behaviors a
 * client adapter cannot afford to get wrong — a failed probe must never
 * throw, a broken line must not swallow the answer, and a missing CLI
 * must read as "no opinion" rather than an error.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  boardLines,
  broEnabled,
  callHookDetailed,
  clip,
  contextOf,
  hookFailureText,
  parseControl,
  statusCrumb,
  type BoardStatus,
} from './core.ts';

test('parseControl: the first parseable JSON line wins', () => {
  const control = parseControl('not json\n{"decision":"block","reason":"x"}\n{"other":1}\n');
  assert.equal(control?.decision, 'block');
  assert.equal(control?.reason, 'x');
});

test('parseControl: unrelated chatter does not swallow the answer', () => {
  const control = parseControl(
    'Loading beads...\n{"hookSpecificOutput":{"additionalContext":"hi"}}\n'
  );
  assert.equal(contextOf(control), 'hi');
});

test('parseControl: garbage yields null, never a throw', () => {
  assert.equal(parseControl(''), null);
  assert.equal(parseControl('not json at all'), null);
  assert.equal(parseControl('[1,2,3]'), null);
  assert.equal(parseControl('null'), null);
  assert.equal(parseControl('42'), null);
});

test('contextOf: only a string counts as context', () => {
  assert.equal(contextOf(null), '');
  assert.equal(contextOf({}), '');
  assert.equal(contextOf({ hookSpecificOutput: { additionalContext: 42 } }), '');
  assert.equal(contextOf({ hookSpecificOutput: { additionalContext: '  spaced  ' } }), 'spaced');
});

test('clip: marks the cut and never exceeds the width', () => {
  assert.equal(clip('short', 10), 'short');
  const clipped = clip('x'.repeat(50), 10);
  assert.equal(clipped.length, 10);
  assert.ok(clipped.endsWith('…'));
});

test('broEnabled: a repo with a bro config opts in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-enabled-'));
  try {
    assert.equal(broEnabled(dir), false);
    writeFileSync(join(dir, 'bro.config.json'), '{}');
    assert.equal(broEnabled(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broEnabled: .beads alone opts in — a beads repo is a bro repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-enabled-'));
  try {
    mkdirSync(join(dir, '.beads'));
    assert.equal(broEnabled(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broEnabled: the marker is found up the tree, not just in the cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'bro-enabled-'));
  try {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'bro.config.json'), '{}');
    assert.equal(broEnabled(nested), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('boardLines: one summary line, then the top beads and workers', () => {
  const board: BoardStatus = {
    dirty: 2,
    beads: {
      readyTotal: 7,
      inProgress: [
        { id: 'bro-1', title: 'first' },
        { id: 'bro-2', title: 'second' },
        { id: 'bro-3', title: 'third' },
        { id: 'bro-4', title: 'fourth' },
      ],
    },
    fleet: {
      maxConcurrent: 3,
      agents: [
        { id: 'a1', backend: 'devin', state: 'running', step: 'coding' },
        { id: 'a2', backend: 'kilo', state: 'running' },
        { id: 'a3', backend: 'x', state: 'exited' },
      ],
    },
  };
  const lines = boardLines(board);
  // the summary carries the counts the widget shows at a glance
  assert.ok(lines[0].includes('◐ 4 beads'));
  assert.ok(lines[0].includes('fleet 2/3'));
  assert.ok(lines[0].includes('ready 7'));
  assert.ok(lines[0].includes('dirty 2'));
  // only the top three beads — the widget is a glance, not a ledger
  assert.equal(lines.filter(l => l.includes('◐ bro-')).length, 3);
  // only the running workers
  assert.equal(lines.filter(l => l.includes('▶')).length, 2);
});

test('boardLines: an empty board still renders a summary', () => {
  const lines = boardLines({});
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('◐ 0 beads'));
});

test('statusCrumb: the one-glance form of the same board', () => {
  const crumb = statusCrumb({
    beads: { inProgress: [{ id: 'a' }, { id: 'b' }] },
    fleet: { agents: [{ id: 'x', state: 'running' }] },
  });
  assert.equal(crumb, 'bro ◐2 ⬢1');
});

// --- callHookDetailed: every failure mode is a named class, healthy
// silence stays classless ------------------------------------------------

const hookDir = mkdtempSync(join(tmpdir(), 'bro-hook-'));
const stubCli = join(hookDir, 'hook-stub.mjs');
writeFileSync(
  stubCli,
  `const map = process.env.BRO_STUB_MAP ? JSON.parse(process.env.BRO_STUB_MAP) : {}
const event = process.argv[process.argv.indexOf('hooks') + 1] ?? ''
process.stdin.resume()
if (process.env.BRO_STUB_SLEEP) {
  setTimeout(() => {}, Number(process.env.BRO_STUB_SLEEP))
} else {
  if (event in map) process.stdout.write(map[event] ?? '')
  process.exit(Number(process.env.BRO_STUB_STATUS ?? '0'))
}
`
);

const stubCmd = { cmd: process.execPath, args: [stubCli] };

after(() => {
  rmSync(hookDir, { recursive: true, force: true });
  delete process.env.BRO_STUB_MAP;
  delete process.env.BRO_STUB_STATUS;
  delete process.env.BRO_STUB_SLEEP;
});

function stubAnswer(map: Record<string, string>, status = '0', sleep?: number): void {
  process.env.BRO_STUB_MAP = JSON.stringify(map);
  process.env.BRO_STUB_STATUS = status;
  if (sleep === undefined) {
    delete process.env.BRO_STUB_SLEEP;
  } else {
    process.env.BRO_STUB_SLEEP = String(sleep);
  }
}

test('callHookDetailed: a control object is health, not failure', async () => {
  stubAnswer({ stop: '{"decision":"block","reason":"x"}' });
  const { control, failure } = await callHookDetailed(stubCmd, 'stop', {}, hookDir, 5_000);
  assert.equal(control?.decision, 'block');
  assert.equal(failure, null);
});

test('callHookDetailed: clean exit + empty stdout is silence, no failure', async () => {
  stubAnswer({});
  const { control, failure } = await callHookDetailed(stubCmd, 'stop', {}, hookDir, 5_000);
  assert.equal(control, null);
  assert.equal(failure, null);
});

test('callHookDetailed: a nonzero exit names its code', async () => {
  stubAnswer({}, '3');
  const { control, failure } = await callHookDetailed(stubCmd, 'stop', {}, hookDir, 5_000);
  assert.equal(control, null);
  assert.deepEqual(failure, { kind: 'exit', code: 3 });
});

test('callHookDetailed: chatter with no control line is broken output', async () => {
  stubAnswer({ stop: 'loading...\ngarbage\n' });
  const { control, failure } = await callHookDetailed(stubCmd, 'stop', {}, hookDir, 5_000);
  assert.equal(control, null);
  assert.deepEqual(failure, { kind: 'output' });
});

test('callHookDetailed: a timed-out hook is its own class', async () => {
  stubAnswer({}, '0', 60_000);
  const { control, failure } = await callHookDetailed(stubCmd, 'stop', {}, hookDir, 50);
  assert.equal(control, null);
  assert.deepEqual(failure, { kind: 'timeout', timeoutMs: 50 });
});

test('callHookDetailed: a child that cannot spawn is its own class', async () => {
  const { control, failure } = await callHookDetailed(
    { cmd: '/nonexistent/bro-cli-xyz', args: [] },
    'stop',
    {},
    hookDir,
    5_000
  );
  assert.equal(control, null);
  assert.deepEqual(failure, { kind: 'spawn' });
});

test('callHookDetailed: an unserializable payload is an outage, not silence', async () => {
  // JSON.stringify throws on circular input — the hook can never run, so
  // resolving {control:null,failure:null} was the invisible-outage bug:
  // the class must be named, and no child is spawned for input it could
  // never receive
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const { control, failure } = await callHookDetailed(stubCmd, 'stop', circular, hookDir, 5_000);
  assert.equal(control, null);
  assert.deepEqual(failure, { kind: 'input' });
  // stringify returns undefined (not a throw) for undefined/functions/
  // symbols — same outage class, still no child spawned
  const undef = await callHookDetailed(stubCmd, 'stop', undefined, hookDir, 5_000);
  assert.equal(undef.control, null);
  assert.deepEqual(undef.failure, { kind: 'input' });
});

test('hookFailureText: every class has a one-line cause', () => {
  assert.equal(hookFailureText({ kind: 'no-cli' }), 'no bro CLI resolved');
  assert.equal(hookFailureText({ kind: 'input' }), 'the hook payload could not be serialized');
  assert.equal(hookFailureText({ kind: 'spawn' }), 'the hook process failed to spawn');
  assert.match(hookFailureText({ kind: 'timeout', timeoutMs: 50 }), /50ms/);
  assert.equal(hookFailureText({ kind: 'exit', code: 2 }), 'the hook exited 2');
  assert.equal(hookFailureText({ kind: 'output' }), 'the hook answered with no control object');
});

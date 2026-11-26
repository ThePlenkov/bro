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
import { test } from 'node:test';
import {
  boardLines,
  broEnabled,
  clip,
  displayWidth,
  contextOf,
  jsRuntime,
  parseControl,
  statusCrumb,
  type BoardStatus,
} from './core.ts';

test('jsRuntime: never resolves to process.execPath, names a JS runtime', () => {
  assert.notEqual(jsRuntime(), process.execPath);
  assert.match(jsRuntime(), /^(node|node\.exe)$/);
});

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

test('clip: wide glyphs count as two columns, never overflow the width', () => {
  // CJK: each glyph is 2 columns — the fixture is 8 columns
  const clipped = clip('\u4e2d\u6587\u6d4b\u8bd5', 5);
  assert.equal(displayWidth(clipped), 5);
  assert.ok(clipped.endsWith('…'));
  // emoji outside the old 1f300–1f64f range: rockets are width 2
  assert.equal(displayWidth('\u{1F680}'), 2);
  assert.equal(displayWidth(clip('\u{1F680}'.repeat(40), 64)), 63);
  // narrow text is unchanged
  assert.equal(clip('abc', 5), 'abc');
});

test('clip: a surrogate pair never splits', () => {
  const emoji = '\u{1F680}'; // 🚀 — astral, width 2
  const text = `ab${emoji}cd`;
  // width 3: fits 'ab' (2 cols) but not the rocket (2 more) — cut before it
  const clipped = clip(text, 3);
  assert.ok(!/[\uD800-\uDFFF]/.test(clipped.replace('…', '')), 'no lone surrogates');
  assert.ok(clipped.endsWith('…'));
  // full-width fits: nothing clipped
  assert.equal(clip(text, displayWidth(text)), text);
});

test('clip: combining marks are zero-width', () => {
  const accented = 'e\u0301'; // e + combining acute — one column
  assert.equal(displayWidth(accented), 1);
  assert.equal(clip(accented.repeat(10), 5), `${'e\u0301'.repeat(4)}…`);
});

test('displayWidth: handles zero-width joiners and supplementary CJK gaps', () => {
  assert.equal(displayWidth('\u200b\u200c\u200d'), 0);
  assert.equal(displayWidth(String.fromCodePoint(0x2fffe)), 1);
  assert.equal(displayWidth(String.fromCodePoint(0x30000)), 2);
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

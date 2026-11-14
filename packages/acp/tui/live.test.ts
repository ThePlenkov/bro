import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { liveAction, liveHint, livePermissionLine, liveQueueLine, type LiveView } from './live.ts';

const view = (over: Partial<LiveView> = {}): LiveView => ({
  mode: 'browse',
  queue: [],
  permission: undefined,
  status: 'live',
  ...over,
});

describe('the keymap — browse mode', () => {
  test('i and / open the composer', () => {
    assert.deepEqual(liveAction({ name: 'i' }, view()), { kind: 'compose' });
    assert.deepEqual(liveAction({ name: '/' }, view()), { kind: 'compose' });
  });

  test('j/k walk the cards, a/z sweep the folds', () => {
    assert.deepEqual(liveAction({ name: 'j' }, view()), { kind: 'select', delta: 1 });
    assert.deepEqual(liveAction({ name: 'k' }, view()), { kind: 'select', delta: -1 });
    assert.deepEqual(liveAction({ name: 'a' }, view()), { kind: 'expand-all' });
    assert.deepEqual(liveAction({ name: 'z' }, view()), { kind: 'collapse-all' });
  });

  test('Enter folds, the arrows scroll', () => {
    assert.deepEqual(liveAction({ name: 'return' }, view()), { kind: 'fold' });
    assert.deepEqual(liveAction({ name: 'space' }, view()), { kind: 'fold' });
    assert.deepEqual(liveAction({ name: 'up' }, view()), { kind: 'scroll', lines: -3 });
    assert.deepEqual(liveAction({ name: 'down' }, view()), { kind: 'scroll', lines: 3 });
    assert.deepEqual(liveAction({ name: 'pageup' }, view()), { kind: 'page', dir: -1 });
    assert.deepEqual(liveAction({ name: 'end' }, view()), { kind: 'edge', edge: 1 });
  });

  test('Ctrl+C copies, Ctrl+X cancels, Ctrl+D quits', () => {
    assert.deepEqual(liveAction({ name: 'c', ctrl: true }, view()), { kind: 'copy' });
    assert.deepEqual(liveAction({ name: 'x', ctrl: true }, view()), { kind: 'cancel' });
    assert.deepEqual(liveAction({ name: 'd', ctrl: true }, view()), { kind: 'quit' });
  });

  test('q quits', () => {
    assert.deepEqual(liveAction({ name: 'q' }, view()), { kind: 'quit' });
  });
});

describe('the keymap — compose mode', () => {
  const composing = view({ mode: 'compose' });

  test('the input owns every key — a letter must stay typeable', () => {
    for (const name of ['j', 'k', 'a', 'z', 'c', 'i', '1', 'q']) {
      assert.deepEqual(
        liveAction({ name }, composing),
        { kind: 'none' },
        `'${name}' must reach the composer`
      );
    }
  });

  test('Escape leaves the composer — the draft stays', () => {
    assert.deepEqual(liveAction({ name: 'escape' }, composing), { kind: 'browse' });
  });

  test('Ctrl+X still cancels the turn, Ctrl+C still copies', () => {
    assert.deepEqual(liveAction({ name: 'x', ctrl: true }, composing), { kind: 'cancel' });
    assert.deepEqual(liveAction({ name: 'c', ctrl: true }, composing), { kind: 'copy' });
  });
});

describe('the keymap — a permission ask', () => {
  const asking = view({
    permission: {
      requestId: 7,
      title: 'Run ls',
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });

  test('the digits pick the agent’s own option, d denies', () => {
    assert.deepEqual(liveAction({ name: '1' }, asking), { kind: 'answer', index: 0 });
    assert.deepEqual(liveAction({ name: '2' }, asking), { kind: 'answer', index: 1 });
    assert.deepEqual(liveAction({ name: 'd' }, asking), { kind: 'deny' });
  });

  test('a digit with no option behind it does nothing', () => {
    assert.deepEqual(liveAction({ name: '3' }, asking), { kind: 'none' });
    assert.deepEqual(liveAction({ name: '1' }, view()), { kind: 'none' });
  });

  test('the ask does not steal the pane’s own keys', () => {
    assert.deepEqual(liveAction({ name: 'j' }, asking), { kind: 'select', delta: 1 });
    assert.deepEqual(liveAction({ name: 'i' }, asking), { kind: 'compose' });
  });
});

describe('the queue line — a sent prompt must be seen waiting', () => {
  test('no queue, no line', () => {
    assert.equal(liveQueueLine([]), '');
  });

  test('the queue says how many and what is next', () => {
    const line = liveQueueLine([
      { ordinal: 1, text: 'and now the tests' },
      { ordinal: 2, text: 'then the docs' },
    ]);
    assert.match(line, /⏳ 2 queued/);
    assert.match(line, /next: and now the tests/);
  });

  test('a long prompt is clipped, not dropped', () => {
    const line = liveQueueLine([{ ordinal: 1, text: 'x'.repeat(200) }]);
    assert.match(line, /…$/);
    assert.ok(line.length < 120);
  });
});

describe('the permission line', () => {
  test('no ask, no line', () => {
    assert.equal(livePermissionLine(undefined), '');
  });

  test('the options are numbered, the way out is spelled out', () => {
    const line = livePermissionLine({
      requestId: 1,
      title: 'Write /etc/hosts',
      options: [
        { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'r', name: 'Reject', kind: 'reject_once' },
      ],
    });
    assert.match(line, /1\) Allow once/);
    assert.match(line, /2\) Reject/);
    assert.match(line, /d deny/);
  });
});

describe('the hint', () => {
  test('it names the composer, the cancel and the ask', () => {
    assert.match(liveHint(view()), /i compose/);
    assert.match(liveHint(view()), /Ctrl\+X cancel/);
    assert.match(
      liveHint(view({ permission: { requestId: 1, title: 'x', options: [] } })),
      /1-9 answer/
    );
    assert.match(liveHint(view({ mode: 'compose' })), /Enter send/);
  });
});

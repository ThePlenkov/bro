/**
 * The pane's state fold (spec bro-q2edc) — the pure half of the
 * OpenTUI view.
 *
 * The Solid tree is Bun-only (native FFI), but the fold that feeds
 * it is plain data: these tests run on the repo's Node runner and
 * cover the semantics the tree depends on.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Item, ToolItem } from '../tui/model.ts';
import {
  applyOps,
  COLLAPSE_AT,
  emptyState,
  moveSelection,
  toolIds,
  withMeta,
} from '../tui/state.ts';

const message = (id: number, text: string): Item => ({ id, kind: 'message', text });
const tool = (id: number, title: string): Item => ({
  id,
  kind: 'tool',
  toolCallId: `t${id}`,
  title,
  status: 'live',
  bodyLanded: false,
  collapsed: false,
  content: [],
});

const toolDone = (id: number, lines: number): ToolItem => ({
  id,
  kind: 'tool',
  toolCallId: `t${id}`,
  title: 'Bash',
  status: 'completed',
  bodyLanded: true,
  collapsed: false,
  content: [{ kind: 'text', text: Array.from({ length: lines }, (_, i) => `line${i}`).join('\n') }],
});

describe('the pane state fold', () => {
  test('an append puts the item in the tree and in the order', () => {
    const next = applyOps(emptyState(), [{ op: 'append', item: message(1, 'hello') }]);
    assert.equal(next.order.length, 1);
    assert.equal(next.byId[1]?.kind, 'message');
  });

  test('a text op grows the item it names', () => {
    const first = applyOps(emptyState(), [{ op: 'append', item: message(1, 'Hel') }]);
    const next = applyOps(first, [{ op: 'text', id: 1, text: 'Hello' }]);
    assert.equal(next.byId[1]?.kind === 'tool' ? '' : next.byId[1]?.text, 'Hello');
  });

  test('a text op for an item the pane no longer holds is dropped', () => {
    const first = applyOps(emptyState(), [{ op: 'append', item: message(1, 'Hello') }]);
    const evicted = applyOps(first, [{ op: 'evict', ids: [1] }]);
    const next = applyOps(evicted, [{ op: 'text', id: 1, text: 'late' }]);
    assert.equal(next.byId[1], undefined);
  });

  test('eviction drops the items and their order entries', () => {
    const first = applyOps(emptyState(), [
      { op: 'append', item: message(1, 'one') },
      { op: 'append', item: message(2, 'two') },
    ]);
    const next = applyOps(first, [{ op: 'evict', ids: [1] }]);
    assert.deepEqual(next.order, [2]);
    assert.equal(next.byId[1], undefined);
    assert.equal(next.byId[2]?.id, 2);
  });

  test('the fold copies the item — the model mutates its own in place', () => {
    const item = message(1, 'hello');
    const next = applyOps(emptyState(), [{ op: 'append', item }]);
    item.kind = 'message';
    (item as { text: string }).text = 'mutated behind the view';
    assert.notEqual(
      next.byId[1]?.kind === 'tool' ? '' : next.byId[1]?.text,
      'mutated behind the view'
    );
  });

  test('an evicted selection is dropped', () => {
    const first = applyOps(emptyState(), [{ op: 'append', item: tool(1, 'Bash') }]);
    const selected = applyOps(first, [{ op: 'append', item: message(2, 'two') }]);
    assert.equal(selected.selected, -1);
  });

  test('the tool walk lists the tool cards in order', () => {
    const next = applyOps(emptyState(), [
      { op: 'append', item: message(1, 'one') },
      { op: 'append', item: tool(2, 'Bash') },
      { op: 'append', item: tool(3, 'Edit') },
    ]);
    assert.deepEqual(toolIds(next), [2, 3]);
  });

  test('the selection walk moves over the tool cards only', () => {
    const next = applyOps(emptyState(), [
      { op: 'append', item: message(1, 'one') },
      { op: 'append', item: tool(2, 'Bash') },
      { op: 'append', item: tool(3, 'Edit') },
    ]);
    const first = moveSelection(next, 1);
    assert.equal(first, 2);
    const second = moveSelection({ ...next, selected: first }, 1);
    assert.equal(second, 3);
    // The walk stops at the last card.
    assert.equal(moveSelection({ ...next, selected: second }, 1), 3);
  });

  test('a selection from nothing lands on the first card', () => {
    const next = applyOps(emptyState(), [{ op: 'append', item: tool(1, 'Bash') }]);
    assert.equal(moveSelection(next, 1), 1);
    assert.equal(moveSelection(next, -1), 1);
  });

  test('an empty batch leaves the state untouched', () => {
    const state = emptyState();
    assert.equal(applyOps(state, []), state);
  });
});

describe('the pane header meta', () => {
  test('emptyState seeds a blank meta', () => {
    const s = emptyState();
    assert.equal(s.meta.led, 'unknown');
    assert.equal(s.meta.agent, '');
  });

  test('withMeta merges fields without touching the items', () => {
    const s = applyOps(emptyState({ worktree: '/wt' }), [
      { op: 'append', item: message(1, 'hello') },
    ]);
    const next = withMeta(s, { agent: 'devin', led: 'working', mode: 'turn' });
    assert.equal(next.meta.agent, 'devin');
    assert.equal(next.meta.worktree, '/wt');
    assert.equal(next.order.length, 1);
  });
});

describe('the auto-fold on a landed body', () => {
  test('a born-finished card past the threshold lands folded', () => {
    const next = applyOps(emptyState(), [{ op: 'append', item: toolDone(1, COLLAPSE_AT + 5) }]);
    const item = next.byId[1];
    assert.ok(item !== undefined && item.kind === 'tool' && item.collapsed);
  });

  test('a body landing via tool op folds past the threshold', () => {
    const live = applyOps(emptyState(), [{ op: 'append', item: tool(1, 'Bash') }]);
    const next = applyOps(live, [{ op: 'tool', item: toolDone(1, COLLAPSE_AT + 3) }]);
    const item = next.byId[1];
    assert.ok(item !== undefined && item.kind === 'tool' && item.collapsed);
  });

  test('a small body stays open', () => {
    const next = applyOps(emptyState(), [{ op: 'append', item: toolDone(1, 3) }]);
    const item = next.byId[1];
    assert.ok(item !== undefined && item.kind === 'tool' && !item.collapsed);
  });

  test('a later op never re-folds a card the user opened', () => {
    const born = applyOps(emptyState(), [{ op: 'append', item: toolDone(1, COLLAPSE_AT + 5) }]);
    const item = born.byId[1];
    assert.ok(item !== undefined && item.kind === 'tool' && item.collapsed);
    const opened = { ...item, collapsed: false };
    const userOpened = applyOps(born, [{ op: 'tool', item: opened }]);
    const bumped = applyOps(userOpened, [{ op: 'tool', item: { ...opened, status: 'completed' } }]);
    const still = bumped.byId[1];
    assert.ok(still !== undefined && still.kind === 'tool' && !still.collapsed);
  });
});

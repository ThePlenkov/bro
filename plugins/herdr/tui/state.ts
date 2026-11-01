/**
 * The pane's reactive state (spec bro-q2edc) — the pure half of
 * the OpenTUI view.
 *
 * The model emits ops (`append`/`text`/`tool`/`evict`); the view
 * needs state. This module is the fold between them, and it is
 * plain data: no renderables, no framework, no fs. That is what
 * makes the pane's behaviour testable without a terminal — the
 * Solid tree is Bun-only (native FFI), this is not.
 *
 * Items are keyed by id, never by index: eviction drops the OLDEST
 * items, so an index-keyed row would show the wrong item's updates
 * after the first eviction.
 */
import type { Item, Op, ToolItem } from './model.ts';
import { isFoldable } from './view.ts';

/** The header bar's live fields — what the shell knows that the
 *  items do not: whose worktree, whose session, and the LED verdict
 *  the pane is reporting upstream. */
export interface PaneMeta {
  worktree: string;
  /** The display agent (driver/provider/slug) — sessionAgentOf. */
  agent: string;
  /** The LED state the pane reports — its own health chip. */
  led: string;
  /** The verdict's detail — 'turn', 'streaming', 'waiting…'. */
  mode: string;
}

/** The pane's state — items by id, plus their order. */
export interface PaneState {
  byId: Record<number, Item>;
  order: number[];
  /** The selected tool card's id, or -1 when none is selected. */
  selected: number;
  meta: PaneMeta;
  /** The impl's fold policy (impl.ts `PaneImpl.fold`) — retained
   *  wiring; tool bodies now fold unconditionally on landing. */
  foldAll?: boolean;
}

/** Line-count marker for a large body — tests use it to fabricate
 *  oversized cards. */
export const COLLAPSE_AT = 12;

/** A fresh, empty pane state. */
export function emptyState(meta?: Partial<PaneMeta>, foldAll?: boolean): PaneState {
  return {
    byId: {},
    order: [],
    selected: -1,
    meta: { worktree: '', agent: '', led: 'unknown', mode: '', ...meta },
    foldAll,
  };
}

/** The ids of the foldable rows, in order — the j/k walk path:
 *  tool cards plus text blocks long enough to fold (addendum 20). */
export function toolIds(state: PaneState): number[] {
  return state.order.filter(id => {
    const it = state.byId[id];
    return it !== undefined && isFoldable(it);
  });
}

/**
 * Fold an op batch into the state.
 *
 * Every op is applied in order, so the result matches what a
 * sequential application would produce. The fold is pure — it
 * returns a new state and never mutates the input.
 *
 * Items are copied on the way in: the model mutates its own items
 * in place, so storing the model's object would let it change
 * underneath the view without the view ever being told.
 */
export function applyOps(state: PaneState, ops: readonly Op[]): PaneState {
  if (ops.length === 0) return state;
  const byId = { ...state.byId };
  let order = state.order;
  let selected = state.selected;

  for (const op of ops) {
    switch (op.op) {
      case 'append': {
        const item = { ...op.item };
        // A card born carrying a body lands folded — every completed
        // call is a compact `⏺ ✓` row; the body (file dumps, JSON
        // output) never takes the feed unpinned. Enter/c or the j/k
        // peek reveals it.
        if (item.kind === 'tool' && item.bodyLanded) {
          item.collapsed = true;
        }
        // Long text blocks fold by default too — a 300-line review
        // dump never owns the screen unpinned (addendum 20).
        if (item.kind !== 'tool' && isFoldable(item)) {
          item.collapsed = true;
        }
        byId[op.item.id] = item;
        order = [...order, op.item.id];
        break;
      }
      case 'text': {
        const item = byId[op.id];
        // A text op for an item the pane no longer holds (evicted
        // before the op drained) is dropped — its row is gone.
        if (item === undefined || item.kind === 'tool') break;
        {
          const next = { ...item, text: op.text };
          // A block that grows past the fold threshold collapses —
          // a deliberate user fold is never overridden.
          if (next.foldTouched !== true && isFoldable(next)) {
            next.collapsed = true;
          }
          byId[op.id] = next;
        }
        break;
      }
      case 'tool': {
        const item = byId[op.item.id];
        if (item === undefined || item.kind !== 'tool') break;
        const next: ToolItem = { ...item, ...op.item };
        // Fold fields are pane-owned: a routine op omits them (the acp
        // convention) and the pane's fold survives; an op that carries
        // them (a deliberate toggle) is authoritative.
        if (op.item.collapsed === undefined) next.collapsed = item.collapsed;
        if (op.item.foldTouched === undefined) next.foldTouched = item.foldTouched;
        // A body lands folded — every completed call collapses to its
        // compact row; file/output dumps never own the feed. Only on
        // the body's first landing: a later op never re-folds a card
        // the user opened.
        if (next.bodyLanded === true && item.bodyLanded !== true) {
          next.collapsed = true;
        }
        byId[op.item.id] = next;
        break;
      }
      case 'evict': {
        const dropped = new Set(op.ids);
        for (const id of op.ids) delete byId[id];
        order = order.filter(id => !dropped.has(id));
        // The selection may have been the evicted card.
        if (dropped.has(selected)) selected = -1;
        break;
      }
    }
  }
  return { ...state, byId, order, selected };
}

/** The header bar's fields — the shell pushes them in alongside
 *  the item ops; the tree reads them like any other state. */
export function withMeta(state: PaneState, meta: Partial<PaneMeta>): PaneState {
  return { ...state, meta: { ...state.meta, ...meta } };
}

/**
 * The next selected tool id after a j/k move.
 *
 * Selection is by id, so it survives an eviction of some other
 * card. From nothing selected, any move lands on the first card.
 */
export function moveSelection(state: PaneState, delta: number): number {
  const ids = toolIds(state);
  const first = ids[0];
  if (first === undefined) return -1;
  const current = ids.indexOf(state.selected);
  if (current === -1) return first;
  const next = Math.min(ids.length - 1, Math.max(0, current + delta));
  return ids[next] ?? first;
}

/** The text of a row — agent speech, a thought, or a side line. */
export function rowText(state: PaneState, id: number): string {
  const item = state.byId[id];
  if (item === undefined || item.kind === 'tool') return '';
  return item.text;
}

/** The tool card of a row, or undefined when the row is not one. */
export function toolOf(state: PaneState, id: number): ToolItem | undefined {
  const item = state.byId[id];
  return item?.kind === 'tool' ? item : undefined;
}

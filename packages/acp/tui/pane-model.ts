/**
 * The pane's model seam (spec bro-q2edc) — the store the tree reads
 * and the writer the shell drives.
 *
 * The writer folds model ops into the plain state (`state.ts`) and
 * reconciles the result into the store. Reconciling — rather than
 * writing paths one at a time — keeps the fold in ONE place: the
 * plain fold is unit-testable without a terminal, and `reconcile`
 * patches the changed paths in place, so an untouched row keeps its
 * renderable (a streaming markdown block is not rebuilt per chunk).
 *
 * `key: null` — the items carry their own `id`, but the store's
 * keys are the ids; letting reconcile treat the items as a keyed
 * list would reorder them.
 */

import type { InputRenderable, ScrollBoxRenderable } from '@opentui/core';
import { createStore, reconcile } from 'solid-js/store';
import type { ComposerSubmitEvent } from './live.ts';
import {
  applyOps,
  emptyState,
  type Item,
  isFoldable,
  isSettled,
  moveSelection,
  type Op,
  type PaneMeta,
  type PaneState,
  rowHeight,
  TAIL_BUDGET,
  toolIds,
  withMeta,
} from '../session/src/index.ts';

/** The store the tree renders from. */
export interface PaneStore {
  state: PaneState;
}

/** The store's writer — the shell pushes model ops in through it. */
export interface PaneWriter {
  /** Fold an op batch into the pane's state. */
  apply(ops: readonly Op[]): void;
  /** Move the tool-card selection by `delta` places. */
  select(delta: number): void;
  /** Fold the selected card open or closed. */
  toggle(): void;
  /** Select + pin-toggle a specific foldable row — the `show more`
   *  button's gesture; every press elsewhere still belongs to copy. */
  toggleRow(id: number): void;
  /** Fold EVERY foldable row at once — `a` opens them all, `z`
   *  shuts them all (addendum 27). Marks foldTouched so neither the
   *  auto-fold nor the selection peek overrides the sweep. */
  toggleAll(open: boolean): void;
  /** The selected card's (else the latest row's) full raw text —
   *  Ctrl+C's payload, via the impl's `copyItem` resolver. */
  copy(): string | undefined;
  /** Update the header bar's fields (worktree, agent, LED). */
  setMeta(meta: Partial<PaneMeta>): void;
}

/** The pane — a store to read and a writer to drive. */
export interface Pane {
  store: PaneStore;
  writer: PaneWriter;
  /** A brief footer message ('copied'); '' clears. */
  toast?: (msg: string) => void;
  /** Scroll the timeline by `lines` (+down/-up) — arrows and the
   *  alt-scroll wheel path ride this. */
  scroll?: (lines: number) => void;
  /** Scroll by a viewport. */
  scrollPage?: (dir: -1 | 1) => void;
  /** Jump to the top (0) or the bottom (1). */
  scrollEdge?: (edge: 0 | 1) => void;
  /** Bring an item's row into the viewport — the shell wires it to
   *  the scrollbox's scrollChildIntoView; select/toggle call it so a
   *  peek or fold never happens off-screen. */
  scrollToRow?: (id: number) => void;
  /** The feed's scrollbox — tests poll its bar's visibility before
   *  sending mouse events at it. */
  scroller?: ScrollBoxRenderable;
  /** The composer's input — the shell reads its value when the
   *  human presses Enter, and clears it after a send. */
  input?: InputRenderable;
  /** Leave compose mode — the input blurs, the draft stays. */
  blurComposer?: () => void;
}

/**
 * The composer's strip — what makes the pane steerable (spec
 * bro-t4uin).
 *
 * Three lines at most, all pinned above the header: the permission
 * bar (only while an ask waits for a human), the input, and the
 * queue's line. The queue is NOT optional: a human who typed during a
 * turn must SEE their words waiting — a sent prompt that nobody read
 * is the failure this whole surface exists to prevent.
 */
export interface ComposerProps {
  /** the composer holds the focus (compose mode) */
  composing: () => boolean;
  /** the queued prompts, in order */
  queue: () => { ordinal: number; text: string }[];
  /** the permission ask waiting for a human */
  permission: () =>
    | {
        requestId: number | string;
        title: string;
        options: { optionId: string; name: string; kind: string }[];
      }
    | undefined;
  /** the input element — the shell reads `value` on submit */
  onInput?: (el: InputRenderable) => void;
  /** the draft was submitted (Enter) — the payload is the input's
   *  own text (the input emits it), the event shape kept for the
   *  renderer's own typing */
  onSubmit: (payload: string | ComposerSubmitEvent) => void;
  /** the placeholder — the hint when the composer is empty */
  placeholder?: string;
}

/**
 * Build the pane.
 *
 * NO row-level mouse handling by design: every press belongs to
 * the renderer's native drag-select → OSC52 copy, so nothing on a
 * row may eat or reshape the gesture (folds are keyboard-driven:
 * j/k peek, Enter/Space/c pin, a/z sweeps — addendum 27).
 */
export function createPane(
  meta?: Partial<PaneMeta>,
  foldAll?: boolean,
  copyItem?: (item: Item) => string,
  onRetire?: (items: Item[]) => void
): Pane {
  const [state, setState] = createStore<PaneState>(emptyState(meta, foldAll));
  let plain: PaneState = emptyState(meta, foldAll);

  const publish = (next: PaneState): void => {
    plain = next;
    setState(reconcile(plain, { key: null }));
  };

  /** Optional eviction seam: when a shell passes `onRetire`, settled
   *  items (terminal tools, closed text blocks — isSettled) flush to
   *  the callback the moment they settle, and any prefix past the
   *  row budget follows. Only a PREFIX ever retires, so print order
   *  matches the feed's order; the selected item and the tail item
   *  always stay live. The production shell passes no onRetire —
   *  every row stays a scrollbox renderable. */
  const retire = (next: PaneState): PaneState => {
    if (onRetire === undefined) return next;
    const lastId = next.order[next.order.length - 1];
    let total = 0;
    for (const id of next.order) total += rowHeight(next.byId[id] as Item);
    const retired: number[] = [];
    for (const id of next.order) {
      const it = next.byId[id] as Item;
      if (id === next.selected) break;
      if (!isSettled(it, id === lastId) && total <= TAIL_BUDGET) break;
      retired.push(id);
      total -= rowHeight(it);
    }
    if (retired.length === 0) return next;
    onRetire(retired.map(id => next.byId[id] as Item));
    return applyOps(next, [{ op: 'evict', ids: retired }]);
  };

  const pane: Pane = {
    store: { state },
    writer: {
      apply(ops) {
        if (ops.length === 0) return;
        publish(retire(applyOps(plain, ops)));
      },
      select(delta) {
        const selected = moveSelection(plain, delta);
        publish({ ...plain, selected });
        // the selection peeks a fold open — useless if it happens
        // off-screen; the row follows the walk into view
        if (selected >= 0) pane.scrollToRow?.(selected);
      },
      toggle() {
        // nothing selected (no j/k yet — and clicks are reserved
        // for copy): Space/Enter/c falls back to the FIRST foldable
        // — the prompt card, the folded row a fresh pane is opened
        // for — and selects it, so the key always does the visible
        // thing the user asked for
        let item = plain.byId[plain.selected];
        if (item === undefined || !isFoldable(item)) {
          const first = toolIds(plain)[0];
          if (first === undefined) return;
          item = plain.byId[first];
          if (item === undefined) return;
          publish({
            ...plain,
            selected: first,
            byId: {
              ...plain.byId,
              [first]: { ...item, collapsed: !item.collapsed, foldTouched: true },
            },
          });
          pane.scrollToRow?.(first);
          return;
        }
        publish({
          ...plain,
          // foldTouched marks the user's explicit fold — the
          // selection preview only opens cards the user never
          // toggled, so toggling SHUT a selected card holds
          byId: {
            ...plain.byId,
            [item.id]: { ...item, collapsed: !item.collapsed, foldTouched: true },
          },
        });
        // an open card can outgrow the viewport — keep its head in view
        pane.scrollToRow?.(item.id);
      },
      toggleRow(id) {
        const item = plain.byId[id];
        if (item === undefined || !isFoldable(item)) return;
        publish({
          ...plain,
          selected: id,
          byId: {
            ...plain.byId,
            [id]: { ...item, collapsed: !item.collapsed, foldTouched: true },
          },
        });
        pane.scrollToRow?.(id);
      },
      toggleAll(open) {
        const byId = { ...plain.byId };
        let any = false;
        for (const id of plain.order) {
          const item = byId[id];
          if (item === undefined || !isFoldable(item) || item.collapsed !== open) continue;
          byId[id] = { ...item, collapsed: !open, foldTouched: true };
          any = true;
        }
        if (any) publish({ ...plain, byId });
      },
      copy() {
        const sel = plain.byId[plain.selected];
        const last = plain.byId[plain.order[plain.order.length - 1]];
        const item = sel !== undefined && sel.kind === 'tool' ? sel : (sel ?? last);
        if (item === undefined) return undefined;
        return copyItem !== undefined ? copyItem(item) : 'text' in item ? item.text : '';
      },
      setMeta(meta) {
        publish(withMeta(plain, meta));
      },
    },
  };
  return pane;
}

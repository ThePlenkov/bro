/**
 * The pane's view root — the header bar, the sticky-bottom
 * scrollback of session items, the composer strip and the footer.
 *
 * The opencode/acp-tui shape: the WHOLE feed is renderables inside a
 * scrollbox (stickyScroll keeps the bottom while rows stream), and
 * the scroll is the scrollbox's own scrollTop — every row keeps its
 * markdown/colors/expand chrome and scrolls in place. The identity +
 * keys chrome sits OUTSIDE the scrollbox, flexShrink=0 at the bottom
 * of the column — pinned there always, never scrolled or clipped.
 */

import type { MouseEvent, ScrollBoxRenderable } from '@opentui/core';
import type { SyntaxStyle } from '@opentui/core';
import { onAnimationTick, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { createSignal, For, Show } from 'solid-js';
import { type Item, itemGroup, spacingBefore, theme } from '../session/src/index.ts';
import { cardRow } from './cards.tsx';
import { ComposerBar, FooterBar, HeaderBar } from './chrome.tsx';
import { ItemRow } from './item-row.tsx';
import type { ComposerProps, PaneStore } from './pane-model.ts';

/** One feed row — its own `id` is the scrollbox's
 *  scrollChildIntoView handle (j/k follows the walk), plus the
 *  blank-row margin their list.ts rhythm asks for. */
function FeedRow(props: {
  id: number;
  index: () => number;
  item: Item;
  store: PaneStore;
  syntax: SyntaxStyle;
  width: () => number;
  frame: () => number;
  findTool: (toolCallId: string) => unknown;
  onToggleRow?: (id: number) => void;
}) {
  // their list.ts rhythm — a blank row on every group
  // change and before user/agent text; activity stays tight.
  // A `┃` card (prompt / verdict / permission) is an
  // OBJECT: one blank row before and after, whatever the
  // group rhythm says — the time-head hug never eats a
  // card's air (addendum 26)
  const margin = () => {
    if (props.index() === 0) return 0;
    const prevId = props.store.state.order[props.index() - 1];
    const prev = prevId === undefined ? undefined : props.store.state.byId[prevId];
    if (prev === undefined) return 0;
    const base = spacingBefore(itemGroup(prev), itemGroup(props.item));
    return Math.max(base, cardRow(prev) || cardRow(props.item) ? 1 : 0);
  };
  return (
    <box id={`row-${props.id}`} flexDirection="column" flexShrink={0} width="100%">
      <Show when={margin() > 0}>
        <box height={margin()} width="100%" flexShrink={0} />
      </Show>
      <ItemRow
        item={props.item}
        syntax={props.syntax}
        selected={props.store.state.selected === props.id}
        width={props.width}
        frame={props.frame}
        findTool={props.findTool}
        onToggleRow={props.onToggleRow}
      />
    </box>
  );
}

/** One-time scrollbox wiring — the light bar (a dim thumb on a
 *  base-colored track reads as a notch, not a rail), the two
 *  breathing columns between the text and the bar's gutter, and the
 *  offset-change → frame bump so atBottom follows a scroll the same
 *  frame instead of waiting up to 10 animation ticks. */
function bindScroll(
  sb: ScrollBoxRenderable,
  onFrame: () => void,
  onScroller?: (el: ScrollBoxRenderable) => void
): void {
  sb.verticalScrollBar.trackOptions = {
    foregroundColor: theme.scrollbar,
    backgroundColor: theme.base,
  };
  sb.verticalScrollBar.onChange = onFrame;
  sb.viewport.paddingRight = 2;
  onScroller?.(sb);
}

/** The scrollback itself — the scrollbox and its rows. */
function FeedScroll(props: {
  store: PaneStore;
  syntax: SyntaxStyle;
  frame: () => number;
  onFrame: () => void;
  findTool: (toolCallId: string) => unknown;
  onScroller?: (el: ScrollBoxRenderable) => void;
  onToggleRow?: (id: number) => void;
}) {
  const dims = useTerminalDimensions();
  return (
    <scrollbox
      ref={el => bindScroll(el as ScrollBoxRenderable, props.onFrame, props.onScroller)}
      flexGrow={1}
      minHeight={0}
      width="100%"
      stickyScroll={true}
      stickyStart="bottom"
      scrollY={true}
      backgroundColor={theme.base}
    >
      <For each={props.store.state.order}>
        {(id, index) => (
          <Show when={props.store.state.byId[id]} keyed>
            {item => (
              <FeedRow
                id={id}
                index={index}
                item={item}
                store={props.store}
                syntax={props.syntax}
                width={() =>
                  // `dims()` is the reactive width source —
                  // `scroller().viewport` is a live getter but
                  // not a signal, so a pane resize never re-ran
                  // the old accessor and rows kept the arm-time
                  // (narrow-column) width. -3 = scrollbar+pad.
                  Math.max(20, dims().width - 3)
                }
                frame={props.frame}
                findTool={props.findTool}
                onToggleRow={props.onToggleRow}
              />
            )}
          </Show>
        )}
      </For>
    </scrollbox>
  );
}

/** Off-bottom → their `Jump to latest ↓` chip — a real click
 *  target like the show-more button, off the selection grammar so
 *  a press never starts a drag. */
function JumpChip(props: { onJump: () => void }) {
  return (
    <box flexDirection="row" width="100%" height={1} flexShrink={0} backgroundColor={theme.base}>
      <box flexGrow={1} />
      <text
        fg={theme.accent}
        content="Jump to latest ↓ "
        selectable={false}
        onMouseDown={props.onJump}
      />
    </box>
  );
}

/** A permission row names its tool — look the call's `vi` up by id. */
function findToolVi(store: PaneStore, toolCallId: string): unknown {
  for (const id of store.state.order) {
    const it = store.state.byId[id];
    if (it?.kind === 'tool' && it.toolCallId === toolCallId) return it.vi;
  }
  return undefined;
}

/** The whole pane — header bar, the sticky-bottom scrollback of
 *  session items, footer. */
export function PaneView(props: {
  store: PaneStore;
  syntax: SyntaxStyle;
  toast: () => string;
  onScroller?: (el: ScrollBoxRenderable) => void;
  /** mouse-up after a drag-select → OSC52 copy (opencode's
   *  copy-on-select on the renderer's own selection) */
  onCopySelect?: (event: MouseEvent) => void;
  /** a row's `show more` button — pin-toggles that row's fold */
  onToggleRow?: (id: number) => void;
  /** the composer's strip — unset keeps the pane read-only */
  composer?: ComposerProps;
}) {
  useRenderer();
  const [frame, setFrame] = createSignal(0);
  onAnimationTick(10, () => setFrame(f => f + 1));
  const [scroller, setScroller] = createSignal<ScrollBoxRenderable>();
  /** off-bottom → their `Jump to latest ↓` chip shows */
  const atBottom = () => {
    frame();
    const s = scroller();
    if (s === undefined || s.scrollHeight === undefined) return true;
    return s.scrollTop + s.height >= s.scrollHeight - 1;
  };
  /** permission rows name their tool — look the call up by id. */
  const findTool = (toolCallId: string): unknown => findToolVi(props.store, toolCallId);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: terminal renderer — mouse events are hit-tested coordinates, not DOM a11y
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      overflow="hidden"
      backgroundColor={theme.base}
      onMouseUp={props.onCopySelect}
    >
      <FeedScroll
        store={props.store}
        syntax={props.syntax}
        frame={frame}
        onFrame={() => setFrame(f => f + 1)}
        findTool={findTool}
        onScroller={el => {
          setScroller(el);
          props.onScroller?.(el);
        }}
        onToggleRow={props.onToggleRow}
      />
      <Show when={!atBottom()}>
        <JumpChip onJump={() => scroller()?.scrollTo?.(Infinity)} />
      </Show>
      {/* identity + keys — pinned at the bottom, OUTSIDE the scrollbox,
       *  so they never move while the feed scrolls */}
      <Show when={props.composer !== undefined}>
        <ComposerBar {...(props.composer as ComposerProps)} />
      </Show>
      <HeaderBar meta={props.store.state.meta} />
      <FooterBar toast={props.toast} meta={props.store.state.meta} />
    </box>
  );
}

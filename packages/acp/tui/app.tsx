/**
 * The session pane's Solid tree (spec bro-q2edc) — the mount seam
 * of the OpenTUI view.
 *
 * The imperative shell kept a `views` Map and a `cards` Map beside
 * the model and hand-applied every op to a renderable: mount, patch,
 * destroy, plus a content-signature guard so a code block was not
 * rebuilt on every status change. The catalogue's components already
 * know how to diff and dispose themselves, so the tree IS the
 * whole view — the state (`pane-model.ts`) holds the items and the
 * tree (`pane.tsx` + `item-row.tsx` + `cards.tsx` + `tool-card.tsx`)
 * reads them.
 *
 * Bun-only, twice over: the Solid JSX transform is a Bun plugin and
 * OpenTUI's native FFI has no Node build. `main.ts` registers the
 * transform before importing this file.
 */

import type { CliRenderer, InputRenderable, ScrollBoxRenderable } from '@opentui/core';
import { render } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { type Item, type PaneMeta, sysCopy } from '../session/src/index.ts';
import { type ComposerProps, createPane, type Pane } from './pane-model.ts';
import { PaneView } from './pane.tsx';
import { syntaxStyle } from './style.ts';

export type { ComposerProps, Pane, PaneStore, PaneWriter } from './pane-model.ts';

/** Copy-on-select: drag → renderer Selection → OSC52 AND a
 *  direct clipboard tool (OSC52 may not survive the pty →
 *  mux → terminal chain). The highlight STAYS up after the
 *  copy — a vanishing flash reads as a failed gesture;
 *  the next press replaces it anyway. */
function copySelection(renderer: CliRenderer): boolean {
  const text = renderer.getSelection()?.getSelectedText();
  if (text === undefined || text === '') return false;
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`);
  sysCopy(text);
  return true;
}

/** The scroll gestures wired onto the pane's handle — arrows and
 *  the wheel, pages, edge jumps, and select/fold row follows. */
function wireScroll(
  pane: Pane,
  scroller: () => ScrollBoxRenderable | undefined,
  renderer: CliRenderer
): void {
  pane.scroll = lines => scroller()?.scrollBy?.(lines);
  pane.scrollPage = dir => scroller()?.scrollBy?.(dir * Math.max(1, renderer.height - 2));
  pane.scrollEdge = edge => scroller()?.scrollTo?.(edge === 0 ? 0 : Infinity);
  pane.scrollToRow = id => scroller()?.scrollChildIntoView?.(`row-${id}`, { align: 'nearest' });
}

/** The composer's props plus the pane's own input capture — the
 *  shell reads the draft and clears it after a send, and the mode
 *  can blur it without reaching into the tree. */
function wrapComposer(
  composer: ComposerProps | undefined,
  onInput: (el: InputRenderable) => void
): ComposerProps | undefined {
  if (composer === undefined) return undefined;
  return {
    ...composer,
    onInput: el => {
      onInput(el);
      composer.onInput?.(el);
    },
  };
}

/**
 * Mount the pane on a renderer and hand back the pane's handle.
 *
 * The caller owns the renderer: `render()` disposes the Solid root
 * when the renderer is destroyed, so the shell's quit path (release
 * the session, destroy the renderer) stays a single call.
 */
export async function mountPane(opts: {
  renderer: CliRenderer;
  meta?: Partial<PaneMeta>;
  /** Retained wiring — tool bodies fold on landing regardless. */
  foldAll?: boolean;
  /** The impl's copy text for an item — Ctrl+C's payload. */
  copyItem?: (item: Item) => string;
  /** Optional eviction hook — settled items the pane retires to the
   *  shell (e.g. for a captured-stdout print). Unset keeps every row
   *  a scrollbox renderable — the production shape. */
  onRetire?: (items: Item[]) => void;
  /** The composer's strip — unset keeps the pane read-only (the
   *  herdr pane tails an archive; the standalone pane drives a live
   *  session). */
  composer?: ComposerProps;
}): Promise<Pane> {
  // mouse ON — the opencode config: mouse reporting enables the
  // scrollbox's own wheel handler (momentum scroll), the scrollbar
  // thumb drag, and renderer-native drag selection. Copy-on-select
  // is handled by the root box's onMouseUp → OSC52.
  opts.renderer.useMouse = true;
  const pane = createPane(opts.meta, opts.foldAll, opts.copyItem, opts.onRetire);
  const syntax = syntaxStyle(opts.renderer.nativeScene);
  const [toast, setToast] = createSignal('');
  let scroller: ScrollBoxRenderable | undefined;
  let input: InputRenderable | undefined;
  const composer = wrapComposer(opts.composer, el => {
    input = el;
  });
  await render(
    () => (
      <PaneView
        store={pane.store}
        syntax={syntax}
        toast={toast}
        onScroller={el => {
          scroller = el;
          pane.scroller = el;
        }}
        onCopySelect={() => {
          if (!copySelection(opts.renderer)) return;
          setToast('copied');
          setTimeout(() => setToast(''), 1500);
        }}
        onToggleRow={id => pane.writer.toggleRow(id)}
        composer={composer}
      />
    ),
    opts.renderer
  );
  pane.toast = setToast;
  wireScroll(pane, () => scroller, opts.renderer);
  // the composer's input — the shell reads `value` when the human
  // presses Enter and clears it after the send
  pane.input = input;
  pane.blurComposer = () => input?.blur();
  return pane;
}

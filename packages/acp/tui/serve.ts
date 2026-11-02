/**
 * serve — the OpenTUI/Solid shell for one session-view pane. Owns the
 * renderer construction, the JSX preload dance, the keymap, and the
 * live-forever hold; the caller (plugin glue) owns target resolution,
 * the feed, and the report loop. Everything herdr-shaped arrives as
 * an option — nothing here imports herdr.
 */
import { type CliRenderer, createCliRenderer } from '@opentui/core';
import type { mountPane } from './app.tsx';

type MountOpts = Omit<Parameters<typeof mountPane>[0], 'renderer'>;

export interface ServeOpts extends MountOpts {
  /** Renderer config overrides — the defaults are the herdr-pane
   *  shape (alternate screen, mouse on, no Ctrl+C exit). */
  renderer?: Parameters<typeof createCliRenderer>[0];
  /** System-clipboard bridge — the Ctrl+C key emits OSC 52 AND calls
   *  this when set (the plugin wires its platform helper). */
  copy?: (text: string) => void;
}

export interface ServedPane {
  pane: Awaited<ReturnType<typeof mountPane>>;
  renderer: CliRenderer;
}

/** Mount one pane — clear screen (BEFORE the renderer so stdout
 *  ESC bytes never surface as literal text), preload the Solid JSX
 *  transform, build the renderer, mount, wire the keymap, return the
 *  handles the caller's feed/report loops ride. The returned pane's
 *  drain/commit cadence is the caller's interval. */
export async function serve(opts: ServeOpts): Promise<ServedPane> {
  const { renderer: rOpts, copy, ...mount } = opts;
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

  // the JSX transform is a Bun plugin and must register BEFORE the
  // .tsx tree loads — hence the dynamic import; everything above
  // this line stays Node-loadable, so non-TUI paths never need Bun.
  await import('@opentui/solid/preload');
  const { mountPane } = await import('./app.tsx');

  const renderer = await createCliRenderer({
    // Ctrl+C is a key, not a signal: the pane copies (addendum 8);
    // herdr owns lifecycle — no exit path lives here (addendum 2)
    exitOnCtrlC: false,
    // mouse ON — the opencode config: wheel hits the scrollbox's own
    // handler (momentum scroll), the scrollbar thumb drags, and
    // renderer-native drag-select feeds copy-on-select via OSC52.
    useMouse: true,
    // "drag" mode (?1002) not "motion" (?1003): no hover UI, and
    // button-held motion is the class lazygit/btop use
    enableMouseMovement: false,
    // alternate-screen owns the whole buffer — frames repaint in
    // place and NOTHING lands in the scrollback (one scroll only)
    screenMode: 'alternate-screen',
    ...rOpts,
  });

  const pane = await mountPane({ renderer, ...mount });

  /** Keys: j/k walk the tool cards, Enter/c folds one, arrows +
   *  PgUp/PgDn/Home/End scroll (?1007 delivers the wheel as arrows),
   *  Ctrl+C copies the current row as OSC 52. No quit binding — the
   *  pane's owner owns lifecycle. */
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  renderer.keyInput.on('keypress', key => {
    if (key.ctrl && key.name === 'c') {
      const text = pane.writer.copy();
      if (text === undefined || text === '') return;
      process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`);
      copy?.(text);
      pane.toast?.('copied');
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => pane.toast?.(''), 1500);
    } else if (key.name === 'j') pane.writer.select(1);
    else if (key.name === 'k') pane.writer.select(-1);
    // ±3 — the opencode wheel step (CustomSpeedScroll(3)); ?1007
    // delivers the wheel as these same arrow keys, so one detent
    // feels like a real scroll, not a crawl
    else if (key.name === 'up') pane.scroll?.(-3);
    else if (key.name === 'down') pane.scroll?.(3);
    else if (key.name === 'pageup') pane.scrollPage?.(-1);
    else if (key.name === 'pagedown') pane.scrollPage?.(1);
    else if (key.name === 'home') pane.scrollEdge?.(0);
    else if (key.name === 'end') pane.scrollEdge?.(1);
    else if (key.name === 'a') pane.writer.toggleAll(true);
    else if (key.name === 'z') pane.writer.toggleAll(false);
    else if (
      key.name === 'return' ||
      key.name === 'enter' ||
      key.name === 'c' ||
      key.name === 'space' ||
      key.name === ' '
    )
      pane.writer.toggle();
  });

  return { pane, renderer };
}

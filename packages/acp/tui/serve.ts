/**
 * serve — the OpenTUI/Solid shell for one session-view pane. Owns the
 * renderer construction, the JSX preload dance, the keymap, and the
 * live-forever hold; the caller (plugin glue) owns target resolution,
 * the feed, and the report loop. Everything herdr-shaped arrives as
 * an option — nothing here imports herdr.
 */
import { type CliRenderer, createCliRenderer } from '@opentui/core';
import type { KeyEvent } from '@opentui/core';
import type { mountPane, Pane } from './app.tsx';

type MountOpts = Omit<Parameters<typeof mountPane>[0], 'renderer'>;

export interface ServeOpts extends MountOpts {
  /** Renderer config overrides — the defaults are the herdr-pane
   *  shape (alternate screen, mouse on, no Ctrl+C exit). */
  renderer?: Parameters<typeof createCliRenderer>[0];
  /** System-clipboard bridge — the Ctrl+C key emits OSC 52 AND calls
   *  this when set (the plugin wires its platform helper). */
  copy?: (text: string) => void;
  /** The keymap — the default is the browse grammar (j/k, folds,
   *  scroll, Ctrl+C copy). A live pane passes its own: the composer,
   *  the cancel, the permission answers. */
  keys?: (pane: Pane, key: KeyEvent) => void;
}

export interface ServedPane {
  pane: Awaited<ReturnType<typeof mountPane>>;
  renderer: CliRenderer;
}

/**
 * Return a key name only when it can use a plain-key binding.
 *
 * OpenTUI reports Ctrl+letter as the same `name` as the letter itself.
 * Keeping the modifier check at the binding boundary prevents a control
 * chord from falling through to (for example) the `a` or `z` binding.
 */
export function unmodifiedKeyName(key: Pick<KeyEvent, 'name' | 'ctrl'>): string | undefined {
  return key.ctrl === true ? undefined : key.name;
}

/**
 * The pane's copy gesture — OSC 52 AND the direct clipboard bridge.
 *
 * The OSC 52 escape may not survive the pty → mux → terminal chain,
 * so the host's own clipboard helper is called too; the row's text is
 * the payload either way.
 */
export function copyRow(pane: Pane, copy?: (text: string) => void): void {
  const text = pane.writer.copy();
  if (text === undefined || text === '') return;
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`);
  copy?.(text);
  pane.toast?.('copied');
}

/** Mount one pane — clear screen (BEFORE the renderer so stdout
 *  ESC bytes never surface as literal text), preload the Solid JSX
 *  transform, build the renderer, mount, wire the keymap, return the
 *  handles the caller's feed/report loops ride. The returned pane's
 *  drain/commit cadence is the caller's interval. */
export async function serve(opts: ServeOpts): Promise<ServedPane> {
  const { renderer: rOpts, copy, keys, ...mount } = opts;
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
  if (keys !== undefined) {
    // the caller's grammar owns every key — the pane's own browse
    // keys would fight the composer's
    renderer.keyInput.on('keypress', key => keys(pane, key));
  } else {
    renderer.keyInput.on('keypress', key => /* NOSONAR typescript:S3776 */ {
      const name = unmodifiedKeyName(key);
      if (key.ctrl && key.name === 'c') {
        copyRow(pane, copy);
        if (toastTimer !== undefined) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => pane.toast?.(''), 1500);
      } else if (name === 'j') pane.writer.select(1);
      else if (name === 'k') pane.writer.select(-1);
      // ±3 — the opencode wheel step (CustomSpeedScroll(3)); ?1007
      // delivers the wheel as these same arrow keys, so one detent
      // feels like a real scroll, not a crawl
      else if (name === 'up') pane.scroll?.(-3);
      else if (name === 'down') pane.scroll?.(3);
      else if (name === 'pageup') pane.scrollPage?.(-1);
      else if (name === 'pagedown') pane.scrollPage?.(1);
      else if (name === 'home') pane.scrollEdge?.(0);
      else if (name === 'end') pane.scrollEdge?.(1);
      else if (name === 'a') pane.writer.toggleAll(true);
      else if (name === 'z') pane.writer.toggleAll(false);
      else if (
        name === 'return' ||
        name === 'enter' ||
        name === 'c' ||
        name === 'space' ||
        name === ' '
      )
        pane.writer.toggle();
    });
  }

  return { pane, renderer };
}

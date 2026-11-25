/**
 * The pane's shared leaf widgets — the atoms every row and card
 * composes: link-painted text runs, the live spinner, the fold
 * button, one styled segment, and the `┃`-barred card block.
 */

import { TextAttributes } from '@opentui/core';
import { onAnimationTick } from '@opentui/solid';
import { createMemo, createSignal, For, type JSX } from 'solid-js';
import { type Segment, segStyle, theme } from '../session/src/index.ts';

const URL_RE = /https?:\/\/[^\s)\]>}"']+/g;

/** One plain line → text runs; URLs paint cyan-underlined (their
 *  link chrome — `56b6c2` + underline in the capture). */
export function LinkRuns(props: { line: string; fg: string; dim?: boolean }) {
  const parts = createMemo(() => {
    const out: { text: string; link: boolean }[] = [];
    let at = 0;
    for (const m of props.line.matchAll(URL_RE)) {
      const i = m.index ?? 0;
      if (i > at) out.push({ text: props.line.slice(at, i), link: false });
      out.push({ text: m[0], link: true });
      at = i + m[0].length;
    }
    if (at < props.line.length) out.push({ text: props.line.slice(at), link: false });
    if (out.length === 0) out.push({ text: props.line, link: false });
    return out;
  });
  return (
    <For each={parts()}>
      {p => (
        <text
          fg={p.link ? theme.cyan : props.fg}
          attributes={
            (p.link ? TextAttributes.UNDERLINE : 0) | (props.dim === true ? TextAttributes.DIM : 0)
          }
          content={p.text}
        />
      )}
    </For>
  );
}

/** The live-card spinner — mounted only while the card is working
 *  (the `<Show>` disposes the tick with the status). */
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export function Spinner(props: { fg: string }) {
  const [tick, setTick] = createSignal(0);
  onAnimationTick(10, () => setTick(t => t + 1));
  return <text fg={props.fg} content={SPINNER[tick() % SPINNER.length]} />;
}

/** The `▸ show more`/`▾ show less` click target — the ONLY mouse
 *  surface a foldable row carries: selectable=false keeps it out of
 *  every drag-selection, and its press pin-toggles the row it sits on
 *  (the prompt card's button grammar, generalised). */
export function FoldBtn(props: { open: boolean; onToggle?: () => void; compact?: boolean }) {
  return (
    <text
      fg={props.open ? theme.muted : theme.accent}
      attributes={props.open ? TextAttributes.DIM : undefined}
      content={
        props.compact === true
          ? props.open
            ? '▾ '
            : '▸ '
          : props.open
            ? '▾ show less '
            : '▸ show more '
      }
      selectable={false}
      onMouseDown={() => props.onToggle?.()}
      flexShrink={0}
    />
  );
}

/** One painted segment — `segStyle` resolves their TokenName through
 *  DEFAULT_THEME into `<text>` props. */
export function SegText(props: { seg: Segment }) {
  const st = () => segStyle(props.seg);
  return (
    <text
      fg={st().fg}
      attributes={
        (st().bold ? TextAttributes.BOLD : 0) |
        (st().italic ? TextAttributes.ITALIC : 0) |
        (st().dim ? TextAttributes.DIM : 0)
      }
      content={props.seg.text}
    />
  );
}

/** One `┃`-barred block — the bar flush at column 0 so the card's
 *  text lands on the same column every other row's text does
 *  (markers at 0, text at 2 — opencode's one-line edge, addendum 27).
 *  The bar is the box's `heavy` left border, so ANY content (a
 *  markdown renderable included) keeps the bar and the bg without
 *  per-line plumbing (addendum 18). */
export function BarBlock(props: { children?: JSX.Element; selected?: boolean }) {
  return (
    <box
      width="100%"
      flexShrink={0}
      border={['left']}
      borderStyle="heavy"
      borderColor={props.selected ? theme.accent : theme.peach}
      backgroundColor={theme.surface}
      paddingLeft={1}
    >
      {props.children}
    </box>
  );
}

/** A bare pad line inside a `BarBlock` — the blank row their blocks
 *  put around titles and between sections. */
export function BarPad() {
  return <box height={1} flexShrink={0} />;
}

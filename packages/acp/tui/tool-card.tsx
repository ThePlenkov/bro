/**
 * The tool rows — the mass row of the feed: the compact `ToolCard`,
 * the impl's own vendored line language (`AcpSegRow`, `AcpToolBody`),
 * and the collapsed activity-run row.
 */

import type { SyntaxStyle } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { createMemo, For, Show } from 'solid-js';
import {
  acpCardRows,
  acpLine,
  cardGlyphColor,
  fillColor,
  firstLine,
  type Segment,
  segStyle,
  type ToolItem,
  theme,
  toolBodyLines,
  toolBodyMd,
  toolTail,
} from '../session/src/index.ts';
import { FoldBtn, SegText, Spinner } from './widgets.tsx';

/** The tool call — the feed's mass row, never a box: status
 *  glyph + the call's name and short arg, all dim. Non-empty output
 *  renders dim+indented under it, capped at 3 lines then `+N more`;
 *  `(no output)` results paint nothing — one compact row per call
 *  (opencode grammar — the first demo's shape restored). */
export function ToolCard(props: {
  item: ToolItem;
  selected: boolean;
  syntax: SyntaxStyle;
  width: () => number;
  onToggle?: () => void;
}) {
  const tail = createMemo(() => toolTail(props.item));
  const md = createMemo(() => toolBodyMd(props.item));
  // the head must END inside the row — an un-budgeted title renders
  // to the edge and the renderer clips it mid-string (the ragged
  // `query='   ▸` rows). Truncate with `…` like opencode does so the
  // row's right edge always lands on the same column as the cards
  const head = createMemo(() => {
    // titles can embed newlines (a graphql query is multi-line) —
    // the row is height=1, so only the first line may exist in it;
    // the `…` then says the command itself continues, not just that
    // the row ran out of cells
    const raw = ` ${props.item.title}${tail().kind}${tail().arg}${tail().tally}`;
    const first = firstLine(raw);
    const full = first === raw ? first : `${first}…`;
    const budget = Math.max(8, props.width() - 2 - (md() !== '' ? 2 : 0) - 1);
    return full.length > budget ? `${full.slice(0, budget - 1)}…` : full;
  });
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      backgroundColor={props.selected ? theme.surface : undefined}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        <Show
          when={props.item.status === 'live'}
          fallback={
            <text
              fg={cardGlyphColor(props.item.status)}
              content={props.item.status === 'completed' ? '✓' : '✗'}
            />
          }
        >
          <Spinner fg={theme.warning} />
        </Show>
        <text fg={theme.muted} attributes={TextAttributes.DIM} content={head()} flexShrink={0} />
        <box flexGrow={1} />
        <Show when={md() !== ''}>
          <FoldBtn open={!props.item.collapsed} onToggle={props.onToggle} compact={true} />
        </Show>
      </box>
      <ToolBody {...props} />
    </box>
  );
}

/** The ≤3-line plain preview a selected (but untouched) card peeks
 *  open while j/k holds it. */
function ToolPeek(props: { item: ToolItem }) {
  const body = createMemo(() => toolBodyLines(props.item));
  return (
    <box flexDirection="column" paddingLeft={2} flexShrink={0}>
      <For each={body().lines}>
        {l => <text fg={theme.muted} attributes={TextAttributes.DIM} content={l} flexShrink={0} />}
      </For>
      <Show when={body().more > 0}>
        <text
          fg={theme.muted}
          attributes={TextAttributes.DIM}
          content={`+${body().more} more`}
          flexShrink={0}
        />
      </Show>
    </box>
  );
}

/** The card's body region — pinned open (Enter/c) shows the FULL
 *  body as real markdown (prose formats, fences highlight via
 *  tree-sitter); the j/k selection peek keeps the plain preview.
 *  The foot button keeps a close target on screen when a long body
 *  scrolls the title row away, same as the prompt card. */
function ToolBody(props: {
  item: ToolItem;
  selected: boolean;
  syntax: SyntaxStyle;
  width: () => number;
  onToggle?: () => void;
}) {
  const body = createMemo(() => toolBodyLines(props.item));
  const md = createMemo(() => toolBodyMd(props.item));
  const open = () => !props.item.collapsed && md() !== '';
  return (
    <>
      <Show
        when={open()}
        fallback={
          <Show when={props.selected && props.item.foldTouched !== true && body().lines.length > 0}>
            <ToolPeek item={props.item} />
          </Show>
        }
      >
        <box flexDirection="column" paddingLeft={2} flexShrink={0}>
          {/* maxWidth is the only constraint a <markdown> honours —
           *  flex/percent parents never reach it inside a scrollbox;
           *  without it a paragraph holds its unwrapped width and
           *  clips at the viewport edge */}
          <markdown
            content={md()}
            syntaxStyle={props.syntax}
            conceal
            streaming
            internalBlockMode="top-level"
            flexShrink={0}
            maxWidth={props.width() - 2}
          />
        </box>
      </Show>
      <Show when={open()}>
        <box flexDirection="row" flexShrink={0} width="100%">
          <box flexGrow={1} />
          <FoldBtn open={true} onToggle={props.onToggle} compact={true} />
        </box>
      </Show>
    </>
  );
}

/** A vendored `format.ts` row — the acp impl's own line language.
 *  Each segment paints through `segStyle` (their DEFAULT_THEME);
 *  selection reads as a surface wash, no box chrome. */
export function AcpSegRow(props: { segs: readonly Segment[]; selected: boolean }) {
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      flexShrink={0}
      backgroundColor={props.selected ? theme.surface : undefined}
    >
      <For each={props.segs}>
        {seg => (
          <box backgroundColor={segStyle(seg).bg} height={1} flexShrink={0}>
            <SegText seg={seg} />
          </box>
        )}
      </For>
    </box>
  );
}

/** The expanded card body — their `cardLines` verbatim: numbered
 *  diffs with added/removed row fills, terminal notice, `▸ JSON`
 *  for pure-JSON results, a blank row between blocks. The `│` margin
 *  hangs it under the line; row fills wash the full width. */
export function AcpToolBody(props: { item: ToolItem; syntax: SyntaxStyle; width: () => number }) {
  const rows = createMemo(() => acpCardRows(props.item.vi, props.width() - 2));
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={rows()}>
        {row => (
          <box
            flexDirection="row"
            flexShrink={0}
            width="100%"
            backgroundColor={row.fill !== undefined ? fillColor(row.fill) : undefined}
          >
            <text fg={theme.muted} attributes={TextAttributes.DIM} content={'│ '} />
            <box flexDirection="row" flexGrow={1}>
              <For each={row.segments}>{seg => <SegText seg={seg} />}</For>
            </box>
          </box>
        )}
      </For>
    </box>
  );
}

/** The collapsed activity run — the confirmed `▸ N tool calls · N
 *  thought · Ns` line; expanded (the card toggle still applies) it
 *  shows each member's own one-liner under the `│` gutter. */
export function AcpRunRow(props: {
  item: ToolItem;
  selected: boolean;
  width: () => number;
  frame: () => number;
  findTool: (toolCallId: string) => unknown;
  onToggle?: () => void;
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box
        flexDirection="row"
        width="100%"
        height={1}
        flexShrink={0}
        backgroundColor={props.selected ? theme.surface : undefined}
      >
        <text
          fg={theme.cyan}
          attributes={props.item.status === 'live' ? undefined : TextAttributes.DIM}
          content={
            props.item.collapsed === true && (!props.selected || props.item.foldTouched === true)
              ? '▸ '
              : '▾ '
          }
        />
        <text
          fg={props.item.status === 'live' ? theme.text : theme.muted}
          attributes={props.item.status === 'live' ? undefined : TextAttributes.DIM}
          content={props.item.arg ?? ''}
        />
        <box flexGrow={1} />
        <FoldBtn open={props.item.collapsed !== true} onToggle={props.onToggle} compact={true} />
      </box>
      {/* selection previews: a still-collapsed run shows its members
       *  while it holds the selection (j/k), Enter/c pins it open;
       *  the FoldBtn on the head row is the mouse path */}
      <Show when={!props.item.collapsed || (props.selected && props.item.foldTouched !== true)}>
        <AcpRunMembers {...props} />
      </Show>
    </box>
  );
}

/** The run's expanded members — each one's own one-liner under
 *  the `│` gutter. */
function AcpRunMembers(props: {
  item: ToolItem;
  width: () => number;
  frame: () => number;
  findTool: (toolCallId: string) => unknown;
}) {
  return (
    <For each={props.item.runs ?? []}>
      {m => (
        <box flexDirection="row" flexShrink={0} width="100%">
          <text fg={theme.muted} attributes={TextAttributes.DIM} content={'│ '} />
          <AcpSegRow
            segs={acpLine(m, {
              width: props.width() - 2,
              frame: props.item.status === 'live' ? props.frame() : 0,
              findTool: props.findTool,
            })}
            selected={false}
          />
        </box>
      )}
    </For>
  );
}

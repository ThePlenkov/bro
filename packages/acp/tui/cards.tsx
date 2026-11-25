/**
 * The `┃` cards — the objects on the timeline: the caller prompt,
 * the judge verdict, and the permission ask. A card is an OBJECT:
 * one blank row before and after it whatever the group rhythm says.
 */

import type { SyntaxStyle } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { createMemo, For, Show } from 'solid-js';
import {
  type Item,
  isFoldable,
  mdSource,
  PROMPT_PREVIEW_LINES,
  theme,
  type VerdictView,
  verdictOf,
} from '../session/src/index.ts';
import { BarBlock, BarPad, FoldBtn, LinkRuns } from './widgets.tsx';

/** Renders as a `┃` card — prompt, permission ask, or a text row
 *  whose body parses as a verdict. Mirrors the ItemRow dispatch so
 *  the margin rule gives cards air without duplicating branches. */
export const cardRow = (item: Item): boolean => {
  if (item.kind === 'prompt' || item.kind === 'permission') return true;
  const vi = item.vi as { kind?: string } | undefined;
  if (vi?.kind === 'permission_record') return true;
  return 'text' in item && verdictOf(item.text) !== undefined;
};

/** The caller prompt — "what was asked" as their `┃` card, no title
 *  (the peach bar IS the label): the prompt as REAL markdown
 *  (addendum 18): links, bold, lists and code fences render, markers
 *  conceal; the tree-sitter client is the shared default <code>
 *  already uses. Folded it keeps its first PROMPT_PREVIEW_LINES lines
 *  visible then `+M more`. Empty text (no journaled prompt, no
 *  `.prompt.md` sibling) is the marker. */
export function PromptRow(props: {
  item: Item;
  syntax: SyntaxStyle;
  selected: boolean;
  width: () => number;
  /** The `▸ show more`/`▾ show less` button's click — the ONLY
   *  mouse target on the card; the rest of the row stays copy-clean */
  onToggle?: () => void;
}) {
  const text = createMemo(() => ('text' in props.item ? mdSource(props.item.text) : ''));
  // the selection peek opens an untouched fold while it holds the
  // row; Enter/c pins it (the tool cards' own grammar)
  const open = () =>
    props.item.collapsed !== true || (props.selected && props.item.foldTouched !== true);
  return (
    <BarBlock selected={props.selected}>
      <BarPad />
      <Show
        when={text() !== ''}
        fallback={
          <text fg={theme.muted} attributes={TextAttributes.DIM} content="prompt unavailable" />
        }
      >
        <Show when={open()} fallback={<PromptFold {...props} />}>
          <PromptOpen {...props} />
        </Show>
      </Show>
      <BarPad />
    </BarBlock>
  );
}

/** The folded prompt — the first PROMPT_PREVIEW_LINES lines as
 *  markdown, then the `+M more lines` row and the expand target. */
function PromptFold(props: {
  item: Item;
  syntax: SyntaxStyle;
  width: () => number;
  onToggle?: () => void;
}) {
  const lines = createMemo(() =>
    ('text' in props.item ? mdSource(props.item.text) : '').split('\n')
  );
  // the folded preview — first N lines; a cut that lands inside a
  // code fence closes it so the renderable doesn't eat the `+more` row
  const preview = createMemo(() => {
    const ls = lines().slice(0, PROMPT_PREVIEW_LINES);
    if (ls.filter(l => /^\s*(`{3,}|~{3,})/.test(l)).length % 2 === 1) ls.push('```');
    return ls.join('\n');
  });
  return (
    <>
      <Show when={PROMPT_PREVIEW_LINES > 0}>
        <markdown
          content={preview()}
          syntaxStyle={props.syntax}
          conceal
          streaming
          internalBlockMode="top-level"
          flexShrink={0}
          maxWidth={props.width() - 2}
        />
      </Show>
      <box flexDirection="row" flexShrink={0} width="100%">
        <text
          fg={theme.muted}
          attributes={TextAttributes.DIM}
          content={`+${lines().length - Math.min(lines().length, PROMPT_PREVIEW_LINES)} more lines — Space expands`}
          flexGrow={1}
        />
        <FoldBtn open={false} onToggle={props.onToggle} />
      </box>
    </>
  );
}

/** The open prompt — the FULL text as real markdown, plus the
 *  close target at its foot. */
function PromptOpen(props: {
  item: Item;
  syntax: SyntaxStyle;
  width: () => number;
  onToggle?: () => void;
}) {
  const text = createMemo(() => ('text' in props.item ? mdSource(props.item.text) : ''));
  return (
    <>
      <markdown
        content={text()}
        syntaxStyle={props.syntax}
        conceal
        streaming
        internalBlockMode="top-level"
        flexShrink={0}
        maxWidth={props.width() - 2}
      />
      <Show when={isFoldable(props.item)}>
        <box flexDirection="row" flexShrink={0} width="100%">
          <box flexGrow={1} />
          <FoldBtn open={true} onToggle={props.onToggle} />
        </box>
      </Show>
    </>
  );
}

/** The verdict control as their `┃` card — a dim title, the badge
 *  line in emphasis (their "recommended option" reads), the answer
 *  fields dim beneath. Shape-checked answers only; the ▸ JSON row
 *  stays the fallback for anything else. */
export function VerdictRow(props: { view: VerdictView; selected: boolean }) {
  return (
    <BarBlock>
      <BarPad />
      <text fg={theme.muted} content="Verdict" flexShrink={0} />
      <BarPad />
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.peach} content="⛨ " />
        <text fg={theme.emph} content={`${props.view.badge} `} />
        <LinkRuns line={props.view.summary} fg={theme.emph} />
      </box>
      <For each={props.view.fields}>
        {f => (
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme.muted} attributes={TextAttributes.DIM} content={`  ${f[0]} `} />
            <LinkRuns line={f[1]} fg={theme.muted} dim />
          </box>
        )}
      </For>
      <BarPad />
    </BarBlock>
  );
}

/** A permission ask as their Questions card — the `┃` block is
 *  exactly what their capture shows for an interactive ask (the
 *  pane stays readonly; the block just reports it). */
export function PermissionRow(props: { title: string; detail: string }) {
  return (
    <BarBlock>
      <BarPad />
      <text fg={theme.muted} content="Permission" flexShrink={0} />
      <BarPad />
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.warning} content="⚠ " />
        <LinkRuns line={props.title} fg={theme.emph} />
      </box>
      <Show when={props.detail !== ''}>
        <box flexDirection="row" flexShrink={0}>
          <LinkRuns line={props.detail} fg={theme.muted} dim />
        </box>
      </Show>
      <BarPad />
    </BarBlock>
  );
}

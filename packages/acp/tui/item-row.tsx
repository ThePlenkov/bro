/**
 * One session item — the row dispatcher. Agent speech, a dim
 * thought, a side line, a tool card, or the impl's own vendored
 * line (`vi` rows): each kind gets its own component, and the
 * nested `Show`s here are the dispatch — the same precedence the
 * imperative shell's view map had.
 */

import type { SyntaxStyle } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { createMemo, For, Show } from 'solid-js';
import {
  acpLine,
  firstLine,
  type Item,
  isFoldable,
  mdPlain,
  mdSource,
  type Segment,
  sideColor,
  theme,
  type ToolItem,
  type VerdictView,
  verdictOf,
} from '../session/src/index.ts';
import { PermissionRow, PromptRow, VerdictRow } from './cards.tsx';
import { AcpRunRow, AcpSegRow, AcpToolBody, ToolCard } from './tool-card.tsx';
import { FoldBtn } from './widgets.tsx';

/** The foldable text rows' shared reads — the selection peek opens
 *  an untouched fold, Enter/c pins it. */
const textOf = (item: Item): string => ('text' in item ? mdSource(item.text) : '');
const textOpen = (item: Item, selected: boolean): boolean =>
  item.collapsed !== true || (selected && item.foldTouched !== true);
/** Folded rows read `first line · +N lines`. */
const foldSummary = (item: Item): string => {
  const n = textOf(item).split('\n').length;
  return `${firstLine(mdPlain(textOf(item)).join('\n'))}${n > 1 ? ` · +${n} lines` : ''}`;
};
/** The tone a turn/permission/note side line paints with. */
const toneOf = (item: Item): 'warn' | 'error' | undefined =>
  item.kind === 'turn' || item.kind === 'permission' || item.kind === 'note'
    ? item.tone
    : undefined;

/** The props every kind branch takes — the row's own context. */
interface RowProps {
  item: Item;
  syntax: SyntaxStyle;
  selected: boolean;
  width: () => number;
  /** wires a row's `show more` button to the writer's pin-toggle */
  onToggleRow?: (id: number) => void;
}

/** The feed header — agent·provider·model·cwd·launched,
 *  their `#141414` bar: dim label, emphasis fields. */
function FeedHeader(props: { item: Item }) {
  return (
    <box width="100%" flexShrink={0} backgroundColor={theme.surface}>
      <text fg={theme.emph} content={`  ${props.item.kind === 'header' ? props.item.text : ''}`} />
    </box>
  );
}

/** Agent speech — bare prose, no bullet (addendum 26: every
 *  remaining prefix earns its cell), padded to the shared text
 *  column (markers 0 / text 2, addendum 27). Long prose folds to a
 *  one-line summary. */
function MessageRow(props: RowProps) {
  const open = () => textOpen(props.item, props.selected);
  return (
    <box flexDirection="column" flexShrink={0} width="100%">
      <box flexDirection="row" flexShrink={0} width="100%" paddingLeft={2}>
        {/* minWidth:0 — a flex item's floor is its content width;
         *  without it long paragraphs hold their unwrapped width and
         *  clip under the scrollbar */}
        <box flexGrow={1} flexShrink={0} minWidth={0}>
          <Show
            when={open() || !isFoldable(props.item)}
            fallback={
              <text
                fg={theme.muted}
                attributes={TextAttributes.DIM}
                content={foldSummary(props.item)}
                flexShrink={0}
              />
            }
          >
            <markdown
              content={props.item.kind === 'tool' ? '' : textOf(props.item)}
              syntaxStyle={props.syntax}
              conceal
              streaming
              internalBlockMode="top-level"
              flexShrink={0}
              maxWidth={props.width() - 3}
            />
          </Show>
        </box>
        <Show when={!open() && isFoldable(props.item)}>
          <FoldBtn open={false} onToggle={() => props.onToggleRow?.(props.item.id)} />
        </Show>
      </box>
      <Show when={open() && isFoldable(props.item)}>
        <box flexDirection="row" flexShrink={0} width="100%">
          <box flexGrow={1} />
          <FoldBtn open={true} onToggle={() => props.onToggleRow?.(props.item.id)} />
        </box>
      </Show>
    </box>
  );
}

/** `+ Thought` — their amber collapsed thought row (capture rows
 *  3/11/23); open it shows the body as markdown. */
function ThoughtRow(props: RowProps) {
  const open = () => textOpen(props.item, props.selected);
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexShrink={0} width="100%">
        <text fg={theme.amber} content="+ " />
        <text fg={theme.amber} content="Thought" />
        <text
          fg={theme.muted}
          attributes={TextAttributes.DIM}
          content={` · ${foldSummary(props.item)}`}
          flexGrow={1}
        />
        <Show when={isFoldable(props.item)}>
          <FoldBtn
            open={props.item.collapsed !== true}
            onToggle={() => props.onToggleRow?.(props.item.id)}
          />
        </Show>
      </box>
      <Show when={open() && isFoldable(props.item)}>
        <box paddingLeft={2} flexShrink={0}>
          <markdown
            content={textOf(props.item)}
            syntaxStyle={props.syntax}
            conceal
            streaming
            internalBlockMode="top-level"
            flexShrink={0}
            maxWidth={props.width() - 2}
          />
        </box>
      </Show>
    </box>
  );
}

/** Time separators — dim one-liners, never markdown. */
function TimeRow(props: { item: Item }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={('text' in props.item ? props.item.text : '').split('\n')}>
        {l => <text fg={theme.muted} attributes={TextAttributes.DIM} content={l} flexShrink={0} />}
      </For>
    </box>
  );
}

/** The folded side line — dim one-line summary plus the fold
 *  button that pins it open. */
function SideSummary(props: RowProps) {
  return (
    <box flexDirection="row" width="100%" flexShrink={0}>
      <text
        fg={sideColor(toneOf(props.item))}
        attributes={TextAttributes.DIM}
        flexShrink={0}
        flexGrow={1}
        content={foldSummary(props.item)}
      />
      <FoldBtn open={false} onToggle={() => props.onToggleRow?.(props.item.id)} />
    </box>
  );
}

/** The authored plain lines — plain <text> so the TONE paints. */
function SideLines(props: RowProps) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={('text' in props.item ? props.item.text : '').split('\n')}>
        {l => (
          <text
            fg={sideColor(toneOf(props.item))}
            attributes={TextAttributes.DIM}
            content={l}
            flexShrink={0}
          />
        )}
      </For>
    </box>
  );
}

/** The open foldable side block — real markdown (the batch's
 *  `- by → reply` list) plus the close target below it. */
function SideMarkdown(props: RowProps) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <markdown
        content={textOf(props.item)}
        syntaxStyle={props.syntax}
        conceal
        streaming
        internalBlockMode="top-level"
        flexShrink={0}
        maxWidth={props.width() - 1}
      />
      <box flexDirection="row" flexShrink={0} width="100%">
        <box flexGrow={1} />
        <FoldBtn open={true} onToggle={() => props.onToggleRow?.(props.item.id)} />
      </box>
    </box>
  );
}

/** Side lines — turn markers, notes, the ▸ internal-calls batch.
 *  Folded → dim one-line summary. Open + foldable → real markdown
 *  (the batch's `- by → reply` list). Everything else is an authored
 *  plain line — plain <text> so the TONE paints: `✗`/`── turn
 *  failed` rows are red, `──` dividers dim (addendum 27 — the old
 *  path ran them through markdown with no fg, so errors were never
 *  actually red). */
function SideRow(props: RowProps) {
  const open = () => textOpen(props.item, props.selected);
  const foldable = () => isFoldable(props.item);
  return (
    <Show
      when={open() && foldable()}
      fallback={
        <Show when={open() || !foldable()} fallback={<SideSummary {...props} />}>
          <SideLines {...props} />
        </Show>
      }
    >
      <SideMarkdown {...props} />
    </Show>
  );
}

/** The impl's own vendored line (`vi` rows) — the acp one-liner
 *  plus, for a foldable tool, the pin-toggle button and the
 *  expanded card body beneath. */
function AcpLineBlock(props: RowProps & { tool?: ToolItem; segs: readonly Segment[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" width="100%" flexShrink={0}>
        <box flexGrow={1} minWidth={0}>
          <AcpSegRow segs={props.segs} selected={props.selected} />
        </box>
        <Show when={props.tool !== undefined}>
          <FoldBtn
            open={props.tool?.collapsed !== true}
            onToggle={() => props.onToggleRow?.(props.item.id)}
            compact={true}
          />
        </Show>
      </box>
      <AcpLineTail {...props} />
    </box>
  );
}

/** a foldable tool's body renders while it is open — a collapsed
 *  one shows under selection until Enter/c pins the fold. */
const toolBodyShown = (tool: ToolItem | undefined, selected: boolean): boolean =>
  tool !== undefined && (!tool.collapsed || (selected && tool.foldTouched !== true));

/** the foot's close target — only on an open foldable tool. */
const toolCloseShown = (tool: ToolItem | undefined): boolean =>
  tool !== undefined && tool.collapsed !== true;

/** The vendored line's expandable tail — the peek/pinned body and
 *  the foot close target, shown only for a foldable tool. */
function AcpLineTail(props: RowProps & { tool?: ToolItem }) {
  return (
    <>
      <Show when={toolBodyShown(props.tool, props.selected)}>
        <AcpToolBody item={props.tool as ToolItem} syntax={props.syntax} width={props.width} />
      </Show>
      <Show when={toolCloseShown(props.tool)}>
        <box flexDirection="row" flexShrink={0} width="100%">
          <box flexGrow={1} />
          <FoldBtn open={true} onToggle={() => props.onToggleRow?.(props.item.id)} compact={true} />
        </box>
      </Show>
    </>
  );
}

/** The plain-kind leaves — header bar, prompt card, agent speech,
 *  thought, time separators, side lines. */
function LeafRow(props: RowProps) {
  return (
    <Show
      when={props.item.kind === 'header'}
      fallback={
        <Show
          when={props.item.kind === 'prompt'}
          fallback={
            <Show
              when={props.item.kind === 'message'}
              fallback={
                <Show
                  when={props.item.kind === 'thought'}
                  fallback={
                    <Show when={props.item.kind === 'time'} fallback={<SideRow {...props} />}>
                      <TimeRow item={props.item} />
                    </Show>
                  }
                >
                  <ThoughtRow {...props} />
                </Show>
              }
            >
              <MessageRow {...props} />
            </Show>
          }
        >
          <PromptRow
            item={props.item}
            syntax={props.syntax}
            selected={props.selected}
            width={props.width}
            onToggle={() => props.onToggleRow?.(props.item.id)}
          />
        </Show>
      }
    >
      <FeedHeader item={props.item} />
    </Show>
  );
}

/** One session item — agent speech, a dim thought, a side line, or
 *  a tool card. Items carrying `vi` render the impl's own row
 *  language (acp impl: the vendored `format.ts` one-liners);
 *  everything else keeps this pane's card chrome. */
export function ItemRow(props: {
  item: Item;
  syntax: SyntaxStyle;
  selected: boolean;
  width: () => number;
  frame: () => number;
  findTool: (toolCallId: string) => unknown;
  /** wires a row's `show more` button to the writer's pin-toggle */
  onToggleRow?: (id: number) => void;
}) {
  // an activity-run group — the confirmed `▸ N tool calls · …` line;
  // it is a tool-kind item but renders its own collapsed/expanded row
  const run = createMemo(() =>
    props.item.kind === 'tool' && props.item.runs !== undefined ? props.item : undefined
  );
  const tool = createMemo(() =>
    props.item.kind === 'tool' && props.item.runs === undefined ? props.item : undefined
  );
  const segs = createMemo(() => {
    const vi = props.item.vi;
    if (vi === undefined) return null;
    // frame ticks exist for the live spinner only — a settled row
    // must not re-derive its line 10x/s (addendum 14: the steady-state
    // sweep was the one proven hotspot, ~0.2ms/row/tick over all rows)
    const frame = props.item.kind === 'tool' && props.item.status === 'live' ? props.frame() : 0;
    const line = acpLine(vi, {
      width: props.width(),
      frame,
      findTool: props.findTool,
      arg: 'arg' in props.item ? props.item.arg : undefined,
    });
    return line.length > 0 ? line : null;
  });
  // a judge reply classifies on its own shape — every answer must
  // match the typed table, so a prose message never trips it; the
  // `judge` flag narrows it further on journaled turns. The badge is
  // the call's MODEL (`"model"` in the reply) else its provider `by`
  // — generic, never a brand literal (addendum 11)
  const verdict = createMemo(() => {
    if (!('text' in props.item)) return undefined;
    const v = verdictOf(props.item.text);
    if (v === undefined) return undefined;
    const by = 'by' in props.item ? props.item.by : undefined;
    return v.model === undefined && by !== undefined ? { ...v, badge: by } : v;
  });
  // a permission ask renders as their `┃` Questions card — legacy
  // `permission` items and the acp `permission_record` both map
  const perm = createMemo((): { title: string; detail: string } | undefined => {
    const it = props.item;
    if (it.kind === 'permission' && 'text' in it) {
      return { title: it.text, detail: '' };
    }
    const vi = it.vi as { kind?: string; title?: string; outcome?: { type?: string } } | undefined;
    if (vi?.kind === 'permission_record') {
      const o = vi.outcome?.type ?? 'pending';
      return { title: vi.title ?? '', detail: `outcome: ${o}` };
    }
    return undefined;
  });
  return (
    // time is ROWS now — the `── HH:MM · by ──` separators own the
    // timeline, content rows keep the full width (addendum 25)
    <box flexDirection="row" flexShrink={0} width="100%">
      <box flexDirection="column" flexGrow={1} flexShrink={0} minWidth={0}>
        <Show
          when={verdict() === undefined}
          fallback={<VerdictRow view={verdict() as VerdictView} selected={props.selected} />}
        >
          <Show
            when={perm() === undefined}
            fallback={<PermissionRow title={perm()?.title ?? ''} detail={perm()?.detail ?? ''} />}
          >
            <Show
              when={segs() === null}
              fallback={
                <AcpLineBlock
                  item={props.item}
                  tool={tool()}
                  segs={segs() ?? []}
                  selected={props.selected}
                  width={props.width}
                  syntax={props.syntax}
                  onToggleRow={props.onToggleRow}
                />
              }
            >
              <Show
                when={run() === undefined}
                fallback={
                  <AcpRunRow
                    item={run() as ToolItem}
                    selected={props.selected}
                    width={props.width}
                    frame={props.frame}
                    findTool={props.findTool}
                    onToggle={() => props.onToggleRow?.(props.item.id)}
                  />
                }
              >
                <Show when={tool()} keyed fallback={<LeafRow {...props} />}>
                  {item => (
                    <ToolCard
                      item={item}
                      selected={props.selected}
                      syntax={props.syntax}
                      width={props.width}
                      onToggle={() => props.onToggleRow?.(props.item.id)}
                    />
                  )}
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </box>
    </box>
  );
}

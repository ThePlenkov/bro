/**
 * The session pane's Solid tree (spec bro-q2edc) — the declarative
 * half of the OpenTUI view.
 *
 * The imperative shell kept a `views` Map and a `cards` Map beside
 * the model and hand-applied every op to a renderable: mount, patch,
 * destroy, plus a content-signature guard so a code block was not
 * rebuilt on every status change. The catalogue's components already
 * know how to diff and dispose themselves, so the tree here IS the
 * whole view — the state (`state.ts`) holds the items and the tree
 * reads them.
 *
 * Bun-only, twice over: the Solid JSX transform is a Bun plugin and
 * OpenTUI's native FFI has no Node build. `main.ts` registers the
 * transform before importing this file.
 */

import type {
  CliRenderer,
  MouseEvent,
  NativeResourceOwner,
  ScrollBoxRenderable,
} from '@opentui/core';
import { SyntaxStyle, TextAttributes } from '@opentui/core';
import { onAnimationTick, render, useRenderer } from '@opentui/solid';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { firstLine } from '../../../packages/providers/src/acp-render.ts';
import {
  acpCardRows,
  acpLine,
  fillColor,
  itemGroup,
  type Segment,
  segStyle,
  spacingBefore,
} from './acp/lines.ts';
import type { Item, Op, ToolItem } from './model.ts';
import {
  applyOps,
  emptyState,
  moveSelection,
  type PaneMeta,
  type PaneState,
  withMeta,
} from './state.ts';
import { ledColor, theme } from './theme.ts';
import { type VerdictView, verdictOf } from './verdict.ts';
import {
  cardGlyphColor,
  isFoldable,
  isSettled,
  mdPlain,
  mdSource,
  PROMPT_PREVIEW_LINES,
  rowHeight,
  sideColor,
  TAIL_BUDGET,
  toolBodyLines,
  toolBodyMd,
  toolTail,
} from './view.ts';

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
}

/**
 * Build the pane.
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
        const item = plain.byId[plain.selected];
        if (item === undefined || !isFoldable(item)) return;
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

/** The markdown/code/diff style derived from the palette — one
 *  `SyntaxStyle` so every renderable speaks the same colors. */
function syntaxStyle(owner: NativeResourceOwner): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      'markup.heading': { fg: theme.emph, bold: true },
      'markup.bold': { fg: theme.emph },
      'markup.italic': { fg: theme.muted },
      'markup.raw': { fg: theme.success },
      'markup.quote': { fg: theme.muted },
      'markup.link': { fg: theme.cyan, underline: true },
      'markup.list': { fg: theme.peach },
      keyword: { fg: theme.cyan },
      string: { fg: theme.success },
      comment: { fg: theme.muted },
      number: { fg: theme.warning },
      'diff.plus': { fg: theme.success },
      'diff.minus': { fg: theme.error },
      'diff.delta': { fg: theme.info },
    },
    owner
  );
}

const URL_RE = /https?:\/\/[^\s)\]>}"']+/g;

/** One plain line → text runs; URLs paint cyan-underlined (their
 *  link chrome — `56b6c2` + underline in the capture). */
function LinkRuns(props: { line: string; fg: string; dim?: boolean }) {
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

function Spinner(props: { fg: string }) {
  const [tick, setTick] = createSignal(0);
  onAnimationTick(10, () => setTick(t => t + 1));
  return <text fg={props.fg} content={SPINNER[tick() % SPINNER.length]} />;
}

/** The tool call — the feed's mass row, never a box: status
 *  glyph + the call's name and short arg, all dim. Non-empty output
 *  renders dim+indented under it, capped at 3 lines then `+N more`;
 *  `(no output)` results paint nothing — one compact row per call
 *  (opencode grammar — the first demo's shape restored). */
function ToolCard(props: {
  item: ToolItem;
  selected: boolean;
  syntax: SyntaxStyle;
  width: () => number;
}) {
  const tail = createMemo(() => toolTail(props.item));
  const body = createMemo(() => toolBodyLines(props.item));
  const md = createMemo(() => toolBodyMd(props.item));
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
        <text fg={theme.muted} attributes={TextAttributes.DIM} content={` ${props.item.title}`} />
        <text
          fg={theme.muted}
          attributes={TextAttributes.DIM}
          content={`${tail().kind}${tail().arg}`}
        />
        <text fg={theme.muted} attributes={TextAttributes.DIM} content={tail().tally} />
      </box>
      {/* pinned open (Enter/c) — the FULL body as real markdown:
       *  prose formats, fences highlight via tree-sitter. The
       *  j/k selection peek keeps the ≤3-line plain preview. */}
      <Show
        when={!props.item.collapsed && md() !== ''}
        fallback={
          <Show when={props.selected && props.item.foldTouched !== true && body().lines.length > 0}>
            <box flexDirection="column" paddingLeft={2} flexShrink={0}>
              <For each={body().lines}>
                {l => (
                  <text
                    fg={theme.muted}
                    attributes={TextAttributes.DIM}
                    content={l}
                    flexShrink={0}
                  />
                )}
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
    </box>
  );
}

/** One painted segment — `segStyle` resolves their TokenName through
 *  DEFAULT_THEME into `<text>` props. */
function SegText(props: { seg: Segment }) {
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

/** A vendored `format.ts` row — the acp impl's own line language.
 *  Each segment paints through `segStyle` (their DEFAULT_THEME);
 *  selection reads as a surface wash, no box chrome. */
function AcpSegRow(props: { segs: readonly Segment[]; selected: boolean }) {
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
function AcpToolBody(props: { item: ToolItem; syntax: SyntaxStyle; width: () => number }) {
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
function AcpRunRow(props: {
  item: ToolItem;
  selected: boolean;
  width: () => number;
  frame: () => number;
  findTool: (toolCallId: string) => unknown;
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
      </box>
      {/* selection previews: a still-collapsed run shows its members
       *  while it holds the selection (j/k), Enter/c pins it open —
       *  no mouse path exists by design (addendum 7) */}
      <Show when={!props.item.collapsed || (props.selected && props.item.foldTouched !== true)}>
        <For each={props.item.runs ?? []}>
          {m => (
            <box flexDirection="row" flexShrink={0} width="100%">
              <text fg={theme.muted} attributes={TextAttributes.DIM} content={'│ '} />
              <AcpSegRow
                segs={acpLine(
                  m,
                  props.width() - 2,
                  props.item.status === 'live' ? props.frame() : 0,
                  props.findTool
                )}
                selected={false}
              />
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

/** One `┃`-barred block — their block grammar verbatim (capture
 *  rows 25-43): two base cells, then the peach `┃` on `#141414`
 *  for the block's whole height, content padded inside, the wash
 *  filling to the right edge. The bar is the box's `heavy` left
 *  border, so ANY content (a markdown renderable included) keeps
 *  the bar and the bg without per-line plumbing (addendum 18). */
function BarBlock(props: { children?: JSX.Element; selected?: boolean }) {
  return (
    <box
      marginLeft={2}
      width="100%"
      flexShrink={0}
      border={['left']}
      borderStyle="heavy"
      borderColor={props.selected ? theme.accent : theme.peach}
      backgroundColor={theme.surface}
      paddingLeft={2}
    >
      {props.children}
    </box>
  );
}

/** A bare pad line inside a `BarBlock` — the blank row their blocks
 *  put around titles and between sections. */
function BarPad() {
  return <box height={1} flexShrink={0} />;
}

/** The caller prompt — "what was asked" as their `┃` card, no title
 *  (the peach bar IS the label): the prompt as REAL markdown
 *  (addendum 18): links, bold, lists and code fences render, markers
 *  conceal; the tree-sitter client is the shared default <code>
 *  already uses. Folded it keeps its first PROMPT_PREVIEW_LINES lines
 *  visible then `+M more`. Empty text (no journaled prompt, no
 *  `.prompt.md` sibling) is the marker. */
function PromptRow(props: {
  item: Item;
  syntax: SyntaxStyle;
  selected: boolean;
  width: () => number;
}) {
  const text = createMemo(() => ('text' in props.item ? mdSource(props.item.text) : ''));
  const lines = createMemo(() => text().split('\n'));
  // the folded preview — first N lines; a cut that lands inside a
  // code fence closes it so the renderable doesn't eat the `+more` row
  const preview = createMemo(() => {
    const ls = lines().slice(0, PROMPT_PREVIEW_LINES);
    if (ls.filter(l => /^\s*(`{3,}|~{3,})/.test(l)).length % 2 === 1) ls.push('```');
    return ls.join('\n');
  });
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
        <Show
          when={open()}
          fallback={
            <>
              <Show when={PROMPT_PREVIEW_LINES > 0}>
                <markdown
                  content={preview()}
                  syntaxStyle={props.syntax}
                  conceal
                  streaming
                  internalBlockMode="top-level"
                  flexShrink={0}
                  maxWidth={props.width() - 5}
                />
              </Show>
              <text
                fg={theme.muted}
                attributes={TextAttributes.DIM}
                content={`+${lines().length - Math.min(lines().length, PROMPT_PREVIEW_LINES)} more lines — Enter expands`}
                flexShrink={0}
              />
            </>
          }
        >
          <markdown
            content={text()}
            syntaxStyle={props.syntax}
            conceal
            streaming
            internalBlockMode="top-level"
            flexShrink={0}
            maxWidth={props.width() - 5}
          />
        </Show>
      </Show>
      <BarPad />
    </BarBlock>
  );
}

/** One session item — agent speech, a dim thought, a side line, or
 *  a tool card. Items carrying `vi` render the impl's own row
 *  language (acp impl: the vendored `format.ts` one-liners);
 *  everything else keeps this pane's card chrome. */
function ItemRow(props: {
  item: Item;
  syntax: SyntaxStyle;
  selected: boolean;
  width: () => number;
  frame: () => number;
  findTool: (toolCallId: string) => unknown;
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
    const line = acpLine(
      vi,
      props.width(),
      frame,
      props.findTool,
      'arg' in props.item ? props.item.arg : undefined
    );
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
  const thought = createMemo(() => props.item.kind === 'thought');
  // foldable text rows — the selection peek opens an untouched fold,
  // Enter/c pins it; folded rows read `first line · +N lines`
  const textOpen = () =>
    props.item.collapsed !== true || (props.selected && props.item.foldTouched !== true);
  const textOf = () => ('text' in props.item ? mdSource(props.item.text) : '');
  const foldSummary = () => {
    const n = textOf().split('\n').length;
    return `${firstLine(mdPlain(textOf()).join('\n'))}${n > 1 ? ` · +${n} lines` : ''}`;
  };
  const tone = createMemo(() => {
    const it = props.item;
    return it.kind === 'turn' || it.kind === 'permission' || it.kind === 'note'
      ? it.tone
      : undefined;
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
                <box flexDirection="column" flexShrink={0}>
                  <AcpSegRow segs={segs() ?? []} selected={props.selected} />
                  <Show
                    when={
                      tool() !== undefined &&
                      (!tool()?.collapsed || (props.selected && tool()?.foldTouched !== true))
                    }
                  >
                    <AcpToolBody
                      item={tool() as ToolItem}
                      syntax={props.syntax}
                      width={props.width}
                    />
                  </Show>
                </box>
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
                  />
                }
              >
                <Show
                  when={tool()}
                  keyed
                  fallback={
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
                                  when={thought()}
                                  fallback={
                                    /* time separators — dim one-liners,
                                     *  never markdown */
                                    <Show
                                      when={props.item.kind === 'time'}
                                      fallback={
                                        /* side lines — turn markers, notes.
                                         *  Long notes fold like prose
                                         *  (addendum 20) */
                                        <Show
                                          when={textOpen() || !isFoldable(props.item)}
                                          fallback={
                                            <text
                                              fg={sideColor(tone())}
                                              attributes={TextAttributes.DIM}
                                              flexShrink={0}
                                              content={foldSummary()}
                                            />
                                          }
                                        >
                                          <markdown
                                            content={textOf()}
                                            syntaxStyle={props.syntax}
                                            conceal
                                            streaming
                                            internalBlockMode="top-level"
                                            flexShrink={0}
                                            maxWidth={props.width() - 1}
                                          />
                                        </Show>
                                      }
                                    >
                                      <box flexDirection="column" flexShrink={0}>
                                        <For
                                          each={('text' in props.item ? props.item.text : '').split(
                                            '\n'
                                          )}
                                        >
                                          {l => (
                                            <text
                                              fg={theme.muted}
                                              attributes={TextAttributes.DIM}
                                              content={l}
                                              flexShrink={0}
                                            />
                                          )}
                                        </For>
                                      </box>
                                    </Show>
                                  }
                                >
                                  {/* `+ Thought` — their amber collapsed
                                   *  thought row (capture rows 3/11/23);
                                   *  open it shows the body as markdown */}
                                  <box flexDirection="column" flexShrink={0}>
                                    <box flexDirection="row" flexShrink={0}>
                                      <text fg={theme.amber} content="+ " />
                                      <text fg={theme.amber} content="Thought" />
                                      <text
                                        fg={theme.muted}
                                        attributes={TextAttributes.DIM}
                                        content={` · ${foldSummary()}`}
                                      />
                                    </box>
                                    <Show when={textOpen() && isFoldable(props.item)}>
                                      <box paddingLeft={2} flexShrink={0}>
                                        <markdown
                                          content={textOf()}
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
                                </Show>
                              }
                            >
                              {/* agent speech — bare prose, no bullet
                               *  (addendum 26: every remaining prefix
                               *  earns its cell). Long prose folds to a
                               *  one-line summary. */}
                              <box flexDirection="row" flexShrink={0} width="100%">
                                {/* minWidth:0 — a flex item's floor is
                                 *  its content width; without it long
                                 *  paragraphs hold their unwrapped
                                 *  width and clip under the scrollbar */}
                                <box flexGrow={1} flexShrink={0} minWidth={0}>
                                  <Show
                                    when={textOpen() || !isFoldable(props.item)}
                                    fallback={
                                      <text
                                        fg={theme.muted}
                                        attributes={TextAttributes.DIM}
                                        content={foldSummary()}
                                        flexShrink={0}
                                      />
                                    }
                                  >
                                    <markdown
                                      content={props.item.kind === 'tool' ? '' : textOf()}
                                      syntaxStyle={props.syntax}
                                      conceal
                                      streaming
                                      internalBlockMode="top-level"
                                      flexShrink={0}
                                      maxWidth={props.width() - 1}
                                    />
                                  </Show>
                                </box>
                              </box>
                            </Show>
                          }
                        >
                          <PromptRow
                            item={props.item}
                            syntax={props.syntax}
                            selected={props.selected}
                            width={props.width}
                          />
                        </Show>
                      }
                    >
                      {/* the feed header — agent·provider·model·cwd·launched,
                       *  their `#141414` bar: dim label, emphasis fields */}
                      <box width="100%" flexShrink={0} backgroundColor={theme.surface}>
                        <text
                          fg={theme.emph}
                          content={`  ${props.item.kind === 'header' ? props.item.text : ''}`}
                        />
                      </box>
                    </Show>
                  }
                >
                  {item => (
                    <ToolCard
                      item={item}
                      selected={props.selected}
                      syntax={props.syntax}
                      width={props.width}
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

/** The verdict control as their `┃` card — a dim title, the badge
 *  line in emphasis (their "recommended option" reads), the answer
 *  fields dim beneath. Shape-checked answers only; the ▸ JSON row
 *  stays the fallback for anything else. */
function VerdictRow(props: { view: VerdictView; selected: boolean }) {
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
function PermissionRow(props: { title: string; detail: string }) {
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

/** The header bar — the pane's name, its worktree + agent, and the
 *  LED chip it reports upstream. Slim, surface-backed, one line. */
function HeaderBar(props: { meta: PaneMeta }) {
  const slug = () => {
    const w = props.meta.worktree;
    return w === '' ? '…' : (w.split('/').filter(Boolean).pop() ?? w);
  };
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      minHeight={1}
      backgroundColor={theme.surface}
      flexShrink={0}
    >
      <text fg={theme.accent} attributes={TextAttributes.BOLD} content=" bro: session" />
      <text fg={theme.muted} content={` — ${slug()}`} />
      <Show when={props.meta.agent !== ''}>
        <text fg={theme.muted} content={` · ${props.meta.agent}`} />
      </Show>
      <box flexGrow={1} />
      <text fg={ledColor(props.meta.led)} content="● " />
      <text
        fg={theme.muted}
        content={`${props.meta.led}${props.meta.mode !== '' ? ` · ${props.meta.mode}` : ''} `}
      />
    </box>
  );
}

/** The footer — the key hints, dim, one line; a toast ('copied')
 *  replaces them while it's set. Their bottom-right `path:branch`
 *  status maps to the worktree slug. */
function FooterBar(props: { toast: () => string; meta: PaneMeta }) {
  const slug = () => {
    const w = props.meta.worktree;
    return w === '' ? '' : (w.split('/').filter(Boolean).pop() ?? w);
  };
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      minHeight={1}
      flexShrink={0}
      backgroundColor={theme.base}
    >
      <Show
        when={props.toast() === ''}
        fallback={<text fg={theme.accent} content={`  ${props.toast()}`} />}
      >
        <text
          fg={theme.muted}
          content="j/k select+peek · Enter/c pin fold · arrows/PgUp/Home/End scroll · Ctrl+C copy row"
        />
      </Show>
      <box flexGrow={1} />
      <text fg={theme.muted} content={slug()} />
    </box>
  );
}

/** The whole pane — header bar, the sticky-bottom scrollback of
 *  session items, footer. */
function Pane(props: {
  store: PaneStore;
  syntax: SyntaxStyle;
  toast: () => string;
  onScroller?: (el: ScrollBoxRenderable) => void;
  /** mouse-up after a drag-select → OSC52 copy (opencode's
   *  copy-on-select on the renderer's own selection) */
  onCopySelect?: (event: MouseEvent) => void;
}) {
  const renderer = useRenderer();
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
  const findTool = (toolCallId: string): unknown => {
    for (const id of props.store.state.order) {
      const it = props.store.state.byId[id];
      if (it?.kind === 'tool' && it.toolCallId === toolCallId) return it.vi;
    }
    return undefined;
  };
  // the opencode/acp-tui shape: the WHOLE feed is renderables inside a
  // scrollbox (stickyScroll keeps the bottom while rows stream), and
  // the scroll is the scrollbox's own scrollTop — every row keeps its
  // markdown/colors/expand chrome and scrolls in place. The identity +
  // keys chrome sits OUTSIDE the scrollbox, flexShrink=0 at the bottom
  // of the column — pinned there always, never scrolled or clipped.
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
      <scrollbox
        ref={el => {
          const sb = el as ScrollBoxRenderable;
          // a light bar: the dim thumb on a base-colored track reads
          // as a notch, not a rail; the viewport's right padding keeps
          // two breathing columns between the text and the bar's gutter
          sb.verticalScrollBar.trackOptions = {
            foregroundColor: theme.scrollbar,
            backgroundColor: theme.base,
          };
          // every offset change bumps the frame signal — atBottom (and
          // so the Jump-to-latest chip) follows a scroll the same frame
          // instead of waiting up to 10 animation ticks
          sb.verticalScrollBar.onChange = () => setFrame(f => f + 1);
          sb.viewport.paddingRight = 2;
          setScroller(sb);
          props.onScroller?.(sb);
        }}
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
              {item => {
                // their list.ts rhythm — a blank row on every group
                // change and before user/agent text; activity stays tight
                const margin = () => {
                  if (index() === 0) return 0;
                  const prevId = props.store.state.order[index() - 1];
                  const prev = prevId === undefined ? undefined : props.store.state.byId[prevId];
                  return prev === undefined ? 0 : spacingBefore(itemGroup(prev), itemGroup(item));
                };
                return (
                  // the row's own box — its `id` is the scrollbox's
                  // scrollChildIntoView handle (j/k follows the walk)
                  <box id={`row-${id}`} flexDirection="column" flexShrink={0} width="100%">
                    <Show when={margin() > 0}>
                      <box height={margin()} width="100%" flexShrink={0} />
                    </Show>
                    <ItemRow
                      item={item}
                      syntax={props.syntax}
                      selected={props.store.state.selected === id}
                      width={() => Math.max(20, (scroller()?.viewport.width || renderer.width) - 2)}
                      frame={frame}
                      findTool={findTool}
                    />
                  </box>
                );
              }}
            </Show>
          )}
        </For>
      </scrollbox>
      <Show when={!atBottom()}>
        <box
          flexDirection="row"
          width="100%"
          height={1}
          flexShrink={0}
          backgroundColor={theme.base}
        >
          <box flexGrow={1} />
          <text fg={theme.muted} content="Jump to latest ↓ " />
        </box>
      </Show>
      {/* identity + keys — pinned at the bottom, OUTSIDE the scrollbox,
       *  so they never move while the feed scrolls */}
      <HeaderBar meta={props.store.state.meta} />
      <FooterBar toast={props.toast} meta={props.store.state.meta} />
    </box>
  );
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
  await render(
    () => (
      <Pane
        store={pane.store}
        syntax={syntax}
        toast={toast}
        onScroller={el => {
          scroller = el;
          pane.scroller = el;
        }}
        onCopySelect={() => {
          // opencode's copy-on-select: drag → renderer Selection →
          // OSC52 onto the clipboard, then clear the highlight
          const text = opts.renderer.getSelection()?.getSelectedText();
          if (text === undefined || text === '') return;
          process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`);
          setToast('copied');
          opts.renderer.clearSelection();
          setTimeout(() => setToast(''), 1500);
        }}
      />
    ),
    opts.renderer
  );
  pane.toast = setToast;
  pane.scroll = lines => scroller?.scrollBy?.(lines);
  pane.scrollPage = dir => scroller?.scrollBy?.(dir * Math.max(1, opts.renderer.height - 2));
  pane.scrollEdge = edge => scroller?.scrollTo?.(edge === 0 ? 0 : Infinity);
  pane.scrollToRow = id => scroller?.scrollChildIntoView?.(`row-${id}`, { align: 'nearest' });
  return pane;
}

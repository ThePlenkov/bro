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

import type { CliRenderer, NativeResourceOwner, ScrollBoxRenderable } from '@opentui/core';
import { SyntaxStyle, TextAttributes } from '@opentui/core';
import { onAnimationTick, render, useRenderer } from '@opentui/solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  acpCardRows,
  acpLine,
  fillColor,
  itemGroup,
  type Segment,
  segStyle,
  spacingBefore,
} from './acp/lines.ts';
import type { Item, Op, ToolContent, ToolItem } from './model.ts';
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
  argBody,
  argHead,
  cardBorderColor,
  cardGlyphColor,
  contentLineCount,
  diffText,
  sideColor,
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
  copyItem?: (item: Item) => string
): Pane {
  const [state, setState] = createStore<PaneState>(emptyState(meta, foldAll));
  let plain: PaneState = emptyState(meta, foldAll);

  const publish = (next: PaneState): void => {
    plain = next;
    setState(reconcile(plain, { key: null }));
  };

  return {
    store: { state },
    writer: {
      apply(ops) {
        if (ops.length === 0) return;
        publish(applyOps(plain, ops));
      },
      select(delta) {
        publish({ ...plain, selected: moveSelection(plain, delta) });
      },
      toggle() {
        const item = plain.byId[plain.selected];
        if (item === undefined || item.kind !== 'tool') return;
        publish({
          ...plain,
          byId: { ...plain.byId, [item.id]: { ...item, collapsed: !item.collapsed } },
        });
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
}

/** The markdown/code/diff style derived from the palette — one
 *  `SyntaxStyle` so every renderable speaks the same colors. */
function syntaxStyle(owner: NativeResourceOwner): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      'markup.heading': { fg: theme.accent, bold: true },
      'markup.bold': { fg: theme.warning },
      'markup.italic': { fg: '#bb9af7' },
      'markup.raw': { fg: theme.success },
      'markup.quote': { fg: theme.muted },
      'markup.link': { fg: '#73daca' },
      'markup.list': { fg: '#7dcfff' },
      keyword: { fg: '#bb9af7' },
      string: { fg: theme.success },
      comment: { fg: theme.muted },
      number: { fg: '#ff9e64' },
      'diff.plus': { fg: theme.success },
      'diff.minus': { fg: theme.error },
      'diff.delta': { fg: theme.accent },
    },
    owner
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

/** A tool card's content entry that the pane cannot render — say
 *  what it was, the way the line renderer does. */
function describeContent(entry: ToolContent): string {
  if (entry.kind === 'terminal') return `terminal output is not archived (terminal ${entry.id})`;
  if (entry.kind === 'unknown') return `[${entry.type}]`;
  return '';
}

/** One content entry → the block that renders it. */
function ToolBody(props: { item: ToolItem; syntax: SyntaxStyle }) {
  return (
    <For each={props.item.content}>
      {entry => {
        if (entry.kind === 'text') {
          return <code content={entry.text} filetype="text" syntaxStyle={props.syntax} />;
        }
        if (entry.kind === 'diff') {
          return <diff diff={diffText(entry)} view="unified" filetype="diff" />;
        }
        return <text attributes={TextAttributes.DIM} content={describeContent(entry)} />;
      }}
    </For>
  );
}

/** The tool card — a rounded box whose header names the call and
 *  whose body holds the arg block (a heredoc renders across lines)
 *  and the finished output. Selected reads at a glance: accent
 *  border over a subtle surface. */
function ToolCard(props: { item: ToolItem; syntax: SyntaxStyle; selected: boolean }) {
  const argBlock = createMemo(() => argBody(props.item));
  const kind = () =>
    props.item.toolKind !== undefined && props.item.toolKind !== ''
      ? ` [${props.item.toolKind}]`
      : '';
  const argHeadSeg = () => {
    const a = argHead(props.item);
    return a !== '' ? ` ${a}` : '';
  };
  const bodyLines = () => contentLineCount(props.item);
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={cardBorderColor(props.item.status, props.selected)}
      backgroundColor={props.selected ? theme.surface : undefined}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
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
        <text
          attributes={props.item.status === 'live' ? 0 : TextAttributes.BOLD}
          content={` ${props.item.title}`}
        />
        <text fg={theme.muted} content={`${kind()}${argHeadSeg()}`} />
      </box>
      <Show when={props.item.collapsed && bodyLines() > 0}>
        <text fg={theme.muted} content={`… ${bodyLines()} more`} flexShrink={0} />
      </Show>
      <Show
        when={!props.item.collapsed && (props.item.content.length > 0 || argBlock() !== undefined)}
      >
        <box paddingLeft={1} flexShrink={0}>
          <Show when={argBlock()}>
            {arg => <code content={arg()} filetype="bash" syntaxStyle={props.syntax} />}
          </Show>
          <ToolBody item={props.item} syntax={props.syntax} />
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
          fg={theme.accent}
          attributes={props.item.status === 'live' ? undefined : TextAttributes.DIM}
          content="▸ "
        />
        <text
          fg={props.item.status === 'live' ? theme.text : theme.muted}
          attributes={props.item.status === 'live' ? undefined : TextAttributes.DIM}
          content={props.item.arg ?? ''}
        />
      </box>
      <Show when={!props.item.collapsed}>
        <For each={props.item.runs ?? []}>
          {m => (
            <box flexDirection="row" flexShrink={0} width="100%">
              <text fg={theme.muted} attributes={TextAttributes.DIM} content={'│ '} />
              <AcpSegRow
                segs={acpLine(m, props.width() - 2, props.frame(), props.findTool)}
                selected={false}
              />
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

/** The injected prompt — "what was asked" at the top, visually
 *  distinct: accent `▸` gutter over the session surface, markdown
 *  body. Empty text (no `.prompt.md` sibling) is the marker. */
function PromptRow(props: { item: Item; syntax: SyntaxStyle }) {
  const text = () => ('text' in props.item ? props.item.text : '');
  return (
    <box flexDirection="row" width="100%" flexShrink={0} backgroundColor={theme.surface}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD} content={'▸ '} />
      <Show
        when={text() !== ''}
        fallback={
          <text fg={theme.muted} attributes={TextAttributes.DIM} content="prompt unavailable" />
        }
      >
        <box flexGrow={1} flexShrink={0}>
          <markdown
            content={text()}
            syntaxStyle={props.syntax}
            internalBlockMode="top-level"
            flexShrink={0}
          />
        </box>
      </Show>
    </box>
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
    const line = acpLine(
      vi,
      props.width(),
      props.frame(),
      props.findTool,
      'arg' in props.item ? props.item.arg : undefined
    );
    return line.length > 0 ? line : null;
  });
  // a judge reply classifies on its own shape — every answer must
  // match the typed table, so a prose message never trips it; the
  // `judge` flag narrows it further on journaled turns
  const verdict = createMemo(() => ('text' in props.item ? verdictOf(props.item.text) : undefined));
  const thought = createMemo(() => props.item.kind === 'thought');
  const tone = createMemo(() => {
    const it = props.item;
    return it.kind === 'turn' || it.kind === 'permission' || it.kind === 'note'
      ? it.tone
      : undefined;
  });
  return (
    // the end-user timeline gutter: every row carries its archive `ts`
    // as a dim HH:MM — one glance tells WHEN the step happened
    <box flexDirection="row" flexShrink={0} width="100%">
      <Show when={props.item.at !== undefined}>
        <text
          fg={theme.muted}
          attributes={TextAttributes.DIM}
          content={`${hhmm(props.item.at)} `}
        />
      </Show>
      <box flexDirection="column" flexGrow={1} flexShrink={0}>
        <Show
          when={verdict() === undefined}
          fallback={<VerdictRow view={verdict() as VerdictView} selected={props.selected} />}
        >
          <Show
            when={segs() === null}
            fallback={
              <box flexDirection="column" flexShrink={0}>
                <AcpSegRow segs={segs() ?? []} selected={props.selected} />
                <Show when={tool() !== undefined && !tool()?.collapsed}>
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
                    when={props.item.kind === 'prompt'}
                    fallback={
                      <Show
                        when={props.item.kind === 'message'}
                        fallback={
                          <text
                            fg={thought() ? theme.muted : sideColor(tone())}
                            attributes={
                              thought()
                                ? TextAttributes.DIM | TextAttributes.ITALIC
                                : TextAttributes.DIM
                            }
                            flexShrink={0}
                            content={props.item.kind === 'tool' ? '' : props.item.text}
                          />
                        }
                      >
                        <markdown
                          content={props.item.kind === 'tool' ? '' : props.item.text}
                          syntaxStyle={props.syntax}
                          streaming
                          internalBlockMode="top-level"
                          flexShrink={0}
                        />
                      </Show>
                    }
                  >
                    <PromptRow item={props.item} syntax={props.syntax} />
                  </Show>
                }
              >
                {item => <ToolCard item={item} syntax={props.syntax} selected={props.selected} />}
              </Show>
            </Show>
          </Show>
        </Show>
      </box>
    </box>
  );
}

/** `at` → the gutter's `HH:MM` (local time — the reader's clock, not
 *  the journal's UTC). Missing/unparseable stamps render nothing. */
const hhmm = (at: string | undefined): string => {
  if (at === undefined) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The verdict control — `⛨ jev · <summary>` badge line plus the
 *  fields table (short — shape-checked answers only, the ▸ JSON row
 *  stays the fallback for anything else). */
function VerdictRow(props: { view: VerdictView; selected: boolean }) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={props.selected ? theme.surface : undefined}
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} content="⛨ " />
        <text fg={theme.accent} attributes={TextAttributes.BOLD} content={`${props.view.badge} `} />
        <text fg={theme.text} content={props.view.summary} />
      </box>
      <For each={props.view.fields}>
        {f => (
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme.muted} attributes={TextAttributes.DIM} content="   " />
            <text fg={theme.muted} content={`${f[0]} `} />
            <text fg={theme.text} attributes={TextAttributes.DIM} content={f[1]} />
          </box>
        )}
      </For>
    </box>
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
    <box flexDirection="row" width="100%" height={1} backgroundColor={theme.surface} flexShrink={0}>
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
 *  replaces them while it's set. */
function FooterBar(props: { toast: () => string }) {
  return (
    <box width="100%" height={1} flexShrink={0}>
      <Show
        when={props.toast() === ''}
        fallback={<text fg={theme.accent} content={`  ${props.toast()}`} />}
      >
        <text
          fg={theme.muted}
          content="j/k select card · Enter/c fold · arrows/PgUp/Home/End scroll · Ctrl+C copy row"
        />
      </Show>
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
}) {
  const renderer = useRenderer();
  const [frame, setFrame] = createSignal(0);
  onAnimationTick(10, () => setFrame(f => f + 1));
  /** permission rows name their tool — look the call up by id. */
  const findTool = (toolCallId: string): unknown => {
    for (const id of props.store.state.order) {
      const it = props.store.state.byId[id];
      if (it?.kind === 'tool' && it.toolCallId === toolCallId) return it.vi;
    }
    return undefined;
  };
  return (
    <box flexDirection="column" width="100%" height="100%">
      <HeaderBar meta={props.store.state.meta} />
      <scrollbox
        ref={el => props.onScroller?.(el as ScrollBoxRenderable)}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        flexGrow={1}
        width="100%"
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
                  <>
                    <Show when={margin() > 0}>
                      <box height={margin()} width="100%" flexShrink={0} />
                    </Show>
                    <ItemRow
                      item={item}
                      syntax={props.syntax}
                      selected={props.store.state.selected === id}
                      width={() => renderer.width}
                      frame={frame}
                      findTool={findTool}
                    />
                  </>
                );
              }}
            </Show>
          )}
        </For>
      </scrollbox>
      <FooterBar toast={props.toast} />
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
  /** The impl's fold policy — 'folded' collapses every card body
   *  (the vendored baseline); unset keeps COLLAPSE_AT. */
  foldAll?: boolean;
  /** The impl's copy text for an item — Ctrl+C's payload. */
  copyItem?: (item: Item) => string;
}): Promise<Pane> {
  // mouse capture OFF — the pane uses no mouse features, and holding
  // reporting steals native selection (addendum 7: copy must work
  // without Shift; herdr's own selection rides the same release)
  opts.renderer.useMouse = false;
  const pane = createPane(opts.meta, opts.foldAll, opts.copyItem);
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
        }}
      />
    ),
    opts.renderer
  );
  pane.toast = setToast;
  pane.scroll = lines => scroller?.scrollBy(lines);
  pane.scrollPage = dir => scroller?.scrollBy(dir * Math.max(1, opts.renderer.height - 2));
  pane.scrollEdge = edge => scroller?.scrollTo(edge === 0 ? 0 : Infinity);
  return pane;
}

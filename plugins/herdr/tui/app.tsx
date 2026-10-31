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
import { For, Show, createMemo, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { render, onAnimationTick } from '@opentui/solid';
import { SyntaxStyle, TextAttributes } from '@opentui/core';
import type { CliRenderer, NativeResourceOwner } from '@opentui/core';
import type { Item, Op, ToolContent, ToolItem } from './model.ts';
import {
  argBody,
  argHead,
  cardBorderColor,
  cardGlyphColor,
  contentLineCount,
  diffText,
  sideColor,
} from './view.ts';
import {
  applyOps,
  emptyState,
  moveSelection,
  withMeta,
  type PaneMeta,
  type PaneState,
} from './state.ts';
import { ledColor, theme } from './theme.ts';

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
  /** Update the header bar's fields (worktree, agent, LED). */
  setMeta(meta: Partial<PaneMeta>): void;
}

/** The pane — a store to read and a writer to drive. */
export interface Pane {
  store: PaneStore;
  writer: PaneWriter;
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
export function createPane(meta?: Partial<PaneMeta>): Pane {
  const [state, setState] = createStore<PaneState>(emptyState(meta));
  let plain: PaneState = emptyState(meta);

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

/** One session item — agent speech, a dim thought, a side line, or
 *  a tool card. */
function ItemRow(props: { item: Item; syntax: SyntaxStyle; selected: boolean }) {
  const tool = createMemo(() => (props.item.kind === 'tool' ? props.item : undefined));
  const thought = createMemo(() => props.item.kind === 'thought');
  const tone = createMemo(() => {
    const it = props.item;
    return it.kind === 'turn' || it.kind === 'permission' || it.kind === 'note'
      ? it.tone
      : undefined;
  });
  return (
    <Show
      when={tool()}
      keyed
      fallback={
        <Show
          when={props.item.kind === 'message'}
          fallback={
            <text
              fg={thought() ? theme.muted : sideColor(tone())}
              attributes={
                thought() ? TextAttributes.DIM | TextAttributes.ITALIC : TextAttributes.DIM
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
      {item => <ToolCard item={item} syntax={props.syntax} selected={props.selected} />}
    </Show>
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

/** The footer — the key hints, dim, one line. */
function FooterBar() {
  return (
    <box width="100%" height={1} flexShrink={0}>
      <text
        fg={theme.muted}
        content="j/k select card · Enter/c fold · arrows/PgUp/Home/End scroll · q quit"
      />
    </box>
  );
}

/** The whole pane — header bar, the sticky-bottom scrollback of
 *  session items, footer. */
function Pane(props: { store: PaneStore; syntax: SyntaxStyle }) {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <HeaderBar meta={props.store.state.meta} />
      <scrollbox stickyScroll stickyStart="bottom" viewportCulling flexGrow={1} width="100%">
        <For each={props.store.state.order}>
          {id => (
            <Show when={props.store.state.byId[id]} keyed>
              {item => (
                <ItemRow
                  item={item}
                  syntax={props.syntax}
                  selected={props.store.state.selected === id}
                />
              )}
            </Show>
          )}
        </For>
      </scrollbox>
      <FooterBar />
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
}): Promise<Pane> {
  const pane = createPane(opts.meta);
  const syntax = syntaxStyle(opts.renderer.nativeScene);
  await render(() => <Pane store={pane.store} syntax={syntax} />, opts.renderer);
  return pane;
}

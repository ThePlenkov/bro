#!/usr/bin/env bun
/**
 * `bro: session` — the OpenTUI pane (spec bro-q2edc). The acp lane's
 * human-readable workspace view: the same `.events.jsonl` archive
 * tail `bro herdr session-view` reads, the same LED contract it
 * reports, but rendered as a retained TUI instead of line output —
 * streaming markdown for agent speech, bordered cards for tool
 * calls, sticky-bottom scrollback, collapse toggle on cards.
 *
 *   bun run plugins/herdr/tui/main.ts <worktree> [--dump]
 *
 * --dump is the headless readout: replay the archive, print the
 * model's text projection, exit — no TUI, no herdr needed.
 */
import { mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { gitCommonDir, type ProviderEntry } from '@broject/core';
import {
  createCliRenderer,
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  TextAttributes,
  type Renderable,
} from '@opentui/core';
import {
  type FleetPaneState,
  fleetStatusPath,
  type PaneLed,
  parseFleetState,
} from '../../../packages/cli/src/commands/fleet-state.ts';
import {
  eventsVerdict,
  parseArchiveRows,
  readTailSlice,
  releaseSession,
  reportSession,
  sessionAgentOf,
  sizeOf,
  TAIL_BYTES,
} from '../../../packages/cli/src/commands/session-feed.ts';
import {
  resolveTarget,
  targetKey,
  type SessionTarget,
} from '../../../packages/cli/src/commands/herdr-session-view.ts';
import { loadBroConfig } from '../../../packages/cli/src/plugins.ts';
import { SessionModel, type Item, type Op, type ToolItem } from './model.ts';

/** The op-drain cadence — opencode's delta buffer: archive rows feed
 *  the model immediately, the renderable tree commits on a timer so
 *  token-wise chunks don't re-render per event. */
const FLUSH_MS = 32;
/** The resolution poll — a fs.watch on the state dir catches most
 *  moves; the poll is the floor for missed events on overlay fs. */
const POLL_MS = 500;

const readRaw = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** Parse the fleet-state doc or undefined — the projector's file may
 *  be mid-write. */
const readState = (path: string): FleetPaneState | undefined => {
  const raw = readRaw(path);
  return raw === undefined ? undefined : parseFleetState(raw);
};

const providers = (worktree: string): Record<string, ProviderEntry> => {
  try {
    return loadBroConfig(worktree).providers ?? {};
  } catch {
    return {};
  }
};

// --- dump mode ------------------------------------------------------------

/** `main.ts <worktree> --dump` — the headless readout. Prints the
 *  model's plain projection of the archive tail and exits. */
async function dump(worktree: string): Promise<void> {
  const base = gitCommonDir(worktree) ?? worktree;
  const state = readState(fleetStatusPath(base, worktree));
  const target = resolveTarget(state, worktree, providers(worktree));
  const model = new SessionModel();
  if (target?.events !== undefined) {
    const from = Math.max(0, sizeOf(target.events) - TAIL_BYTES);
    const slice = readTailSlice(target.events, from);
    if (slice !== undefined) {
      const start = from > 0 ? slice.text.indexOf('\n') + 1 : 0;
      for (const row of parseArchiveRows(slice.text.slice(start))) model.feed(row);
    }
  }
  for (const line of model.dump()) process.stdout.write(`${line}\n`);
}

// --- the TUI ---------------------------------------------------------------

const GLYPH: Record<string, string> = { live: '⣿', completed: '✓', failed: '✗' };

interface CardView {
  box: BoxRenderable;
  header: TextRenderable;
  body: BoxRenderable;
  contentSig: string;
}

export async function runTui(argv: string[]): Promise<void> {
  const worktree = argv.find(a => !a.startsWith('-'));
  if (worktree === undefined) {
    console.error('usage: main.ts <worktree> [--dump]');
    process.exit(2);
  }
  if (argv.includes('--dump')) {
    await dump(worktree);
    return;
  }
  if (process.env.HERDR_ENV !== '1') return;
  const pane = process.env.HERDR_PANE_ID;
  if (pane === undefined || pane === '') return;

  const base = gitCommonDir(worktree) ?? worktree;
  const statePath = fleetStatusPath(base, worktree);
  mkdirSync(dirname(statePath), { recursive: true });

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  // the pane's own header — one line pinned above the scrollback
  const banner = new TextRenderable(renderer, {
    content: `bro: session — ${worktree} · j/k select tool · Enter/c collapse · arrows scroll · q quit`,
    attributes: TextAttributes.DIM,
    flexShrink: 0,
  });
  renderer.root.add(banner);

  const scroll = new ScrollBoxRenderable(renderer, {
    stickyScroll: true,
    stickyStart: 'bottom',
    viewportCulling: true,
    flexGrow: 1,
    width: '100%',
    border: false,
  });
  renderer.root.add(scroll);
  scroll.focus();

  const syntax = SyntaxStyle.fromStyles(
    {
      'markup.heading': { fg: '#7aa2f7' },
      'markup.bold': { fg: '#e0af68' },
      'markup.italic': { fg: '#bb9af7' },
      'markup.raw': { fg: '#9ece6a' },
      'markup.quote': { fg: '#565f89' },
      'markup.link': { fg: '#73daca' },
      'markup.list': { fg: '#7dcfff' },
    },
    renderer.nativeScene
  );

  const model = new SessionModel();
  /** itemId → its renderable; text ops grow in place, eviction drops. */
  const views = new Map<number, Renderable>();
  const cards = new Map<number, CardView>();
  /** Ordered tool item ids — j/k selection walks this. */
  const toolOrder: number[] = [];
  let selected = -1;

  const dimText = (text: string): TextRenderable =>
    new TextRenderable(renderer, {
      content: text,
      attributes: TextAttributes.DIM,
      flexShrink: 0,
    });

  /** One tool content entry → its renderable: code block, unified
   *  diff, terminal note, unknown bracket. */
  const contentView = (c: ToolItem['content'][number]): Renderable => {
    switch (c.kind) {
      case 'text':
        return new CodeRenderable(renderer, {
          content: c.text,
          filetype: 'text',
          syntaxStyle: syntax,
        });
      case 'diff': {
        const old = (c.old ?? '').split('\n').map(l => `-${l}`);
        const cur = (c.cur ?? '').split('\n').map(l => `+${l}`);
        const diff = `--- a/${c.path}\n+++ b/${c.path}\n@@ -1,${old.length} +1,${cur.length} @@\n${[...old, ...cur].join('\n')}\n`;
        return new DiffRenderable(renderer, {
          diff,
          view: 'unified',
          filetype: 'diff',
        });
      }
      case 'terminal':
        return dimText(`terminal output is not archived (terminal ${c.id})`);
      case 'unknown':
        return dimText(`[${c.type}]`);
    }
  };

  const cardHeader = (it: ToolItem): string => {
    const glyph = GLYPH[it.status] ?? '⣿';
    const kind = it.toolKind !== undefined && it.toolKind !== '' ? ` [${it.toolKind}]` : '';
    const arg = it.arg !== undefined && it.arg !== '' ? ` ${it.arg}` : '';
    return `${glyph} ${it.title}${kind}${arg}`;
  };

  /** Build + register the card view for a tool item. */
  const mountCard = (it: ToolItem): CardView => {
    const header = new TextRenderable(renderer, {
      content: cardHeader(it),
      attributes: it.status === 'live' ? 0 : TextAttributes.BOLD,
      flexShrink: 0,
    });
    const body = new BoxRenderable(renderer, {
      border: false,
      paddingLeft: 2,
      visible: !it.collapsed,
    });
    const box = new BoxRenderable(renderer, {
      border: true,
      borderColor:
        it.status === 'failed' ? '#f7768e' : it.status === 'completed' ? '#9ece6a' : '#565f89',
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    });
    box.add(header);
    box.add(body);
    const view: CardView = { box, header, body, contentSig: '' };
    cards.set(it.id, view);
    views.set(it.id, box);
    scroll.add(box);
    patchCard(view, it);
    return view;
  };

  /** Refresh a mounted card — header, status color, collapsed body,
   *  content rebuilt only when its signature moves. */
  const patchCard = (view: CardView, it: ToolItem): void => {
    view.header.content = cardHeader(it);
    view.header.attributes = it.status === 'live' ? 0 : TextAttributes.BOLD;
    view.box.borderColor =
      it.status === 'failed' ? '#f7768e' : it.status === 'completed' ? '#9ece6a' : '#565f89';
    const sig = JSON.stringify(it.content);
    if (sig !== view.contentSig) {
      view.contentSig = sig;
      // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: remove() mutates the live children array
      for (const child of [...view.body.getChildren()]) view.body.remove(child);
      for (const c of it.content) view.body.add(contentView(c));
    }
    view.body.visible = !it.collapsed && it.content.length > 0;
  };

  /** Build a renderable for a fresh item — tool cards go through
   *  mountCard, everything else is a leaf node. */
  const mount = (it: Item): void => {
    switch (it.kind) {
      case 'message':
        views.set(
          it.id,
          new MarkdownRenderable(renderer, {
            content: it.text,
            syntaxStyle: syntax,
            streaming: true,
            internalBlockMode: 'top-level',
            flexShrink: 0,
          })
        );
        break;
      case 'thought':
        views.set(it.id, dimText(it.text));
        break;
      case 'turn':
        views.set(it.id, dimText(it.text));
        break;
      case 'permission':
        views.set(
          it.id,
          new TextRenderable(renderer, {
            content: it.text,
            fg: '#e0af68',
            flexShrink: 0,
          })
        );
        break;
      case 'note':
        views.set(it.id, dimText(it.text));
        break;
      case 'tool':
        mountCard(it);
        toolOrder.push(it.id);
        return;
    }
    const v = views.get(it.id);
    if (v !== undefined) scroll.add(v);
  };

  /** Apply the model's op queue — the only place the tree mutates. */
  const applyOps = (ops: Op[]): void => {
    for (const o of ops) {
      switch (o.op) {
        case 'append':
          mount(o.item);
          break;
        case 'text': {
          const v = views.get(o.id);
          if (v instanceof TextRenderable) v.content = o.text;
          else if (v instanceof MarkdownRenderable) v.content = o.text;
          break;
        }
        case 'tool': {
          const card = cards.get(o.item.id);
          if (card !== undefined) patchCard(card, o.item);
          break;
        }
        case 'evict':
          for (const id of o.ids) {
            const v = views.get(id);
            if (v !== undefined) {
              scroll.remove(v);
              v.destroyRecursively();
            }
            views.delete(id);
            cards.delete(id);
            const ti = toolOrder.indexOf(id);
            if (ti !== -1) toolOrder.splice(ti, 1);
          }
          break;
      }
    }
  };

  /** The tool cards' selection — j/k walks, Enter/c collapses. The
   *  selected card carries a bright border. */
  const paintSelection = (): void => {
    for (const id of toolOrder) {
      const card = cards.get(id);
      if (card !== undefined) card.box.borderStyle = 'single';
    }
    const id = toolOrder[selected];
    if (id !== undefined) {
      const card = cards.get(id);
      if (card !== undefined) card.box.borderStyle = 'double';
    }
  };

  renderer.keyInput.on('keypress', key => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      quit(0);
      return;
    }
    if (toolOrder.length === 0) return;
    if (key.name === 'j') {
      selected = Math.min(toolOrder.length - 1, selected + 1);
      paintSelection();
    } else if (key.name === 'k') {
      selected = Math.max(0, selected - 1);
      paintSelection();
    } else if (key.name === 'return' || key.name === 'enter' || key.name === 'c') {
      const id = toolOrder[selected];
      if (id === undefined) return;
      const it = model.items.find(i => i.id === id);
      if (it !== undefined && it.kind === 'tool') {
        model.toggle(it.toolCallId);
        applyOps(model.drain());
      }
    }
  });

  // --- the feed: fleet doc → target → archive tail → model → ops

  let cur: { key: string; eventsPath?: string; offset: number; watcher?: FSWatcher } | undefined;
  const detachFeed = (): void => {
    cur?.watcher?.close();
    cur = undefined;
  };

  /** One pump of the archive tail — feed the model only; the render
   *  commit rides the FLUSH_MS drain so token-wise chunks don't
   *  re-render per event. */
  const pumpEvents = (): void => {
    if (cur?.eventsPath === undefined) return;
    const more = readTailSlice(cur.eventsPath, cur.offset);
    if (more === undefined) return;
    cur.offset = more.size;
    for (const row of parseArchiveRows(more.text)) model.feed(row);
  };

  /** Arm the archive tail on a resolved target — replay the window,
   *  then ride appends via fs.watch (+ the poll covers misses). */
  const armFeed = (t: SessionTarget): void => {
    if (t.events === undefined) return;
    const path = t.events;
    cur = { key: targetKey(t), eventsPath: path, offset: 0 };
    const from = Math.max(0, sizeOf(path) - TAIL_BYTES);
    const slice = readTailSlice(path, from);
    if (slice !== undefined) {
      cur.offset = slice.size;
      const start = from > 0 ? slice.text.indexOf('\n') + 1 : 0;
      for (const row of parseArchiveRows(slice.text.slice(start))) model.feed(row);
    }
    try {
      cur.watcher = watch(path, () => pumpEvents());
    } catch {
      // a vanished archive just stays put — the poll still rides
    }
  };

  /** The LED — model verdict over the worker floor, deduped by
   *  state|mode like session-view. */
  let lastReport = '';
  let target: SessionTarget | undefined;
  const report = (): void => {
    const rowV = model.verdict;
    const v =
      target === undefined
        ? { led: { state: 'unknown' } as PaneLed, mode: 'waiting for projector' }
        : eventsVerdict(target.workerLed, rowV);
    const mark = `${v.led.state}|${v.mode}`;
    if (mark === lastReport) return;
    lastReport = mark;
    reportSession(pane, sessionAgentOf(target), v.led, v.mode);
  };

  /** The resolution poll — read the doc, re-arm the feed when the
   *  attach identity moves, report the verdict. */
  const refresh = (): void => {
    target = resolveTarget(readState(statePath), worktree, providers(worktree));
    const key = targetKey(target);
    if (key !== cur?.key) {
      detachFeed();
      if (target !== undefined) armFeed(target);
    }
    report();
  };

  const quit = (code: number): void => {
    releaseSession(pane);
    renderer.destroy();
    process.exit(code);
  };
  process.on('exit', () => releaseSession(pane));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(0));
  }

  try {
    watch(dirname(statePath), () => refresh());
  } catch {
    // the poll alone still rides
  }

  refresh();
  setInterval(() => {
    pumpEvents();
    refresh();
  }, POLL_MS);
  // the render commit — opencode's delta-buffer cadence
  setInterval(() => applyOps(model.drain()), FLUSH_MS);

  // the intervals keep the loop alive; this promise just holds the fn
  await new Promise(() => {});
}

await runTui(process.argv.slice(2));

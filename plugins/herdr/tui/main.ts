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
 *
 * The rendering lives in `app.tsx` (a Solid tree over @opentui/solid);
 * this file is the shell around it — the archive pump, the LED
 * verdict, and the process lifecycle. The split is not cosmetic:
 * the Solid JSX transform and OpenTUI's native FFI are both Bun-only,
 * so `app.tsx` cannot be imported by the Node test runner, while the
 * model and the pane's state (`model.ts`, `state.ts`) can.
 */
import { type FSWatcher, mkdirSync, readFileSync, watch, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { gitCommonDir, type ProviderEntry } from '@broject/core';
import { createCliRenderer } from '@opentui/core';
import {
  type FleetPaneState,
  fleetStatusPath,
  type PaneLed,
  parseFleetState,
} from '../../../packages/cli/src/commands/fleet-state.ts';
import {
  resolveTarget,
  type SessionTarget,
  targetKey,
} from '../../../packages/cli/src/commands/herdr-session-view.ts';
import {
  type ArchiveRow,
  eventsVerdict,
  parseArchiveRows,
  readTailSlice,
  releaseSession,
  reportSession,
  sessionAgentOf,
  sizeOf,
  TAIL_BYTES,
} from '../../../packages/cli/src/commands/session-feed.ts';
import { loadBroConfig } from '../../../packages/cli/src/plugins.ts';
import { implArg, type PaneImpl, pickImpl } from './impl.ts';

/** The op-drain cadence — opencode's delta buffer: archive rows feed
 *  the model immediately, the tree commits on a timer so token-wise
 *  chunks don't re-render per event. */
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

/** The sibling `<agentId>.prompt.md` bro writes at spawn — the archive
 *  journals no user-side rows, so it seeds the first item. Absent file
 *  (hand-made rows, foreign archives) → undefined → the `▸ prompt
 *  unavailable` marker; never fabricate. */
function readPrompt(eventsPath: string): string | undefined {
  try {
    return readFileSync(eventsPath.replace(/\.events\.jsonl$/, '.prompt.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/** Replay rows into the impl — the `.prompt.md` injection fires only
 *  when the archive carries no journaled `kind:'prompt'` rows (addendum
 *  3: bro journals them since `plane.start(prompt)`; the file is the
 *  fallback for older archives, never a duplicate). */
function feedArchive(impl: PaneImpl, eventsPath: string, rows: ArchiveRow[]): void {
  if (!rows.some(r => r.kind === 'prompt')) {
    impl.feed({ kind: 'prompt', text: readPrompt(eventsPath) });
  }
  for (const row of rows) impl.feed(row);
}

// --- dump mode -------------------------------------------------------------

/** `main.ts <worktree> --dump` — the headless readout. Prints the
 *  model's text projection of the archive tail and exits. */
async function dump(worktree: string, argv: string[]): Promise<void> {
  const base = gitCommonDir(worktree) ?? worktree;
  const state = readState(fleetStatusPath(base, worktree));
  const target = resolveTarget(state, worktree, providers(worktree));
  const impl = await pickImpl(implArg(argv));
  if (target?.events !== undefined) {
    const from = Math.max(0, sizeOf(target.events) - TAIL_BYTES);
    const slice = readTailSlice(target.events, from);
    if (slice !== undefined) {
      const start = from > 0 ? slice.text.indexOf('\n') + 1 : 0;
      feedArchive(impl, target.events, parseArchiveRows(slice.text.slice(start)));
    }
    impl.beginLive();
  }
  for (const line of impl.dump()) process.stdout.write(`${line}\n`);
}

// --- the TUI ---------------------------------------------------------------

export async function runTui(argv: string[]): Promise<void> {
  const worktree = argv.find(a => !a.startsWith('-'));
  if (worktree === undefined) {
    console.error('usage: main.ts <worktree> [--dump] [--impl legacy|acp]');
    process.exit(2);
  }
  if (argv.includes('--dump')) {
    await dump(worktree, argv);
    return;
  }
  if (process.env.HERDR_ENV !== '1') return;
  const paneId = process.env.HERDR_PANE_ID;
  if (paneId === undefined || paneId === '') return;

  const base = gitCommonDir(worktree) ?? worktree;
  const statePath = fleetStatusPath(base, worktree);
  mkdirSync(dirname(statePath), { recursive: true });

  // The Solid JSX transform is a Bun plugin, and it must be
  // registered BEFORE the .tsx tree is loaded — a static import
  // would resolve the JSX first and fail on the React runtime.
  // Hence the dynamic import; everything above this line stays
  // Node-loadable, so the --dump path never needs Bun.
  await import('@opentui/solid/preload');
  const { mountPane } = await import('./app.tsx');

  const renderer = await createCliRenderer({
    // Ctrl+C is a key, not a signal: the pane copies (addendum 8);
    // herdr owns lifecycle — no exit path lives here (addendum 2)
    exitOnCtrlC: false,
    // no mouse features — reporting would steal native/herdr
    // selection; copy must work without Shift (addendum 7)
    useMouse: false,
  });

  // Alternate scroll (DECSET 1007): with mouse reporting off, the
  // terminal translates the wheel into arrow keys — scroll returns
  // without button tracking, so plain drag still selects (addendum 9)
  process.stdout.write('\x1b[?1007h');
  process.on('exit', () => {
    try {
      writeSync(1, '\x1b[?1007l');
    } catch {
      // stdout already gone — the terminal's own teardown resets 1007
    }
  });

  const impl = await pickImpl(implArg(argv));
  const pane = await mountPane({
    renderer,
    meta: { worktree },
    foldAll: impl.fold === 'folded',
    copyItem: it => impl.copyText?.(it) ?? ('text' in it ? it.text : ''),
  });

  // --- keys: j/k walk the tool cards, Enter/c folds one, arrows and
  // PgUp/PgDn/Home/End scroll (the wheel rides them via ?1007), and
  // Ctrl+C copies the current row as OSC 52 — the terminal puts it on
  // the system clipboard where it speaks OSC 52 at all. No quit
  // binding — herdr owns the pane's lifecycle; the pane exits on
  // its close (signal → process.exit → 'exit' releases the session).
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  renderer.keyInput.on('keypress', key => {
    if (key.ctrl && key.name === 'c') {
      const text = pane.writer.copy();
      if (text === undefined || text === '') return;
      process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`);
      pane.toast?.('copied');
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => pane.toast?.(''), 1500);
    } else if (key.name === 'j') pane.writer.select(1);
    else if (key.name === 'k') pane.writer.select(-1);
    else if (key.name === 'up') pane.scroll?.(-1);
    else if (key.name === 'down') pane.scroll?.(1);
    else if (key.name === 'pageup') pane.scrollPage?.(-1);
    else if (key.name === 'pagedown') pane.scrollPage?.(1);
    else if (key.name === 'home') pane.scrollEdge?.(0);
    else if (key.name === 'end') pane.scrollEdge?.(1);
    else if (key.name === 'return' || key.name === 'enter' || key.name === 'c')
      pane.writer.toggle();
  });

  // --- the feed: fleet doc → target → archive tail → model → tree

  let cur: { key: string; eventsPath?: string; offset: number; watcher?: FSWatcher } | undefined;
  const detachFeed = (): void => {
    cur?.watcher?.close();
    cur = undefined;
  };

  /** One pump of the archive tail — feed the model only; the tree
   *  commit rides the FLUSH_MS drain so token-wise chunks don't
   *  re-render per event. */
  const pumpEvents = (): void => {
    if (cur?.eventsPath === undefined) return;
    const more = readTailSlice(cur.eventsPath, cur.offset);
    if (more === undefined) return;
    cur.offset = more.size;
    for (const row of parseArchiveRows(more.text)) impl.feed(row);
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
      feedArchive(impl, path, parseArchiveRows(slice.text.slice(start)));
    }
    // the tail window is replayed history; appends after this are the
    // live tail — the impl's replay/live boundary
    impl.beginLive();
    try {
      cur.watcher = watch(path, () => pumpEvents());
    } catch {
      // a vanished archive just stays put — the poll still rides
    }
  };

  /** The LED — model verdict over the worker floor, deduped by
   *  state|mode|agent like session-view; every real move also lands
   *  on the header bar's chip. */
  let lastReport = '';
  let target: SessionTarget | undefined;
  const report = (): void => {
    const rowV = impl.verdict;
    const v =
      target === undefined
        ? { led: { state: 'unknown' } as PaneLed, mode: 'waiting for projector' }
        : eventsVerdict(target.workerLed, rowV);
    const agent = sessionAgentOf(target);
    const mark = `${v.led.state}|${v.mode}|${agent}`;
    if (mark === lastReport) return;
    lastReport = mark;
    reportSession(paneId, agent, v.led, v.mode);
    pane.writer.setMeta({ agent, led: v.led.state, mode: v.mode });
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

  process.on('exit', () => releaseSession(paneId));
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
  // the tree commit — opencode's delta-buffer cadence
  setInterval(() => pane.writer.apply(impl.drain()), FLUSH_MS);

  // the intervals keep the loop alive; this promise just holds the fn
  await new Promise(() => {});
}

await runTui(process.argv.slice(2));

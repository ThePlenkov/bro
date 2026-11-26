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
import { type FSWatcher, mkdirSync, readFileSync, statSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { gitCommonDir, type ProviderEntry } from '@broject/core';
import {
  type ArchiveRow,
  completePart,
  eventsFile,
  eventsVerdict,
  fmtWhen,
  implArg,
  type PaneImpl,
  type PaneLed,
  parseArchiveRows,
  pickImpl,
  promptFile,
  readTailSlice,
  sysCopy,
  TAIL_BYTES,
  tailArchive,
} from '../../../packages/acp/session/src/index.ts';
import { serve, type ServedPane } from '../../../packages/acp/tui/serve.ts';
import { loadBroConfig } from '../../../packages/cli/src/plugins.ts';
import { flag } from '../../../packages/cli/src/commands/args.ts';
import {
  agentEntry,
  displayAgentOf,
  type FleetPaneState,
  fleetStatusPath,
  logStem,
  release as paneRelease,
  report as paneReport,
  parseFleetState,
  registryHomeOf,
  resolveTarget,
  SESSION_IDENTITY,
  type SessionTarget,
  sessionAgentOf,
  targetKey,
  workerLedState,
} from '../../../packages/herdr-kit/src/index.ts';

/** The op-drain cadence — opencode's delta buffer: archive rows feed
 *  the model immediately, the tree commits on a timer so token-wise
 *  chunks don't re-render per event. */
const FLUSH_MS = 32;
/** The resolution poll — a fs.watch on the state dir catches most
 *  moves; the poll is the floor for missed events on overlay fs. */
const POLL_MS = 500;

const opt = (argv: string[], name: string): string | undefined => flag(argv, name);

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
    return readFileSync(promptFile(eventsPath), 'utf8');
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
    // the fallback prompt IS the session's first event — it heads the
    // feed (addendum 25), never an unstamped orphan ahead of the
    // separators. Its origin is the session's own agent (the first
    // `acp provider` turn — a slice can open mid-session where the
    // first turn-start is an internal micro-call); its time is the
    // slice's first event. No agent turn in the slice → bare head.
    const agent = rows.find(r => /^acp provider '/.test(r.by ?? ''));
    impl.feed({
      kind: 'prompt',
      text: readPrompt(eventsPath),
      ts: rows[0]?.ts,
      by: agent?.by,
    });
  }
  for (const row of rows) impl.feed(row);
}

// --- argv / env gates --------------------------------------------------------

/** The CLI's target selectors: a worktree positional and the direct
 *  bind flags. A flag's VALUE is not a positional — `--events <path>`
 *  alone must not turn the archive path into the worktree arg. */
interface TuiCli {
  worktree?: string;
  eventsArg?: string;
  agentArg?: string;
  dump: boolean;
}

function parseCli(argv: string[]): TuiCli {
  const VALUE_FLAGS = new Set(['--events', '--agent', '--impl']);
  const cli: TuiCli = {
    worktree: argv.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(argv[i - 1] ?? '')),
    eventsArg: opt(argv, '--events'),
    agentArg: opt(argv, '--agent'),
    dump: argv.includes('--dump'),
  };
  if ([cli.worktree, cli.eventsArg, cli.agentArg].every(a => a === undefined)) {
    console.error(
      'usage: main.ts <worktree> [--dump] [--impl legacy|acp] [--events <path>] [--agent <id>]'
    );
    process.exit(2);
  }
  return cli;
}

/** The pane env gate — the viewer only lives under herdr supervision:
 *  HERDR_ENV=1 plus the pane's report id; a bare exec is a no-op. */
const supervisedPaneId = (): string | undefined => {
  if (process.env.HERDR_ENV !== '1') return undefined;
  const id = process.env.HERDR_PANE_ID;
  return id === undefined || id === '' ? undefined : id;
};

// --- dump mode -------------------------------------------------------------

/** `main.ts <worktree> --dump` — the headless readout. Prints the
 *  model's text projection of the archive tail and exits. */
async function dump(worktree: string, argv: string[]): Promise<void> {
  const eventsArg = opt(argv, '--events');
  const agentArg = opt(argv, '--agent');
  const base = gitCommonDir(worktree) ?? worktree;
  const state = readState(fleetStatusPath(base, worktree));
  const target = resolveTarget(state, worktree, providers(worktree));
  // `--agent` may carry the registry run key while the journal sits
  // on the entry's archive stem — resolve the path through its log,
  // the same lookup the live pane does
  const entry = agentEntry(base, agentArg);
  const eventsPath =
    eventsArg ??
    (agentArg !== undefined ? eventsFile(base, logStem(entry) ?? agentArg) : undefined) ??
    target?.events;
  // the dump's unflagged impl is `legacy` — the zero-extra-dep read
  // (the pane's acp default is an explicit `--impl`/`BRO_TUI_IMPL`
  // override away)
  const impl = await pickImpl(implArg(argv), process.env, 'legacy');
  impl.setContext?.({ worktree, agent: agentArg ?? sessionAgentOf(target) });
  if (eventsPath !== undefined) {
    const tail = tailArchive(eventsPath);
    if (tail !== undefined) feedArchive(impl, eventsPath, tail.rows);
    impl.beginLive();
  }
  for (const line of impl.dump()) process.stdout.write(`${line}\n`);
}

// --- the direct bind ---------------------------------------------------------

/** The LED worker floor with its reason stamped — a blocked worker
 *  reports WHEN it exited (the journal's last write), an idle one
 *  when it went quiet; the verdict reads the message as its mode.
 *  working/unknown carry no timestamp — the archive's own verdict
 *  rides on top via eventsVerdict. */
const UNSTAMPED: ReadonlySet<string> = new Set(['working', 'unknown']);
function workerFloorLed(entry: ReturnType<typeof agentEntry>, events: string | undefined): PaneLed {
  const state = workerLedState(entry, events);
  if (events === undefined || UNSTAMPED.has(state)) return { state };
  try {
    const when = fmtWhen(statSync(events).mtimeMs);
    return { state, message: state === 'blocked' ? `exited ${when}` : `quiet since ${when}` };
  } catch {
    return { state };
  }
}

/** The archive stem a `--events` journal names its worker by. */
const eventsStem = (eventsPath: string): string =>
  basename(eventsPath).replace(/\.events\.jsonl$/, '');

/** The id the registry resolves — `--agent` first; a journal-only
 *  bind (`--events` alone) still names its worker by the file's own
 *  stem, or a provable crash reads 'unknown' forever. */
const entryIdOf = (cli: TuiCli): string | undefined =>
  cli.agentArg ?? (cli.eventsArg === undefined ? undefined : eventsStem(cli.eventsArg));

/** The registry home: the worktree's git common dir first. A
 *  worktree-less direct bind leaves ctxDir at the pane's scratch cwd —
 *  the journal's own <git-common>/bro/agents/ location is the next
 *  source, or the floor reads 'unknown' and a stale journal glows
 *  working. */
const registryBase = (ctxDir: string, eventsArg: string | undefined): string =>
  gitCommonDir(ctxDir) ??
  (eventsArg === undefined ? undefined : registryHomeOf(eventsArg)) ??
  ctxDir;

/** The journal's path resolved through the matched entry's log stem
 *  (a registry run key like `bro-2bv6q` never becomes the filename;
 *  the archive lives on the native stem) — a FUNCTION, not a const:
 *  a bind made before the registry harvest lands must heal on the
 *  next refresh, not keep stating a key-named file that never exists
 *  (the floor reads 'idle' and the watch never fires). A bare live
 *  pid still never stands in for a journal the floor cannot read. */
const eventsPathOf = (cli: TuiCli, base: string, entryId: string | undefined) =>
  cli.eventsArg ??
  (cli.agentArg === undefined
    ? undefined
    : eventsFile(base, logStem(agentEntry(base, entryId)) ?? cli.agentArg));

/** The direct SessionTarget a resolved bind carries — undefined when
 *  neither --events nor --agent named anything and the fleet doc must
 *  drive instead. */
function directTarget(cli: TuiCli, bind: DirectBind): SessionTarget | undefined {
  const resolved = eventsPathOf(cli, bind.base, bind.entryId);
  if (resolved === undefined && cli.agentArg === undefined) return undefined;
  return {
    worktree: bind.worktree,
    status: 'live',
    ...(resolved === undefined ? {} : { events: resolved }),
    agent: bind.agent,
    slug: cli.agentArg,
    workerLed: workerFloorLed(agentEntry(bind.base, bind.entryId), resolved),
  };
}

/** Direct resolution (addendum 17): `--events`/`--agent` point the
 *  viewer at the archive itself — no fleet-status doc involved
 *  (janitor-reaped files were the "waiting for projector" bug). The
 *  bind carries the probes refresh() re-runs every poll: a respawn
 *  swaps the registry record, and probing a stale entry's pid reads
 *  'blocked' on a live worker — the display name and the journal path
 *  heal on the same pass once the record lands. */
interface DirectBind {
  /** The worktree context — the positional arg or the pane's scratch cwd. */
  ctxDir: string;
  /** The registry home: the worktree's git common dir first. A
   *  worktree-less direct bind leaves ctxDir at the pane's scratch cwd —
   *  the journal's own <git-common>/bro/agents/ location is the next
   *  source, or the floor reads 'unknown' and a stale journal glows
   *  working. */
  base: string;
  /** The entry's worktree or the ctx fallback. */
  worktree: string;
  /** The display agent — the true agent name (provider), resolved in
   *  the kit next to agentKey/agentEntry. Re-probed in reprobe(): a
   *  late-landing registry record heals the cryptic archive stem the
   *  first pass had to print. */
  agent?: string;
  /** The entry id the registry resolves (agent arg or journal stem). */
  entryId?: string;
  /** The direct target — undefined when neither --events nor --agent
   *  resolved anything and the fleet doc must drive. */
  target?: SessionTarget;
  /** Re-read the registry and re-probe the worker floor / journal path
   *  / display name. A crash mid-turn leaves the model 'running'
   *  forever; only the fresh pid check reads 'blocked' instead of
   *  lying working (dogfood finding — a crashed agent's pane glowed
   *  working while its pid was gone). */
  reprobe(): void;
}

function bindDirect(cli: TuiCli): DirectBind {
  const ctxDir = cli.worktree ?? process.cwd();
  const base = registryBase(ctxDir, cli.eventsArg);
  const entryId = entryIdOf(cli);
  const bind: DirectBind = {
    ctxDir,
    base,
    entryId,
    worktree: agentEntry(base, entryId)?.worktree ?? ctxDir,
    agent: displayAgentOf(base, cli.agentArg ?? entryId),
    reprobe() {
      if (bind.target === undefined) return;
      const events = eventsPathOf(cli, base, entryId);
      bind.target.workerLed = workerFloorLed(agentEntry(base, entryId), events);
      if (events !== bind.target.events) bind.target.events = events;
      bind.target.agent = displayAgentOf(base, cli.agentArg ?? entryId);
    },
  };
  bind.target = directTarget(cli, bind);
  return bind;
}

// --- the feed: archive tail → model → tree -----------------------------------

/** One armed archive tail — replay the window, then ride appends via
 *  fs.watch (+ the poll covers misses). */
interface Feed {
  /** The armed attach identity, or undefined with nothing armed. */
  readonly key?: string;
  /** One pump of the archive tail — feed the model only; the tree
   *  commit rides the FLUSH_MS drain so token-wise chunks don't
   *  re-render per event. */
  pump(): void;
  /** Arm the tail on a resolved target. */
  arm(t: SessionTarget): void;
  /** Close the watcher and drop the binding. */
  detach(): void;
}

function createFeed(getImpl: () => PaneImpl): Feed {
  let cur:
    | {
        key: string;
        eventsPath?: string;
        offset: number;
        watcher?: FSWatcher;
        seeded?: boolean;
      }
    | undefined;

  const pump = (): void => {
    if (cur?.eventsPath === undefined) return;
    const more = readTailSlice(cur.eventsPath, cur.offset);
    if (more === undefined) return;
    const end = completePart(more.buf);
    if (end === 0) return;
    cur.offset += end;
    const rows = parseArchiveRows(more.buf.subarray(0, end).toString('utf8'));
    // a session born after the pane: the first landed slice carries
    // the same prompt-sidecar fallback the arm-time replay does
    if (cur.seeded !== true) {
      cur.seeded = true;
      feedArchive(getImpl(), cur.eventsPath, rows);
      return;
    }
    for (const row of rows) getImpl().feed(row);
  };

  const arm = (t: SessionTarget): void => {
    const path = t.events;
    cur = { key: targetKey(t), eventsPath: path, offset: 0 };
    if (path === undefined) return;
    // A window of pure `update` rows attaches to items born outside
    // it — an update storm for one tool call can fill the whole tail
    // and drain zero items. Widen 64KB → 4MB → whole file until a
    // creating row enters the slice. Parse per candidate but feed ONCE
    // — update rows are not idempotent under a re-feed.
    let rows: ArchiveRow[] | undefined;
    for (const win of [TAIL_BYTES, 4 * 1024 * 1024, 0]) {
      const tail = tailArchive(path, win);
      if (tail === undefined) break;
      cur.offset = tail.offset;
      rows = tail.rows;
      if (win === 0 || rows.some(r => r.kind !== 'update')) break;
    }
    if (rows !== undefined) {
      cur.seeded = true;
      feedArchive(getImpl(), path, rows);
    }
    // the tail window is replayed history; appends after this are the
    // live tail — the impl's replay/live boundary
    getImpl().beginLive();
    try {
      cur.watcher = watch(path, () => pump());
    } catch {
      // a vanished archive just stays put — the poll still rides
    }
  };

  return {
    get key() {
      return cur?.key;
    },
    pump,
    arm,
    detach() {
      cur?.watcher?.close();
      cur = undefined;
    },
  };
}

/** A target with nothing the feed can ride — no archive, no session
 *  log, no acp leg. */
const noFeedSource = (t: SessionTarget): boolean =>
  t.events === undefined && t.session === undefined && t.log === undefined;

/** The LED verdict — the model's verdict over the worker floor. */
function paneVerdict(
  target: SessionTarget | undefined,
  armed: boolean,
  rowV: PaneImpl['verdict']
): { led: PaneLed; mode: string } {
  if (target === undefined) {
    return { led: { state: 'unknown' }, mode: 'waiting for projector' };
  }
  if (!armed) {
    return noFeedSource(target)
      ? // nothing armed and nothing to arm — the impl never leaves
        // 'replaying' on its own and the LED would lie 'working'
        // forever on an empty tree
        { led: target.workerLed, mode: 'no session recorded' }
      : // a feed exists this shell cannot ride (log/acp legs) — report
        // the worker posture, not a phantom 'replaying'
        eventsVerdict(target.workerLed, undefined);
  }
  return eventsVerdict(target.workerLed, rowV);
}

/** The LED — model verdict over the worker floor, deduped by
 *  state|mode|agent like session-view; every real move also lands
 *  on the header bar's chip. */
function createReporter(
  getImpl: () => PaneImpl,
  pane: ServedPane['pane'],
  paneId: string
): (target: SessionTarget | undefined, armed: boolean) => void {
  let lastReport = '';
  return (target, armed) => {
    const impl = getImpl();
    const v = paneVerdict(target, armed, impl.verdict);
    const agent = sessionAgentOf(target);
    const mark = `${v.led.state}|${v.mode}|${agent}`;
    if (mark === lastReport) return;
    lastReport = mark;
    paneReport(paneId, agent, v.led, v.mode, SESSION_IDENTITY);
    impl.setContext?.({ agent });
    pane.writer.setMeta({ agent, led: v.led.state, mode: v.mode });
  };
}

// --- the TUI ---------------------------------------------------------------

/** The copy gesture's text — the impl's own copyText when it has one,
 *  the item's text slot otherwise. */
const copyTextOf = (impl: PaneImpl) => {
  return (it: Parameters<NonNullable<PaneImpl['copyText']>>[0]): string =>
    impl.copyText?.(it) ?? ('text' in it ? it.text : '');
};

export async function runTui(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  if (cli.dump) {
    await dump(cli.worktree ?? process.cwd(), argv);
    return;
  }
  const paneId = supervisedPaneId();
  if (paneId === undefined) return;

  const bind = bindDirect(cli);
  const statePath = fleetStatusPath(bind.base, bind.ctxDir);
  mkdirSync(dirname(statePath), { recursive: true });

  let impl = await pickImpl(implArg(argv));
  impl.setContext?.({ worktree: bind.worktree, agent: bind.agent });

  // the shell — renderer + JSX preload + mount + keymap — is
  // @broject/acp-tui's serve(); this process stays glue: target
  // resolution, feed, report
  const { pane } = await serve({
    meta: { worktree: bind.worktree },
    foldAll: impl.fold === 'folded',
    copyItem: item => copyTextOf(impl)(item),
    // no onRetire — the feed lives ENTIRELY in the scrollbox as
    // renderables: every row keeps markdown/color/expand chrome, and
    // scrolling is the scrollbox's scrollTop, not captured stdout.
    copy: sysCopy,
  });

  const feed = createFeed(() => impl);
  const report = createReporter(() => impl, pane, paneId);
  let refreshing = false;

  /** The resolution poll pass — read the doc, re-arm the feed when
   *  the attach identity moves, report the verdict. */
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      bind.reprobe();
      const target =
        bind.target ?? resolveTarget(readState(statePath), bind.ctxDir, providers(bind.ctxDir));
      if (targetKey(target) !== feed.key) {
        feed.detach();
        // A feed and its implementation are one session binding. Keeping
        // either across an attach move leaks the previous agent's model.
        impl = await pickImpl(implArg(argv));
        const agent = sessionAgentOf(target);
        impl.setContext?.({ worktree: bind.worktree, agent });
        pane.writer.reset({ worktree: bind.worktree, agent }, impl.fold === 'folded');
        if (target !== undefined) feed.arm(target);
      }
      report(target, feed.key !== undefined && target?.events !== undefined);
    } finally {
      refreshing = false;
    }
  };

  process.on('exit', () => paneRelease(paneId, SESSION_IDENTITY));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(0));
  }

  try {
    watch(dirname(statePath), () => void refresh().catch(console.error));
  } catch {
    // the poll alone still rides
  }

  await refresh();
  setInterval(() => {
    feed.pump();
    void refresh().catch(console.error);
  }, POLL_MS);
  // the tree commit — opencode's delta-buffer cadence
  setInterval(() => pane.writer.apply(impl.drain()), FLUSH_MS);

  // the intervals keep the loop alive; this promise just holds the fn
  await new Promise(() => {});
}

await runTui(process.argv.slice(2));

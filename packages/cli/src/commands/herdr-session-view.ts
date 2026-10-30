/**
 * `bro herdr session-view <worktree>` — the `bro: session` pane's
 * foreground process (spec bro-nwl5g). Renders the bro-managed agent's
 * conversation for one worktree: when the fleet-state file names a
 * provider whose `providers.<name>` entry is `type === 'acp'` AND
 * carries a command, the pane spawns that command, attaches the
 * recorded `acpSessionId` via `session/load`, and renders the replayed
 * — then live — `session/update` stream through AcpRenderer. Anything
 * else (non-acp provider, missing session/command, absent loadSession
 * capability, attach or transport failure) falls back to tailing the
 * session-owning agent's native log — the compact event stream the
 * acp-worker writes.
 *
 * Readonly by construction: the attach advertises no served client
 * capability, permission asks are auto-denied, and the pane never
 * prompts. Lifecycle mirrors status-view — `bro:fleet` /
 * `bro-session` report authority held while occupied, two-call
 * metadata, release on every exit, dedup on real moves only.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { gitCommonDir, type ProviderEntry } from '@broject/core';
import type {
  AcpRenderer as AcpRendererT,
  AcpSessionViewResult,
  AcpSessionViewSpec,
  SessionUpdateLike,
} from '@broject/providers';
import {
  type FleetPaneState,
  fleetStatusPath,
  nextSeq,
  type PaneLed,
  parseFleetState,
} from './fleet-state.ts';
import { PANE_SOURCE, plain } from './herdr-status-view.ts';
import { loadBroConfig } from '../plugins.ts';

export const SESSION_PANE_AGENT = 'bro-session';

/** Milliseconds — every herdr call is fire-and-forget behind a short
 *  fuse; a wedged socket must not freeze the view. */
const HERDR_TIMEOUT_MS = 5_000;

const herdrBin = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';

function call(args: string[]): void {
  try {
    spawnSync(herdrBin(), args, { timeout: HERDR_TIMEOUT_MS, stdio: 'ignore' });
  } catch {
    // every report is advisory — a dead socket retires to the watch loop
  }
}

/** The shared report/release/metadata envelope — `bro:fleet` source,
 *  `bro-session` agent (a distinct identity from `bro-status`: a
 *  recycled pane id must fail the status backstop's foreign check). */
function paneArgs(verb: string, pane: string, seq: number): string[] {
  return [
    'pane',
    verb,
    pane,
    '--source',
    PANE_SOURCE,
    '--agent',
    SESSION_PANE_AGENT,
    '--seq',
    String(seq),
  ];
}

/** The report-agent argv for one semantic state. */
export function sessionReportArgs(pane: string, led: PaneLed, seq: number): string[] {
  const args = [...paneArgs('report-agent', pane, seq), '--state', led.state];
  if (led.message !== undefined && led.message !== '') {
    args.push('--message', led.message);
  }
  return args;
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function sessionReleaseArgs(pane: string, seq: number): string[] {
  return paneArgs('release-agent', pane, seq);
}

// --- resolution -----------------------------------------------------------------

/** What one refresh resolves — the attach identity plus the display
 *  fields the report carries. `session` present means an ACP attach
 *  is attempted; absent, `log` tails. */
/** The resolved acp attach — only when provider type==='acp' and a
 *  session id exists. */
export interface SessionSpec {
  id: string;
  command: string;
  provider?: string;
  model?: string;
}

export interface SessionTarget {
  worktree: string;
  /** Display driver name (`agent` field — binary, not provider). */
  agent?: string;
  slug?: string;
  title?: string;
  status: string;
  /** The worker verdict — log-mode LED + label input. */
  workerLed: PaneLed;
  session?: SessionSpec;
  /** The fallback stream — the session-owning agent's native log. */
  log?: string;
}

/** The attach dedup key — a new key re-arms the view; identical keys
 *  never re-spawn (a churned state file can't fork acp children). */
export function targetKey(t: SessionTarget | undefined): string {
  if (t === undefined) return 'waiting';
  if (t.session !== undefined) return `acp|${t.session.command}|${t.session.id}`;
  if (t.log !== undefined) return `log|${t.log}`;
  return 'none';
}

/** The acp attach spec one state doc resolves to — only when the
 *  provider entry exists, carries `type === 'acp'`, and the doc names
 *  a session id. Everything else resolves to no session at all. */
function sessionSpecOf(
  s: FleetPaneState,
  providers: Record<string, ProviderEntry>
): SessionSpec | undefined {
  const entry = s.provider !== undefined ? providers[s.provider] : undefined;
  if (entry === undefined || entry.type !== 'acp' || s.acpSessionId === undefined) {
    return undefined;
  }
  return {
    id: s.acpSessionId,
    command: entry.command,
    ...(s.provider !== undefined ? { provider: s.provider } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
  };
}

export function resolveTarget(
  s: FleetPaneState | undefined,
  worktree: string,
  providers: Record<string, ProviderEntry>
): SessionTarget | undefined {
  if (s === undefined) return undefined;
  const session = sessionSpecOf(s, providers);
  return {
    worktree,
    ...(s.agent !== undefined ? { agent: s.agent } : {}),
    ...(s.slug !== undefined ? { slug: s.slug } : {}),
    title: s.title,
    status: s.status,
    workerLed: s.led,
    ...(session !== undefined ? { session } : {}),
    ...(s.log !== undefined ? { log: s.log } : {}),
  };
}

/** The pane's own semantic verdict — the LED answers "is this pane
 *  following a live feed": a live acp attach or a live worker's log is
 *  working; a recorded log or an ended attach is idle; nothing to
 *  show (or no state file) is unknown. `mode` is the label detail. */
export interface ViewVerdict {
  led: PaneLed;
  mode: string;
}

/** The attach's current posture — what the refresh reports and what a
 *  resolution move re-arms. */
interface AttachState {
  /** 'acp' once a session target resolved; 'log' when the fallback
   *  runs (from the start or after a failed attach); 'none' when the
   *  tree carries nothing to show. */
  mode: 'acp' | 'log' | 'none';
  /** acp leg: 'connecting' through the handshake, 'live' after
   *  session/load resolved, 'ended' once the transport died or the
   *  attach fell back to the log. */
  acp: 'none' | 'connecting' | 'live' | 'ended';
}

export function viewVerdict(t: SessionTarget | undefined, a: AttachState): ViewVerdict {
  if (t === undefined) return { led: { state: 'unknown' }, mode: 'waiting for projector' };
  if (a.mode === 'acp') {
    if (a.acp === 'ended') return { led: { state: 'idle' }, mode: 'session ended' };
    if (a.acp === 'live') return { led: { state: 'working' }, mode: 'session/load' };
    return { led: { state: 'working' }, mode: 'attaching' };
  }
  if (a.mode === 'log') {
    return {
      led: { state: t.workerLed.state === 'working' ? 'working' : 'idle' },
      mode: 'log tail',
    };
  }
  return { led: { state: 'unknown' }, mode: 'no session' };
}

/** The display-text argvs — same two-call contract status-view
 *  carries: call 1 clears, call 2 lands display-agent + state-label
 *  (herdr rejects set-and-clear in one call). */
export function sessionMetaArgs(
  pane: string,
  t: SessionTarget | undefined,
  v: ViewVerdict,
  seq: number
): string[][] {
  const calls = [[...paneArgs('report-metadata', pane, seq), '--clear-state-labels']];
  const set = [
    ...paneArgs('report-metadata', pane, seq + 1),
    '--display-agent',
    plain(t?.agent ?? t?.session?.provider ?? t?.slug ?? 'session'),
    '--state-label',
    `${v.led.state}=${plain(v.mode)}`,
  ];
  calls.push(set);
  return calls;
}

// --- the view -------------------------------------------------------------------

/** The open-tail cap — a dead session's log can run to megabytes; the
 *  pane scrolls back through the last chunk, not the corpus. */
const LOG_TAIL_BYTES = 64 * 1024;

/** statSync().size or 0 — the tail math's floor. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A chunk of the native log — from byte `from` to EOF. */
function readLogSlice(path: string, from: number): { text: string; size: number } | undefined {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const start = Math.min(Math.max(0, from), size);
    const len = size - start;
    if (len === 0) return { text: '', size };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), size };
  } finally {
    closeSync(fd);
  }
}

interface Attach extends AttachState {
  /** The target key this attach serves — a refresh with the same key
   *  never re-arms. */
  key: string;
  ac?: AbortController;
  watcher?: FSWatcher;
  /** The log tail's path + read offset — appends render from here. */
  logPath?: string;
  logOffset?: number;
  /** One-shot: resolves when the acp handshake reports (attached or
   *  failed) — `--once` waits on it instead of the open attach. */
  handshake: Promise<unknown>;
  markHandshake: (v: unknown) => void;
}

/** Everything one live view needs — resolved once at start. */
interface ViewCtx {
  worktree: string;
  pane: string;
  statePath: string;
  once: boolean;
}

/** Arg + environment resolution — `undefined` means "outside herdr,
 *  do nothing"; a missing worktree arg is the only usage error. */
function viewContext(argv: string[]): ViewCtx | undefined {
  const worktree = argv.find(a => !a.startsWith('-'));
  if (worktree === undefined) {
    console.error('usage: bro herdr session-view <worktree> [--once]');
    process.exit(2);
  }
  if (process.env.HERDR_ENV !== '1') return undefined;
  const pane = process.env.HERDR_PANE_ID;
  if (pane === undefined || pane === '') return undefined;
  const base = gitCommonDir(worktree) ?? worktree;
  return {
    worktree,
    pane,
    statePath: fleetStatusPath(base, worktree),
    once: argv.includes('--once'),
  };
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Render seam for tests — the pane's default is stdout; a test feeds
 *  a capture instead of patching the stream the TAP reporter rides. */
export interface SessionViewOpts {
  out?: (line: string) => void;
}

/** `bro herdr session-view <worktree> [--once]` — the pane's whole
 *  lifecycle: bind, resolve the session target, attach or tail, ride
 *  file moves, release on exit. */
export async function runSessionView(argv: string[], opts: SessionViewOpts = {}): Promise<void> {
  const ctx = viewContext(argv);
  if (ctx === undefined) return;
  mkdirSync(dirname(ctx.statePath), { recursive: true });

  const out =
    opts.out ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  /** A dim status/banner line — always plain()'d: banners, notes and
   *  stderr mirrors carry provider-controlled text. */
  const dim = (line: string): void => {
    out(`\u001b[2m${plain(line)}\u001b[0m`);
  };
  // lazy — the SDK+providers import only pays when an acp target
  // resolves; a log-tail pane never loads the protocol stack
  let renderer: AcpRendererT | undefined;
  const providers = (): Record<string, ProviderEntry> => {
    try {
      return loadBroConfig(ctx.worktree).providers ?? {};
    } catch {
      return {};
    }
  };

  let cur: Attach | undefined;
  const detach = (): void => {
    cur?.ac?.abort();
    cur?.watcher?.close();
    cur = undefined;
  };
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    detach();
    call(sessionReleaseArgs(ctx.pane, nextSeq()));
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(0));
  }

  let lastReport = '';
  const report = (t: SessionTarget | undefined, v: ViewVerdict): void => {
    const mark = `${v.led.state}|${v.mode}`;
    if (mark === lastReport) return;
    lastReport = mark;
    const seq = nextSeq();
    call(sessionReportArgs(ctx.pane, v.led, seq));
    for (const a of sessionMetaArgs(ctx.pane, t, v, seq)) call(a);
  };

  /** One pump of the log tail — render whatever appended since the
   *  last read. Shared by the fs.watch handler and the refresh poll. */
  const pumpLog = (a: Attach): void => {
    if (a.logPath === undefined) return;
    const more = readLogSlice(a.logPath, a.logOffset ?? 0);
    if (more === undefined) return;
    a.logOffset = more.size;
    for (const line of more.text.split('\n')) {
      if (line !== '') out(plain(line));
    }
  };

  /** The fallback leg — print the log's tail, then ride appends. An
   *  unreadable log still records the path: the file may appear. */
  const tailLog = (a: Attach, path: string): void => {
    a.mode = 'log';
    a.logPath = path;
    const from = Math.max(0, sizeOf(path) - LOG_TAIL_BYTES);
    const slice = readLogSlice(path, from);
    if (slice === undefined) {
      dim(`── log tail ${path} — unreadable ──`);
      return;
    }
    a.logOffset = slice.size;
    // a mid-file read starts inside a line — drop the partial head
    const start = from > 0 ? slice.text.indexOf('\n') + 1 : 0;
    for (const line of slice.text.slice(start).split('\n')) {
      if (line !== '') out(plain(line));
    }
    try {
      a.watcher = watch(path, () => pumpLog(a));
    } catch {
      // a vanished log just stays put — the refresh poll still rides
    }
  };

  /** The acp leg's verdict landing — fallback to the log (or a bare
   *  reason line) plus a re-report, since the attach's posture moved
   *  even when the target key didn't. `reason === undefined` means the
   *  attach ended cleanly after being live: the renderer prints the
   *  close marker, no fallback. */
  const acpDone = (a: Attach, t: SessionTarget, reason: string, attached: boolean): void => {
    a.acp = 'ended';
    if (!attached) {
      if (t.log !== undefined) {
        dim(`── ${reason} — tailing the native log ──`);
        tailLog(a, t.log);
      } else {
        dim(`── ${reason} ──`);
      }
    } else {
      renderer?.closed(reason);
    }
    lastReport = '';
    report(t, viewVerdict(t, a));
  };

  /** The spawned leg — import, spec, run. Split from `arm` so the
   *  dispatch stays a flat read; a stale generation checks `cur`. */
  const acpAttach = async (
    a: Attach,
    session: SessionSpec,
    t: SessionTarget,
    signal: AbortSignal
  ): Promise<AcpSessionViewResult | undefined> => {
    const { AcpRenderer, runAcpSessionView } = await import('@broject/providers');
    if (cur !== a) return undefined;
    renderer ??= new AcpRenderer(out);
    const r = renderer;
    const spec: AcpSessionViewSpec = {
      command: session.command,
      sessionId: session.id,
      cwd: ctx.worktree,
      ...(session.provider !== undefined ? { provider: session.provider } : {}),
      update: u => r.update(u as SessionUpdateLike),
      note: dim,
      err: text => {
        for (const line of text.split('\n')) {
          if (line.trim() !== '') dim(`‹stderr› ${line.slice(0, 200)}`);
        }
      },
      permission: pctx => ({ outcome: r.permission(pctx.params, 'none') }),
      attached: () => {
        if (cur === a) {
          a.acp = 'live';
          a.markHandshake('live');
          // 'attaching' → 'session/load' without waiting on the poll
          lastReport = '';
          report(t, viewVerdict(t, a));
        }
      },
      signal,
    };
    return runAcpSessionView(spec);
  };

  /** One attach generation — identity-checked so a stale handshake
   *  or a re-resolve mid-flight can't double-render into the pane. */
  const arm = (t: SessionTarget): void => {
    detach();
    let markHandshake!: (v: unknown) => void;
    const handshake = new Promise<unknown>(r => {
      markHandshake = r;
    });
    const a: Attach = {
      key: targetKey(t),
      mode: 'none',
      acp: 'none',
      handshake,
      markHandshake,
    };
    cur = a;
    const who = t.agent ?? t.session?.provider ?? 'session';
    const what = t.session !== undefined ? `${who} · ${t.session.id}` : who;
    const title = t.title === undefined || t.title === '' ? basename(ctx.worktree) : t.title;
    out(`── ${plain(what)} · ${plain(title)} ──`);
    if (t.session === undefined) {
      if (t.log !== undefined) {
        dim('── no acp session resolved — tailing the native log ──');
        tailLog(a, t.log);
      } else {
        dim('── no session recorded for this worktree ──');
      }
      a.markHandshake(null);
      return;
    }
    a.mode = 'acp';
    a.acp = 'connecting';
    const ac = new AbortController();
    a.ac = ac;
    const session = t.session;
    acpAttach(a, session, t, ac.signal).then(
      result => {
        a.markHandshake(result);
        if (cur !== a || result === undefined) return;
        acpDone(a, t, result.reason, result.attached);
      },
      (err: unknown) => {
        // a failed module import or a thrown spawn lands here — the
        // same fallback as a wire refusal
        a.markHandshake(err);
        if (cur !== a) return;
        acpDone(a, t, err instanceof Error ? err.message : String(err), false);
      }
    );
  };

  /** One refresh — file parse → target resolve → report + attach
   *  moves only when the resolution actually changed. */
  const refresh = (): void => {
    const raw = readRaw(ctx.statePath);
    const t = resolveTarget(
      raw === undefined ? undefined : parseFleetState(raw),
      ctx.worktree,
      providers()
    );
    const key = targetKey(t);
    if (cur === undefined || key !== cur.key) {
      if (t !== undefined) {
        arm(t);
      } else {
        detach();
        dim('── waiting for the daemon projector ──');
      }
    }
    report(t, viewVerdict(t, cur ?? { mode: 'none', acp: 'none' }));
    // a tailed log can grow without a state-file move — pump every poll
    if (cur !== undefined) pumpLog(cur);
  };

  refresh();
  if (ctx.once) {
    // --once drains one resolution: an acp attach gets a bounded
    // handshake window (replay lands inside it — a cold provider
    // spawn alone can burn most of it), then a beat for late
    // updates, then detaches; a log target renders its tail already
    if (cur?.acp === 'connecting') {
      await Promise.race([cur.handshake, sleep(20_000)]);
      await sleep(300);
    }
    detach();
    renderer?.end();
    release();
    return;
  }

  try {
    watch(dirname(ctx.statePath), (_e, name) => {
      if (name === basename(ctx.statePath)) refresh();
    });
  } catch {
    // the dir vanishes only with the whole repo — the poll still rides
  }
  setInterval(refresh, 30_000);
  await new Promise(() => {});
}

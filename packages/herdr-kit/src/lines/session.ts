/**
 * lines/session — the `bro: session` pane's lifecycle core (spec
 * bro-nwl5g → bro-l8wqu). Resolved target in, output lines out, LED
 * through the client envelope. Feed order: events archive (the acp
 * lane's live wire) → acp session/load attach → native log tail →
 * nothing. Readonly by construction.
 */
import { type FSWatcher, mkdirSync, readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  type ArchiveRow,
  PERMISSION_FALLBACK,
  parseArchiveRows,
  readTailSlice,
  rowVerdict,
  tailArchive,
  tailWindow,
} from '@broject/acp-session';
import type { ProviderEntry } from '@broject/core';
import type {
  AcpRenderer as AcpRendererT,
  AcpSessionViewResult,
  AcpSessionViewSpec,
  SessionUpdateLike,
} from '@broject/providers';
import {
  type PaneLed,
  release as paneRelease,
  report as paneReport,
  plain,
  SESSION_IDENTITY,
} from '../client/index.ts';
import {
  type AttachState,
  parseFleetState,
  resolveTarget,
  type SessionSpec,
  type SessionTarget,
  sessionAgentOf,
  targetKey,
  type ViewVerdict,
  viewVerdict,
} from '../fleet/index.ts';

/** Everything one live pane needs — resolved by the caller (argv/env
 *  checks live outside the kit). */
export interface SessionPaneCtx {
  worktree: string;
  pane: string;
  statePath: string;
  once: boolean;
}

// --- the view -------------------------------------------------------------------

interface Attach extends AttachState {
  /** The target key this attach serves — a refresh with the same key
   *  never re-arms. */
  key: string;
  ac?: AbortController;
  watcher?: FSWatcher;
  /** The log tail's path + read offset — appends render from here. */
  logPath?: string;
  logOffset?: number;
  /** The events tail's path + read offset — archive rows parse from
   *  here; shares the watcher/log pump plumbing. */
  eventsPath?: string;
  eventsOffset?: number;
  /** One-shot: resolves when the acp handshake reports (attached or
   *  failed) — `--once` waits on it instead of the open attach. */
  handshake: Promise<unknown>;
  markHandshake: (v: unknown) => void;
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Render + config seams — `out` feeds a capture in tests (default
 *  stdout); `providers` is the config read the cli wires (the kit
 *  never touches plugin config itself). */
export interface SessionPaneDeps {
  out?: (line: string) => void;
  providers: () => Record<string, ProviderEntry>;
}

/** One bound session pane's lifecycle — resolve the target, attach or
 *  tail, ride file moves, release on exit. The caller has already
 *  resolved ctx (worktree/pane/statePath/once) from argv + env. */
export async function runSessionPane(ctx: SessionPaneCtx, deps: SessionPaneDeps): Promise<void> {
  mkdirSync(dirname(ctx.statePath), { recursive: true });

  const out =
    deps.out ??
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
      return deps.providers();
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
    paneRelease(ctx.pane, SESSION_IDENTITY);
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
    paneReport(ctx.pane, sessionAgentOf(t), v.led, v.mode, SESSION_IDENTITY);
  };

  /** One pump of the log tail — render whatever appended since the
   *  last read. Shared by the fs.watch handler and the refresh poll. */
  const pumpLog = (a: Attach): void => {
    if (a.logPath === undefined) return;
    const more = readTailSlice(a.logPath, a.logOffset ?? 0);
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
    const window = tailWindow(path);
    if (window === undefined) {
      dim(`── log tail ${path} — unreadable ──`);
      return;
    }
    a.logOffset = window.offset;
    for (const line of window.text.split('\n')) {
      if (line !== '') out(plain(line));
    }
    try {
      a.watcher = watch(path, () => pumpLog(a));
    } catch {
      // a vanished log just stays put — the refresh poll still rides
    }
  };

  /** The archive's own LED — last row wins; the worker verdict is the
   *  floor only for 'blocked'. A verdict move re-reports, so a stop
   *  mid-poll doesn't wait on the next refresh. */
  const setRowLed = (a: Attach, led: PaneLed, mode: string, t: SessionTarget): void => {
    const before = viewVerdict(t, a);
    a.rowLed = led;
    a.rowMode = mode;
    const after = viewVerdict(t, a);
    if (`${before.led.state}|${before.mode}` !== `${after.led.state}|${after.mode}`) {
      lastReport = '';
      report(t, after);
    }
  };

  /** One parsed archive row — update rows feed the renderer verbatim;
   *  turn rows print the boundary; permission rows print the ask. The
   *  LED mapping is the shared verdict — the pane stays readonly:
   *  rows render, nothing answers back. */
  const eventRow = (a: Attach, row: ArchiveRow, t: SessionTarget): void => {
    switch (row.kind) {
      case 'update':
        if (row.update !== undefined) renderer?.update(row.update);
        break;
      case 'turn':
        if (row.phase === 'stop') {
          if (row.error !== undefined && row.error !== '') {
            dim(`── turn failed — ${row.error} ──`);
          } else {
            dim(
              `── turn complete${row.stopReason !== undefined && row.stopReason !== '' ? ` (${row.stopReason})` : ''} ──`
            );
          }
        }
        break;
      case 'permission': {
        const what = row.title ?? PERMISSION_FALLBACK;
        const verdict = row.verdict ?? 'denied';
        dim(
          `── ⚠ permission ‹${what}› — ${verdict} (headless driver; open a terminal in this workspace to handle interactively) ──`
        );
        break;
      }
      default:
        return;
    }
    const v = rowVerdict(row);
    if (v !== undefined) setRowLed(a, v.led, v.mode, t);
  };

  /** One pump of the events archive — parse whatever appended since
   *  the last read. Shared by the fs.watch handler and the refresh
   *  poll; a torn tail row (still being written) is dropped — the
   *  next complete read picks it up. */
  const pumpEvents = (a: Attach, t: SessionTarget): void => {
    if (a.eventsPath === undefined) return;
    const more = readTailSlice(a.eventsPath, a.eventsOffset ?? 0);
    if (more === undefined) return;
    a.eventsOffset = more.size;
    for (const row of parseArchiveRows(more.text)) {
      eventRow(a, row, t);
    }
  };

  /** The acp lane's leg — replay the archive's tail, then ride
   *  appends; rows render through AcpRenderer like the live wire. */
  const tailEvents = (a: Attach, t: SessionTarget, path: string): void => {
    a.mode = 'events';
    a.eventsPath = path;
    const tail = tailArchive(path);
    if (tail === undefined) {
      dim(`── session events ${path} — unreadable; waiting for the worker ──`);
      return;
    }
    a.eventsOffset = tail.offset;
    for (const row of tail.rows) {
      eventRow(a, row, t);
    }
    try {
      a.watcher = watch(path, () => pumpEvents(a, t));
    } catch {
      // a vanished archive just stays put — the refresh poll still rides
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

  /** The generation's header line — driver name (agent → provider),
   *  the session id when an attach is coming, and the worktree's
   *  title or basename. */
  const banner = (t: SessionTarget): void => {
    const who = t.agent ?? t.session?.provider ?? 'session';
    const what = t.session !== undefined ? `${who} · ${t.session.id}` : who;
    const title = t.title === undefined || t.title === '' ? basename(ctx.worktree) : t.title;
    out(`── ${plain(what)} · ${plain(title)} ──`);
  };

  /** The attach resolved — a clean end after live, or a refusal that
   *  falls back. A superseded generation reports nothing. */
  const acpSettled = (
    a: Attach,
    t: SessionTarget,
    result: AcpSessionViewResult | undefined
  ): void => {
    a.markHandshake(result);
    if (cur !== a || result === undefined) return;
    acpDone(a, t, result.reason, result.attached);
  };

  /** The leg threw — a failed module import or a thrown spawn lands
   *  here, the same fallback as a wire refusal. */
  const acpErrored = (a: Attach, t: SessionTarget, err: unknown): void => {
    a.markHandshake(err);
    if (cur !== a) return;
    acpDone(a, t, err instanceof Error ? err.message : String(err), false);
  };

  /** No acp target resolved — the log carries the conversation when
   *  the doc records one, a bare note otherwise. */
  const armFallback = (a: Attach, t: SessionTarget): void => {
    if (t.log !== undefined) {
      dim('── no acp session resolved — tailing the native log ──');
      tailLog(a, t.log);
    } else {
      dim('── no session recorded for this worktree ──');
    }
    a.markHandshake(null);
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
    banner(t);
    if (t.events !== undefined) {
      // the acp lane's leg — the renderer import is lazy like the
      // attach leg's; rows stay on disk so the async gap loses nothing
      a.mode = 'events';
      const events = t.events;
      void (async (): Promise<void> => {
        const { AcpRenderer } = await import('@broject/providers');
        if (cur !== a) return;
        renderer ??= new AcpRenderer(out);
        tailEvents(a, t, events);
        a.markHandshake('events');
      })().catch((err: unknown) => {
        a.markHandshake(err);
        if (cur !== a) return;
        dim(
          `── events feed failed (${err instanceof Error ? err.message : String(err)}) — ${
            t.log !== undefined ? 'tailing the native log' : 'no fallback stream'
          } ──`
        );
        if (t.log !== undefined) tailLog(a, t.log);
        lastReport = '';
        report(t, viewVerdict(t, a));
      });
      return;
    }
    if (t.session === undefined) {
      armFallback(a, t);
      return;
    }
    a.mode = 'acp';
    a.acp = 'connecting';
    const ac = new AbortController();
    a.ac = ac;
    const session = t.session;
    acpAttach(a, session, t, ac.signal).then(
      result => acpSettled(a, t, result),
      (err: unknown) => acpErrored(a, t, err)
    );
  };

  /** `bro: status` folds in — the projector's status string prints as
   *  a dim transition line whenever it changes (spec bro-l8wqu). */
  let lastStatus = '';
  const foldStatus = (t: SessionTarget | undefined): void => {
    if (t === undefined || t.status === lastStatus) return;
    lastStatus = t.status;
    if (t.status !== '') dim(`── ${t.status} ──`);
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
    foldStatus(t);
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
    // tailed streams can grow without a state-file move — pump every poll
    if (cur !== undefined && t !== undefined) {
      pumpLog(cur);
      pumpEvents(cur, t);
    }
  };

  refresh();
  if (ctx.once) {
    // --once drains one resolution: every leg gets a bounded
    // handshake window (an acp attach's replay lands inside it — a
    // cold provider spawn alone can burn most of it; the events
    // leg's lazy renderer import resolves the same latch), then a
    // beat for late updates, then detaches
    if (cur !== undefined) {
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

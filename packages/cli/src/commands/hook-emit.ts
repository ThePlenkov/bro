/** Adapter-side spool emission — the Node half of the Tier-0 writer for
 *  hosts that bypass hooks/run.sh (specs/bro-izpyk.9.md).
 *
 *  The in-process adapters (opencode/kilo/pi/omp) spawn
 *  `bro hooks <event>` directly and stamp `BRO_HOOK_HOST` on the env.
 *  When a registered `SessionPlane`'s `detectHook` claims the launch,
 *  `bro hooks` writes the same v2 start/end pair run.sh would have —
 *  same file, same wire format, same drain. run.sh hosts produce no
 *  marker, so their path is untouched (one registry scan of four
 *  planes).
 *
 *  pid/ppid mirror run.sh's $$/$PPID exactly: the hooks process is the
 *  launcher's pid, its parent the plugin host — a host kill leaves a
 *  start with no end, which the worker's existing killed synthesis
 *  turns into the "firing but killed" signal. */
import {
  appendHookSpoolRows,
  normalizeHookPayload,
  resolveHookSpoolPath,
  sessionPlanes,
  type SpoolOutcome,
  type SpoolRow,
} from '@broject/core';
// side effect: registers the opencode/kilo/pi/omp hook planes
import '../session-planes/adapters.ts';

/** A started launch — `mark` names the outcome before `end` writes it;
 *  the end row is write-once so the finally fallback and an explicit
 *  early outcome never produce two ends. */
export interface HookEmit {
  mark(outcome: SpoolOutcome): void;
  end(outcome?: SpoolOutcome): void;
}

const NOOP_EMIT: HookEmit = {
  mark: () => {},
  end: () => {},
};

/** run.sh's launcher taxonomy, verbatim — agent | herdr | tmux | zellij
 *  | screen | ssh | interactive, env-only. The adapter's spawn env is
 *  the host's own env, so the answer matches what run.sh would have
 *  written for a session in the same terminal. */
function spoolLauncher(env: NodeJS.ProcessEnv): string {
  if (env.BRO_AGENT_ID !== undefined && env.BRO_AGENT_ID !== '') {
    return 'agent';
  }
  if (env.HERDR_ENV === '1' || env.HERDR_PANE_ID !== undefined) {
    return 'herdr';
  }
  if (env.TMUX !== undefined) {
    return 'tmux';
  }
  if (env.ZELLIJ !== undefined) {
    return 'zellij';
  }
  if (env.STY !== undefined) {
    return 'screen';
  }
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) {
    return 'ssh';
  }
  return 'interactive';
}

const emptyUndef = (v: string | undefined): string | undefined =>
  v === undefined || v === '' ? undefined : v;

/** Open a launch when this `bro hooks` invocation is an in-process
 *  adapter's direct call — i.e. a registered plane's `detectHook`
 *  matches the env. The start row is written eagerly; the returned
 *  handle's `end` pairs it (the caller wraps dispatch in try/finally).
 *  No-op handle when: no plane claims the launch, spooling is disabled,
 *  or `BRO_HOOKS=0` would have exited run.sh before journaling
 *  (everything but `permission`). */
export function adapterEmitBegin(
  event: string,
  raw: unknown,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): HookEmit {
  if (env.BRO_HOOKS === '0' && event !== 'permission') {
    return NOOP_EMIT;
  }
  const plane = sessionPlanes().find(p => p.detectHook?.(env) === true);
  if (plane === undefined) {
    return NOOP_EMIT;
  }
  if (resolveHookSpoolPath(env) === null) {
    return NOOP_EMIT;
  }
  // the plane's normalizeHook is the host's own claim of identity; the
  // canonical input.session_id is the fallback — every adapter sends it
  const norm = plane.normalizeHook?.(raw) ?? normalizeHookPayload(raw);
  const t0 = Math.floor(Date.now() / 1000);
  const base = {
    version: 2 as const,
    id: `${process.pid}-${t0}`,
    host: plane.kind,
    sid: norm.sid ?? (sessionId === '' ? undefined : sessionId),
    event,
    pid: process.pid,
    ppid: process.ppid,
    agent: emptyUndef(env.BRO_AGENT_ID),
    adapter: emptyUndef(env.BRO_HOOK_ADAPTER),
    pluginRoot: emptyUndef(env.BRO_HOOK_PROOT),
    launcher: spoolLauncher(env),
    cwd: process.cwd(),
  };
  appendHookSpoolRows([{ ...base, ts: t0, phase: 'start' }], env);
  let outcome: SpoolOutcome = 'ok';
  let ended = false;
  return {
    mark(o) {
      outcome = o;
    },
    end(o) {
      if (ended) {
        return;
      }
      ended = true;
      const row: SpoolRow = {
        ...base,
        ts: Math.floor(Date.now() / 1000),
        phase: 'end',
        rc: 0,
        outcome: o ?? outcome,
      };
      appendHookSpoolRows([row], env);
    },
  };
}

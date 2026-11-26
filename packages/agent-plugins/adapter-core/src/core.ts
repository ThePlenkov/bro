/**
 * bro's host-agnostic adapter core.
 *
 * Every bro client adapter (pi, omp, opencode, kilo) answers the same
 * three questions: where is the bro CLI, how do I ask it something, and
 * what did it say. That is this module — and only this module. The
 * per-client files carry the *host* half: which events exist, how a
 * context string reaches the model, how a stop is refused, which tool
 * and command to register.
 *
 * The split exists so the duplication cannot come back. The CLI ladder,
 * the spawn-and-parse protocol and the board rendering were three
 * near-verbatim copies of the same 120 lines; they live here once.
 *
 * Two constraints shape the code:
 *
 *   - **Self-contained.** A shipped adapter is loaded by its host as a
 *     plain file (pi's jiti reads the raw .ts; omp resolves relative
 *     imports inside a plugin package). Nothing here may import from
 *     @broject/*: a bundler would drag a package's worth of unrelated
 *     code into a two-hundred-line artifact, and the artifact has to
 *     keep working when the host loads it from a directory nobody
 *     installed a node_modules tree into. `broEnabled` therefore
 *     re-implements core's `repoOptedIn` — one duplication, in one
 *     place, instead of one per client. Keep the marker list in sync
 *     with CONFIG_LAYER_FILES in @broject/core.
 *
 *   - **Fail-open.** A missing CLI, a hung child, a broken pipe, a
 *     non-JSON line, a non-zero exit — every one of them resolves to
 *     "no opinion" (null), never to a thrown error. A hook that throws
 *     takes the host's session down with it, and bro's policy is
 *     advisory everywhere except the stop gate.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one control object `bro hooks <event>` prints. */
export interface HookControl {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown };
  decision?: string;
  reason?: unknown;
}

/** A resolved bro CLI invocation. */
export interface Command {
  cmd: string;
  args: string[];
}

/** Minimal structural read of `bro status --json` — fields the widget
 *  renders; everything else passes through unread. */
export interface BoardStatus {
  branch?: string;
  dirty?: number;
  beads?: {
    inProgress?: Array<{ id?: string; title?: string; link?: string }>;
    readyTotal?: number;
  };
  fleet?: {
    maxConcurrent?: number;
    agents?: Array<{ id?: string; backend?: string; state?: string; step?: string }>;
  };
  drill?: { frame?: { id?: string; title?: string; depth?: number } | null };
}

/** How long a normal hook probe may take. */
export const HOOK_TIMEOUT_MS = 15_000;
/** session-start/post-compaction list `bd ready` and scan worktrees —
 *  measured at 20-40s in a loaded repo. */
export const REHYDRATION_TIMEOUT_MS = 45_000;
/** Cap on a hook's stdout — a runaway child must not eat the heap. */
export const MAX_OUTPUT = 1 << 20;
/** A hung CLI must not wedge an adapter: `/bro`, `bro_status` and the
 *  bro tool are interactive reads, and a wedged dolt lock can stall
 *  them forever. The kill takes the detached process group down. */
export const RUN_TIMEOUT_MS = 60_000;
/** How long a failed CLI resolution stays cached before a retry —
 *  PATH, a local install or npx can appear mid-session, but
 *  re-probing the npx rung on every keystroke would be worse than
 *  the outage. */
export const RESOLVE_RETRY_MS = 60_000;
const HOOKS_COMMAND = 'hooks';
const STATUS_COMMAND = 'status';
const JSON_FLAG = '--json';
const NPX_COMMAND = 'npx';
const NPX_YES_FLAG = '-y';
const NPX_OFFLINE_FLAG = '--prefer-offline';
const BRO_MARKERS = [
  'bro.config.ts',
  'bro.config.json',
  'bro.config.local.ts',
  'bro.config.local.json',
  '.beads',
] as const;

/** The curated command family — first-class slash aliases for bro's
 *  workflow verbs. `verb` is the CLI argv head; `name` is the slash
 *  name, renamed to `bro:<name>` when the host owns it natively
 *  (AGT-1 §command family — a host-native command always wins).
 *  `/wtf` passes any args through untouched — the wtf routine owns
 *  multilingual frustration input itself. */
export const BRO_COMMANDS: ReadonlyArray<{
  name: string;
  verb: string;
  description: string;
}> = [
  { name: 'act', verb: 'act', description: 'bro act — PR review gate, threads, resolve' },
  {
    name: 'wtf',
    verb: 'wtf',
    description: 'bro wtf — frustration → retrospect capture, any language',
  },
  {
    name: 'retro',
    verb: 'retrospect',
    description: 'bro retrospect — learn + backlog review',
  },
  { name: 'learn', verb: 'learn', description: 'bro learn — lessons and backlog' },
  {
    name: 'drill',
    verb: 'drill',
    description: 'bro drill — deep research routine, scoped investigation',
  },
  {
    name: 'judge',
    verb: 'judge',
    description: 'bro judge — typed decision on session state',
  },
  {
    name: 'loop',
    verb: 'loop',
    description: 'bro loop — iterations with exit condition or formula',
  },
  {
    name: 'goal',
    verb: 'goal',
    description: 'bro goal — goal tracking, hooks remind every turn',
  },
];

/**
 * `node` on PATH, not process.execPath — a host may ship as a compiled
 * binary whose execPath IS that binary, so running it with our own
 * entry script would re-enter the host instead of running the script.
 */
export function jsRuntime(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/** The bro CLI bundled next to this adapter (`dist/index.js`). */
export function siblingCli(): string | null {
  for (const rel of ['./index.js', '../dist/index.js']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The bro CLI of the checkout this adapter was loaded from — the
 *  development path: the adapter's own source tree wins over any
 *  published package, so a local edit is live without a rebuild. */
export function checkoutCli(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** A kill timer — cleared once the child settles. */
export type KillTimer = ReturnType<typeof setTimeout>;

/**
 * SIGKILL a hung child on a timer. The child is spawned detached, so
 * killing the pid's group takes the grandchildren down too — a hook
 * that spawns `bd` must not leave a dolt server behind.
 */
export function killAfter(child: ChildProcess, ms: number, onTimeout: () => void): KillTimer {
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    onTimeout();
  }, ms);
  timer.unref?.();
  return timer;
}

/** Does this command exit zero? Used to probe whether a candidate CLI
 *  actually speaks bro's hook protocol — an older bro on PATH fails the
 *  probe instead of failing every hook. */
export async function exitsZero(cmd: string, args: string[]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    }); // NOSONAR typescript:S4036
  } catch {
    return false;
  }
  const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(false));
  child.on('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
  child.on('close', code => {
    clearTimeout(timer);
    resolve(code === 0);
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end('');
  return promise;
}

/** Options for the CLI ladder. */
export interface ResolveOptions {
  /** A caller-pinned CLI (config `options.command`) — wins over the
   *  local dist, because the operator asked for that binary. A string
   *  splits on whitespace (`"node /x/bro.js"`); an object form carries
   *  argv verbatim for hosts whose config spells cmd+args separately. */
  command?: string | { cmd: string; args?: unknown };
  /** The pinned npx spec — the published version of this adapter. */
  npxPin?: string;
  /** Ordered npx fallback specs, tried after `bro` on PATH fails the
   *  hooks probe. When set it supersedes `npxPin` — a host that wants
   *  a pinned-then-latest ladder lists both. */
  npxSpecs?: readonly string[];
}

/**
 * The CLI ladder, in order: the pinned command, the bundled sibling,
 * the checkout's dist, `bro` on PATH, and finally the pinned npx
 * package. Every tier is probed with `bro hooks` — the silent
 * capability probe — so a tier that resolves to something that is not
 * bro is skipped rather than failing every hook.
 */
export async function resolveCommand(opts: ResolveOptions = {}): Promise<Command | null> {
  return (
    (await pinnedCommand(opts.command)) ??
    (await checkoutResolved()) ??
    (await pathResolved()) ??
    (await npxResolved(opts))
  );
}

async function pinnedCommand(pinned: ResolveOptions['command']): Promise<Command | null> {
  if (typeof pinned === 'string') {
    return pinnedStringCommand(pinned);
  }
  if (typeof pinned !== 'object' || pinned === null) {
    return null;
  }
  const cmd = typeof pinned.cmd === 'string' ? pinned.cmd : '';
  const args = Array.isArray(pinned.args)
    ? pinned.args.filter((a): a is string => typeof a === 'string')
    : [];
  return cmd !== '' && (await exitsZero(cmd, [...args, 'hooks'])) ? { cmd, args } : null;
}

async function pinnedStringCommand(pinned: string): Promise<Command | null> {
  const [cmd, ...args] = pinned.split(/\s+/).filter(p => p !== '');
  return cmd !== undefined && (await exitsZero(cmd, [...args, 'hooks'])) ? { cmd, args } : null;
}

async function checkoutResolved(): Promise<Command | null> {
  for (const entry of [siblingCli(), checkoutCli()]) {
    if (entry !== null && (await exitsZero(jsRuntime(), [entry, 'hooks']))) {
      return { cmd: jsRuntime(), args: [entry] };
    }
  }
  return null;
}

async function pathResolved(): Promise<Command | null> {
  return (await exitsZero('bro', ['hooks'])) ? { cmd: 'bro', args: [] } : null;
}

async function npxResolved(opts: ResolveOptions): Promise<Command | null> {
  const specs = opts.npxSpecs ?? (opts.npxPin !== undefined ? [opts.npxPin] : []);
  if (specs.length === 0 || !(await exitsZero(NPX_COMMAND, ['--version']))) {
    return null;
  }
  for (const spec of specs) {
    if (await exitsZero(NPX_COMMAND, [NPX_YES_FLAG, NPX_OFFLINE_FLAG, spec, HOOKS_COMMAND])) {
      return { cmd: NPX_COMMAND, args: [NPX_YES_FLAG, NPX_OFFLINE_FLAG, spec] };
    }
  }
  return null;
}

/**
 * The env an in-process adapter stamps on its `bro hooks` spawn so the
 * CLI's adapter emit path can journal the session into the hook spool
 * (specs/bro-izpyk.9.md): `BRO_HOOK_HOST` is the ledger host name (and
 * the launch marker — presence means "direct adapter call, no run.sh"),
 * `BRO_HOOK_PROOT` this module's own directory (the installed plugin
 * root), `BRO_HOOK_ADAPTER` the adapter version parsed off the npx pin.
 * A CLI that predates the marker ignores the env — rollout is safe in
 * both directions.
 */
export function hookEmitEnv(kind: string, opts: { npxPin?: string } = {}): Record<string, string> {
  const env: Record<string, string> = {
    BRO_HOOK_HOST: kind,
    BRO_HOOK_PROOT: dirname(fileURLToPath(import.meta.url)),
  };
  // '@broject/bro@X.Y.Z' → 'X.Y.Z' — the pin is version-synced, so the
  // stamped version tracks releases without a second source
  const at = opts.npxPin?.lastIndexOf('@') ?? -1;
  if (opts.npxPin !== undefined && at > 0) {
    env.BRO_HOOK_ADAPTER = opts.npxPin.slice(at + 1);
  }
  return env;
}

/** Why one hook call produced no usable answer. Healthy silence is NOT
 *  a kind: a clean exit with empty stdout is bro's "nothing to say" —
 *  every kind here is a real outage the caller may need to surface. */
export type HookFailure =
  /** Every CLI ladder rung failed the `bro hooks` capability probe. */
  | { kind: 'no-cli' }
  /** The payload would not serialize — the hook never ran, and no child
   *  was even spawned for input it could never receive. */
  | { kind: 'input' }
  /** spawn threw or the child raised 'error' — the hook never ran. */
  | { kind: 'spawn' }
  /** The kill timer fired; the child's process group was killed. */
  | { kind: 'timeout'; timeoutMs: number }
  /** Nonzero (or signal — code null) exit: a failed run's stdout is not
   *  a control object even when it happens to parse. */
  | { kind: 'exit'; code: number | null }
  /** Clean exit but stdout carried chatter and no control line — the
   *  protocol broke, not a quiet answer. */
  | { kind: 'output' };

/** One hook call's verdict: the control object bro answered, the
 *  failure that kept it from answering, or healthy silence — `control`
 *  and `failure` both null. */
export interface HookResult {
  control: HookControl | null;
  failure: HookFailure | null;
}

/** The one-line cause a diagnostic surfaces for a failed hook call. */
export function hookFailureText(failure: HookFailure): string {
  switch (failure.kind) {
    case 'no-cli':
      return 'no bro CLI resolved';
    case 'input':
      return 'the hook payload could not be serialized';
    case 'spawn':
      return 'the hook process failed to spawn';
    case 'timeout':
      return `the hook timed out after ${failure.timeoutMs}ms`;
    case 'exit':
      return `the hook exited ${failure.code ?? 'with no exit code'}`;
    case 'output':
      return 'the hook answered with no control object';
  }
}

/**
 * Run one `bro hooks <event>` with the payload on stdin; resolve null on
 * every failure mode — spawn error, timeout, nonzero exit, garbage out.
 * `extraEnv` rides on the spawn env (the adapter's `hookEmitEnv` block).
 */
export interface HookCall {
  event: string;
  payload: unknown;
  cwd: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
}

export async function callHook(command: Command, call: HookCall): Promise<HookControl | null> {
  return (await callHookDetailed(command, call)).control;
}

/**
 * callHook with the failure class attached. The stop gate needs to tell
 * "bro had nothing to say" apart from "bro could not answer": both are
 * fail-open, but the second must not pass invisibly. A clean exit with
 * empty stdout is silence (failure null) — only real outage kinds set it.
 */
export async function callHookDetailed(command: Command, call: HookCall): Promise<HookResult> {
  const { event, payload, cwd, timeoutMs, extraEnv } = call;
  // serialize before spawning: a payload JSON.stringify rejects means the
  // hook can never run — that is its own outage class, not a spawn error
  // and never healthy silence (and this function resolves, never throws)
  let input: string | undefined;
  try {
    input = JSON.stringify(payload);
  } catch {
    return { control: null, failure: { kind: 'input' } };
  }
  // stringify returns undefined (not a throw) for undefined/functions/
  // symbols — no JSON document exists to hand the child either way
  if (input === undefined) {
    return { control: null, failure: { kind: 'input' } };
  }
  const { promise, resolve } = Promise.withResolvers<HookResult>();
  let child: ChildProcess;
  try {
    child = spawn(command.cmd, [...command.args, HOOKS_COMMAND, event], {
      cwd,
      env: extraEnv === undefined ? undefined : { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    return { control: null, failure: { kind: 'spawn' } };
  }
  let settled = false;
  const settle = (result: HookResult): void => {
    if (!settled) {
      settled = true;
      resolve(result);
    }
  };
  const timer = killAfter(child, timeoutMs, () =>
    settle({ control: null, failure: { kind: 'timeout', timeoutMs } })
  );
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const remaining = MAX_OUTPUT - out.length;
    if (remaining > 0) {
      out += chunk.slice(0, remaining);
    }
  });
  child.on('error', () => {
    clearTimeout(timer);
    settle({ control: null, failure: { kind: 'spawn' } });
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) {
      settle({ control: null, failure: { kind: 'exit', code } });
      return;
    }
    const control = parseControl(out);
    if (control === null && out.trim() !== '') {
      settle({ control: null, failure: { kind: 'output' } });
      return;
    }
    settle({ control, failure: null });
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
  return promise;
}

/**
 * Scan for the first parseable control line — unrelated chatter on
 * stdout must not swallow the answer.
 */
/** Non-null plain object — the control-line shape. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseControl(out: string): HookControl | null {
  for (const line of out.split('\n')) {
    const text = line.trim();
    if (text === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) {
        return parsed as HookControl;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * The context half of a control object: bro's "here is what you should
 * know" text. Empty means the hook had nothing to add.
 */
export function contextOf(control: HookControl | null): string {
  const text = control?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * The repo opts in by carrying any project/local bro.config.* or
 * .beads/ — the same gate `bro hooks` applies (core's repoOptedIn).
 * Duplicated here because a shipped adapter cannot import @broject/core;
 * keep the list in sync with CONFIG_LAYER_FILES.
 */
export function broEnabled(startDir: string): boolean {
  let dir = startDir;
  for (;;) {
    if (BRO_MARKERS.some(marker => existsSync(join(dir, marker)))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

/** `bro status --json` — the board the widget renders. Null on any
 *  failure; the board is a convenience, never a gate. */
export async function statusJson(command: Command, cwd: string): Promise<BoardStatus | null> {
  const { promise, resolve } = Promise.withResolvers<BoardStatus | null>();
  let child: ChildProcess;
  try {
    child = spawn(command.cmd, [...command.args, STATUS_COMMAND, JSON_FLAG], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    return null;
  }
  const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(null));
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const remaining = MAX_OUTPUT - out.length;
    if (remaining > 0) {
      out += chunk.slice(0, remaining);
    }
  });
  child.on('error', () => {
    clearTimeout(timer);
    resolve(null);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) {
      resolve(null);
      return;
    }
    try {
      const parsed = JSON.parse(out) as unknown;
      resolve(
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as BoardStatus)
          : null
      );
    } catch {
      resolve(null);
    }
  });
  return promise;
}

const ELLIPSIS = '…';

/** Return the terminal column width of a string without splitting Unicode
 * code points. Combining marks occupy no columns; wide CJK and emoji occupy
 * two. This small implementation keeps the bundled adapters dependency-free. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    ) {
      continue;
    }
    const zeroWidth =
      (code >= 0x200b && code <= 0x200d) ||
      (code >= 0xfe00 && code <= 0xfe0f);
    if (zeroWidth) {
      continue;
    }
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2329 && code <= 0x232a) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f000 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Clip to a width, marking the cut. */
export function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) {
    return text;
  }
  const target = Math.max(0, width - displayWidth(ELLIPSIS));
  let used = 0;
  let prefix = '';
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > target) {
      break;
    }
    prefix += char;
    used += charWidth;
  }
  return `${prefix}${ELLIPSIS}`;
}

/**
 * The widget board — one compact summary line, then the top in-progress
 * beads and running fleet agents. A string array is the simplest board
 * any host can render.
 */
export function boardLines(s: BoardStatus): string[] {
  const running = runningAgents(s);
  return [`bro · ${boardParts(s, running).join(' · ')}`, ...beadLines(s), ...agentLines(running)];
}

function runningAgents(s: BoardStatus) {
  return (s.fleet?.agents ?? []).filter(a => a.state === 'running');
}

function boardParts(s: BoardStatus, running: ReturnType<typeof runningAgents>): string[] {
  const beads = s.beads?.inProgress ?? [];
  const cap = (s.fleet?.maxConcurrent ?? 0) > 0 ? `/${s.fleet?.maxConcurrent}` : '';
  const parts = [
    `◐ ${beads.length} bead${beads.length === 1 ? '' : 's'}`,
    `fleet ${running.length}${cap}`,
    `ready ${s.beads?.readyTotal ?? 0}`,
  ];
  if (s.drill?.frame) {
    parts.push(`drill ${s.drill.frame.id}`);
  }
  if ((s.dirty ?? 0) > 0) {
    parts.push(`dirty ${s.dirty}`);
  }
  return parts;
}

function beadLines(s: BoardStatus): string[] {
  return (s.beads?.inProgress ?? [])
    .slice(0, 3)
    .map(b => `  ◐ ${b.id ?? '?'}  ${clip(b.title ?? '', 64)}${b.link ? `  ${b.link}` : ''}`);
}

function agentLines(running: ReturnType<typeof runningAgents>): string[] {
  return running
    .slice(0, 2)
    .map(a => `  ▶ ${a.id ?? '?'}  ${a.backend ?? ''}${a.step ? `  ${a.step}` : ''}`);
}

/** The footer crumb — the one-glance form of the same board. */
export function statusCrumb(s: BoardStatus): string {
  const beads = s.beads?.inProgress?.length ?? 0;
  const running = (s.fleet?.agents ?? []).filter(a => a.state === 'running').length;
  return `bro ◐${beads} ⬢${running}`;
}

/** A finished arbitrary bro invocation — the read-verb/tool path, not
 *  the hook protocol. `code` is null when the child never produced an
 *  exit status (spawn error or timeout — `error` says which). */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs: number;
}

/** Spawn `command args`, capture stdout+stderr, kill the process group
 *  on timeout. Never rejects — every failure mode lands in `error` or
 *  a null `code`, because a read-verb caller's only question is what
 *  printed. The nonzero exit IS the answer for gate verbs like
 *  `act status`, so the code travels in the result. */
export function runCommand(
  command: string,
  args: string[],
  options: RunOptions
): Promise<RunResult> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    runCollect(child, options, resolve);
  });
}

function runCollect(
  child: ChildProcess,
  options: RunOptions,
  resolve: (r: RunResult) => void
): void {
  const settle = once(resolve);
  let stdout = '';
  let stderr = '';
  const timer = killAfter(child, options.timeoutMs, () =>
    settle({
      code: null,
      stdout,
      stderr,
      error: `timed out after ${options.timeoutMs}ms`,
    })
  );
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = appendOutput(stderr, chunk);
  });
  child.on('error', error => {
    clearTimeout(timer);
    settle({ code: null, stdout, stderr, error: error.message });
  });
  child.on('close', code => {
    clearTimeout(timer);
    settle({ code, stdout, stderr, error: null });
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.input ?? '');
}

function once(resolve: (result: RunResult) => void): (result: RunResult) => void {
  let settled = false;
  return result => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(result);
  };
}

function appendOutput(buffer: string, chunk: string): string {
  const remaining = MAX_OUTPUT - buffer.length;
  return remaining > 0 ? buffer + chunk.slice(0, remaining) : buffer;
}

/**
 * The lazy, retrying CLI resolver every adapter shares: resolution
 * costs spawn probes, so it runs on first use and a *failed* answer
 * expires after RESOLVE_RETRY_MS instead of poisoning the instance —
 * PATH, a local install or npx can appear mid-session.
 */
export function createCommandResolver(opts: ResolveOptions = {}): () => Promise<Command | null> {
  let resolved: Promise<Command | null> | undefined;
  let failedAt: number | undefined;
  const cacheFresh = (): boolean => {
    if (resolved === undefined) {
      return false;
    }
    return failedAt === undefined || Date.now() - failedAt < RESOLVE_RETRY_MS;
  };
  return () => {
    if (cacheFresh() && resolved !== undefined) {
      return resolved;
    }
    failedAt = undefined;
    resolved = resolveCommand(opts).then(cmd => {
      if (cmd === null) {
        failedAt = Date.now();
      }
      return cmd;
    });
    return resolved;
  };
}

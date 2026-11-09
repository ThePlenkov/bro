// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro — OpenCode server plugin (modern API).
 *
 * Follows https://opencode.ai/docs/build/plugins/server/
 * `export default { id, setup }` (OpenCode server plugin contract).
 *
 * Rehydrates bro state into sessions, gates premature stops (re-prompt once),
 * approves safe bro self-tool commands, exposes bro read tools and `/bro`,
 * and mounts `bro serve` as MCP when opted in.
 *
 * Fail-open: every hook is wrapped; a missing bro binary, timeout, nonzero
 * exit, or bad output degrades to no context / no gate / no re-prompt.
 * Nothing here throws into opencode. Spawns are async (server event loop).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogInput {
  body: { service: string; level: Level; message: string; extra?: unknown };
}

/** `["@broject/bro", { command: … }]` — opencode's tuple plugin form. */
interface PluginOptions {
  command?: string | { cmd: string; args?: string[] };
  /** Mount `bro serve` as a remote MCP server on this loopback port (opt-in). */
  mcpPort?: number;
}

/** Control object from `bro hooks <event>`. */
interface HookControl {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown };
  decision?: string;
  reason?: unknown;
}

interface Command {
  cmd: string;
  args: string[];
}

/** Per-probe budget for the events that ride on a turn. A wedged connector
 *  already costs up to 4s each and bro runs probes sequentially, so this is an
 *  outer bound, not the expected wait — on timeout the event degrades to "no
 *  context", which is the fail-open answer anyway. */
const HOOK_TIMEOUT_MS = 15_000;

/** Rehydration gets a longer budget because it shells out to `bd ready` and
 *  scans the worktree set — measured at 20-40s in a loaded repo. It is primed
 *  on `session.created` (see below) so that cost overlaps the user's first
 *  prompt instead of serializing after it. */
const REHYDRATION_TIMEOUT_MS = 45_000;

const MAX_OUTPUT = 1 << 20;

/** The runtime that executes the sibling CLI.
 *
 *  NOT `process.execPath`. opencode ships as a compiled binary, so inside its
 *  own plugin process `process.execPath` IS opencode — spawning it with
 *  `hooks <event>` starts a TUI instead of running the hook, and the plugin
 *  fails open into silence. `node` on PATH is the right ask anyway: it is what
 *  bro itself requires (`engines.node >= 22.18`), it is what hooks/run.sh
 *  resolves, and the CLI is plain ESM JS, so any runtime will do. */
export function jsRuntime(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * The CLI shipped beside this module: installed as
 * `node_modules/@broject/bro/dist/{opencode,index}.js`, built in a checkout as
 * `packages/cli/dist/{opencode,index}.js`. Same package, so the hook policy
 * can never be a different version than the plugin calling it.
 */
function siblingCli(): string | null {
  for (const rel of ['./index.js', '../dist/index.js']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Walk up from this module for a checkout build — a bro.ts materialized
 *  into `.opencode/plugins/` or `plugins/opencode/bro/` inside a bro
 *  clone resolves the clone's own `packages/cli/dist/index.js`, so hook
 *  behavior tracks the checkout. Same walk `.kilo/plugin/bro.ts` and
 *  `hooks/run.sh` already do. */
function checkoutCli(): string | null {
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

/** Last-resort npx package spec, pinned to this module's own version —
 *  gen-plugins lists this file in VERSIONED_SOURCES, so the pin is
 *  rewritten to plugin.json's version on every gen/release run. */
const NPX_PIN = '@broject/bro@0.3.0';

/** Spawn `cmd args`, resolve true iff it exits 0 within the hook budget. One
 *  probe serves both launch tiers: `hooks` with no event answers "is this
 *  a bro that speaks the hook contract" — a bare `bro hooks` returns before
 *  it reads stdin, and an older build without the subcommand exits nonzero.
 *  A spawn error, timeout, or nonzero exit is "no" — selecting
 *  a command that cannot launch is worse than falling through to the next
 *  tier. */
function exitsZero(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      // PATH lookup is the point of both tiers — the probe verifies the
      // answer before any hook trusts it
      child = spawn(cmd, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
      }); // NOSONAR typescript:S4036
    } catch {
      resolve(false);
      return;
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
  });
}

/** Does a PATH `bro` actually answer `bro hooks`? Without an event the hook
 *  command is a silent no-op, so exit 0 is the probe — an older bro without
 *  the subcommand fails it instead of failing every hook. Same discriminator
 *  hooks/run.sh uses. */
function hasHooksCommand(): Promise<boolean> {
  return exitsZero('bro', ['hooks']);
}

/** SIGKILL a hung child on a timer. The spawns below are detached, so the
 *  child leads its own process group and `-pid` takes a spawned `gh`/`bd`
 *  down with it — a lone child.kill would leave them orphaned. */
function killAfter(
  child: ChildProcess,
  ms: number,
  onTimeout: () => void
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // no group to kill (not detached, already gone, or windows)
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

async function resolveCommand(options: PluginOptions | undefined): Promise<Command | null> {
  const override = options?.command;
  if (typeof override === 'string' && override.trim() !== '') {
    return { cmd: override, args: [] };
  }
  if (override && typeof override === 'object' && typeof override.cmd === 'string') {
    return {
      cmd: override.cmd,
      args: Array.isArray(override.args)
        ? override.args.filter((a): a is string => typeof a === 'string')
        : [],
    };
  }
  // local-dist tiers: the bundled sibling (npm `plugin` config-entry form)
  // first, then the checkout walk-up for a materialized module inside a
  // clone. The probe asks for the hook contract itself — `--version` would
  // also pass on a stale dist that predates `bro hooks`, shadowing a
  // working PATH `bro` while every hook fails open into silence. Each
  // candidate is probed in order: a sibling that fails must not hide a
  // working checkout build behind it.
  for (const entry of [siblingCli(), checkoutCli()]) {
    if (entry !== null && (await exitsZero(jsRuntime(), [entry, 'hooks']))) {
      return { cmd: jsRuntime(), args: [entry] };
    }
  }
  // no local dist — fall back to PATH, and only to a bro that passes the
  // hooks probe.
  if (await hasHooksCommand()) {
    return { cmd: 'bro', args: [] };
  }
  // last resort mirrors hooks/run.sh: the published package via npx,
  // probed cheaply (the hook call itself carries the hook budget — a cold
  // npx resolve degrades to no-context for that turn, not a hang)
  if (await exitsZero('npx', ['--version'])) {
    if (await exitsZero('npx', ['-y', '--prefer-offline', NPX_PIN, 'hooks'])) {
      return { cmd: 'npx', args: ['-y', '--prefer-offline', NPX_PIN] };
    }
    const latest = '@broject/bro';
    if (await exitsZero('npx', ['-y', '--prefer-offline', latest, 'hooks'])) {
      return { cmd: 'npx', args: ['-y', '--prefer-offline', latest] };
    }
    return { cmd: 'npx', args: ['-y', '--prefer-offline', NPX_PIN] };
  }
  return null;
}

/** Run one bro hook event. Resolves null for every failure mode, including
 *  "bro isn't there" — the caller's only question is whether a valid control
 *  object came back.
 *
 *  Async spawn, not spawnSync: opencode runs plugin hooks on the server's event
 *  loop, so a synchronous child would freeze the whole session — and bro's
 *  rehydration probes are measured in tens of seconds, not milliseconds. */
function callHook(
  command: Command,
  event: string,
  payload: unknown,
  directory: string,
  timeoutMs: number
): Promise<HookControl | null> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command.cmd, [...command.args, 'hooks', event], {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'ignore'],
        // own process group so killAfter can take spawned children down too
        detached: process.platform !== 'win32',
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (value: HookControl | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = killAfter(child, timeoutMs, () => settle(null));
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
      settle(null);
    });
    child.on('close', code => {
      clearTimeout(timer);
      // `bro hooks` always exits 0; anything else means the run failed, and a
      // failed run's stdout is not a control object even if it parses
      settle(code === 0 ? parseControl(out) : null);
    });
    // bro can exit before reading stdin (unrecognized event) — EPIPE here is
    // bro's answer, not a crash
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** bro prints a single control object per event, but scan for the first
 *  parseable line so unrelated chatter on stdout can't swallow the answer. */
function parseControl(out: string): HookControl | null {
  for (const line of out.split('\n')) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as HookControl;
      }
    } catch {
      // not a control line — keep scanning
    }
  }
  return null;
}

function contextOf(control: HookControl | null): string {
  const text = control?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' ? text.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Did the tool succeed? bro arms its gates and cites skills only on success,
 *  so a false positive here is worse than a false negative.
 *
 *  opencode's bash metadata is `{ output, exit, truncated }` — there is no
 *  `error` field on a nonzero exit, so keying on `error` alone reads every
 *  failure as a success. Honour `exit` when the tool reports it and fall back
 *  to the error key for tools that only set that. */
export function toolSucceeded(metadata: Record<string, unknown> | null): boolean {
  if (metadata?.error !== undefined) {
    return false;
  }
  return typeof metadata?.exit === 'number' ? metadata.exit === 0 : true;
}

/** Everything both majors share: lazy command resolution, the probe, the
 *  per-session rehydration cache, the stop-gate state, and the bus-event
 *  handlers. `log` and `reprompt` are the client-shaped seams
 *  (`ctx.app.log` + `ctx.session.prompt`).
 *  `session.prompt`. */
interface BroCoreInput {
  directory: string;
  options?: PluginOptions;
  log(level: Level, message: string): Promise<unknown>;
  /** Feed the blocker back as a fresh turn. The core catches and logs a
   *  reprompt failure — implementations only supply the call. */
  reprompt(sessionID: string, text: string): Promise<unknown>;
  /** Optional durable store for the one-shot gate set —
   *  `ctx.storage` so a plugin reload doesn't re-prompt a session that
   *  already blocked once. A load that settles after a `session.deleted`
   *  must not resurrect that id's gate — deletes landing during the
   *  snapshot read are tombstoned out of the merge. */
  persist?: {
    load(): Promise<unknown>;
    save(ids: readonly string[]): Promise<unknown>;
  };
}

function makeCore(input: BroCoreInput) {
  const directory = input.directory;
  const options = input.options;
  const log = input.log;
  // resolved on first use, not at load — the PATH tier costs a spawn probe
  // and opencode loads plugins even in repos where bro is inert.
  let command: Promise<Command | null> | undefined;

  const probe = async (
    event: string,
    payload: unknown,
    timeoutMs = HOOK_TIMEOUT_MS
  ): Promise<HookControl | null> => {
    command ??= resolveCommand(options);
    const resolved = await command;
    return resolved ? callHook(resolved, event, payload, directory, timeoutMs) : null;
  };

  /** Spawn `<bro> args` and capture stdout — the read-verb path tool
   *  executions and commands share. Never rejects: no resolved CLI,
   *  a spawn error, or a timeout resolves with what printed. The code
   *  travels in the result because a nonzero exit IS the answer for
   *  gate verbs like `act status`. */
  const exec = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
    new Promise(resolve => {
      command ??= resolveCommand(options);
      void command.then(resolved => {
        if (resolved === null) {
          resolve({ code: 127, out: '', err: 'no bro command resolved' });
          return;
        }
        let child: ChildProcess;
        try {
          child = spawn(resolved.cmd, [...resolved.args, ...args], {
            cwd: directory,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          });
        } catch {
          resolve({ code: 127, out: '', err: 'spawn failed' });
          return;
        }
        let out = '';
        let err = '';
        const cap = (buf: string, chunk: string): string =>
          buf.length < MAX_OUTPUT ? buf + chunk.slice(0, MAX_OUTPUT - buf.length) : buf;
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          out = cap(out, chunk);
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          err = cap(err, chunk);
        });
        const finish = (code: number): void => resolve({ code, out: out.trim(), err: err.trim() });
        const timer = killAfter(child, HOOK_TIMEOUT_MS, () => finish(124));
        child.on('error', () => {
          clearTimeout(timer);
          finish(127);
        });
        child.on('close', code => {
          clearTimeout(timer);
          finish(code ?? 1);
        });
      });
    });

  /** Rehydration is per session, not per turn: system.transform runs on every
   *  request, so the probe runs once and the answer is re-pushed each turn —
   *  which is also what carries it across compaction. The cache holds the
   *  in-flight promise, not its result, so a `session.created` prime and a
   *  first turn racing each other share one probe instead of two. A FAILED
   *  probe is evicted rather than cached — timing out once is not the
   *  session's verdict, and the next turn deserves a retry; only a real
   *  answer (including an empty one) is sticky. */
  const rehydration = new Map<string, Promise<string>>();
  const hydrate = (
    sessionID: string,
    event: 'session-start' | 'post-compaction'
  ): Promise<string> => {
    const pending = rehydration.get(sessionID);
    if (pending) {
      return pending;
    }
    const started = probe(event, { session_id: sessionID }, REHYDRATION_TIMEOUT_MS).then(
      control => {
        // evict only our own failed entry — a compaction may have already
        // replaced it with a newer probe, which must not be deleted out
        // from under the session that owns it
        if (control === null && rehydration.get(sessionID) === started) {
          rehydration.delete(sessionID);
        }
        return contextOf(control);
      }
    );
    rehydration.set(sessionID, started);
    return started;
  };
  /** Sessions that already got their one re-prompt. */
  const gated = new Set<string>();
  const persistGated = (): void => {
    void input.persist?.save([...gated]).catch(() => {});
  };
  /** Ids deleted while the persisted snapshot is still in flight — the
   *  merge would otherwise resurrect the gate onto a session reusing the
   *  id and its first block would be swallowed as a repeat. */
  const retiredDuringLoad = new Set<string>();
  let persistLoaded = input.persist === undefined;
  if (input.persist) {
    void input.persist
      .load()
      .then(stored => {
        if (Array.isArray(stored)) {
          for (const id of stored) {
            if (typeof id === 'string' && !retiredDuringLoad.has(id)) {
              gated.add(id);
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        persistLoaded = true;
        retiredDuringLoad.clear();
      });
  }
  /** Sessions whose last assistant turn finished cleanly. */
  const clean = new Set<string>();
  /** Sessions observed alive. `session.deleted` is the only retirement, and
   *  the idle gate suspends on real I/O — liveness is re-checked after each
   *  suspending await before the re-prompt goes out, never assumed. The
   *  value is an instance token minted per observing event, not membership:
   *  a delete followed by an id-reusing create leaves the map occupied by a
   *  *different* session, and a bare `has` would wave a stale gate through
   *  to it. */
  const live = new Map<string, number>();
  let liveSeq = 0;

  /** `session.created` primes rehydration while opencode is still waiting on a
   *  prompt — the probe costs real seconds, and this is the only window where
   *  paying it doesn't sit on the critical path of a turn. */
  const onSessionCreated = (props: Record<string, unknown>): void => {
    const sessionID = props.sessionID;
    if (typeof sessionID === 'string') {
      live.set(sessionID, ++liveSeq);
      void hydrate(sessionID, 'session-start');
    }
  };

  /** `message.updated` arrives before the matching `session.idle` —
   *  `time.completed` with no `error` is what separates a finished turn from
   *  one the user aborted or the provider failed. The latest assistant update
   *  is the verdict: a clean step followed by one that aborts, errors, or is
   *  still streaming erases the earlier completion. */
  const onMessageUpdated = (props: Record<string, unknown>): void => {
    const info = asRecord(props.info);
    if (info?.role !== 'assistant' || typeof info.sessionID !== 'string') {
      return;
    }
    // a fresh token only when the session wasn't already live — minting
    // one per update would invalidate an idle gate mid-flight for no reason
    if (!live.has(info.sessionID)) {
      live.set(info.sessionID, ++liveSeq);
    }
    if (asRecord(info.time)?.completed !== undefined && info.error === undefined) {
      clean.add(info.sessionID);
    } else {
      clean.delete(info.sessionID);
    }
  };

  /** `session.deleted` retires the per-session structures — they live as
   *  long as the plugin process, not the session, so without this a
   *  long-lived server accumulates dead entries. */
  const onSessionDeleted = (props: Record<string, unknown>): void => {
    const sessionID = asRecord(props.info)?.id ?? props.sessionID;
    if (typeof sessionID !== 'string') {
      return;
    }
    rehydration.delete(sessionID);
    // tombstone for the in-flight snapshot merge — a persisted copy of
    // this gate arriving now belongs to the dead session, not the id
    if (!persistLoaded) {
      retiredDuringLoad.add(sessionID);
    }
    if (gated.delete(sessionID)) {
      persistGated();
    }
    clean.delete(sessionID);
    live.delete(sessionID);
  };

  /** `session.compacted` re-primes the cache so the next turn pushes
   *  post-compaction state instead of the pre-compaction snapshot. */
  const onSessionCompacted = (props: Record<string, unknown>): void => {
    const sessionID = props.sessionID;
    if (typeof sessionID !== 'string') {
      return;
    }
    rehydration.delete(sessionID);
    void hydrate(sessionID, 'post-compaction');
  };

  /** `session.idle` is the stop gate. Gated sessions pass `stop_hook_active`,
   *  so bro skips its own re-evaluation — the one-shot guard is bro's, not
   *  duplicated here. */
  const onSessionIdle = async (props: Record<string, unknown>): Promise<void> => {
    const sessionID = props.sessionID;
    if (typeof sessionID !== 'string' || !clean.delete(sessionID)) {
      return;
    }
    // the instance token is captured before any suspending await: a
    // `session.deleted` followed by an id-reusing `session.created` leaves
    // `live` occupied by a different session, and only the token tells the
    // stale gate apart from it
    const instance = live.get(sessionID);
    const stillAlive = (): boolean => instance !== undefined && live.get(sessionID) === instance;
    const control = await probe('stop', {
      session_id: sessionID,
      stop_hook_active: gated.has(sessionID),
    });
    const reason = typeof control?.reason === 'string' ? control.reason.trim() : '';
    if (control?.decision !== 'block') {
      const hint = contextOf(control);
      if (hint) {
        await log('info', hint);
      }
      return;
    }
    // the probe awaited real I/O — a session.deleted that interleaved retired
    // this instance, and gating it now would resurrect the entry and suppress
    // a session reusing it. The gate is set before the log/prompt awaits for
    // the same reason: a delete during them must clear it, not race it.
    if (!stillAlive()) {
      return;
    }
    if (gated.has(sessionID)) {
      // the repeat block still earns a trace — it's the answer to
      // "why didn't the agent get re-prompted?"
      await log(
        'info',
        `stop gate: already gated — not re-prompting (${reason || 'unfinished bro work'})`
      );
      return;
    }
    gated.add(sessionID);
    persistGated();
    const message = reason || 'unfinished bro work';
    await log('warn', `stop gate: ${message}`);
    // the log await is real I/O — a session.deleted landing inside it
    // retires the instance, and prompting now could hit a session that
    // reused the id
    if (!stillAlive()) {
      return;
    }
    try {
      await input.reprompt(sessionID, message);
    } catch (err) {
      await log('error', `stop gate could not re-prompt: ${errorText(err)}`);
    }
  };

  /** Dispatches the event stream into core handlers. */
  const onEvent = async (type: string, props: Record<string, unknown>): Promise<void> => {
    switch (type) {
      case 'session.created':
        onSessionCreated(props);
        break;
      case 'message.updated':
        onMessageUpdated(props);
        break;
      case 'session.compacted':
        onSessionCompacted(props);
        break;
      case 'session.deleted':
        onSessionDeleted(props);
        break;
      case 'session.idle':
        await onSessionIdle(props);
        break;
    }
  };

  return { probe, hydrate, onEvent, exec };
}

/* Plugin context (structural — tolerant of runtime drift)             */
/* ------------------------------------------------------------------ */

interface Registration {
  dispose?(): Promise<void>;
}

/** `ctx.<domain>.hook(name, cb)` — hook() is declared per domain and
 *  every call site is optional-chained: a drifted runtime missing a
 *  domain degrades to "not wired", not a setup throw. */
interface HookDomain<E> {
  hook?(
    name: string,
    callback: (event: E) => void | Promise<void>
  ): Promise<Registration | undefined>;
}

/** Superset of the session-hook event shapes we touch — `prompt`
 *  (admission draft), `context` and `compaction` (model request). The
 *  optional members partition it: a prompt event has no `system`, a
 *  context event has no `prompt`. */
interface SessionEvent {
  sessionID?: string;
  prompt?: { text?: string };
  system?: { type: string; text?: string }[];
  messages?: unknown[];
  options?: Record<string, unknown>;
}

interface ToolEvent {
  tool?: string;
  sessionID?: string;
  /** 'completed' | 'error' on execute.after */
  status?: string;
  input?: unknown;
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PermissionEvent {
  sessionID?: string;
  action?: string;
  resources?: unknown[];
  metadata?: Record<string, unknown>;
  effect?: string;
  message?: string;
}

interface ShellEvent {
  command?: string;
  cwd?: string;
  timeout?: number;
  shell?: string;
  env?: Record<string, string | undefined>;
}

/** `ctx.<domain>.transform(cb)` — synchronous registry edit returning a
 *  Registration. */
interface TransformDomain<E> {
  transform?(callback: (editor: E) => void): Promise<Registration | undefined>;
}

interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema — no zod in a standalone module. */
  input: Record<string, unknown>;
  options?: { namespace?: string };
  execute(input: unknown, context: unknown): Promise<unknown>;
}

interface ToolEditor {
  namespace?(ns: { name: string; description?: string }): void;
  add?(tool: ToolDef): void;
}

interface CommandEditor {
  add?(def: {
    name: string;
    description?: string;
    execute(input: {
      sessionID?: string;
      prompt?: { text?: string };
      delivery?: string;
    }): Promise<void>;
  }): void;
}

interface McpEditor {
  set?(name: string, config: Record<string, unknown>): void;
}

interface PluginContext {
  location?: { directory?: string };
  options?: PluginOptions;
  app?: { version?: string; log?(input: LogInput): Promise<unknown> };
  session?: HookDomain<SessionEvent> & {
    prompt?(input: { sessionID: string; text: string }): Promise<unknown>;
    synthetic?(input: { sessionID: string; text: string }): Promise<unknown>;
  };
  tool?: HookDomain<ToolEvent> & TransformDomain<ToolEditor>;
  command?: TransformDomain<CommandEditor>;
  mcp?: TransformDomain<McpEditor>;
  permission?: HookDomain<PermissionEvent>;
  shell?: HookDomain<ShellEvent>;
  event?: { subscribe?(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
  storage?: {
    get?(key: string): Promise<unknown>;
    set?(key: string, value: unknown): Promise<void>;
  };
}

/** Permission evaluation carries `resources` — for a bash ask, the command
 *  segments. The classifier wants the whole ask joined. */
function evalCommand(event: PermissionEvent): string {
  const resources = Array.isArray(event.resources)
    ? event.resources.filter((r): r is string => typeof r === 'string')
    : [];
  if (resources.length > 0) {
    return resources.join(' && ');
  }
  for (const key of ['command', 'cmd', 'pattern']) {
    const value = event.metadata?.[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

/** bro read-verbs exposed as `bro_<name>` model tools — args pinned so
 *  the model gets reads, never arbitrary bro. */
const BRO_TOOLS: ReadonlyArray<{ name: string; description: string; args: string[] }> = [
  {
    name: 'status',
    description:
      'bro live board — beads in-progress/ready, fleet agents, drill frame, branch (--json)',
    args: ['status', '--json'],
  },
  {
    name: 'convoy_status',
    description: 'bro molecule DAG — done/ready/blocked steps for the open convoy',
    args: ['convoy', 'status'],
  },
  {
    name: 'act_status',
    description:
      'PR review exit gate — nonzero while blocked; the exit code IS the verdict (--json)',
    args: ['act', 'status', '--json'],
  },
  {
    name: 'fleet',
    description: 'fleet snapshot — mols × steps × agents × worktrees × PRs',
    args: ['fleet'],
  },
];

/** `/bro` arguments — whitespace-split with "…"/'…' holding a multiword
 *  value together (`/bro learn capture "a note"` must not shred the
 *  note into four argv entries). Unmatched quotes degrade to the plain
 *  token — a mangled command still runs. Twin of opencode-tui.ts's
 *  copy — materialized files share no imports, keep them in sync. */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(m[1] ?? m[2] ?? m[3] ?? m[0]);
  }
  return args;
}

/** Where the nudge lands on a tool result — `output`/`content` take text
 *  directly; anything else rides metadata as `broContext`. */
function appendToolResult(result: Record<string, unknown> | null, text: string): unknown {
  if (result === null) {
    return { metadata: { broContext: text } };
  }
  if (typeof result.output === 'string') {
    return { ...result, output: `${result.output}\n\n${text}` };
  }
  if (typeof result.content === 'string') {
    return { ...result, content: `${result.content}\n\n${text}` };
  }
  return { ...result, metadata: { ...asRecord(result.metadata), broContext: text } };
}

export async function BroSetup(ctx: PluginContext): Promise<() => Promise<void>> {
  const core = makeCore({
    // ctx.location is where this plugin instance loaded — the right cwd
    // for hook spawns; cwd() is the floor when a runtime omits it.
    directory: ctx.location?.directory ?? process.cwd(),
    options: ctx.options,
    log: (level, message) => {
      try {
        return Promise.resolve(ctx.app?.log?.({ body: { service: 'bro', level, message } })).catch(
          () => undefined
        );
      } catch {
        return Promise.resolve(undefined);
      }
    },
    reprompt: (sessionID, text) => {
      const session = ctx.session;
      const fn = session?.prompt?.bind(session) ?? session?.synthetic?.bind(session);
      return fn ? fn({ sessionID, text }) : Promise.resolve(undefined);
    },
    persist:
      ctx.storage?.get !== undefined && ctx.storage?.set !== undefined
        ? {
            load: () => ctx.storage?.get?.('stop-gated') ?? Promise.resolve(undefined),
            save: ids =>
              Promise.resolve(ctx.storage?.set?.('stop-gated', [...ids])).then(() => undefined),
          }
        : undefined,
  });

  const pendingPromptContext = new Map<string, string>();
  const registrations: Promise<Registration | undefined>[] = [];
  const register = (r: Promise<Registration | undefined> | undefined): void => {
    // a hook domain that rejects registration (drifted shape, disabled
    // feature) is one unwired surface — never a failed setup
    if (r) {
      registrations.push(r.catch(() => undefined));
    }
  };

  // hydrated once per session, re-pushed on every model request —
  // "context" covers continuations, so the cache is what keeps it cheap
  register(
    ctx.session?.hook?.('context', async event => {
      const sessionID = event.sessionID;
      if (!sessionID || event.system === undefined) {
        return;
      }
      const text = await core.hydrate(sessionID, 'session-start');
      if (text) {
        event.system.push({ type: 'text', text });
      }
      if (sessionID) {
        const pending = pendingPromptContext.get(sessionID);
        if (pending && event.system !== undefined) {
          event.system.push({ type: 'text', text: pending });
          pendingPromptContext.delete(sessionID);
        }
      }
    })
  );

  register(
    ctx.session?.hook?.('compaction', async event => {
      const text = contextOf(
        await core.probe('pre-compact', { session_id: event.sessionID }, REHYDRATION_TIMEOUT_MS)
      );
      if (text && event.system !== undefined) {
        event.system.push({ type: 'text', text });
      }
    })
  );

  register(
    ctx.session?.hook?.('prompt', async event => {
      const prompt = event.prompt;
      if (prompt === undefined) {
        return;
      }
      const text = contextOf(
        await core.probe('prompt-submit', {
          session_id: event.sessionID,
          prompt: prompt.text ?? '',
        })
      );
      if (text && event.sessionID) {
        // keep injected context out of the visible prompt — it rides the
        // system context instead (see the context hook above)
        pendingPromptContext.set(event.sessionID, text);
      }
    })
  );

  register(
    ctx.tool?.hook?.('execute.before', async event => {
      const control = await core.probe('pre-tool', {
        session_id: event.sessionID,
        tool_name: event.tool,
        tool_input: asRecord(event.input) ?? {},
      });
      if (control === null) {
        return;
      }
      // bro's guard contract, translated: block becomes the throw that
      // vetoes the call; a tool_input override merges over the original
      // args — a connector rewriting `command` must not wipe `workdir`
      const override = asRecord(asRecord(control.hookSpecificOutput)?.tool_input);
      if (override) {
        event.input = { ...asRecord(event.input), ...override };
      }
      if (control.decision === 'block' || control.decision === 'deny') {
        const reason = typeof control.reason === 'string' ? control.reason.trim() : '';
        throw new Error(reason || 'blocked by bro');
      }
    })
  );

  register(
    ctx.tool?.hook?.('execute.after', async event => {
      const result = asRecord(event.result);
      const text = contextOf(
        await core.probe('post-tool', {
          session_id: event.sessionID,
          tool_name: event.tool,
          tool_input: asRecord(event.input) ?? asRecord(event.args) ?? {},
          tool_response: {
            success: event.status !== 'error' && toolSucceeded(asRecord(result?.metadata)),
          },
        })
      );
      if (text) {
        event.result = appendToolResult(result, text);
      }
    })
  );

  register(
    ctx.permission?.hook?.('evaluate', async event => {
      const command = evalCommand(event);
      if (!command) {
        return;
      }
      const control = await core.probe('permission', {
        tool_input: { command },
        session_id: event.sessionID,
      });
      if (control?.decision === 'approve') {
        event.effect = 'allow';
      } else if (control?.decision === 'deny' || control?.decision === 'block') {
        event.effect = 'deny';
        const reason = typeof control?.reason === 'string' ? control.reason.trim() : '';
        if (reason) {
          event.message = reason;
        }
      }
    })
  );

  register(
    ctx.shell?.hook?.('create.before', event => {
      if (event.env === undefined) {
        return;
      }
      // provenance only — never clobber an operator's own values
      event.env.BRO_AGENT_ID ??= 'opencode';
    })
  );

  // bro read-verbs as model-callable tools — args pinned so the model
  // gets reads, never arbitrary bro; the exit code prefixes the content
  // because a nonzero gate (`act status` blocked) IS the answer
  register(
    ctx.tool?.transform?.(editor => {
      editor.namespace?.({ name: 'bro', description: 'bro orchestration reads' });
      for (const tool of BRO_TOOLS) {
        editor.add?.({
          name: tool.name,
          description: tool.description,
          input: { type: 'object', properties: {}, additionalProperties: false },
          options: { namespace: 'bro' },
          execute: async () => {
            const { code, out, err } = await core.exec(tool.args);
            const body = out || err || '(no output)';
            return { content: code === 0 ? body : `exit ${code}: ${body}` };
          },
        });
      }
    })
  );

  // `/bro <args>` — run the verb, feed the output back as a prompt
  register(
    ctx.command?.transform?.(editor => {
      editor.add?.({
        name: 'bro',
        description: 'bro orchestration — `/bro [args]` runs the CLI and submits the output',
        execute: async ({ sessionID, prompt }) => {
          if (!sessionID || !ctx.session?.prompt) {
            return;
          }
          const args = splitArgs(prompt?.text ?? '');
          const verb = args.length > 0 ? args : ['status'];
          const { code, out, err } = await core.exec(verb);
          const body = out || err || '(no output)';
          const suffix = code === 0 ? '' : ` (exit ${code})`;
          await ctx.session.prompt({
            sessionID,
            text: `bro ${verb.join(' ')}${suffix}:\n${body}`,
          });
        },
      });
    })
  );

  // `bro serve` as a remote MCP server — strictly opt-in via plugin
  // options; nothing mounts a URL nobody asked for
  if (typeof ctx.options?.mcpPort === 'number') {
    const mcpPort = ctx.options.mcpPort;
    register(
      ctx.mcp?.transform?.(editor => {
        editor.set?.('bro', { type: 'remote', url: `http://127.0.0.1:${mcpPort}` });
      })
    );
  }

  // the stop gate rides the public event stream — dispatched without
  // awaiting so a session.deleted lands inside an in-flight idle gate
  const controller = new AbortController();
  const stream = ctx.event?.subscribe?.({ signal: controller.signal });
  if (stream) {
    void (async () => {
      for await (const raw of stream) {
        const e = asRecord(raw);
        const type = typeof e?.type === 'string' ? e.type : '';
        // fire-and-forget, never awaited: the idle gate suspends on real
        // I/O, and a session.deleted must land INSIDE an in-flight gate —
        // serializing the stream would replay it after the prompt sent
        if (type) {
          void core
            .onEvent(type, asRecord(e?.properties) ?? asRecord(e?.data) ?? {})
            .catch(() => {});
        }
      }
    })().catch(() => {});
  }

  return async () => {
    controller.abort();
    for (const pending of registrations) {
      try {
        await (await pending)?.dispose?.();
      } catch {
        // teardown must not throw into the host's unload path
      }
    }
  };
}

export default {
  id: 'bro',
  setup: BroSetup,
};

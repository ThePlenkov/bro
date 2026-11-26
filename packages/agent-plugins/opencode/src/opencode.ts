// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro — OpenCode V2 server plugin.
 *
 * The contract is https://opencode.ai/docs/build/plugins/server/ — a
 * `Plugin.define({ id, setup })` default export. The plugin ships as the
 * SERVER part of a three-part package:
 *
 *   ./server   this module — hooks, tools, commands, skills, RPC
 *   ./tui      the terminal half (opencode-tui.ts)
 *   ./rpc      the typed contract both halves and any client share
 *
 * What it wires:
 *
 *   session hooks     rehydrate bro state into the model request
 *                     (context), into a compaction (compaction), and turn a
 *                     prompt probe into system context (prompt)
 *   tool hooks        bro's guard (execute.before) and result enrichment
 *                     (execute.after)
 *   permission hook   bro's approve/deny verdict
 *   shell hook        BRO_AGENT_ID provenance
 *   tools             bro's read-verbs as `bro_*` model tools
 *   commands          `/bro [args]` and `/act`
 *   skills            bro's skills registered into opencode's skill registry
 *   RPC               `board` / `notify` / `prompt` methods and the
 *                     `changed` / `attention` events — the channel bro uses
 *                     to push state INTO opencode
 *
 * Fail-open: every hook is wrapped; a missing bro binary, timeout, nonzero
 * exit, or bad output degrades to no context / no gate / no re-prompt.
 * Nothing here throws into opencode. Spawns are async (server event loop).
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRO_COMMANDS,
  callHookDetailed,
  contextOf,
  createCommandResolver,
  HOOK_TIMEOUT_MS,
  type HookControl,
  hookFailureText,
  hookEmitEnv,
  REHYDRATION_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  runCommand,
} from '@broject/adapter-core/core';
import { Plugin } from '@opencode/plugin';
import { Bro, type BroBoard, emptyBoard, parseBoard } from './rpc.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const DEFAULT_STOP_REASON = 'unfinished bro work';
const BLOCKED_TOOL_REASON = 'blocked by bro';
const DEFAULT_COMMAND_OUTPUT = '(no output)';
const BRO_AGENT = 'opencode';

/** `["@broject/bro", { command: … }]` — opencode's tuple plugin form. */
interface PluginOptions {
  command?: string | { cmd: string; args?: string[] };
  /** Mount `bro serve` as a remote MCP server on this loopback port (opt-in). */
  mcpPort?: number;
  /** Extra directory to scan for bro skills (defaults to the sibling `skills/`). */
  skillsDir?: string;
}

interface StorageLike {
  get?(key: string): Promise<unknown>;
  set?(key: string, value: unknown): Promise<void>;
}

function makePersistence(storage: StorageLike | undefined): BroCoreInput['persist'] {
  if (!storage?.get || !storage.set) return undefined;
  return {
    load: () => storage.get?.('stop-gated') ?? Promise.resolve(undefined),
    save: ids => Promise.resolve(storage.set?.('stop-gated', [...ids])).then(() => undefined),
  };
}

/** Last-resort npx fallback specs, pinned first then latest — gen-plugins
 *  lists this file in VERSIONED_SOURCES, so the pin is rewritten to
 *  plugin.json's version on every gen/release run. */
const NPX_SPECS = ['@broject/bro@0.3.0', '@broject/bro'];

/** Env stamped on every `bro hooks` spawn so the CLI's adapter emit
 *  path journals this session into the hook spool — the in-process
 *  adapters bypass run.sh, which owns the shell-side writer
 *  (specs/bro-izpyk.9.md). A CLI that predates the marker ignores
 *  the env, so old↔new mixes degrade to the pre-emit status quo. */
const HOOK_ENV = hookEmitEnv('opencode', { npxPin: NPX_SPECS[0] });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCleanSession(sessionID: unknown, clean: Set<string>): sessionID is string {
  return typeof sessionID === 'string' && clean.delete(sessionID);
}

async function logControlHint(
  control: HookControl | null,
  log: (level: Level, message: string) => Promise<unknown>
): Promise<void> {
  const hint = contextOf(control);
  if (hint) await log('info', hint);
}

async function logAlreadyGated(
  reason: string,
  log: (level: Level, message: string) => Promise<unknown>
): Promise<void> {
  await log(
    'info',
    `stop gate: already gated — not re-prompting (${reason || DEFAULT_STOP_REASON})`
  );
}

function stopReason(control: HookControl | null): string {
  return typeof control?.reason === 'string' ? control.reason.trim() : '';
}

interface SystemMessage {
  push(value: { type: 'text'; text: string }): void;
}

function pushSystem(system: SystemMessage | undefined, text: string): void {
  if (system) system.push({ type: 'text', text });
}

function mergedToolInput(control: HookControl, input: unknown): Record<string, unknown> | null {
  const override = asRecord(asRecord(control.hookSpecificOutput)?.tool_input);
  return override ? { ...asRecord(input), ...override } : null;
}

function assertToolAllowed(control: HookControl): void {
  if (control.decision !== 'block' && control.decision !== 'deny') return;
  throw new Error(stopReason(control) || BLOCKED_TOOL_REASON);
}

function permissionEffect(control: HookControl | null): 'allow' | 'deny' | undefined {
  if (control?.decision === 'approve') return 'allow';
  if (control?.decision === 'deny' || control?.decision === 'block') return 'deny';
  return undefined;
}

interface StopGateOptions {
  control: HookControl | null;
  sessionID: string;
  stillAlive(): boolean;
  gated: Set<string>;
  persistGated(): void;
  log: (level: Level, message: string) => Promise<unknown>;
  reprompt(sessionID: string, text: string): Promise<unknown>;
}

async function finishStopGate(options: StopGateOptions): Promise<void> {
  const { control, sessionID, stillAlive, gated, persistGated, log, reprompt } = options;
  const reason = stopReason(control);
  if (gated.has(sessionID)) {
    await logAlreadyGated(reason, log);
    return;
  }
  gated.add(sessionID);
  persistGated();
  const message = reason || DEFAULT_STOP_REASON;
  await log('warn', `stop gate: ${message}`);
  if (!stillAlive()) return;
  try {
    await reprompt(sessionID, message);
  } catch (err) {
    await log('error', `stop gate could not re-prompt: ${errorText(err)}`);
  }
}

/** Did the tool succeed? bro arms its gates and cites skills only on success,
 * so a false positive here is worse than a false negative.
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
 * per-session rehydration cache, the stop-gate state, and the bus-event
 * handlers. `log` and `reprompt` are the client-shaped seams. */
interface BroCoreInput {
  directory: string;
  options?: PluginOptions;
  log(level: Level, message: string): Promise<unknown>;
  /** Feed the blocker back as a fresh turn. The core catches and logs a
   * reprompt failure — implementations only supply the call. */
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
  // and opencode loads plugins even in repos where bro is inert. The
  // shared resolver owns the ladder (pin → sibling → checkout → PATH →
  // npx) and the retry-on-failure window every adapter uses.
  const getCommand = createCommandResolver({
    command: options?.command,
    npxSpecs: NPX_SPECS,
  });

  const notify = (level: Level, message: string): void => {
    log(level, message).catch(() => {
      // diagnostics are deliberately best-effort
    });
  };
  let lastStopWarning = 0;

  const probe = async (
    event: string,
    payload: unknown,
    timeoutMs = HOOK_TIMEOUT_MS
  ): Promise<HookControl | null> => {
    const resolved = await getCommand();
    if (!resolved) {
      notify('debug', `bro probe skipped (no cli) for event=${event}`);
      return null;
    }
    const result = await callHookDetailed(resolved, {
      event,
      payload,
      cwd: directory,
      timeoutMs,
      extraEnv: HOOK_ENV,
    });
    if (result.failure !== null) {
      const message = hookFailureText(result.failure);
      if (event === 'stop' && Date.now() - lastStopWarning >= 15 * 60_000) {
        lastStopWarning = Date.now();
        notify('warn', `stop gate did not run (${message})`);
      } else {
        notify('debug', `probe failed (${message})`);
      }
    } else if (result.control === null) {
      notify('debug', `bro probe returned null for event=${event}`);
    }
    return result.control;
  };

  /** Spawn `<bro> args` and capture stdout — the read-verb path tool
   * executions and commands share. Never rejects: no resolved CLI,
   * a spawn error, or a timeout resolves with what printed. The code
   * travels in the result because a nonzero exit IS the answer for
   * gate verbs like `act status`. */
  const exec = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
    getCommand().then(async resolved => {
      if (resolved === null) {
        return { code: 127, out: '', err: 'no bro command resolved' };
      }
      const result = await runCommand(resolved.cmd, [...resolved.args, ...args], {
        cwd: directory,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      const code =
        result.code ?? (result.error !== null && result.error.startsWith('timed out') ? 124 : 127);
      return {
        code,
        out: result.stdout.trim(),
        err: (result.stderr !== '' ? result.stderr : (result.error ?? '')).trim(),
      };
    });

  /** Rehydration is per session, not per turn: the context hook runs on every
   * request, so the probe runs once and the answer is re-pushed each turn —
   * which is also what carries it across compaction. The cache holds the
   * in-flight promise, not its result, so a `session.created` prime and a
   * first turn racing each other share one probe instead of two. A FAILED
   * probe is evicted rather than cached — timing out once is not the
   * session's verdict, and the next turn deserves a retry; only a real
   * answer (including an empty one) is sticky. */
  const rehydration = new Map<string, Promise<string | undefined>>();
  const hydrate = (
    sessionID: string,
    event: 'session-start' | 'post-compaction'
  ): Promise<string | undefined> => {
    const pending = rehydration.get(sessionID);
    if (pending) {
      return pending;
    }
    notify('debug', `bro hydrate starting for session=${sessionID} event=${event}`);
    const started = probe(event, { session_id: sessionID }, REHYDRATION_TIMEOUT_MS).then(
      control => {
        // evict only our own failed entry — a compaction may have already
        // replaced it with a newer probe, which must not be deleted out
        // from under the session that owns it
        if (control === null && rehydration.get(sessionID) === started) {
          rehydration.delete(sessionID);
        }
        const ctx = contextOf(control);
        if (ctx) {
          notify(
            'debug',
            `bro hydrate injected context for session=${sessionID} len=${ctx.length}`
          );
        }
        return ctx;
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
   * merge would otherwise resurrect the gate onto a session reusing the
   * id and its first block would be swallowed as a repeat. */
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
      .catch(() => {
        // persistence is best-effort
      })
      .finally(() => {
        persistLoaded = true;
        retiredDuringLoad.clear();
      });
  }
  /** Sessions whose last assistant turn finished cleanly. */
  const clean = new Set<string>();
  /** Sessions observed alive. `session.deleted` is the only retirement, and
   * the idle gate suspends on real I/O — liveness is re-checked after each
   * suspending await before the re-prompt goes out, never assumed. The
   * value is an instance token minted per observing event, not membership:
   * a delete followed by an id-reusing create leaves the map occupied by a
   * *different* session, and a bare `has` would wave a stale gate through
   * to it. */
  const live = new Map<string, number>();
  let liveSeq = 0;

  /** `session.deleted` retires the per-session structures — they live as
   * long as the plugin process, not the session, so without this a
   * long-lived server accumulates dead entries. */
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
   * post-compaction state instead of the pre-compaction snapshot. */
  const onSessionCompacted = (props: Record<string, unknown>): void => {
    const sessionID = props.sessionID;
    if (typeof sessionID !== 'string') {
      return;
    }
    rehydration.delete(sessionID);
    void hydrate(sessionID, 'post-compaction');
  };

  /** Turn completion is the stop gate — `session.idle` on v1 hosts,
   *  `session.execution.succeeded` on v2. Gated sessions pass
   *  `stop_hook_active`, so bro skips its own re-evaluation — the
   *  one-shot guard is bro's, not duplicated here. */
  const onSessionIdle = async (props: Record<string, unknown>): Promise<void> => {
    const sessionID = props.sessionID;
    if (!isCleanSession(sessionID, clean)) {
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
    if (control?.decision !== 'block') {
      await logControlHint(control, log);
      return;
    }
    // the probe awaited real I/O — a session.deleted that interleaved retired
    // this instance, and gating it now would resurrect the entry and suppress
    // a session reusing it. The gate is set before the log/prompt awaits for
    // the same reason: a delete during them must clear it, not race it.
    if (!stillAlive()) {
      return;
    }
    await finishStopGate({
      control,
      sessionID,
      stillAlive,
      gated,
      persistGated,
      log,
      reprompt: input.reprompt,
    });
  };

  /** Dispatches the v2 event stream into core handlers.
   *
   *  opencode ≥2.x never emits the v1 names — `session.idle` is declared
   *  in the schema but nothing publishes it (opencode#55358), and
   *  `session.created`/`message.updated`/`session.compacted` are absent
   *  from the public stream (verified live on 2.2.7). The v2 lifecycle
   *  is `session.execution.{started,succeeded,failed,interrupted}` plus
   *  `session.compaction.*` and `session.deleted` (that name survived).
   *  A succeeded execution is simultaneously the clean-turn verdict and
   *  the idle moment, so it feeds both the `clean` set and the stop
   *  gate in one step. */
  const onEvent = async (type: string, props: Record<string, unknown>): Promise<void> => {
    const sessionID = typeof props.sessionID === 'string' ? props.sessionID : undefined;
    // any session-scoped event proves liveness — mint the token only
    // once, or every event would invalidate an in-flight idle gate
    if (sessionID !== undefined && !live.has(sessionID)) {
      live.set(sessionID, ++liveSeq);
    }
    switch (type) {
      case 'session.execution.started':
        if (sessionID !== undefined) void hydrate(sessionID, 'session-start');
        return;
      case 'session.execution.succeeded':
        if (sessionID === undefined) return;
        clean.add(sessionID);
        await onSessionIdle({ sessionID });
        return;
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        if (sessionID !== undefined) clean.delete(sessionID);
        return;
      case 'session.compaction.succeeded':
      case 'session.compaction.ended':
        onSessionCompacted(props);
        return;
      case 'session.deleted':
        onSessionDeleted(props);
        return;
    }
  };

  return { probe, hydrate, onEvent, exec };
}

/* Plugin context (structural — tolerant of runtime drift)             */
/* ------------------------------------------------------------------ */

interface Registration {
  dispose?(): Promise<void>;
}

/** The second argument every RPC handler receives: an abort signal plus
 *  the `error` factory that mints a DECLARED error (one named in the
 *  contract's `errors` map). The factory is a plain function that returns
 *  the error value — it does not throw. */
interface RpcCallContext {
  signal?: AbortSignal;
  error?: (type: string, message: string, data?: unknown) => unknown;
}

/**
 * Mint a declared RPC error, tolerating a host that hands us no context.
 *
 * The contract's `errors` map is the promise to the caller: `no_session`
 * comes back as `no_session`, not as a 500 and not as a crash. The host
 * provides `context.error`; when it is missing we still have to answer
 * with SOMETHING shaped like the declared error, so we build it by hand.
 */
function declaredError(
  context: RpcCallContext | undefined,
  type: string,
  message: string,
  data?: unknown
): unknown {
  if (typeof context?.error === 'function') {
    try {
      return context.error(type, message, data);
    } catch {
      // a host whose error factory throws is still a host — fall through
    }
  }
  return { type, message, data };
}

/** `ctx.<domain>.hook(name, cb)` — hook() is declared per domain and
 * every call site is optional-chained: a drifted runtime missing a
 * domain degrades to "not wired", not a setup throw. */
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

/** The skill registry editor — `ctx.skill.transform` adds bro's skills to
 *  opencode's own skill list, so `/bro`-family skills are available to the
 *  model the same way built-in skills are. */
interface SkillEditor {
  list?(): readonly Record<string, unknown>[];
  get?(id: string): Record<string, unknown> | undefined;
  add?(skill: Record<string, unknown>): void;
  remove?(id: string): void;
}

interface PluginContext {
  location?: { directory?: string };
  options?: PluginOptions;
  app?: { version?: string; channel?: string; name?: string };
  session?: HookDomain<SessionEvent> & {
    prompt?(input: { sessionID: string; text: string }): Promise<unknown>;
    synthetic?(input: { sessionID: string; text: string }): Promise<unknown>;
    get?(input: { sessionID: string }): Promise<unknown>;
    switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>;
  };
  tool?: HookDomain<ToolEvent> & TransformDomain<ToolEditor>;
  command?: TransformDomain<CommandEditor>;
  mcp?: TransformDomain<McpEditor>;
  permission?: HookDomain<PermissionEvent>;
  shell?: HookDomain<ShellEvent>;
  skill?: TransformDomain<SkillEditor> & { list?(): Promise<unknown> };
  event?: { subscribe?(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
  storage?: {
    get?(key: string): Promise<unknown>;
    set?(key: string, value: unknown): Promise<void>;
  };
  rpc?: {
    register?(
      definition: typeof Bro,
      handlers: Record<string, unknown>
    ): Promise<Registration & { events: { emit(name: string, data: unknown): Promise<void> } }>;
  };
}

/** Permission evaluation carries `resources` — for a bash ask, the command
 * segments. The classifier wants the whole ask joined. */
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
 * the model gets reads, never arbitrary bro. */
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
  {
    name: 'next',
    description: 'bro next actionable work — pick the next ready bead respecting constraints',
    args: ['next', '--list'],
  },
  {
    name: 'drill_status',
    description: 'current drill frame status — scoped investigation context',
    args: ['work', 'drill', 'status'],
  },
  {
    name: 'review_threads',
    description: 'unresolved PR review threads for current branch/PR',
    args: ['review', 'act', 'threads'],
  },
  {
    name: 'worktree_status',
    description: 'worktree and branch hygiene — dirty/uncommitted changes',
    args: ['status', '--json'],
  },
];

/** Tool registration options — `codemode: false` keeps the reads as
 * direct `bro_*` function tools; the plugin SDK's `Info.options` type
 * predates the field, so the literal is widened once here. */
const BRO_TOOL_OPTIONS = { namespace: 'bro', codemode: false } as const;

/** `/bro` arguments — whitespace-split with "…"/'…' holding a multiword
 * value together (`/bro learn capture "a note"` must not shred the
 * note into four argv entries). Unmatched quotes degrade to the plain
 * token — a mangled command still runs. */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(m[1] ?? m[2] ?? m[3] ?? m[0]);
  }
  return args;
}

function cleanCommandOutput(body: string): string {
  return body
    .split('\n')
    .filter(line => {
      if (!line.trim()) return true;
      const words = line.trim().toLowerCase().split(/\s+/);
      return !(words[0] === 'bro' && words[1] === 'learn');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function tryPrompt(
  prompt: ((input: { sessionID: string; text: string }) => Promise<unknown>) | undefined,
  sessionID: string,
  text: string
): Promise<boolean> {
  if (!prompt) return false;
  try {
    await prompt({ sessionID, text });
    return true;
  } catch {
    return false;
  }
}

interface Notification {
  sessionID?: string;
  title: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

function readNotification(input: unknown): Notification | null {
  const { sessionID, text, title, variant } = asRecord(input) ?? {};
  if (typeof text !== 'string' || text.trim() === '') return null;
  return {
    sessionID: validSessionID(sessionID),
    title: validTitle(title),
    message: warningMessage(text, variant),
    severity: notificationSeverity(variant),
  };
}

function validSessionID(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function validTitle(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : 'bro';
}

function warningMessage(text: string, variant: unknown): string {
  return variant === 'error' || variant === 'warning' ? `⚠ ${text}` : text;
}

function notificationSeverity(variant: unknown): Notification['severity'] {
  if (variant === 'error') return 'error';
  if (variant === 'warning') return 'warning';
  return 'info';
}

async function submitPrompt(options: {
  switchAgent?: (input: { sessionID: string; agent: string }) => Promise<unknown>;
  prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  sessionID: string;
  text: string;
  agent?: string;
}): Promise<boolean> {
  const { switchAgent, prompt, sessionID, text, agent } = options;
  if (agent) await switchAgent?.({ sessionID, agent });
  await prompt?.({ sessionID, text });
  return true;
}

/** Where the nudge lands on a tool result — `output`/`content` take text
 * directly; anything else rides metadata as `broContext`. */
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

/* bro skills — the tree opencode should learn                          */
/* ------------------------------------------------------------------ */

/** One skill as opencode's registry wants it. */
interface BroSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

interface SkillFileReader {
  stat(path: string): { isFile(): boolean };
  read(path: string, encoding: 'utf8'): string;
}

function readSkillFile(reader: SkillFileReader, root: string, entry: string): BroSkill | null {
  const path = join(root, entry, 'SKILL.md');
  try {
    if (!reader.stat(path).isFile()) return null;
    const content = reader.read(path, 'utf8');
    const parsed = parseSkill(content);
    if (!parsed) return null;
    return {
      id: entry,
      name: parsed.name ?? entry,
      description: parsed.description ?? '',
      path,
      content,
    };
  } catch {
    return null;
  }
}

/** Parse a `SKILL.md` frontmatter block — `name`, `description`, and the
 * optional `autoinvoke` flag. A file without frontmatter is not a skill;
 * it is skipped rather than half-registered. */
function parseSkill(markdown: string): { name?: string; description?: string } | null {
  const front = frontmatter(markdown);
  if (front === null) return null;
  const name = readFrontmatterValue(front, 'name');
  const description = readFrontmatterValue(front, 'description');
  if (!name || !description) return null;
  return {
    name: name.replace(/^["']|["']$/g, ''),
    description: description.replace(/^["']|["']$/g, ''),
  };
}

function frontmatter(markdown: string): string | null {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  return end < 0 ? null : markdown.slice(3, end);
}

function readFrontmatterValue(front: string, key: string): string | undefined {
  const pattern = key === 'name' ? /^\s*name:\s*(\S[^\r\n]*)/m : /^\s*description:\s*(\S[^\r\n]*)/m;
  return pattern.exec(front)?.[1]?.trim();
}

/** Auto-discovered skills roots must look like BRO's tree before they
 *  are registered — the ancestor walk-up can land on a foreign `skills/`
 *  dir (e.g. opencode's own `~/.config/opencode/skills`), and registering
 *  somebody else's skills under bro's name is worse than registering
 *  none. `sdd` is bro's canonical skill — every shipped tree carries it.
 *  An explicit `skillsDir` is the operator's choice and skips the check. */
const BRO_SKILLS_SENTINEL = 'sdd';

export function isBroSkillsRoot(root: string): boolean {
  try {
    return statSync(join(root, BRO_SKILLS_SENTINEL, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

/** The directories that may hold bro's skills, most specific first:
 *  an explicit option, the materialized sibling `skills/`, the npm
 *  package's `skills/`, then the checkout's `skills/`.
 *
 *  An explicit `skillsDir` is AUTHORITATIVE: it is the only root tried.
 *  Falling back to the checkout when it points nowhere would register a
 *  different skill set than the operator asked for — a silent mismatch
 *  between what was configured and what opencode learned. */
export function skillRoots(options: PluginOptions | undefined): string[] {
  if (typeof options?.skillsDir === 'string' && options.skillsDir.trim() !== '') {
    return [options.skillsDir];
  }
  const roots: string[] = [];
  roots.push(fileURLToPath(new URL('./skills', import.meta.url)));
  roots.push(fileURLToPath(new URL('../skills', import.meta.url)));
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    roots.push(join(dir, 'skills'));
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return roots;
}

export async function BroSetup(ctx: PluginContext): Promise<() => Promise<void>> {
  // v2 dropped `ctx.app.log` — the server writes plugin stdout/stderr to
  // its own log, and a missing sink must never break a hook.
  const log = (level: Level, message: string): Promise<void> => {
    try {
      // stderr only: the host captures the plugin's stderr into its log,
      // and a stdout line lands nowhere the operator can read it
      console.error(`[bro] ${level}: ${message}`);
    } catch {
      // a host that closed stderr must not break the hook
    }
    return Promise.resolve(undefined);
  };
  const core = makeCore({
    // ctx.location is where this plugin instance loaded — the right cwd
    // for hook spawns; cwd() is the floor when a runtime omits it.
    directory: ctx.location?.directory ?? process.cwd(),
    options: ctx.options,
    log,
    reprompt: (sessionID, text) => {
      const session = ctx.session;
      const fn = session?.prompt?.bind(session) ?? session?.synthetic?.bind(session);
      return fn ? fn({ sessionID, text }) : Promise.resolve(undefined);
    },
    persist: makePersistence(ctx.storage),
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
      if (text) pushSystem(event.system, text);
      const pending = pendingPromptContext.get(sessionID);
      if (pending) {
        pushSystem(event.system, pending);
        pendingPromptContext.delete(sessionID);
      }
    })
  );

  register(
    ctx.session?.hook?.('compaction', async event => {
      try {
        const text = contextOf(
          await core.probe('pre-compact', { session_id: event.sessionID }, REHYDRATION_TIMEOUT_MS)
        );
        if (text && event.system !== undefined) {
          event.system.push({ type: 'text', text });
        }
      } catch {
        // fail-open
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
      const merged = mergedToolInput(control, event.input);
      if (merged) event.input = merged;
      assertToolAllowed(control);
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
      const effect = permissionEffect(control);
      if (!effect) return;
      event.effect = effect;
      const reason = stopReason(control);
      if (reason) {
        event.message = reason;
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
          options: BRO_TOOL_OPTIONS,
          execute: async () => {
            const { code, out, err } = await core.exec(tool.args);
            const body = out || err || DEFAULT_COMMAND_OUTPUT;
            return { content: code === 0 ? body : `exit ${code}: ${body}` };
          },
        });
      }
    })
  );

  // `/bro <args>` and shortcuts — run the verb, submit output as a prompt
  register(
    ctx.command?.transform?.(editor => {
      const run = async (
        sessionID: string | undefined,
        argv: string[],
        label: string
      ): Promise<void> => {
        if (!sessionID || !ctx.session?.prompt) {
          return;
        }
        const { code, out, err } = await core.exec(argv);
        const body = cleanCommandOutput(out || err || DEFAULT_COMMAND_OUTPUT);
        const suffix = code === 0 ? '' : ` (exit ${code})`;
        await ctx.session.prompt({
          sessionID,
          text: `${label}${suffix}:\n${body}`,
        });
      };
      editor.add?.({
        name: 'bro',
        description: 'bro orchestration — `/bro [args]` runs the CLI and submits the output',
        execute: async ({ sessionID, prompt }) => {
          const args = splitArgs(prompt?.text ?? '');
          const verb = args.length > 0 ? args : ['status'];
          await run(sessionID, verb, `bro ${verb.join(' ')}`);
        },
      });
      // Command family — same table the pi/omp lineage registers. A
      // host-native command of the same name always wins: opencode 2.x
      // owns `/goal` natively (verified in the binary), so that alias
      // lands on `bro:goal`; the rest keep bare names.
      const natives = new Set(['goal']);
      for (const c of BRO_COMMANDS) {
        const name = natives.has(c.name) ? `bro:${c.name}` : c.name;
        editor.add?.({
          name,
          description: c.description,
          execute: async ({ sessionID, prompt }) => {
            const args = splitArgs(prompt?.text ?? '');
            const verb = [c.verb, ...args];
            await run(sessionID, verb, `bro ${verb.join(' ')}`);
          },
        });
      }
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

  /* RPC — the channel bro pushes INTO opencode                          */
  /* ------------------------------------------------------------------ */

  // The board snapshot every RPC reader gets. Built from `bro status
  // --json` by the shared parser, so the server and the TUI widget can
  // never disagree about what the board is.
  const boardSnapshot = async (): Promise<BroBoard> => {
    const { code, out } = await core.exec(['status', '--json']);
    if (code !== 0 || out === '') {
      return emptyBoard();
    }
    return parseBoard(out);
  };

  const rpcRegistration = ctx.rpc?.register?.(Bro, {
    board: async () => boardSnapshot(),

    notify: async (input: unknown, _context?: RpcCallContext) => {
      const notification = readNotification(input);
      if (!notification) return { delivered: false };
      const { sessionID, title, message, severity } = notification;
      if (sessionID && (await tryPrompt(ctx.session?.prompt, sessionID, `${title}: ${message}`))) {
        return { delivered: true };
      }
      // no session — the event still reaches every TUI listening on the
      // contract, which is the point of an RPC event
      await emitRpc('attention', {
        title,
        message,
        severity,
      });
      return { delivered: true };
    },

    prompt: async (input: unknown, context?: RpcCallContext) => {
      const { sessionID, text, agent } = asRecord(input) ?? {};
      if (typeof sessionID !== 'string' || sessionID === '') {
        return declaredError(context, 'no_session', 'sessionID is required', { sessionID: '' });
      }
      if (typeof text !== 'string' || text.trim() === '') {
        return { accepted: false };
      }
      try {
        await submitPrompt({
          switchAgent: ctx.session?.switchAgent,
          prompt: ctx.session?.prompt,
          sessionID,
          text,
          agent: typeof agent === 'string' && agent !== '' ? agent : undefined,
        });
        return { accepted: true };
      } catch {
        return declaredError(context, 'no_session', 'session not available', { sessionID });
      }
    },
  });
  // the registration is the ONLY way to emit on the contract — keep the
  // handle so the event helpers below can publish through it.
  let emitRpc: (name: string, data: unknown) => Promise<void> = async () => undefined;
  register(
    (rpcRegistration ?? Promise.resolve(undefined))?.then(reg => {
      if (reg !== undefined) {
        emitRpc = async (name, data) => {
          try {
            await reg.events.emit(name as 'changed', data as never);
          } catch {
            // a subscriber that throws must not break the caller
          }
        };
      }
      return reg;
    })
  );

  /* bro skills — the tree opencode should learn                          */
  /* ------------------------------------------------------------------ */

  const skills = await collectBroSkills(ctx.options);
  if (skills.length > 0) {
    register(
      ctx.skill?.transform?.(editor => {
        for (const skill of skills) {
          editor.add?.({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            path: skill.path,
            content: skill.content,
          });
        }
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

  // one line that says the plugin is LIVE — the host's own log carries
  // it, so a blank sidebar can be told apart from a slow setup
  await log('info', `plugin ready — ${skills.length} bro skill(s), RPC 'bro' registered`);

  return async () => {
    controller.abort();
    for (const pending of registrations) {
      try {
        const registration = await pending;
        if (registration?.dispose) {
          await registration.dispose();
        }
      } catch {
        // teardown must not throw into the host's unload path
      }
    }
  };
}

/** Read bro's skills off disk and shape them for opencode's registry.
 *  Every failure mode — a missing tree, an unreadable file, a file
 *  without frontmatter — drops that one skill, never the whole set. */
export async function collectBroSkills(options: PluginOptions | undefined): Promise<BroSkill[]> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const out: BroSkill[] = [];
  const seen = new Set<string>();
  const explicit = typeof options?.skillsDir === 'string' && options.skillsDir.trim() !== '';
  for (const root of skillRoots(options)) {
    // auto-discovered roots must carry bro's sentinel skill — without
    // it the walk-up found a foreign skills/ dir, not ours
    if (!explicit && !isBroSkillsRoot(root)) {
      continue;
    }
    let entries: string[];
    try {
      if (!existsSync(root)) {
        continue;
      }
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skill = readSkillFile({ stat: statSync, read: readFileSync }, root, entry);
      if (!skill) continue;
      const id = entry;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(skill);
    }
    if (out.length > 0) {
      // the first root that yields skills wins — a materialized sibling
      // must not be shadowed by the checkout's tree
      break;
    }
  }
  return out;
}

/** The plugin as opencode loads it: `id` + `setup`. The setup signature
 *  stays STRUCTURAL on purpose — the implementation reads a partial ctx
 *  (a drifted runtime missing a domain degrades to "not wired", never a
 *  setup throw), and the tests drive it with a partial ctx too. The SDK's
 *  `Plugin.define` is applied at the export site, where the one cast
 *  bridges the structural view to the published contract. */
export interface BroPlugin {
  readonly id: string;
  readonly setup: (context: PluginContext) => Promise<() => Promise<void>>;
}

/** `Plugin.define` at runtime — opencode's own loader is what reads the
 *  default export, and the published contract asks for this exact shape.
 *  The cast below narrows the SDK's stricter signature back to the
 *  structural one the implementation actually honours. */
const defined = Plugin.define({
  id: 'bro',
  setup: BroSetup as unknown as (context: Plugin.Context) => Promise<() => Promise<void>>,
});

export default defined as unknown as BroPlugin;

/**
 * The shared bro adapter driver.
 *
 * The core (adapter/core.ts) knows how to *ask* bro. This module knows
 * *when* to ask and what to do with the answer — and it does so once,
 * for every host. A client adapter supplies only the host's own shape:
 * its event names, its UI calls, and how it spells "refuse to stop".
 *
 * That split is the whole point. Before it, each client re-implemented
 * the same lifecycle (hydrate → nudge → inject → arm → gate) and the
 * same CLI ladder, and the copies drifted: pi had no `options.command`
 * tier, kilo's doc claimed an npx tier its code never had. One driver
 * cannot drift from itself.
 *
 * ## The host contract
 *
 * `BroHostBinding` is deliberately small — it is the *difference*
 * between hosts, nothing else. Everything else (probe ordering, cache
 * lifetimes, fail-open behavior) lives here.
 *
 * ## Lifecycle
 *
 *   session_start ──▶ probe session-start ──▶ cache hydration
 *                          │
 *   before_agent_start ◀──┴──▶ probe prompt-submit ──▶ inject
 *                              hydration + nudge (one hidden message)
 *
 *   tool_result ──▶ probe post-tool ──▶ arm the session, append a nudge
 *
 *   session_stop ──▶ probe stop ──▶ refuse the stop, or let it land
 *
 * The stop gate is the one place bro *blocks* rather than advises, so
 * it is the one place the driver is careful: the host says whether it
 * already refused once (omp reports `stop_hook_active`; pi needs a
 * local flag), and the driver passes that back to bro so bro's own
 * one-shot rule decides.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import {
  type BoardStatus,
  BRO_COMMANDS,
  boardLines,
  broEnabled,
  type Command,
  callHook,
  contextOf,
  createCommandResolver,
  HOOK_TIMEOUT_MS,
  type HookControl,
  hookEmitEnv,
  REHYDRATION_TIMEOUT_MS,
  RESOLVE_RETRY_MS,
  RUN_TIMEOUT_MS,
  statusCrumb,
  statusJson,
} from './core.ts';

export { RESOLVE_RETRY_MS, RUN_TIMEOUT_MS };

/** The board's widget key — one slot, owned by bro. */
export const BOARD_KEY = 'bro';
const CONTEXT_MESSAGE_TYPE = 'bro-context';
const TEXT_CONTENT_TYPE = 'text';
const TUI_MODE = 'tui';
const SESSION_START_EVENT = 'session-start';
const POST_COMPACTION_EVENT = 'post-compaction';
const PRE_COMPACT_EVENT = 'pre-compact';
const PROMPT_SUBMIT_EVENT = 'prompt-submit';
const POST_TOOL_EVENT = 'post-tool';
const STOP_EVENT = 'stop';

/** The context shape this API lineage shares.
 *
 *  pi and omp are the same extension API lineage: the same `ctx.ui`,
 *  the same `ctx.mode`, the same `ctx.sessionManager`. Only the
 *  *vocabulary* differs — the event names and the stop refusal. */
export interface BroContext {
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, content: string[] | undefined): void;
  };
  cwd: string;
  mode: 'tui' | 'rpc' | 'json' | 'print';
  hasUI: boolean;
  sessionManager: { getSessionId(): string | undefined };
}

/** The event names this lineage shares. A host that spells one
 *  differently overrides it — pi's settle gate is not omp's stop. */
const LINEAGE_EVENTS = {
  sessionStart: 'session_start',
  sessionBeforeCompact: 'session_before_compact',
  sessionCompact: 'session_compact',
  beforeAgentStart: 'before_agent_start',
  toolResult: 'tool_result',
  turnEnd: 'turn_end',
  sessionShutdown: 'session_shutdown',
} as const;

/** What a host must supply: the parts that are genuinely its own. */
export interface BroHostShape<Ctx extends BroContext> {
  /** The ledger host name — stamped on every `bro hooks` spawn as
   *  `BRO_HOOK_HOST` so the session ledger sees this host's firings
   *  (specs/bro-izpyk.9.md). */
  kind: string;
  /** The host's stop event. */
  stop: string;
  /** Register a handler. */
  on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void;
  /** Paint the board. */
  paint(ctx: Ctx, lines: string[], crumb: string): void;
  /** Tell the user something. */
  notify(ctx: Ctx, text: string, level: 'info' | 'warning' | 'error'): void;
  /** Optional argument completion for /bro. */
  argumentCompletions?(prefix: string): Array<{ label: string; value: string }> | null;
  /** Slash commands the host already owns natively — a bro family
   *  alias never shadows them; collisions register as `bro:<name>`
   *  instead (AGT-1 §command family). */
  nativeCommands?: readonly string[];
  /** Build the result that refuses to stop, with the reason. */
  refuseStop(reason: string): unknown;
  /** Whether the stop event says the host already refused once. */
  stopAlreadyRefused(event: unknown): boolean;
  /** Whether this stop event is an abort/error the gate must not
   *  resurrect — pi's settle gate is the only host with outcomes. */
  stopAborted?(event: unknown): boolean;
  /** The npx spec to fall back to — the published version of this adapter.
   *  sharedBinding forwards it to the binding and stamps its version
   *  into the hook env's BRO_HOOK_ADAPTER column. */
  readonly npxPin?: string;
}

/**
 * Build a binding for a host in this lineage.
 *
 * Everything the lineage agrees on — the session id, the cwd, the paint
 * check, the message shapes, the event names — is filled in here. A
 * binding is left holding only what its host actually spells
 * differently, which is the whole point: a binding that re-copies the
 * lineage's shape is a binding that will drift.
 */
export function sharedBinding<Ctx extends BroContext>(
  host: BroHostShape<Ctx>
): BroHostBinding<Ctx> {
  return {
    events: { ...LINEAGE_EVENTS, stop: host.stop },
    on: host.on,
    sessionId(ctx) {
      return ctx.sessionManager.getSessionId() ?? '';
    },
    cwd(ctx) {
      return ctx.cwd;
    },
    canPaint(ctx) {
      return ctx.mode === TUI_MODE;
    },
    paint: host.paint,
    clear(ctx) {
      ctx.ui.setWidget(BOARD_KEY, undefined);
      ctx.ui.setStatus(BOARD_KEY, undefined);
    },
    notify: host.notify,
    argumentCompletions: undefined,
    refuseStop: host.refuseStop,
    stopAlreadyRefused: host.stopAlreadyRefused,
    stopAborted: host.stopAborted,
    promptOf(event) {
      const turn = event as { prompt?: string; text?: string };
      if (typeof turn.prompt === 'string') {
        return turn.prompt;
      }
      return typeof turn.text === 'string' ? turn.text : '';
    },
    inject(text) {
      return {
        message: {
          customType: CONTEXT_MESSAGE_TYPE,
          content: text,
          display: false,
        },
      };
    },
    appendToolResult(event, text) {
      const result = event as { content?: Array<{ type: typeof TEXT_CONTENT_TYPE; text: string }> };
      const content = Array.isArray(result.content) ? [...result.content] : [];
      content.push({ type: TEXT_CONTENT_TYPE, text });
      return { content };
    },
    npxPin: host.npxPin,
    nativeCommands: host.nativeCommands,
    hookEnv: hookEmitEnv(host.kind, { npxPin: host.npxPin }),
  };
}

/** How a host spells the things the driver needs.
 *
 *  Generic over the host's context type: the driver passes the host's
 *  own context object through, so the binding can read `ctx.ui` and
 *  `ctx.cwd` without a cast at every call site. */
export interface BroHostBinding<Ctx = unknown> {
  /** The host's event names. A host without one of these omits the
   *  key and the driver skips that behavior. */
  readonly events: {
    sessionStart?: string;
    sessionBeforeCompact?: string;
    sessionCompact?: string;
    beforeAgentStart?: string;
    toolResult?: string;
    stop?: string;
    turnEnd?: string;
    sessionShutdown?: string;
  };
  /** Register a handler. */
  on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void;
  /** The host's session id — empty when it has none. */
  sessionId(ctx: Ctx): string;
  /** The host's working directory. */
  cwd(ctx: Ctx): string;
  /** Whether the host can paint UI right now. */
  canPaint(ctx: Ctx): boolean;
  /** Paint the board. */
  paint(ctx: Ctx, lines: string[], crumb: string): void;
  /** Remove the board. */
  clear(ctx: Ctx): void;
  /** Tell the user something. */
  notify(ctx: Ctx, text: string, level: 'info' | 'warning' | 'error'): void;
  /** Optional argument completion for /bro. */
  argumentCompletions?(prefix: string): Array<{ label: string; value: string }> | null;
  /** Build the result that refuses to stop, with the reason. */
  refuseStop(reason: string): unknown;
  /** Whether the stop event says the host already refused once. */
  stopAlreadyRefused(event: unknown): boolean;
  /** Whether this stop event is an abort/error the gate must not
   *  resurrect — pi settles carry an outcome, and refusing an
   *  aborted turn would resume a turn the user already cancelled.
   *  Hosts without outcomes omit it. */
  stopAborted?(event: unknown): boolean;
  /** The prompt behind a turn. */
  promptOf(event: unknown): string;
  /** Slash commands the host already owns natively — a bro family
   *  alias never shadows them; collisions register as `bro:<name>`
   *  instead (AGT-1 §command family). */
  nativeCommands?: readonly string[];
  /** Build the result that injects a hidden context message. */
  inject(text: string): unknown;
  /** Build the result that appends text to a tool result. */
  appendToolResult(event: unknown, text: string): unknown;
  /** The npx spec to fall back to — the published version of this adapter. */
  readonly npxPin?: string;
  /** Env stamped on every `bro hooks` spawn — the `BRO_HOOK_HOST`
   *  marker block `hookEmitEnv` builds (specs/bro-izpyk.9.md). */
  readonly hookEnv?: Record<string, string>;
}

/** The host API surface the shared surfaces need.
 *
 *  pi and omp are the same extension API lineage — `registerCommand`,
 *  `registerTool` and `sendMessage` have the same shapes — so `/bro`
 *  and `bro_status` are written once, here, instead of copied into
 *  every binding. A copied command is a drifted command. */
export interface BroHostApi<Ctx = unknown> {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: Ctx) => Promise<void> | void;
      getArgumentCompletions?: (
        argumentPrefix: string
      ) =>
        | Array<{ label: string; value: string }>
        | null
        | Promise<Array<{ label: string; value: string }> | null>;
    }
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Host-policy hints, passed through verbatim — hosts that don't
     *  know them ignore the fields. omp reads `loadMode` ('essential'
     *  keeps the tool top-level; 'discoverable' hides it under xdev)
     *  and `approval` ('read'|'write'|'exec'). */
    loadMode?: string;
    approval?: string;
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: Ctx
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
  }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void;
}

/** A finished bro invocation's result. */
export interface BroRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the driver exposes to a client adapter beyond the wiring. */
export interface BroDriver {
  /** Run a bro subcommand and capture its output. */
  run(args: string[], cwd: string): Promise<BroRunResult>;
  /** Refresh + repaint the board for a context — the repaint path a
   *  host-only settle/turn event can call. */
  refresh(ctx: unknown): Promise<void>;
  /** The last board snapshot. */
  readonly board: BoardStatus | null;
  /** The host's own extension API, passed through untouched. */
  readonly api: unknown;
}

function carryForSession(
  carry: { sessionId: string; text: string } | undefined,
  sessionId: string
): string {
  return carry?.sessionId === sessionId ? carry.text : '';
}

function mergeHydration(carry: string, text: string): string {
  if (carry === '') {
    return text;
  }
  return text === '' ? carry : `${carry}\n\n${text}`;
}

function trackHydration(
  raw: Promise<HookControl | null>,
  started: Promise<string>,
  isCurrent: () => boolean,
  handlers: { failed: () => void; empty: () => void }
): void {
  void raw
    .then(control => {
      if (control === null && isCurrent()) {
        handlers.failed();
      }
    })
    .catch(() => {});
  void started
    .then(text => {
      if (isCurrent() && text === '') {
        handlers.empty();
      }
    })
    .catch(() => {});
}

/**
 * Wire bro into a host. `api` is the host's own extension API — the
 * driver passes it through so the client can register commands and
 * tools without a second channel.
 */
export function createBroDriver<Ctx>(host: BroHostBinding<Ctx>, api: BroHostApi<Ctx>): BroDriver {
  let board: BoardStatus | null = null;
  /** Monotonic token — a refresh that finishes after a newer one
   *  started must not overwrite the newer snapshot. */
  let refreshSeq = 0;

  /** Hydration text + the session it belongs to. Sessions can overlap
   *  (a replaced session's handler still pending while the new one
   *  starts), so the cache and the "already injected" claim are keyed
   *  by session id — one session's context never lands in another,
   *  and the claim is taken synchronously so two concurrent
   *  before-agent handlers cannot both inject. */
  let hydration: { sessionId: string; promise: Promise<string> } | undefined;
  let hydrated: string | undefined;
  /** The session whose rehydration probe FAILED (not merely came back
   *  empty) — a failed probe is not the session's verdict: bro may not
   *  have been resolvable yet, so a later turn may re-probe once. */
  let hydrationFailed: string | undefined;
  /** The session that already spent its one re-probe — a broken install
   *  must not turn every turn into a spawn. */
  let hydrationRetried: string | undefined;
  /** Pre-compaction carry — kept apart from the hydration probe so a
   *  post-compaction re-probe cannot overwrite what must survive the
   *  summary. Consumed (cleared) by the next hydrate() that runs. */
  let carry: { sessionId: string; text: string } | undefined;
  /** Set when the stop gate already refused this session — gates, not
   *  loops: the blocker goes back once per session, a later stop is
   *  let through, and a NEW session starts with a fresh gate (the
   *  flag dies with its session instead of leaking into the next). */
  let gatedSession: string | undefined;

  /** Resolve the CLI once — the shared lazy+retrying resolver. Probing
   *  costs a spawn even where bro is inert, so it stays lazy; a failed
   *  resolution expires instead of poisoning the extension instance. */
  const command = createCommandResolver({ npxPin: host.npxPin });

  /** Probe one bro hook. Fail-open: every failure is "no opinion". */
  const probe = async (
    event: string,
    payload: unknown,
    cwd: string,
    timeoutMs = HOOK_TIMEOUT_MS
  ): Promise<HookControl | null> => {
    if (!broEnabled(cwd)) {
      return null;
    }
    const cmd = await command();
    return cmd === null
      ? null
      : callHook(cmd, { event, payload, cwd, timeoutMs, extraEnv: host.hookEnv });
  };

  const paint = (ctx: Ctx): void => {
    if (!host.canPaint(ctx)) {
      return;
    }
    if (board === null) {
      host.clear(ctx);
      return;
    }
    host.paint(ctx, boardLines(board), statusCrumb(board));
  };

  const refreshBoard = async (ctx: Ctx): Promise<void> => {
    const cwd = host.cwd(ctx);
    const seq = ++refreshSeq;
    if (!broEnabled(cwd)) {
      // another repo's board must not leak into this session
      board = null;
      paint(ctx);
      return;
    }
    const cmd = await command();
    if (cmd === null || seq !== refreshSeq) {
      return;
    }
    const next = await statusJson(cmd, cwd);
    // a newer refresh superseded this one while it was in flight —
    // the slower, older answer must not overwrite it
    if (seq !== refreshSeq) {
      return;
    }
    // the repo changed while the refresh was in flight: the answer
    // belongs to ANOTHER repo, and another repo's bead claims must
    // never be injected into this session
    if (host.cwd(ctx) !== cwd) {
      board = null;
      paint(ctx);
      return;
    }
    board = next;
    paint(ctx);
  };

  /** Hydration runs once per session (re-primed on compaction); the
   *  answer is injected at the next turn start, not pushed into the
   *  transcript eagerly — the user may sit at the prompt for minutes.
   *  A pre-compaction carry rides along: it was already shown to the
   *  model once, so it must survive the summary re-probe. */
  const hydrate = (ctx: Ctx, event: 'session-start' | 'post-compaction'): void => {
    const cwd = host.cwd(ctx);
    const sessionId = host.sessionId(ctx);
    const priorCarry = carryForSession(carry, sessionId);
    carry = undefined;
    const raw = probe(event, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS);
    const started = raw.then(contextOf).then(text => mergeHydration(priorCarry, text));
    hydration = { sessionId, promise: started };
    // re-priming (compaction) earns a fresh inject for this session;
    // a different session's claim is untouched
    if (hydrated === sessionId) {
      hydrated = undefined;
    }
    // a failed probe is not the session's verdict — remember it so a
    // later turn can re-probe instead of running the session contextless
    hydrationFailed = undefined;
    trackHydration(raw, started, () => hydration?.promise === started, {
      failed: () => {
        hydrationFailed = sessionId;
      },
      empty: () => {
        hydration = undefined;
      },
    });
  };

  /** The session's context text, consumed from the cached probe. An
   *  empty answer is not the session's verdict: the claim is released
   *  and a failed probe is re-run once (fire-and-forget — the next turn
   *  picks the answer up, this turn never waits on it). */
  const consumeHydration = async (sessionId: string, cwd: string): Promise<string> => {
    const pending = hydration;
    if (pending === undefined) {
      return '';
    }
    if (pending.sessionId !== sessionId || hydrated === sessionId) {
      return '';
    }
    // claim synchronously, before the await — two concurrent
    // before-agent handlers must not both inject this text
    hydrated = sessionId;
    const text = (await pending.promise).trim();
    if (text !== '') {
      return text;
    }
    hydrated = undefined;
    retryHydration(sessionId, cwd);
    return '';
  };

  const retryHydration = (sessionId: string, cwd: string): void => {
    if (hydrationFailed !== sessionId || hydrationRetried === sessionId) {
      return;
    }
    hydrationRetried = sessionId;
    hydration = {
      sessionId,
      promise: probe(
        SESSION_START_EVENT,
        { session_id: sessionId },
        cwd,
        REHYDRATION_TIMEOUT_MS
      ).then(contextOf),
    };
  };

  /** Register one handler if the host has that event. */
  const bind = (name: string | undefined, handler: (event: unknown, ctx: Ctx) => unknown): void => {
    if (name === undefined) {
      return;
    }
    host.on(name, handler);
  };

  bind(host.events.sessionStart, (_event, ctx) => {
    // a fresh session starts with a fresh gate — the prior session's
    // refusal must not skip this one's exit gate
    gatedSession = undefined;
    hydrate(ctx, SESSION_START_EVENT);
    void refreshBoard(ctx).catch(() => {});
  });

  bind(host.events.sessionCompact, (_event, ctx) => {
    hydrate(ctx, POST_COMPACTION_EVENT);
    void refreshBoard(ctx).catch(() => {});
  });

  // pre-compact context is what must survive the summary — park it in
  // the carry slot so the next hydrate() for the same session appends
  // it instead of the post-compaction probe overwriting it
  bind(host.events.sessionBeforeCompact, async (_event, ctx) => {
    const cwd = host.cwd(ctx);
    const sessionId = host.sessionId(ctx);
    const text = contextOf(
      await probe(PRE_COMPACT_EVENT, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS)
    );
    if (text === '') {
      return;
    }
    carry = { sessionId, text };
    // if this session's hydration already ran (compaction beat the
    // probe), splice the carry into the live promise — the next inject
    // must still carry it
    const pending = hydration;
    if (pending !== undefined && pending.sessionId === sessionId) {
      const merged = pending.promise.then(base => (base === '' ? text : `${base}\n\n${text}`));
      hydration = { sessionId, promise: merged };
      carry = undefined;
    }
  });

  // The turn's entry point: bro's prompt-submit nudge and the cached
  // hydration ride one hidden message, so the transcript gains nothing
  // the user has to scroll past.
  bind(host.events.beforeAgentStart, async (event, ctx) => {
    const cwd = host.cwd(ctx);
    const sessionId = host.sessionId(ctx);
    const prompt = host.promptOf(event);
    const nudge = probe(PROMPT_SUBMIT_EVENT, { session_id: sessionId, prompt }, cwd).then(
      contextOf
    );

    const parts: string[] = [];
    const hydrationText = await consumeHydration(sessionId, cwd);
    if (hydrationText !== '') {
      parts.push(hydrationText);
    }
    const nudgeText = (await nudge).trim();
    if (nudgeText !== '') {
      parts.push(nudgeText);
    }
    if (parts.length === 0) {
      return undefined;
    }
    return host.inject(parts.join('\n\n'));
  });

  // post-tool: the arming markers + nudges live in bro; the nudge text
  // appends to the tool result content
  bind(host.events.toolResult, async (event, ctx) => {
    const cwd = host.cwd(ctx);
    const tool = event as { toolName?: string; input?: unknown; isError?: boolean };
    const text = contextOf(
      await probe(
        POST_TOOL_EVENT,
        {
          session_id: host.sessionId(ctx),
          tool_name: tool.toolName ?? '',
          tool_input: tool.input ?? {},
          tool_response: { success: tool.isError !== true },
        },
        cwd
      )
    );
    if (text === '') {
      return undefined;
    }
    return host.appendToolResult(event, text);
  });

  // the stop gate: bro decides, the host refuses. The host's own
  // "already refused" flag goes back to bro so bro's one-shot rule
  // applies — the driver never loops the gate itself.
  const alreadyGated = (event: unknown, sessionId: string): boolean =>
    gatedSession === sessionId || host.stopAlreadyRefused(event) === true;

  const notifyHint = (ctx: Ctx, control: HookControl | null): void => {
    const hint = contextOf(control);
    if (hint !== '') {
      host.notify(ctx, hint, 'info');
    }
  };

  const stopReason = (control: HookControl): string => {
    const reason = typeof control.reason === 'string' ? control.reason.trim() : '';
    return reason === '' ? 'unfinished bro work' : reason;
  };

  const stopGate = async (event: unknown, ctx: Ctx, sessionId: string): Promise<unknown> => {
    // an aborted or errored turn ends — the gate exists to keep
    // unfinished WORK in the session, never to resurrect a cancelled turn
    if (host.stopAborted?.(event) === true) {
      return undefined;
    }
    const control = await probe(
      STOP_EVENT,
      {
        session_id: sessionId,
        stop_hook_active: alreadyGated(event, sessionId),
      },
      host.cwd(ctx)
    );
    if (control?.decision !== 'block') {
      notifyHint(ctx, control);
      return undefined;
    }
    gatedSession = sessionId;
    void refreshBoard(ctx).catch(() => {});
    return host.refuseStop(stopReason(control));
  };

  /** In-flight stop probes by session id — two concurrent stops must
   *  not both run the probe and both block: the second awaits the
   *  first's verdict, by which point `already` is true and bro's
   *  one-shot rule lets it through. */
  const stopsInFlight = new Map<string, Promise<unknown>>();
  bind(host.events.stop, (event, ctx) => {
    const sessionId = host.sessionId(ctx);
    const inFlight = stopsInFlight.get(sessionId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const run = stopGate(event, ctx, sessionId).finally(() => {
      stopsInFlight.delete(sessionId);
    });
    stopsInFlight.set(sessionId, run);
    return run;
  });

  bind(host.events.turnEnd, (_event, ctx) => {
    void refreshBoard(ctx).catch(() => {});
  });

  bind(host.events.sessionShutdown, (_event, ctx) => {
    host.clear(ctx);
  });

  /** Run a bro subcommand — resolve the CLI first, then hand off. */
  const run = async (args: string[], cwd: string): Promise<BroRunResult> =>
    runBro(await command(), args, cwd);

  /** `/bro <args>` and every family alias share one dispatch: split,
   *  run, surface. Bare family names never reach here — they always
   *  carry their verb. */
  const dispatchArgs = async (argv: string[], ctx: Ctx): Promise<void> => {
    const result = await run(argv, host.cwd(ctx));
    const text = (result.stdout || result.stderr).trim();
    if (result.code !== 0) {
      host.notify(ctx, `bro ${argv.join(' ')}: exit ${result.code}`, 'error');
      return;
    }
    api.sendMessage(
      { customType: 'bro-output', content: `$ bro ${argv.join(' ')}\n${text}`, display: true },
      { triggerTurn: false }
    );
  };

  /** The shared surfaces. `/bro` is a thin passthrough — `bro
   *  act|next|fleet|drill` reachable without leaving the editor — and
   *  `bro_status` hands the model the same board JSON the widget
   *  renders. Both are the same on every host, so both live here. */
  api.registerCommand('bro', {
    description: 'bro — board refresh, or run `bro <args>` (act|next|fleet|drill|…)',
    getArgumentCompletions: host.argumentCompletions,
    async handler(args: string, ctx: Ctx) {
      const trimmed = args.trim();
      if (trimmed === '') {
        // refresh + repaint — the old path spawned the CLI and threw
        // the answer away, so bare /bro never updated the widget
        await refreshBoard(ctx);
        host.notify(ctx, 'bro: board refreshed', 'info');
        return;
      }
      await dispatchArgs(splitArgs(trimmed), ctx);
    },
  });

  /* Command family — the curated verbs as first-class slash commands.
   * A host-native command of the same name always wins: the alias then
   * registers under `bro:<name>` instead of shadowing it. */
  const natives = new Set(host.nativeCommands ?? []);
  for (const c of BRO_COMMANDS) {
    const name = natives.has(c.name) ? `bro:${c.name}` : c.name;
    api.registerCommand(name, {
      description: c.description,
      getArgumentCompletions: host.argumentCompletions,
      async handler(args: string, ctx: Ctx) {
        const argv = [c.verb, ...splitArgs(args)];
        await dispatchArgs(argv, ctx);
      },
    });
  }

  api.registerTool({
    name: 'bro_status',
    label: 'bro status',
    description:
      'Read the bro project board: in-progress beads, ready count, fleet agents, drill frame, branch/dirty state. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    loadMode: 'essential',
    approval: 'read',
    async execute(...args: unknown[]) {
      const ctx = args[4] as Ctx;
      const result = await run(['status', '--json'], host.cwd(ctx));
      return {
        content: [
          {
            type: 'text' as const,
            text: result.code === 0 ? result.stdout : 'bro status unavailable',
          },
        ],
        details: undefined,
      };
    },
  });

  return {
    get board() {
      return board;
    },
    run,
    refresh: (ctx: unknown) => refreshBoard(ctx as Ctx),
    api,
  };
}

function splitArgs(args: string): string[] {
  return args.trim() === '' ? [] : args.trim().split(/\s+/);
}

/** Run a bro subcommand and capture its output — the read side of the
 *  CLI, used by the client's own command and tools. A hung CLI must
 *  not wedge the driver: the child gets RUN_TIMEOUT_MS and then the
 *  whole process group dies (it is detached, so -pid takes dolt
 *  descendants with it). */
async function runBro(
  command: Command | null,
  args: string[],
  cwd: string,
  timeoutMs = RUN_TIMEOUT_MS
): Promise<BroRunResult> {
  if (command === null) {
    return { code: 127, stdout: '', stderr: 'bro CLI not found' };
  }
  const child = spawnBro(command, args, cwd);
  if (child === null) {
    return { code: 127, stdout: '', stderr: 'spawn failed' };
  }
  return collectBro(child, timeoutMs);
}

function spawnBro(command: Command, args: string[], cwd: string): ChildProcess | null {
  try {
    return spawn(command.cmd, [...command.args, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    return null;
  }
}

function collectBro(child: ChildProcess, timeoutMs: number): Promise<BroRunResult> {
  const { promise, resolve } = Promise.withResolvers<BroRunResult>();
  let out = '';
  let err = '';
  let settled = false;
  const settle = (result: BroRunResult): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    killTree(child);
    settle({
      code: 1,
      stdout: out,
      stderr: `${err}\nbro CLI timed out after ${timeoutMs}ms`.trim(),
    });
  }, timeoutMs);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (out.length < 1 << 20) out += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    if (err.length < 1 << 20) err += chunk;
  });
  child.on('error', () => settle({ code: 127, stdout: '', stderr: 'spawn failed' }));
  child.on('close', code => settle({ code: code ?? 1, stdout: out, stderr: err }));
  return promise;
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined && process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // already dead — the close handler settles
  }
}

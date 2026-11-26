// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro Kilo plugin — native adapter over the bro CLI.
 *
 * Registers bro's subcommands as a Kilo tool, maps Kilo lifecycle events
 * onto `bro hooks`, and auto-approves bro/bd shell calls. The plugin is
 * side-effect-free at import: it returns the Hooks object; the CLI entry
 * runs main() on import, so this module must never do that.
 *
 * The CLI ladder, hook protocol, spawn-and-parse and timeout discipline
 * are the shared adapter core — the same implementation pi, omp and
 * opencode ship. This file carries only Kilo's own shape: the `bro`
 * tool, the system.transform rehydration, the session.idle notify,
 * and the permission.ask auto-approve.
 */
import { tool } from '@kilocode/plugin/tool';
import type { Plugin } from '@kilocode/plugin';
import {
  HOOK_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  callHookDetailed,
  contextOf,
  createCommandResolver,
  hookEmitEnv,
  hookFailureText,
  runCommand,
} from '@broject/adapter-core/core';

/** Last-resort npx fallback specs, pinned first then latest — gen-plugins
 *  lists this file in VERSIONED_SOURCES, so the pin is rewritten to
 *  plugin.json's version on every gen/release run. */
const NPX_SPECS = ['@broject/bro@0.3.0', '@broject/bro'];

/** Env stamped on every `bro hooks` spawn so the CLI's adapter emit
 *  path journals this session into the hook spool — the in-process
 *  adapters bypass run.sh, which owns the shell-side writer
 *  (specs/bro-izpyk.9.md). A CLI that predates the marker ignores
 *  the env, so old↔new mixes degrade to the pre-emit status quo. */
const HOOK_ENV = hookEmitEnv('kilo', { npxPin: NPX_SPECS[0] });
const GATE_DIAG_INTERVAL_MS = 60_000;

/** Auto-approve only a plain bro/bd/npx-bro invocation — no shell
 *  metacharacters in args (a metachar just means the ask goes to the
 *  user; auto-approve fails closed, never wrong). */
const SHELL_META_CHARACTERS = new Set([
  ';',
  '&',
  '|',
  '`',
  '<',
  '>',
  '$',
  '(',
  ')',
  '\\',
  '\n',
  '\r',
]);

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === '' || [...trimmed].some(character => SHELL_META_CHARACTERS.has(character))) {
    return false;
  }
  const words = trimmed.split(/\s+/);
  if (words[0] === 'bro' || words[0] === 'bd') {
    return true;
  }
  if (words[0] !== 'npx') {
    return false;
  }
  const packageIndex = words[1] === '-y' ? 2 : 1;
  return words[packageIndex] === '@broject/bro';
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface HookOutcome {
  control: unknown;
  failure: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function hookOutcome(result: SpawnResult): HookOutcome {
  if (result.error !== null) {
    return { control: null, failure: result.error };
  }
  if (result.code !== 0) {
    return { control: null, failure: `the hook exited ${result.code ?? 'with no exit code'}` };
  }
  const control = firstControl(result.stdout);
  if (control === null) {
    return {
      control: null,
      failure: result.stdout === '' ? null : 'the hook answered with no control object',
    };
  }
  return { control, failure: null };
}

/** First JSON object on the hook's stdout; non-JSON lines are
 *  diagnostic chatter. null when nothing parses. */
function firstControl(stdout: string): unknown {
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed !== null) {
        return parsed;
      }
    } catch {
      // Non-JSON output is diagnostic chatter.
    }
  }
  return null;
}

const BroPlugin: Plugin = async input => {
  const { directory, client } = input;
  const broArgv = (input as { broArgv?: string[] }).broArgv;
  // resolved on first use — the PATH tier costs a spawn probe and kilo
  // loads plugins even in repos where bro is inert. The shared resolver
  // owns the ladder (pin → sibling → checkout → PATH → npx) and the
  // retry-on-failure window every adapter uses.
  const getCommand = createCommandResolver({ npxSpecs: NPX_SPECS });

  /** Run one bro hook event; null on every failure mode (fail-open).
   *  `bro hooks` itself no-ops in a repo that never opted in. */
  const runBroHook = async (event: string, input: unknown) => {
    if (broArgv !== undefined) {
      const command = { cmd: broArgv[0] ?? '', args: broArgv.slice(1) };
      return callHookDetailed(command, {
        event,
        payload: input,
        cwd: directory,
        timeoutMs: HOOK_TIMEOUT_MS,
        extraEnv: HOOK_ENV,
      });
    }
    const resolved = await getCommand();
    return resolved === null
      ? { control: null, failure: { kind: 'no-cli' as const } }
      : callHookDetailed(resolved, {
          event,
          payload: input,
          cwd: directory,
          timeoutMs: HOOK_TIMEOUT_MS,
          extraEnv: HOOK_ENV,
        });
  };

  // --- tools: bro subcommands the model can call directly -------------------

  const run = async (sub: string, args: string[]): Promise<string> => {
    const resolved = await getCommand();
    if (resolved === null) {
      return 'error: no bro command resolved';
    }
    const result = await runCommand(resolved.cmd, [...resolved.args, sub, ...args], {
      cwd: directory,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (result.error !== null && result.code === null) {
      return `error: ${result.error}`;
    }
    return result.stdout + result.stderr;
  };

  // session-start probes are idempotent but not free (they shell out to
  // gh/bd) — run them once per session, then push the cached context on
  // every turn so it survives compaction. The plugin instance is shared
  // across sessions, so each session owns its own hydrated context.
  const liveSessions = new Set<string>();
  const hydratedContexts = new Map<string, { token: number; context: string | null }>();
  let hydrationToken = 0;
  let stopGateDiagAt = 0;
  const hydrate = async (sessionKey: string): Promise<void> => {
    const token = ++hydrationToken;
    hydratedContexts.set(sessionKey, { token, context: null });
    const { control } = await runBroHook('session-start', { session_id: sessionKey });
    if (Object.is(hydratedContexts.get(sessionKey)?.token, token)) {
      hydratedContexts.set(sessionKey, { token, context: contextOf(control) || null });
    }
  };
  const contextForSession = (sessionKey: string): string | null => {
    if (sessionKey) {
      return hydratedContexts.get(sessionKey)?.context ?? null;
    }
    const contexts: string[] = [];
    for (const liveSession of liveSessions) {
      const candidate = hydratedContexts.get(liveSession)?.context;
      if (candidate === null || candidate === undefined) {
        continue;
      }
      contexts.push(candidate);
    }
    return contexts.length === 1 ? (contexts[0] ?? null) : null;
  };

  const sessionIdOf = (event: { properties?: unknown }): string | null => {
    const props = asRecord(event.properties) ?? {};
    const info = asRecord(props.info);
    return typeof props.sessionID === 'string'
      ? props.sessionID
      : typeof info?.id === 'string'
        ? info.id
        : null;
  };

  const onSessionCreated = async (sid: string | null): Promise<void> => {
    if (sid === null) {
      return;
    }
    liveSessions.add(sid);
    if (!hydratedContexts.has(sid)) {
      await hydrate(sid);
    }
  };

  const contextVisibleFor = (sessionKey: string): boolean =>
    sessionKey === '' || liveSessions.has(sessionKey);

  const onSessionDeleted = (sid: string | null): void => {
    liveSessions.delete(sid ?? '');
    if (sid === null) {
      hydratedContexts.clear();
    } else {
      hydratedContexts.delete(sid);
    }
  };

  const reportStopGateDiag = async (
    failure: Parameters<typeof hookFailureText>[0]
  ): Promise<void> => {
    const now = Date.now();
    if (now - stopGateDiagAt < GATE_DIAG_INTERVAL_MS) {
      return;
    }
    stopGateDiagAt = now;
    try {
      await client.app
        .log({
          body: {
            service: 'bro',
            level: 'warn',
            message: `bro stop gate did not run (${hookFailureText(failure)}) — the stop is unguarded`,
          },
        })
        .catch(() => {
          // Diagnostics are best effort and must not affect the lifecycle hook.
        });
    } catch {
      // Diagnostics are fail-open and must never break the lifecycle hook.
    }
  };

  const runStopGate = async (event: { properties?: unknown }): Promise<void> => {
    const { control, failure } = await runBroHook('stop', {
      session_id: asRecord(event.properties)?.sessionID,
    });
    if (failure !== null) {
      await reportStopGateDiag(failure);
      return;
    }
    if (control?.decision === 'block') {
      await client.app.log({
        body: {
          service: 'bro',
          level: 'warn',
          message: `bro stop gate blocked: ${control.reason ?? 'unfinished work'}`,
        },
      });
    }
  };

  return {
    tool: {
      bro: tool({
        description:
          'Run a bro subcommand (act, debt, drill, convoy, work, stack, ' +
          'spec, fleet, agents, watch, serve, sync, setup, doctor, cleanup, ' +
          'next, loop, plan, plugins). Args after the subcommand are passed ' +
          'through verbatim.',
        args: {
          sub: tool.schema.string().describe('bro subcommand (e.g. act, debt, drill)'),
          args: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('arguments to the subcommand'),
        },
        async execute(args, _context) {
          return run(args.sub, args.args ?? []);
        },
      }),
    },

    // --- session rehydration: run bro hooks session-start on every turn ---
    //
    // Kilo fires system.transform with no sessionId on the first turn, so
    // the hook runs once per session and the injection is pushed into the
    // system prompt every turn (the connector probes are idempotent — a
    // second run just re-reads the same ready queue / drill frame).

    'experimental.chat.system.transform': async (input, output) => {
      const sessionKey = input.sessionID ?? '';
      // hydrate once per session — the probes shell out to gh/bd
      if (sessionKey && !hydratedContexts.has(sessionKey)) {
        liveSessions.add(sessionKey);
        await hydrate(sessionKey);
      }
      const context = contextForSession(sessionKey);
      // an id-less transform only pushes a live session's own context —
      // a foreign session's cached frame must never leak across
      if (context !== null && contextVisibleFor(sessionKey)) {
        output.system.push(`bro state — resume from here:\n${context}`);
      }
    },

    // --- stop gate: session.idle is Kilo's Stop-equivalent ---------------
    //
    // bro's stop gate blocks (decision: "block") when this session armed
    // an aspect and left unfinished business. We can't halt Kilo from
    // here, but we surface the block as a warn-level log so the session
    // sees it before it would otherwise miss it.

    event: async ({ event }) => {
      // the cache is re-keyed on session boundaries — a created session
      // primes its own probe, a deleted one retires it. Without this a
      // new session's first (id-less) transform pushes the prior
      // session's cached context.
      const sid = sessionIdOf(event);
      if (event.type === 'session.created') {
        await onSessionCreated(sid);
      } else if (event.type === 'session.deleted') {
        onSessionDeleted(sid);
      }
      if (event.type !== 'session.idle') {
        return;
      }
      await runStopGate(event);
    },

    // --- auto-approve bro/bd shell calls ------------------------------------

    'permission.ask': async (input, output) => {
      // the Permission type declares `pattern` (string|string[]) but this
      // hook was written against `patterns` — read both, array-normalized.
      // EVERY pattern must be a plain bro/bd/npx-bro invocation with no
      // shell metacharacters: checking only the first would let
      // ['bd ready','rm -rf x'] ride the allow, and a prefix-only match
      // approves the compound 'bro x && rm'.
      const pats = (input as { patterns?: string[] }).patterns ?? input.pattern;
      const cmds = pats === undefined ? [] : Array.isArray(pats) ? pats : [pats];
      if (cmds.length > 0 && cmds.every(isSafeCommand)) {
        output.status = 'allow';
      }
    },
  };
};

// `server` widens to unknown at the export boundary: the emitted kilo.d.ts
// must not reference @kilocode/plugin (a devDependency — consumers would
// fail to resolve the Plugin type), so BroPlugin keeps the SDK type above
// and sheds it here.
export default { id: 'bro', server: BroPlugin as unknown };

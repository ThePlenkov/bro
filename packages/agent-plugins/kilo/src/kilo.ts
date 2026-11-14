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
  callHook,
  contextOf,
  createCommandResolver,
  hookEmitEnv,
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

/** Auto-approve only a plain bro/bd/npx-bro invocation — no shell
 *  metacharacters in args (a metachar just means the ask goes to the
 *  user; auto-approve fails closed, never wrong). */
const SAFE_CMD = [
  /^\s*(?:bro|bd)(?:\s+[^;&|`<>$()\\\n]*)?\s*$/,
  /^\s*npx\s+(?:-y\s+)?@broject\/bro(?:\s+[^;&|`<>$()\\\n]*)?\s*$/,
];

const BroPlugin: Plugin = async ({ directory, client }) => {
  // resolved on first use — the PATH tier costs a spawn probe and kilo
  // loads plugins even in repos where bro is inert. The shared resolver
  // owns the ladder (pin → sibling → checkout → PATH → npx) and the
  // retry-on-failure window every adapter uses.
  const getCommand = createCommandResolver({ npxSpecs: NPX_SPECS });

  /** Run one bro hook event; null on every failure mode (fail-open).
   *  `bro hooks` itself no-ops in a repo that never opted in. */
  const runBroHook = async (event: string, input: unknown) => {
    const resolved = await getCommand();
    return resolved === null
      ? null
      : callHook(resolved, event, input, directory, HOOK_TIMEOUT_MS, HOOK_ENV);
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
  const hydrate = async (sessionKey: string): Promise<void> => {
    const token = ++hydrationToken;
    hydratedContexts.set(sessionKey, { token, context: null });
    const control = await runBroHook('session-start', { session_id: sessionKey });
    if (Object.is(hydratedContexts.get(sessionKey)?.token, token)) {
      hydratedContexts.set(sessionKey, { token, context: contextOf(control) || null });
    }
  };
  const contextForSession = (sessionKey: string): string | null => {
    if (sessionKey) {
      return hydratedContexts.get(sessionKey)?.context ?? null;
    }
    let context: string | null = null;
    for (const liveSession of liveSessions) {
      const candidate = hydratedContexts.get(liveSession)?.context;
      if (candidate === null || candidate === undefined) {
        continue;
      }
      if (context !== null) {
        return null;
      }
      context = candidate;
    }
    return context;
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
      if (context && (!sessionKey || liveSessions.has(sessionKey))) {
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
      const props = (event.properties ?? {}) as Record<string, unknown>;
      const sid =
        typeof props.sessionID === 'string'
          ? props.sessionID
          : typeof (props.info as { id?: unknown } | undefined)?.id === 'string'
            ? (props.info as { id: string }).id
            : null;
      if (event.type === 'session.created' && sid !== null) {
        liveSessions.add(sid);
        if (!hydratedContexts.has(sid)) {
          await hydrate(sid);
        }
      } else if (event.type === 'session.deleted') {
        liveSessions.delete(sid ?? '');
        if (sid === null) {
          hydratedContexts.clear();
        } else {
          hydratedContexts.delete(sid);
        }
      }
      if (event.type !== 'session.idle') {
        return;
      }
      const control = await runBroHook('stop', { session_id: event.properties.sessionID });
      if (control?.decision === 'block') {
        await client.app.log({
          body: {
            service: 'bro',
            level: 'warn',
            message: `bro stop gate blocked: ${control.reason ?? 'unfinished work'}`,
          },
        });
      }
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
      if (cmds.length > 0 && cmds.every(c => SAFE_CMD.some(re => re.test(c)))) {
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

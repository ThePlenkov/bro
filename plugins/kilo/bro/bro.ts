/**
 * bro Kilo plugin — native adapter over the bro CLI.
 *
 * Registers bro's subcommands as Kilo tools, maps Kilo lifecycle events
 * onto `bro hooks`, and auto-approves bro/bd shell calls. The plugin is
 * side-effect-free at import: it returns the Hooks object; the CLI entry
 * runs main() on import, so this module must never do that.
 *
 * Resolves the bro binary in priority order:
 *   1. the built dist reachable from this checkout (local/dev installs)
 *   2. `bro` on PATH
 *   3. npx fallback pinned to the plugin's own version
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tool } from '@kilocode/plugin/tool'
import type { Plugin } from '@kilocode/plugin'

/** Walk up from the plugin dir for a built CLI — adapter dirs live
 *  below the repo root, so a relative/malformed root can't wander off. */
function findBroBin(): string | null {
  const scriptRoot = dirname(fileURLToPath(import.meta.url))
  let dir = scriptRoot
  for (;;) {
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return null
}

/** Resolve argv[0] for `bro` — the local build wins over PATH so hook
 *  behavior tracks the checkout; PATH is the fallback for installed
 *  builds; npx is the last resort (warm cache via --prefer-offline). */
function broArgs(event: string, extra: string[] = []): string[] {
  const local = findBroBin()
  if (local) {
    return ['node', local, 'hooks', event, ...extra]
  }
  return ['bro', 'hooks', event, ...extra]
}

/** Run a bro hook, passing the event payload on stdin. Returns the parsed
 *  hook control JSON on stdout, or null on any failure (fail-open). */
function runBroHook(event: string, input: unknown): unknown {
  const argv = broArgs(event)
  let result
  try {
    result = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      input: JSON.stringify(input),
      env: { ...process.env, BRO_HOOK_INPUT: '1' },
      timeout: 20_000,
    })
  } catch {
    return null
  }
  if (result.status !== 0 || !result.stdout) {
    return null
  }
  // bro emits one JSON control object per line; take the last parseable one
  for (const line of result.stdout.split('\n').reverse()) {
    try {
      return JSON.parse(line) as unknown
    } catch {
      continue
    }
  }
  return null
}

/** Extract the additionalContext a bro hook wants injected, if any. */
function hookContext(out: unknown): string | null {
  if (!out || typeof out !== 'object') {
    return null
  }
  const o = out as { hookSpecificOutput?: { additionalContext?: unknown } }
  const ctx = o.hookSpecificOutput?.additionalContext
  return typeof ctx === 'string' && ctx.trim() !== '' ? ctx : null
}

/** Auto-approve only a plain bro/bd/npx-bro invocation — no shell
 *  metacharacters in args (a metachar just means the ask goes to the
 *  user; auto-approve fails closed, never wrong). */
const SAFE_CMD = [
  /^\s*(?:bro|bd)(?:\s+[^;&|`<>$()\\\n]*)?\s*$/,
  /^\s*npx\s+(?:-y\s+)?@broject\/bro(?:\s+[^;&|`<>$()\\\n]*)?\s*$/,
]

const BroPlugin: Plugin = async ({ directory, client }) => {
  // --- tools: bro subcommands the model can call directly -------------------

  const run = (sub: string, args: string[]) => {
    const local = findBroBin()
    const argv = local ? ['node', local, sub, ...args] : ['bro', sub, ...args]
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      cwd: directory,
      env: { ...process.env },
      timeout: 120_000,
    })
    if (r.error) {
      return `error: ${r.error.message}`
    }
    return (r.stdout || '') + (r.stderr || '')
  }

  // session-start probes are idempotent but not free (they shell out to
  // gh/bd) — run them once per session, then push the cached context on
  // every turn so it survives compaction.
  let hydratedSession: string | null = null
  let hydratedContext: string | null = null
  const hydrate = (sessionId: string): void => {
    const out = runBroHook('session-start', { session_id: sessionId })
    hydratedContext = hookContext(out)
    hydratedSession = sessionId
  }

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
          args: tool.schema.array(tool.schema.string()).optional().describe('arguments to the subcommand'),
        },
        async execute(args, _context) {
          return run(args.sub, args.args ?? [])
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
      const sessionId = input.sessionID ?? ''
      // hydrate once per session — the probes shell out to gh/bd
      if (sessionId && hydratedSession !== sessionId) {
        hydrate(sessionId)
      }
      if (hydratedContext) {
        output.system.push(`bro state — resume from here:\n${hydratedContext}`)
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
      const props = (event.properties ?? {}) as Record<string, unknown>
      const sid =
        typeof props.sessionID === 'string'
          ? props.sessionID
          : typeof (props.info as { id?: unknown } | undefined)?.id === 'string'
            ? (props.info as { id: string }).id
            : null
      if (event.type === 'session.created' && sid !== null && sid !== hydratedSession) {
        hydrate(sid)
      } else if (event.type === 'session.deleted' && (sid === null || sid === hydratedSession)) {
        hydratedSession = null
        hydratedContext = null
      }
      if (event.type !== 'session.idle') {
        return
      }
      const out = runBroHook('stop', { session_id: event.properties.sessionID })
      if (out && typeof out === 'object' && (out as { decision?: string }).decision === 'block') {
        await client.app.log({
          body: {
            service: 'bro',
            level: 'warn',
            message: `bro stop gate blocked: ${(out as { reason?: string }).reason ?? 'unfinished work'}`,
          },
        })
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
      const pats = (input as { patterns?: string[] }).patterns ?? input.pattern
      const cmds = pats === undefined ? [] : Array.isArray(pats) ? pats : [pats]
      if (cmds.length > 0 && cmds.every((c) => SAFE_CMD.some((re) => re.test(c)))) {
        output.status = 'allow'
      }
    },
  }
}

// `server` widens to unknown at the export boundary: the emitted kilo.d.ts
// must not reference @kilocode/plugin (a devDependency — consumers would
// fail to resolve the Plugin type), so BroPlugin keeps the SDK type above
// and sheds it here.
export default { id: 'bro', server: BroPlugin as unknown }

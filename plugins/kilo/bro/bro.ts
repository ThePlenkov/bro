// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro Kilo plugin — native adapter over the bro CLI.
 *
 * Registers bro's subcommands as Kilo tools, maps Kilo lifecycle events
 * onto `bro hooks`, and auto-approves bro/bd shell calls. The plugin is
 * side-effect-free at import: it returns the Hooks object; the CLI entry
 * runs main() on import, so this module must never do that.
 *
 * Resolves the bro binary from the built dist reachable from this
 * checkout, then from `bro` on PATH.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tool } from '@kilocode/plugin/tool'
import type { Plugin } from '@kilocode/plugin'

const HOOK_TIMEOUT_MS = 15_000
const RUN_TIMEOUT_MS = 120_000

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
 *  builds. */
function broArgs(event: string, extra: string[] = []): string[] {
  const local = findBroBin()
  if (local) {
    return ['node', local, 'hooks', event, ...extra]
  }
  return ['bro', 'hooks', event, ...extra]
}

interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
  error: string | null
}

interface SpawnOptions {
  cwd?: string
  env: NodeJS.ProcessEnv
  input?: string
  timeoutMs: number
}

/** SIGKILL a timed-out child and its process group when available. */
function killAfter(child: ChildProcess, ms: number, onTimeout: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    onTimeout()
  }, ms)
  timer.unref?.()
  return timer
}

function spawnCollect(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    let settled = false
    const settle = (result: SpawnResult): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    let stdout = ''
    let stderr = ''
    const timer = killAfter(child, options.timeoutMs, () =>
      settle({
        code: null,
        stdout,
        stderr,
        error: `timed out after ${options.timeoutMs}ms`,
      })
    )
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ code: null, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ code, stdout, stderr, error: null })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input ?? '')
  })
}

/** Run a bro hook, passing the event payload on stdin. Returns the parsed
 *  hook control JSON on stdout, or null on any failure (fail-open). */
async function runBroHook(event: string, input: unknown): Promise<unknown> {
  const argv = broArgs(event)
  let payload: string | undefined
  try {
    payload = JSON.stringify(input)
  } catch {
    return null
  }
  const result = await spawnCollect(argv[0], argv.slice(1), {
    input: payload,
    env: { ...process.env, BRO_HOOK_INPUT: '1' },
    timeoutMs: HOOK_TIMEOUT_MS,
  })
  if (result.error !== null || result.code !== 0 || !result.stdout) {
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
    return spawnCollect(argv[0], argv.slice(1), {
      cwd: directory,
      env: { ...process.env },
      timeoutMs: RUN_TIMEOUT_MS,
    }).then((result) => {
      if (result.error !== null) {
        return `error: ${result.error}`
      }
      return result.stdout + result.stderr
    })
  }

  // session-start probes are idempotent but not free (they shell out to
  // gh/bd) — run them once per session, then push the cached context on
  // every turn so it survives compaction. The plugin instance is shared
  // across sessions, so `liveSessions` records which session each event
  // belongs to: a sessionless transform may only push context whose
  // owning session is still live — otherwise the prior session's
  // hydrate leaks into a reused instance.
  const liveSessions = new Set<string>()
  let hydratedSession: string | null = null
  let hydratedContext: string | null = null
  const hydrate = async (sessionId: string): Promise<void> => {
    const out = await runBroHook('session-start', { session_id: sessionId })
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
        liveSessions.add(sessionId)
        await hydrate(sessionId)
      }
      // A sessionless transform inherits whichever session hydrated last;
      // push only when that owner is still live, so a reused instance can
      // never inject a retired session's context into an early turn.
      const ownerLive =
        hydratedSession !== null &&
        (hydratedSession === sessionId || liveSessions.has(hydratedSession))
      if (hydratedContext && ownerLive) {
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
      if (event.type === 'session.created' && sid !== null) {
        liveSessions.add(sid)
        if (sid !== hydratedSession) {
          await hydrate(sid)
        }
      } else if (event.type === 'session.deleted') {
        liveSessions.delete(sid ?? '')
        if (sid === null || sid === hydratedSession) {
          hydratedSession = null
          hydratedContext = null
        }
      }
      if (event.type !== 'session.idle') {
        return
      }
      const out = await runBroHook('stop', { session_id: event.properties.sessionID })
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

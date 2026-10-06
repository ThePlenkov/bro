/**
 * bro — opencode CLI/TUI plugin (`cli.ts`), the terminal half of the
 * integration. `bro.ts` speaks to the opencode server; this module speaks
 * to the operator's TUI:
 *
 *   `/bro [args]`           slash + palette command → runs `bro <args>`
 *                           (default `status`) against the resolved CLI
 *                           and shows the board as a toast
 *   permission.asked        gate visibility — the ask the server adapter
 *                           is evaluating lands as a warning toast
 *   session.error           provider/agent failures surface as an error
 *                           toast instead of dying in the event log
 *
 * Same standalone-module contract as `bro.ts`: node builtins only, all
 * opencode types structural (no runtime import — the published artifact
 * loads without `@opencode/plugin` installed), and every call is
 * optional-chained so a drifted or older runtime degrades to "not wired",
 * never a setup throw.
 *
 * The CLI ladder below is a copy of bro.ts's — materialized files are
 * copied verbatim and cannot share imports. Keep both in sync: the
 * semantics (options override → sibling dist → checkout walk-up → PATH
 * probe → pinned npx) must stay identical or the two halves of the
 * integration would run different bro versions.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Command {
  cmd: string
  args: string[]
}

interface CliOptions {
  command?: string | { cmd: string; args?: string[] }
}

/** Operator command: palette entry + `/bro` slash invocation. */
interface CliCommand {
  id: string
  title: string
  group?: string
  bind?: string
  palette?: boolean
  slash?: { name: string; aliases?: string[]; arguments?: boolean }
  enabled?(): boolean
  run(input?: string): void | Promise<void> | false
}

/** `context.keymap.layer(factory)` — the factory must be pure; it is
 *  re-evaluated reactively. */
interface CliKeymap {
  layer?(factory: () => {
    mode?: string
    priority?: number
    commands?: CliCommand[]
    bindings?: string[]
  }): unknown
}

interface CliToast {
  show?(input: {
    title?: string
    message: string
    variant?: 'info' | 'success' | 'warning' | 'error'
    duration?: number
  }): void
}

/** `context.data.on(event, cb)` — typed server-event tap returning an
 *  unsubscribe function. */
interface CliData {
  on?(event: string, callback: (event: { data?: unknown }) => void): () => void
}

interface CliCtx {
  location?: { directory?: string }
  options?: CliOptions
  keymap?: CliKeymap
  ui?: { toast?: CliToast }
  data?: CliData
}

const HOOK_TIMEOUT_MS = 15_000
const MAX_OUTPUT = 1 << 20
/** Toasts are glanceable — a `bro status` board is not; cap the body. */
const TOAST_MAX = 3_000

const NPX_PIN = '@broject/bro@0.2.4'

function jsRuntime(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

function siblingCli(): string | null {
  for (const rel of ['./index.js', '../dist/index.js']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function checkoutCli(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

function killAfter(
  child: ChildProcess,
  ms: number,
  onTimeout: () => void
): ReturnType<typeof setTimeout> {
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

function exitsZero(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
      })
    } catch {
      resolve(false)
      return
    }
    const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(false))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end('')
  })
}

/** Same ladder as bro.ts — resolve once, lazily, and keep the answer. */
function commandResolver(options: CliOptions | undefined): () => Promise<Command | null> {
  let resolved: Promise<Command | null> | undefined
  return () =>
    (resolved ??= (async (): Promise<Command | null> => {
      const override = options?.command
      if (typeof override === 'string' && override.trim() !== '') {
        return { cmd: override, args: [] }
      }
      if (override && typeof override === 'object' && typeof override.cmd === 'string') {
        return {
          cmd: override.cmd,
          args: Array.isArray(override.args)
            ? override.args.filter((a): a is string => typeof a === 'string')
            : [],
        }
      }
      for (const entry of [siblingCli(), checkoutCli()]) {
        if (entry !== null && (await exitsZero(jsRuntime(), [entry, 'hooks']))) {
          return { cmd: jsRuntime(), args: [entry] }
        }
      }
      if (await exitsZero('bro', ['hooks'])) {
        return { cmd: 'bro', args: [] }
      }
      if (await exitsZero('npx', ['--version'])) {
        return { cmd: 'npx', args: ['-y', '--prefer-offline', NPX_PIN] }
      }
      return null
    })())
}

/** Spawn `bro <args>` — the toast shows what printed; stderr tail is the
 *  body when stdout is empty and the exit code prefixes it on failure. */
function exec(
  command: Command | null,
  args: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const finish = (code: number, out = '', err = ''): void =>
      resolve({ code, out: out.trim(), err: err.trim() })
    if (command === null) {
      finish(127, '', 'no bro command resolved')
      return
    }
    let child: ChildProcess
    try {
      child = spawn(command.cmd, [...command.args, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch {
      finish(127, '', 'spawn failed')
      return
    }
    let out = ''
    let err = ''
    const cap = (buf: string, chunk: string): string =>
      buf.length < MAX_OUTPUT ? buf + chunk.slice(0, MAX_OUTPUT - buf.length) : buf
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out = cap(out, chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      err = cap(err, chunk)
    })
    const timer = killAfter(child, HOOK_TIMEOUT_MS, () => finish(124, out, err))
    child.on('error', () => {
      clearTimeout(timer)
      finish(127, out, err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code ?? 1, out, err)
    })
  })
}

function clip(text: string): string {
  return text.length > TOAST_MAX ? `${text.slice(0, TOAST_MAX)}\n…` : text
}

/** `/bro` arguments — whitespace-split with "…"/'…' holding a multiword
 *  value together (`/bro learn capture "a note"` must not shred the
 *  note into four argv entries). Unmatched quotes degrade to the plain
 *  token — a mangled command still runs. */
function splitArgs(input: string): string[] {
  const args: string[] = []
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(m[1] ?? m[2] ?? m[3] ?? m[0])
  }
  return args
}

/** The plugin's default export — the V2 CLI contract, structurally
 *  declared: `{id, setup}` with `kind:"opencode-tui"` marking the file
 *  for `bro plugins install`'s sentinel (isBroAdapter). */
export default {
  id: 'bro.cli',
  kind: 'opencode-tui',
  async setup(context: CliCtx): Promise<() => void> {
    const cwd = context.location?.directory ?? process.cwd()
    const resolveCmd = commandResolver(context.options)
    const toast = context.ui?.toast

    const runBro = async (input?: string): Promise<void> => {
      const args = splitArgs(input ?? '')
      const verb = args.length > 0 ? args : ['status']
      const { code, out, err } = await exec(await resolveCmd(), verb, cwd)
      const body = out || err || '(no output)'
      const suffix = code === 0 ? '' : ` — exit ${code}`
      toast?.show?.({
        title: `bro ${verb.join(' ')}${suffix}`,
        message: clip(body),
        variant: code === 0 ? 'info' : 'warning',
        duration: 10_000,
      })
    }

    // the pure layer factory — one command, palette + `/bro` slash
    context.keymap?.layer?.(() => ({
      mode: 'global',
      commands: [
        {
          id: 'bro.status',
          title: 'Show bro status',
          group: 'bro',
          palette: true,
          slash: { name: 'bro', arguments: true },
          run: (input?: string) => runBro(input),
        },
      ],
      bindings: ['bro.status'],
    }))

    const stops: Array<() => void> = []
    const on = context.data?.on?.bind(context.data)
    if (on !== undefined) {
      const tap = (event: string, cb: (e: { data?: unknown }) => void): void => {
        try {
          stops.push(on(event, cb))
        } catch {
          // a drifted event name unwires one tap, never setup
        }
      }
      tap('permission.asked', (e) => {
        const d = (typeof e?.data === 'object' && e.data !== null ? e.data : {}) as Record<
          string,
          unknown
        >
        const action = typeof d.action === 'string' ? d.action : ''
        const resources = Array.isArray(d.resources)
          ? d.resources.filter((r): r is string => typeof r === 'string').join(' ')
          : ''
        const detail = [action, resources].filter((s) => s !== '').join(' ')
        toast?.show?.({
          title: 'bro',
          message: clip(detail !== '' ? `permission: ${detail}` : 'permission requested'),
          variant: 'warning',
        })
      })
      tap('session.error', (e) => {
        const d = (typeof e?.data === 'object' && e.data !== null ? e.data : {}) as Record<
          string,
          unknown
        >
        const error = d.error
        let message = 'session error'
        if (typeof error === 'object' && error !== null && 'message' in error) {
          message = String((error as { message: unknown }).message)
        } else if (typeof error === 'string') {
          message = error
        }
        toast?.show?.({ title: 'bro', message: clip(message), variant: 'error' })
      })
    }

    return () => {
      for (const stop of stops) {
        try {
          stop()
        } catch {
          // teardown must not throw into the host's unload path
        }
      }
    }
  },
}

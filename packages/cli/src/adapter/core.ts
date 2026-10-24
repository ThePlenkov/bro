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
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The one control object `bro hooks <event>` prints. */
export interface HookControl {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown }
  decision?: string
  reason?: unknown
}

/** A resolved bro CLI invocation. */
export interface Command {
  cmd: string
  args: string[]
}

/** Minimal structural read of `bro status --json` — fields the widget
 *  and the interactive board panel render; everything else passes
 *  through unread. */
export interface BoardStatus {
  dir?: string
  branch?: string
  dirty?: number
  worktrees?: Array<{
    name?: string
    path?: string
    main?: boolean
    branch?: string
    state?: string
  }>
  beads?: {
    inProgress?: Array<{
      id?: string
      title?: string
      priority?: string | number
      issue_type?: string
      assignee?: string
    }>
    ready?: Array<{
      id?: string
      title?: string
      priority?: string | number
      issue_type?: string
    }>
    readyTotal?: number
  }
  fleet?: {
    maxConcurrent?: number
    agents?: Array<{
      id?: string
      backend?: string
      state?: string
      step?: string
      cause?: string
      pid?: number
      worktree?: string
      provider?: string
    }>
  }
  loop?: {
    stallMin?: number
    runs?: Array<{
      beadId?: string
      slug?: string
      pid?: number
      state?: string
      startedAt?: string
      worktree?: string
      log?: string
      silentMs?: number
    }>
  }
  drill?: { frame?: { id?: string; title?: string; depth?: number } | null }
  watch?: { ts?: string; ageMs?: number; attention?: number }
}

/** How long a normal hook probe may take. */
export const HOOK_TIMEOUT_MS = 15_000
/** session-start/post-compaction list `bd ready` and scan worktrees —
 *  measured at 20-40s in a loaded repo. */
export const REHYDRATION_TIMEOUT_MS = 45_000
/** Cap on a hook's stdout — a runaway child must not eat the heap. */
export const MAX_OUTPUT = 1 << 20

/**
 * `node` on PATH, not process.execPath — a host may ship as a compiled
 * binary whose execPath IS that binary, so running it with our own
 * entry script would re-enter the host instead of running the script.
 */
export function jsRuntime(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/** The bro CLI bundled next to this adapter (`dist/index.js`). */
export function siblingCli(): string | null {
  for (const rel of ['./index.js', '../dist/index.js']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** The bro CLI of the checkout this adapter was loaded from — the
 *  development path: the adapter's own source tree wins over any
 *  published package, so a local edit is live without a rebuild. */
export function checkoutCli(): string | null {
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

/** A kill timer — cleared once the child settles. */
export type KillTimer = ReturnType<typeof setTimeout>

/**
 * SIGKILL a hung child on a timer. The child is spawned detached, so
 * killing the pid's group takes the grandchildren down too — a hook
 * that spawns `bd` must not leave a dolt server behind.
 */
export function killAfter(
  child: ChildProcess,
  ms: number,
  onTimeout: () => void
): KillTimer {
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

/** Does this command exit zero? Used to probe whether a candidate CLI
 *  actually speaks bro's hook protocol — an older bro on PATH fails the
 *  probe instead of failing every hook. */
export async function exitsZero(cmd: string, args: string[]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let child: ChildProcess
  try {
    child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' }) // NOSONAR typescript:S4036
  } catch {
    return false
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
  return promise
}

/** Options for the CLI ladder. */
export interface ResolveOptions {
  /** A caller-pinned CLI (config `options.command`) — wins over the
   *  local dist, because the operator asked for that binary. */
  command?: string
  /** The pinned npx spec — the published version of this adapter. */
  npxPin?: string
}

/**
 * The CLI ladder, in order: the pinned command, the bundled sibling,
 * the checkout's dist, `bro` on PATH, and finally the pinned npx
 * package. Every tier is probed with `bro hooks` — the silent
 * capability probe — so a tier that resolves to something that is not
 * bro is skipped rather than failing every hook.
 */
export async function resolveCommand(opts: ResolveOptions = {}): Promise<Command | null> {
  if (opts.command !== undefined && opts.command !== '') {
    const [cmd, ...args] = opts.command.split(/\s+/).filter((p) => p !== '')
    if (cmd !== undefined && (await exitsZero(cmd, [...args, 'hooks']))) {
      return { cmd, args }
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
  if (opts.npxPin !== undefined && (await exitsZero('npx', ['--version']))) {
    return { cmd: 'npx', args: ['-y', '--prefer-offline', opts.npxPin] }
  }
  return null
}

/**
 * Run one `bro hooks <event>` with the payload on stdin; resolve null on
 * every failure mode — spawn error, timeout, nonzero exit, garbage out.
 */
export async function callHook(
  command: Command,
  event: string,
  payload: unknown,
  cwd: string,
  timeoutMs: number
): Promise<HookControl | null> {
  const { promise, resolve } = Promise.withResolvers<HookControl | null>()
  let child: ChildProcess
  try {
    child = spawn(command.cmd, [...command.args, 'hooks', event], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    })
  } catch {
    return null
  }
  let settled = false
  const settle = (value: HookControl | null): void => {
    if (!settled) {
      settled = true
      resolve(value)
    }
  }
  const timer = killAfter(child, timeoutMs, () => settle(null))
  let out = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    const remaining = MAX_OUTPUT - out.length
    if (remaining > 0) {
      out += chunk.slice(0, remaining)
    }
  })
  child.on('error', () => {
    clearTimeout(timer)
    settle(null)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    settle(code === 0 ? parseControl(out) : null)
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(JSON.stringify(payload))
  return promise
}

/**
 * Scan for the first parseable control line — unrelated chatter on
 * stdout must not swallow the answer.
 */
export function parseControl(out: string): HookControl | null {
  for (const line of out.split('\n')) {
    const text = line.trim()
    if (text === '') {
      continue
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as HookControl
      }
    } catch {
      // keep scanning
    }
  }
  return null
}

/**
 * The context half of a control object: bro's "here is what you should
 * know" text. Empty means the hook had nothing to add.
 */
export function contextOf(control: HookControl | null): string {
  const text = control?.hookSpecificOutput?.additionalContext
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * The repo opts in by carrying any project/local bro.config.* or
 * .beads/ — the same gate `bro hooks` applies (core's repoOptedIn).
 * Duplicated here because a shipped adapter cannot import @broject/core;
 * keep the list in sync with CONFIG_LAYER_FILES.
 */
export function broEnabled(startDir: string): boolean {
  const markers = [
    'bro.config.ts',
    'bro.config.json',
    'bro.config.local.ts',
    'bro.config.local.json',
    '.beads',
  ]
  let dir = startDir
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) {
      return true
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return false
    }
    dir = parent
  }
}

/** `bro status --json` — the board the widget renders. Null on any
 *  failure; the board is a convenience, never a gate. */
export async function statusJson(command: Command, cwd: string): Promise<BoardStatus | null> {
  const { promise, resolve } = Promise.withResolvers<BoardStatus | null>()
  let child: ChildProcess
  try {
    child = spawn(command.cmd, [...command.args, 'status', '--json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    })
  } catch {
    return null
  }
  const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(null))
  let out = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    const remaining = MAX_OUTPUT - out.length
    if (remaining > 0) {
      out += chunk.slice(0, remaining)
    }
  })
  child.on('error', () => {
    clearTimeout(timer)
    resolve(null)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (code !== 0) {
      resolve(null)
      return
    }
    try {
      const parsed = JSON.parse(out) as unknown
      resolve(
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as BoardStatus)
          : null
      )
    } catch {
      resolve(null)
    }
  })
  return promise
}

const ELLIPSIS = '…'

/** Clip to a width, marking the cut. */
export function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}${ELLIPSIS}` : text
}

/**
 * The widget board — one compact summary line, then the top in-progress
 * beads and running fleet agents. A string array is the simplest board
 * any host can render.
 */
export function boardLines(s: BoardStatus): string[] {
  const beads = s.beads?.inProgress ?? []
  const running = (s.fleet?.agents ?? []).filter((a) => a.state === 'running')
  const cap = (s.fleet?.maxConcurrent ?? 0) > 0 ? `/${s.fleet?.maxConcurrent}` : ''
  const parts = [
    `◐ ${beads.length} bead${beads.length === 1 ? '' : 's'}`,
    `fleet ${running.length}${cap}`,
    `ready ${s.beads?.readyTotal ?? 0}`,
  ]
  if (s.drill?.frame) {
    parts.push(`drill ${s.drill.frame.id}`)
  }
  if ((s.dirty ?? 0) > 0) {
    parts.push(`dirty ${s.dirty}`)
  }
  const lines = [`bro · ${parts.join(' · ')}`]
  for (const b of beads.slice(0, 3)) {
    lines.push(`  ◐ ${b.id ?? '?'}  ${clip(b.title ?? '', 64)}`)
  }
  for (const a of running.slice(0, 2)) {
    const step = a.step ? `  ${a.step}` : ''
    lines.push(`  ▶ ${a.id ?? '?'}  ${a.backend ?? ''}${step}`)
  }
  return lines
}

/** The footer crumb — the one-glance form of the same board. */
export function statusCrumb(s: BoardStatus): string {
  const beads = s.beads?.inProgress?.length ?? 0
  const running = (s.fleet?.agents ?? []).filter((a) => a.state === 'running').length
  return `bro ◐${beads} ⬢${running}`
}

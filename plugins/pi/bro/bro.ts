/**
 * bro as a pi extension — the project board on pi's TUI, plus the same
 * lifecycle mechanics the shell adapters get, over pi's in-process
 * extension API (spec: bro-1qpk.3).
 *
 * Pi loads this module with jiti (raw TS, no compile) and calls the
 * default-export factory with `ExtensionAPI`. Two surfaces come from
 * bro; none of bro's policy lives here:
 *
 *   board     `bro status --json` → ctx.ui.setWidget + setStatus,
 *             refreshed on session_start / turn_end / agent_settled.
 *             The one-call aggregated read exists precisely so this
 *             widget never shells out N times per tick.
 *   hooks     pi lifecycle events → `bro hooks <event>` with the
 *             payload on stdin, the same contract hooks/run.sh and the
 *             opencode adapter speak. The control object on stdout is
 *             translated into pi's own result slots.
 *
 *   pi event                  → bro hook / surface
 *   session_start             → session-start  (hydrate + prime board)
 *   session_before_compact    → pre-compact    (context carried into the
 *                                              post-compaction inject)
 *   session_compact           → post-compaction (re-prime hydration)
 *   input                     → prompt-submit  (nudge → merged into the
 *                                              before_agent_start inject)
 *   before_agent_start        → inject cached hydration once, as a hidden
 *                               custom message (display:false)
 *   tool_result               → post-tool      (arming + nudges; nudge
 *                                              text appended to content)
 *   agent_before_settle       → stop           (block → continue + the
 *                                              blocker as a visible
 *                                              custom_message entry —
 *                               pi's real settle gate, no post-hoc
 *                               re-prompt needed like opencode's)
 *
 * `tool_call` is deliberately unwired: it can only block, and bro's
 * `permission` plane answers approve/ask — neither maps to a block. When
 * the guard plane lands (bro guard spec) it slots in here.
 *
 * `/bro <args>` is a thin passthrough — `bro act|next|fleet|drill`
 * reachable without leaving the editor. The `bro_status` tool hands the
 * model the same board JSON the widget renders.
 *
 * Fail-open is the whole contract: the CLI resolves lazily (sibling
 * dist → checkout walk-up → PATH probe → npx pin), every spawn is async,
 * a missing bro or a non-bro repo yields no widget, no context, no gate
 * — never an error thrown into pi.
 *
 * One pi-specific hazard this file is built around: **ctx goes stale.**
 * A session replace/reload invalidates the old ExtensionContext — any
 * property read on it throws, and an async handler still holding one
 * crashes the host process. Handlers snapshot cwd/sessionId
 * synchronously at event time (see snapshot()) and every ui touch is
 * wrapped — a stale ctx mid-flight degrades to "no paint".
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- structural pi surface ------------------------------------------------
// Declared, never imported — pi loads this module at runtime and nobody
// typechecks it against @earendil-works/pi-coding-agent, so a dependency
// would drag pi's type tree into this repo for fidelity pi itself
// guarantees. Field names are verbatim; upstream is the only place they
// should change. (Same convention as opencode.ts.)

type Level = 'info' | 'warning' | 'error'

interface UIContext {
  notify(message: string, type?: Level): void
  setStatus(key: string, text: string | undefined): void
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: 'aboveEditor' | 'belowEditor' }
  ): void
}

interface SessionReader {
  getSessionId(): string | undefined
}

interface ExtContext {
  ui: UIContext
  cwd: string
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  sessionManager: SessionReader
}

interface BoundaryResult {
  entries?: Array<{
    type: 'custom_message'
    customType: string
    content: string
    display: boolean
  }>
  continue?: boolean
}

interface HookEvent {
  input?: Record<string, unknown>
  isError?: boolean
  outcome?: 'completed' | 'aborted' | 'error'
  prompt?: string
  text?: string
  toolCallId?: string
  toolName?: string
  content?: Array<{ type: string; text?: string }>
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  killed: boolean
}

interface PiApi {
  on(event: string, handler: (event: never, ctx: ExtContext) => unknown): () => void
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtContext) => Promise<void> | void
    }
  ): void
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtContext
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }): void
  exec(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<ExecResult>
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void
}

// --- shared with the other adapters ----------------------------------------

/** The one control object `bro hooks <event>` prints. */
interface HookControl {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown }
  decision?: string
  reason?: unknown
}

interface Command {
  cmd: string
  args: string[]
}

const HOOK_TIMEOUT_MS = 15_000
/** session-start/post-compaction list `bd ready` and scan worktrees —
 *  measured at 20-40s in a loaded repo. */
const REHYDRATION_TIMEOUT_MS = 45_000
const MAX_OUTPUT = 1 << 20

/** `node` on PATH, not process.execPath — pi may ship as a compiled
 *  binary whose execPath IS pi. Same rule as the opencode module. */
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

/** Last-resort npx spec, pinned to this module's own version — the pin is
 *  rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = '@broject/bro@0.2.4'

/** SIGKILL a hung child on a timer; the detached group flag lets one
 *  kill take spawned grandchildren down with it. */
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
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' }) // NOSONAR typescript:S4036
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

async function resolveCommand(): Promise<Command | null> {
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
}

/** Run one `bro hooks <event>` with the payload on stdin; resolve null on
 *  every failure mode — spawn error, timeout, nonzero exit, garbage out.
 *  Async: pi runs extensions on its own event loop. */
function callHook(
  command: Command,
  event: string,
  payload: unknown,
  cwd: string,
  timeoutMs: number
): Promise<HookControl | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command.cmd, [...command.args, 'hooks', event], {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      })
    } catch {
      resolve(null)
      return
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
  })
}

/** Scan for the first parseable control line — unrelated chatter on
 *  stdout must not swallow the answer. */
function parseControl(out: string): HookControl | null {
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

function contextOf(control: HookControl | null): string {
  const text = control?.hookSpecificOutput?.additionalContext
  return typeof text === 'string' ? text.trim() : ''
}

/** The repo opts in by carrying bro.config.json or .beads/ — the same
 *  gate `bro hooks` itself applies; checked cheaply here so non-bro dirs
 *  never even spawn the CLI. */
function broEnabled(startDir: string): boolean {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, 'bro.config.json')) || existsSync(join(dir, '.beads'))) {
      return true
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return false
    }
    dir = parent
  }
}

// --- the board ------------------------------------------------------------

/** Minimal structural read of `bro status --json` — fields the widget
 *  renders; everything else passes through unread. */
interface BoardStatus {
  branch?: string
  dirty?: number
  beads?: {
    inProgress?: Array<{ id?: string; title?: string }>
    readyTotal?: number
  }
  fleet?: {
    maxConcurrent?: number
    agents?: Array<{ id?: string; backend?: string; state?: string; step?: string }>
  }
  drill?: { frame?: { id?: string; title?: string; depth?: number } | null }
}

function statusJson(command: Command, cwd: string): Promise<BoardStatus | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command.cmd, [...command.args, 'status', '--json'], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      })
    } catch {
      resolve(null)
      return
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
  })
}

const ELLIPSIS = '…'
function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}${ELLIPSIS}` : text
}

/** The widget board — one compact summary line, then the top in-progress
 *  beads. String[] is pi's simplest widget slot; detail lives in `/bro`. */
function boardLines(s: BoardStatus): string[] {
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

/** The footer crumb — what setWidget's detail folds into. */
function statusCrumb(s: BoardStatus): string {
  const beads = s.beads?.inProgress?.length ?? 0
  const running = (s.fleet?.agents ?? []).filter((a) => a.state === 'running').length
  return `bro ◐${beads} ⬢${running}`
}

// --- the extension ---------------------------------------------------------

export default function broExtension(pi: PiApi): void {
  // resolved on first use — probing costs a spawn even where bro is inert
  let command: Promise<Command | null> | undefined
  /** Cached hydration text — primed on session_start (the only window
   *  where the 20-40s probe cost overlaps the user's first prompt), then
   *  injected once into context and re-primed across compaction. */
  let hydration: Promise<string> | undefined
  let injected = false
  /** prompt-submit nudge for the next turn — consumed, not cached. */
  let promptNudge: Promise<string> | undefined
  /** Set when the stop gate already continued this session — gates, not
   *  loops: the blocker goes back once, a later settle is let through. */
  let gated = false
  /** Latest board payload — every refresh path (session_start,
   *  turn_end, /bro) writes through here. */
  let lastBoard: BoardStatus | null = null

  /** pi invalidates a session's ctx on replace/reload — ANY property
   *  access on a stale ctx throws (and async handlers holding one crash
   *  the host). So handlers snapshot cwd/sessionId synchronously at
   *  event time, and every ui touch is guarded: a stale ctx mid-flight
   *  degrades to "no paint", never a throw into pi. */
  const snapshot = (ctx: ExtContext): { cwd: string; sessionId: string } | null => {
    try {
      return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() ?? '' }
    } catch {
      return null
    }
  }

  const probe = async (
    event: string,
    payload: unknown,
    cwd: string,
    timeoutMs = HOOK_TIMEOUT_MS
  ): Promise<HookControl | null> => {
    if (!broEnabled(cwd)) {
      return null
    }
    command ??= resolveCommand()
    const resolved = await command
    return resolved === null ? null : callHook(resolved, event, payload, cwd, timeoutMs)
  }

  const paint = (ctx: ExtContext): void => {
    try {
      if (ctx.mode !== 'tui') {
        return
      }
      if (lastBoard === null) {
        ctx.ui.setWidget('bro', undefined)
        ctx.ui.setStatus('bro', undefined)
        return
      }
      ctx.ui.setWidget('bro', boardLines(lastBoard), { placement: 'aboveEditor' })
      ctx.ui.setStatus('bro', statusCrumb(lastBoard))
    } catch {
      // stale ctx — the new session's own refresh paints when it lands
    }
  }

  const refreshBoard = async (ctx: ExtContext): Promise<void> => {
    const snap = snapshot(ctx)
    if (snap === null || !broEnabled(snap.cwd)) {
      return
    }
    command ??= resolveCommand()
    const resolved = await command
    if (resolved === null) {
      return
    }
    lastBoard = await statusJson(resolved, snap.cwd)
    paint(ctx)
  }

  /** Hydration runs once per session (re-primed on compaction); the
   *  answer is injected at the next before_agent_start, not pushed into
   *  the transcript eagerly — pi may sit at the prompt for minutes. */
  const hydrate = (ctx: ExtContext, event: 'session-start' | 'post-compaction'): void => {
    const snap = snapshot(ctx)
    if (snap === null) {
      return
    }
    const started = probe(event, { session_id: snap.sessionId }, snap.cwd, REHYDRATION_TIMEOUT_MS).then(
      (control) => contextOf(control)
    )
    hydration = started
    injected = false
    // a failed probe is not the session's verdict — drop the cache entry
    // so the next prompt deserves a retry rather than sticking on ''
    void started.then((text) => {
      if (hydration === started && text === '') {
        hydration = undefined
      }
    })
  }

  pi.on('session_start', (_e: never, ctx: ExtContext) => {
    hydrate(ctx, 'session-start')
    void refreshBoard(ctx)
  })

  pi.on('session_compact', (_e: never, ctx: ExtContext) => {
    gated = false
    hydrate(ctx, 'post-compaction')
    void refreshBoard(ctx)
  })

  // pre-compact context is what must survive the summary — carry it into
  // the hydration cache so the post-compaction inject keeps it
  pi.on('session_before_compact', async (_e: never, ctx: ExtContext) => {
    const snap = snapshot(ctx)
    if (snap === null) {
      return
    }
    const text = contextOf(
      await probe('pre-compact', { session_id: snap.sessionId }, snap.cwd, REHYDRATION_TIMEOUT_MS)
    )
    if (text === '') {
      return
    }
    const carry = text
    const prior = hydration ?? Promise.resolve('')
    hydration = prior.then((base) => (base === '' ? carry : `${base}\n\n${carry}`))
  })

  // the prompt-submit nudge rides the same inject slot as hydration —
  // one hidden custom message, not two transcript entries
  pi.on('input', (event: HookEvent, ctx: ExtContext) => {
    const prompt = typeof event.text === 'string' ? event.text : ''
    const snap = snapshot(ctx)
    if (prompt === '' || snap === null) {
      return
    }
    promptNudge = probe('prompt-submit', { session_id: snap.sessionId, prompt }, snap.cwd).then(
      (control) => contextOf(control)
    )
  })

  pi.on('before_agent_start', async (_e: never, ctx: ExtContext) => {
    const parts: string[] = []
    if (!injected && hydration !== undefined) {
      const text = (await hydration).trim()
      if (text !== '') {
        parts.push(text)
      }
      injected = true
    }
    const nudge = promptNudge
    promptNudge = undefined
    if (nudge !== undefined) {
      const text = (await nudge).trim()
      if (text !== '') {
        parts.push(text)
      }
    }
    if (parts.length === 0) {
      return
    }
    return {
      message: {
        customType: 'bro-context',
        content: parts.join('\n\n'),
        display: false,
      },
    }
  })

  // post-tool: the arming markers + nudges live in bro; the nudge text
  // appends to the tool result content, same as the opencode adapter
  pi.on('tool_result', async (event: HookEvent, ctx: ExtContext) => {
    const snap = snapshot(ctx)
    if (snap === null) {
      return
    }
    const text = contextOf(
      await probe('post-tool', {
        session_id: snap.sessionId,
        tool_name: event.toolName ?? '',
        tool_input: event.input ?? {},
        tool_response: { success: event.isError !== true },
      }, snap.cwd)
    )
    if (text === '') {
      return
    }
    const content = Array.isArray(event.content) ? [...event.content] : []
    content.push({ type: 'text', text })
    return { content }
  })

  // the stop gate: block → continue + the blocker back as a visible
  // message, ONCE per session (gated arms stop_hook_active on the probe,
  // so bro's own one-shot rule is what fires — not a duplicated guard)
  pi.on('agent_before_settle', async (event: HookEvent, ctx: ExtContext) => {
    const snap = snapshot(ctx)
    if (snap === null || event.outcome !== 'completed' || gated) {
      return
    }
    const control = await probe(
      'stop',
      { session_id: snap.sessionId, stop_hook_active: gated },
      snap.cwd
    )
    if (control?.decision !== 'block') {
      const hint = contextOf(control)
      if (hint !== '') {
        try {
          ctx.ui.notify(hint, 'info')
        } catch {
          // stale ctx — a hint is advisory, never worth a throw
        }
      }
      return
    }
    gated = true
    const reason = typeof control.reason === 'string' ? control.reason.trim() : ''
    void refreshBoard(ctx)
    return {
      continue: true,
      entries: [
        {
          type: 'custom_message' as const,
          customType: 'bro-stop-gate',
          content: reason === '' ? 'unfinished bro work' : reason,
          display: true,
        },
      ],
    } satisfies BoundaryResult
  })

  pi.on('turn_end', (_e: never, ctx: ExtContext) => {
    void refreshBoard(ctx)
  })
  pi.on('agent_settled', (_e: never, ctx: ExtContext) => {
    void refreshBoard(ctx)
  })
  pi.on('session_shutdown', (_e: never, ctx: ExtContext) => {
    try {
      if (ctx.mode === 'tui') {
        ctx.ui.setWidget('bro', undefined)
        ctx.ui.setStatus('bro', undefined)
      }
    } catch {
      // teardown races a stale ctx — nothing to paint anyway
    }
  })

  /** `/bro <args>` — the CLI without leaving the editor. Bare `/bro`
   *  repaints the board; a real subcommand runs it and drops stdout into
   *  the transcript as a visible custom message. */
  pi.registerCommand('bro', {
    description: 'bro — board refresh, or run `bro <args>` (act|next|fleet|drill|…)',
    async handler(args: string, ctx: ExtContext) {
      const snap = snapshot(ctx)
      if (snap === null) {
        return
      }
      if (!broEnabled(snap.cwd)) {
        ctx.ui.notify('bro: not a bro-enabled directory', 'warning')
        return
      }
      command ??= resolveCommand()
      const resolved = await command
      if (resolved === null) {
        ctx.ui.notify('bro: CLI not found (dist, PATH, or npx)', 'error')
        return
      }
      const trimmed = args.trim()
      if (trimmed === '') {
        await refreshBoard(ctx)
        ctx.ui.notify(lastBoard === null ? 'bro: no board state' : 'bro board refreshed', 'info')
        return
      }
      const out = await pi.exec(
        resolved.cmd,
        [...resolved.args, ...trimmed.split(/\s+/)],
        { cwd: snap.cwd, timeout: 60_000 }
      )
      const text = (out.stdout || out.stderr).trim()
      if (out.code !== 0) {
        const detail = text === '' ? '' : ` — ${clip(text.split('\n')[0] ?? '', 120)}`
        ctx.ui.notify(`bro ${trimmed}: exit ${out.code}${detail}`, 'error')
        return
      }
      pi.sendMessage(
        { customType: 'bro-output', content: `$ bro ${trimmed}\n${text}`, display: true },
        { triggerTurn: false }
      )
      void refreshBoard(ctx)
    },
  })

  /** `bro_status` — the board JSON as a model-callable read. The model
   *  gets the same object the widget renders; schema is a plain empty
   *  object (a TypeBox-compatible literal — no dependency dragged in). */
  pi.registerTool({
    name: 'bro_status',
    label: 'bro status',
    description:
      'Read the bro project board: in-progress beads, ready count, fleet agents, drill frame, branch/dirty state. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const snap = snapshot(ctx)
      command ??= resolveCommand()
      const resolved = await command
      const board =
        snap === null || resolved === null ? null : await statusJson(resolved, snap.cwd)
      return {
        content: [
          {
            type: 'text' as const,
            text: board === null ? 'bro status unavailable' : JSON.stringify(board),
          },
        ],
      }
    },
  })
}

/** Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
 *  foreign file holding this slot; the marker survives generation into
 *  plugins/pi/bro/bro.ts. */
export const adapter = { id: 'bro', kind: 'pi-extension' } as const

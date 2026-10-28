// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/** @jsxImportSource @opentui/solid */
/**
 * bro — opencode V2 TUI plugin (`tui.tsx`), the terminal half of the
 * integration for the v2 slot tree. `bro.ts` still speaks to the
 * server; `cli.ts` is the V1 single-file shape v2 no longer loads —
 * this module is the directory plugin (`plugins/bro/tui.tsx`) the v2
 * TUI actually discovers:
 *
 *   sidebar.content     the bro board — in-work beads, backlog top,
 *                       fleet load, watch heartbeat; polls
 *                       `bro status --json` and re-reads on session
 *                       events. Hidden outside a bro rig.
 *   `/bro [args]`       slash + palette command → `bro <args>` → toast
 *   permission.asked    gate visibility toast
 *   session.execution.failed  failure toast
 *
 * Host-provided imports (`@opencode/plugin`, `solid-js`, `@opentui/*`)
 * resolve against opencode's own modules — the artifact needs no
 * node_modules beside it. Every bro call stays optional-chained and
 * fail-quiet: a missing CLI renders nothing, never a crash.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Plugin } from '@opencode/plugin/tui'
import { For, Show, createSignal } from 'solid-js'

interface Command {
  cmd: string
  args: string[]
}

interface CliOptions {
  command?: string | { cmd: string; args?: string[] }
}

const HOOK_TIMEOUT_MS = 15_000
const MAX_OUTPUT = 1 << 20
/** Toasts are glanceable — a `bro status` board is not; cap the body. */
const TOAST_MAX = 3_000
/** Board refresh cadence — `bro status` is local reads only. */
const POLL_MS = 15_000
/** Sidebar rows are narrow — the id already keys the bead, the title
 *  is a reminder, not a document. */
const TITLE_MAX = 34

const NPX_PIN = '@broject/bro@0.2.5'

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

/** Same ladder as bro.ts / cli.ts — resolve once, lazily, and keep the
 *  answer. */
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
 *  value together. Unmatched quotes degrade to the plain token. */
function splitArgs(input: string): string[] {
  const args: string[] = []
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(m[1] ?? m[2] ?? m[3] ?? m[0])
  }
  return args
}

/** The board's read — `bro status --json` projected down to what the
 *  sidebar renders. Anything unreadable parses to null and the widget
 *  hides; an absent rig is an ordinary state. */
interface Board {
  dirty: number
  dir?: string
  branch?: string
  beads: {
    inProgress: Array<{ id: string; title: string; assignee?: string }>
    ready: Array<{ id: string; title: string }>
    readyTotal: number
  }
  fleet: {
    maxConcurrent: number
    agents: Array<{ id: string; state: string; provider?: string; model?: string; worktree?: string; pid?: number; step?: string }>
  }
  loop: { runs: Array<{ slug: string; state: string; startedAt?: number }> }
  watch: { ageMs: number; attention: number } | null
  act?: { pr: number; url: string } | null
  worktrees?: Array<{ name: string; branch?: string; path?: string }>
}

/** Same gate as `bro hooks` / the pi adapter's `broEnabled` — a repo
 *  opts in by carrying any project/local bro.config.* or a `.beads/`
 *  store. Duplicated here because the shipped artifact cannot import
 *  @broject/core; keep the list in sync with CONFIG_LAYER_FILES. */
function broEnabled(startDir: string): boolean {
  const markers = ['bro.config.ts', 'bro.config.json', 'bro.config.local.ts', 'bro.config.local.json', '.beads']
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

function parseRows(v: unknown): Array<{ id: string; title: string; assignee?: string }> {
  if (!Array.isArray(v)) return []
  return v.flatMap((r) => {
    const row = r as { id?: unknown; title?: unknown; assignee?: unknown }
    if (typeof row.id === 'string' && typeof row.title === 'string') {
      const out: { id: string; title: string; assignee?: string } = { id: row.id, title: row.title }
      if (typeof row.assignee === 'string') out.assignee = row.assignee
      return [out]
    }
    return []
  })
}

function parseAgents(v: unknown): Board['fleet']['agents'] {
  if (!Array.isArray(v)) return []
  return v.flatMap((a) => {
    const row = a as Record<string, unknown>
    if (typeof row.id === 'string' && typeof row.state === 'string') {
      return [
        {
          id: row.id,
          state: row.state,
          provider: typeof row.provider === 'string' ? row.provider : undefined,
          model: typeof row.model === 'string' ? row.model : undefined,
          worktree: typeof row.worktree === 'string' ? row.worktree : undefined,
          pid: typeof row.pid === 'number' ? row.pid : undefined,
          step: typeof row.step === 'string' ? row.step : undefined,
        },
      ]
    }
    return []
  })
}

function parseRuns(v: unknown): Board['loop']['runs'] {
  if (!Array.isArray(v)) return []
  return v.flatMap((r) => {
    const row = r as Record<string, unknown>
    if (typeof row.slug === 'string' && typeof row.state === 'string') {
      return [
        {
          slug: row.slug,
          state: row.state,
          startedAt: typeof row.startedAt === 'number' ? row.startedAt : undefined,
        },
      ]
    }
    return []
  })
}

function parseWorktrees(v: unknown): Board['worktrees'] {
  if (!Array.isArray(v)) return undefined
  return v.flatMap((w) => {
    const row = w as Record<string, unknown>
    if (typeof row.name === 'string') {
      return [
        {
          name: row.name,
          branch: typeof row.branch === 'string' ? row.branch : undefined,
          path: typeof row.path === 'string' ? row.path : undefined,
        },
      ]
    }
    return []
  })
}

function parseWatch(v: unknown): Board['watch'] {
  if (v === null || typeof v !== 'object') return null
  const o = v as { ageMs?: unknown; attention?: unknown }
  return {
    ageMs: Number(o.ageMs) || 0,
    attention: Number(o.attention) || 0,
  }
}

function parseAct(v: unknown): Board['act'] {
  if (v === null || typeof v !== 'object') return null
  const o = v as { pr?: unknown; url?: unknown }
  return {
    pr: Number(o.pr) || 0,
    url: typeof o.url === 'string' ? o.url : '',
  }
}

function parseBoard(out: string): Board | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null
  }
  const o = parsed as Record<string, unknown>
  const beads = (o.beads ?? {}) as Record<string, unknown>
  const fleet = (o.fleet ?? {}) as Record<string, unknown>
  const loop = (o.loop ?? {}) as Record<string, unknown>
  const rows = parseRows
  const agents = parseAgents(fleet.agents)
  const runs = parseRuns(loop.runs)
  const watch = parseWatch(o.watch)
  const act = parseAct(o.act)
  const worktrees = parseWorktrees(o.worktrees)
  return {
    dirty: typeof o.dirty === 'number' ? o.dirty : 0,
    dir: typeof o.dir === 'string' ? o.dir : undefined,
    branch: typeof o.branch === 'string' ? o.branch : undefined,
    beads: {
      inProgress: rows(beads.inProgress),
      ready: rows(beads.ready),
      readyTotal: typeof beads.readyTotal === 'number' ? beads.readyTotal : 0,
    },
    fleet: {
      maxConcurrent: typeof fleet.maxConcurrent === 'number' ? fleet.maxConcurrent : 0,
      agents,
    },
    loop: { runs },
    watch,
    act,
    worktrees,
  }
}

function ageStr(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  return `${Math.round(m / 60)}h`
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null || ms <= 0) return '?'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

function shortId(id: string): string {
  return id.startsWith('bro-') ? id.slice(4) : id
}

function findAgentForBead(b: { id: string }, agents: Board['fleet']['agents'], runs: Board['loop']['runs']): Board['fleet']['agents'][number] | null {
  for (const a of agents) {
    if (a.step === b.id) return a
    if (a.id === b.id) return a
    if (a.worktree && (a.worktree.includes(b.id) || b.id.includes(a.worktree))) return a
  }
  for (const r of runs) {
    if (r.slug === b.id) {
      for (const a of agents) {
        if (a.worktree?.includes(r.slug)) return a
      }
    }
  }
  return null
}

function findRunForBead(b: { id: string }, runs: Board['loop']['runs']): Board['loop']['runs'][number] | null {
  for (const r of runs) {
    if (r.slug === b.id) return r
    if (b.id.includes(r.slug) || r.slug.includes(b.id)) return r
  }
  return null
}

function InWorkItem(props: { b: { id: string; title: string }; board: () => Board | null; theme: any }) {
  const board = () => props.board()
  const theme = props.theme
  const b = props.b
  const a = findAgentForBead(b, board()!.fleet.agents, board()!.loop.runs)
  const r = findRunForBead(b, board()!.loop.runs)
  const pr = board()!.act?.pr && board()!.act?.url ? board()!.act : null
  const dur = r?.startedAt ? fmtDuration(Date.now() - r.startedAt) : undefined
  return (
    <box flexDirection="column" marginBottom={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: theme.text.feedback.info.base }}>●</span>{' '}
        <b>{shortId(b.id)}</b> <span style={{ fg: theme.text.muted }}>{b.title.length > 40 ? `${b.title.slice(0, 40)}…` : b.title}</span>
      </text>
      <box flexDirection="row" gap={1} paddingLeft={2}>
        <Show when={pr}>
          <text fg={theme.text.feedback.info.base}>
            <u>#{pr!.pr}</u>
          </text>
        </Show>
        <Show when={a}>
          <text fg={theme.text.muted}>
            {a!.provider ?? 'agent'}{a!.model ? `/${a!.model}` : ''}
          </text>
        </Show>
        <Show when={dur !== undefined}>
          <text fg={theme.text.muted}>{dur}</text>
        </Show>
      </box>
    </box>
  )
}

function BroBoardOpen(props: { board: () => Board | null; theme: any }) {
  const board = () => props.board()
  const theme = props.theme
  const live = () => (board()?.fleet.agents ?? []).filter((a) => a.state === 'running')
  const runningLoops = () => (board()?.loop.runs ?? []).filter((r) => r.state === 'running')
  const now = () => Date.now()
  return (
<>
  <Show when={(board()?.beads.inProgress.length ?? 0) > 0}>
    <text fg={theme.text.muted}>in work</text>
    <For each={board()?.beads.inProgress.slice(0, 6) ?? []}>
      {(b) => <InWorkItem b={b} board={board} theme={theme} />}
    </For>
  </Show>
  <Show when={(board()?.beads.readyTotal ?? 0) > 0}>
    <text fg={theme.text.muted}>ready ({board()?.beads.readyTotal})</text>
    <For each={board()?.beads.ready.slice(0, 4) ?? []}>
      {(b) => (
        <box flexDirection="row" gap={1} minWidth={0}>
          <text flexShrink={0} style={{ fg: theme.text.muted }}>○</text>
          <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
            <b>{shortId(b.id)}</b> {b.title.length > 40 ? `${b.title.slice(0, 40)}…` : b.title}
          </text>
        </box>
      )}
    </For>
  </Show>
  <Show when={live().length > 0 || runningLoops().length > 0}>
    <text fg={theme.text.muted}>
      fleet {live().length}
      <Show when={(board()?.fleet.maxConcurrent ?? 0) > 0}>/{board()!.fleet.maxConcurrent}</Show>
      <Show when={runningLoops().length > 0}> · loop ×{runningLoops().length}</Show>
    </text>
    <For each={live().slice(0, 3)}>
      {(a) => (
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {'  '}<span style={{ fg: theme.text.feedback.success.base }}>●</span> {a.id}
        </text>
      )}
    </For>
  </Show>
  <Show when={board()?.watch}>
    {(w) => (
      <text fg={w().attention > 0 ? theme.text.feedback.warning.base : theme.text.muted}>
        watch {ageStr(w().ageMs)} ago
        <Show when={w().attention > 0}> · {w().attention} attention</Show>
      </text>
    )}
  </Show>
  <Show when={(board()?.dirty ?? 0) > 0}>
    <text fg={theme.text.feedback.warning.base}>dirty ×{board()!.dirty}</text>
  </Show>
</>
  )
}

function BroBoard(props: { context: Plugin.Context; board: () => Board | null }) {
  const theme = props.context.theme
  const [view, updateView] = props.context.storage.store('bro.view', {
    initial: { open: true },
  })
  const board = () => props.board()
  const now = () => Date.now()
  return (
    <Show when={board() !== null}>
      <box flexDirection="column">
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch(() => {})
          }}
        >
          <text fg={theme.text.base}>{view.open ? '▼' : '▶'}</text>
          <text fg={theme.text.base}>
            <b>bro</b>
            <Show when={!view.open && board() !== null}>
              <span style={{ fg: theme.text.muted }}>
                {' '}
                ({board()!.beads.inProgress.length} in work, {board()!.beads.readyTotal} ready
                {board()!.watch ? `, ${board()!.watch!.attention} attention` : ''})
              </span>
            </Show>
          </text>
        </box>
        <Show when={view.open}>
          <BroBoardOpen board={board} theme={theme} />
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: 'bro.cli',
  setup(context) {
    const cwd = context.location?.directory ?? process.cwd()
    const resolveCmd = commandResolver(context.options)
    const toast = context.ui.toast

    const runBro = async (input?: string): Promise<void> => {
      const args = splitArgs(input ?? '')
      const verb = args.length > 0 ? args : ['status']
      const { code, out, err } = await exec(await resolveCmd(), verb, cwd)
      const body = out || err || '(no output)'
      const suffix = code === 0 ? '' : ` — exit ${code}`
      toast.show({
        title: `bro ${verb.join(' ')}${suffix}`,
        message: clip(body),
        variant: code === 0 ? 'info' : 'warning',
        duration: 10_000,
      })
    }

    context.keymap.layer(() => ({
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

    // the board poll — one signal feeds every session's sidebar; a rig
    // without bro never parses, so the widget stays hidden there
    const [board, setBoard] = createSignal<Board | null>(null)
    const refresh = async (): Promise<void> => {
      if (!broEnabled(cwd)) {
        setBoard(null)
        return
      }
      const command = await resolveCmd()
      if (command === null) {
        return
      }
      const { code, out } = await exec(command, ['status', '--json'], cwd)
      if (code === 0 && out !== '') {
        const parsed = parseBoard(out)
        setBoard(parsed)
      } else {
        setBoard(null)
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    timer.unref?.()

    const stops = [
      context.data.on('session.idle', () => void refresh()),
      context.data.on('session.execution.succeeded', () => void refresh()),
      context.data.on('session.execution.failed', () => void refresh()),
      context.data.on('permission.asked', (event) => {
        const d = event.data as Record<string, unknown>
        const action = typeof d.action === 'string' ? d.action : ''
        const resources = Array.isArray(d.resources)
          ? d.resources.filter((r): r is string => typeof r === 'string').join(' ')
          : ''
        const detail = [action, resources].filter((s) => s !== '').join(' ')
        toast.show({
          title: 'bro • permission',
          message: clip(detail !== '' ? detail : 'permission requested'),
          variant: 'warning',
          duration: 8000,
        })
      }),
      context.data.on('session.execution.failed', (event) => {
        const d = event.data as { error?: unknown }
        const error = d.error
        let message = 'session error'
        if (typeof error === 'object' && error !== null && 'message' in error) {
          message = String((error as { message: unknown }).message)
        } else if (typeof error === 'string') {
          message = error
        }
        toast.show({
          title: 'bro • error',
          message: clip(message),
          variant: 'error',
          duration: 10_000,
        })
      }),
    ]

    const releaseSlot = context.ui.slot({
      append: 'sidebar.content',
      render: () => <BroBoard context={context} board={board} />,
    })

    return () => {
      clearInterval(timer)
      releaseSlot()
      for (const stop of stops) {
        stop()
      }
    }
  },
})

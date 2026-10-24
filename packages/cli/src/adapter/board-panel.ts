/**
 * The interactive bro board — the `ui.custom` panel behind bare `/bro`.
 *
 * The passive widget (`boardLines`) answers "what is going on" in a few
 * clipped lines; this panel is the same board with a keyboard: sections
 * you can collapse, a cursor, and `r` re-probing `bro status --json`
 * through the driver.
 *
 * Contract: omp's docs/tui.md, "TUI integration for extensions and
 * custom tools" — `render(width)` returns width-safe lines and the same
 * array reference while unchanged, `handleInput(data)` receives raw
 * terminal input, `done(result)` closes. The adapter bundle may import
 * node builtins only (see scripts/bundle-adapter.ts), so this module is
 * plain TypeScript: the Component/Theme/KeybindingsManager shapes are
 * structural, mirroring upstream `packages/tui/src/tui.ts` and
 * `extensions/types.ts`.
 */
import { boardLines, clip, sanitizeTerminalText, type BoardStatus } from './core.ts'

/** Where the panel reads its board — the driver's snapshot and refresh
 *  paths, so the widget and the panel never diverge on data. */
export interface BoardPanelHost {
  /** The last `bro status --json` snapshot (driver state). */
  snapshot(): BoardStatus | null
  /** Re-probe the board, repaint the widget, return the fresh snapshot. */
  refresh(): Promise<BoardStatus | null>
}

/** Structural pi-tui `Theme` — the colorizer a panel needs, nothing
 *  more. Method syntax keeps parameter bivariance with upstream's
 *  role-union signatures. */
export interface BoardPanelTheme {
  fg(role: string, text: string): string
}

/** Structural `KeybindingsManager` (upstream `extensions/types.ts`). */
export interface BoardPanelKeybindings {
  matches(data: string, action: string): boolean
}

/** The TUI handle the host factory passes — only the async repaint
 *  poke: a refreshed board must repaint without a keypress. */
export interface BoardPanelTui {
  requestRender?(force?: boolean): void
}

/** Structural pi-tui `Component` — the mount contract from docs/tui.md. */
export interface BoardPanelComponent {
  render(width: number): readonly string[]
  handleInput(data: string): void
  invalidate?(): void
  dispose?(): void
}

export interface BoardPanelOptions {
  host: BoardPanelHost
  /** Called exactly once — the `custom()` promise resolves with it. */
  done: (result: undefined) => void
  theme?: BoardPanelTheme
  keybindings?: BoardPanelKeybindings
  tui?: BoardPanelTui
}

/** The factory `ui.custom` mounts (upstream `ExtensionUIContext.
 *  custom`'s shape) — shared by the host binding and the UI typings. */
export type BoardPanelFactory = (
  tui: BoardPanelTui,
  theme: BoardPanelTheme,
  keybindings: BoardPanelKeybindings,
  done: (result: undefined) => void
) => BoardPanelComponent | Promise<BoardPanelComponent>

/** One collapsible group of board rows. */
interface Section {
  id: string
  title: string
  rows: string[]
}

type RowKind = 'header' | 'section' | 'item' | 'footer'

interface Row {
  kind: RowKind
  section?: string
}

const READY_SHOWN = 8
const SILENT_MS = 60_000

type InProgressBead = NonNullable<NonNullable<BoardStatus['beads']>['inProgress']>[number]
type ReadyBead = NonNullable<NonNullable<BoardStatus['beads']>['ready']>[number]
type FleetAgent = NonNullable<NonNullable<BoardStatus['fleet']>['agents']>[number]
type LoopRun = NonNullable<NonNullable<BoardStatus['loop']>['runs']>[number]
type Worktree = NonNullable<BoardStatus['worktrees']>[number]

/** One in-progress bead's row. */
function beadRow(b: InProgressBead): string {
  const assignee = b.assignee ? `  [${b.assignee}]` : ''
  return `◐ ${b.id ?? '?'}  ${clip(b.title ?? '', 96)}${assignee}`
}

/** One ready bead's row. */
function readyRow(b: ReadyBead): string {
  return `✓ ${b.id ?? '?'}  ${clip(b.title ?? '', 96)}`
}

/** One fleet agent's row: id, backend, state, then what it is doing. */
function fleetRow(a: FleetAgent): string {
  const parts = [`▶ ${a.id ?? '?'}  ${a.backend ?? ''}  ${a.state ?? '?'}`]
  if (a.state === 'running' && a.step) {
    parts.push(a.step)
  }
  if (a.state !== 'running' && a.cause) {
    parts.push(`(${a.cause})`)
  }
  if (a.worktree) {
    parts.push(a.worktree)
  }
  return parts.join('  ')
}

/** One loop run's row: bead, state, pid, silence, worktree. */
function loopRow(r: LoopRun): string {
  const parts = [`${r.state === 'running' ? '▶' : '·'} ${r.beadId ?? r.slug ?? '?'}`]
  parts.push(r.state ?? '?')
  if (typeof r.pid === 'number') {
    parts.push(`pid ${r.pid}`)
  }
  const silent = r.silentMs ?? 0
  if (silent > SILENT_MS) {
    parts.push(`silent ${Math.round(silent / 60_000)}m`)
  }
  if (r.worktree) {
    parts.push(r.worktree)
  }
  return parts.join('  ')
}

/** One worktree's row: name, branch, state, main marker. */
function worktreeRow(w: Worktree): string {
  const parts = [`⎇ ${w.name ?? w.path ?? '?'}  ${w.branch ?? '?'}`]
  if (w.state) {
    parts.push(w.state)
  }
  if (w.main) {
    parts.push('(main)')
  }
  return parts.join('  ')
}

/** Build the panel's sections from a snapshot. Absent data hides its
 *  section; present-but-empty data shows it with a placeholder — the
 *  difference between "no loop configured" and "loop with 0 runs" is
 *  worth one row. */
function buildSections(s: BoardStatus | null): Section[] {
  if (s === null) {
    return [{ id: 'board', title: 'board', rows: ['no board yet — press r to load'] }]
  }
  return [...workSections(s), ...agentSections(s), ...checkoutSections(s)]
}

/** beads + ready — what is claimed and what is queued. */
function workSections(s: BoardStatus): Section[] {
  const inProgress = s.beads?.inProgress ?? []
  const beadRows = inProgress.length === 0 ? ['— none in progress —'] : inProgress.map(beadRow)
  const ready = s.beads?.ready ?? []
  const readyTotal = s.beads?.readyTotal ?? ready.length
  const shown = ready.slice(0, READY_SHOWN)
  const readyRows = shown.map(readyRow)
  if (readyTotal - shown.length > 0) {
    readyRows.push(`… ${readyTotal - shown.length} more ready`)
  }
  return [
    { id: 'beads', title: `beads (${inProgress.length})`, rows: beadRows },
    { id: 'ready', title: `ready (${readyTotal})`, rows: readyRows },
  ]
}

/** fleet + loop — the agent plane: who runs, who exited, who is loud. */
function agentSections(s: BoardStatus): Section[] {
  const sections: Section[] = []
  const agents = s.fleet?.agents ?? []
  const running = agents.filter((a) => a.state === 'running').length
  const max = s.fleet?.maxConcurrent ?? 0
  const cap = max > 0 ? `/${max}` : ''
  sections.push({
    id: 'fleet',
    title: `fleet (${running}${cap})`,
    rows: agents.length === 0 ? ['— no agents —'] : agents.map(fleetRow),
  })
  // a configured loop with zero runs shows its empty state — hiding it
  // would make "no runs" indistinguishable from "no loop"
  if (s.loop !== undefined) {
    const runs = s.loop.runs ?? []
    sections.push({
      id: 'loop',
      title: `loop (${runs.filter((r) => r.state === 'running').length})`,
      rows: runs.length === 0 ? ['— no runs —'] : runs.map(loopRow),
    })
  }
  return sections
}

/** worktrees + drill + repo — the checkout around the session. */
function checkoutSections(s: BoardStatus): Section[] {
  const sections: Section[] = []
  // an empty list shows its empty state (see the loop note above)
  if (s.worktrees !== undefined) {
    const trees = s.worktrees
    sections.push({
      id: 'worktrees',
      title: `worktrees (${trees.length})`,
      rows: trees.length === 0 ? ['— none —'] : trees.map(worktreeRow),
    })
  }
  const frame = s.drill?.frame
  if (frame) {
    const title = frame.title ? `  — ${clip(frame.title, 96)}` : ''
    const depth = typeof frame.depth === 'number' ? `  (depth ${frame.depth})` : ''
    sections.push({
      id: 'drill',
      title: 'drill',
      rows: [`⌄ ${frame.id ?? '?'}${title}${depth}`],
    })
  }
  const repoRows = [`branch  ${s.branch ?? '?'}`]
  if ((s.dirty ?? 0) > 0) {
    repoRows.push(`dirty   ${s.dirty} file(s)`)
  }
  sections.push({ id: 'repo', title: 'repo', rows: repoRows })
  return sections
}

/** The always-visible summary — the widget's own words (boardLines),
 *  so panel header and widget line never drift apart. */
function summaryOf(s: BoardStatus | null, pending: boolean): string {
  if (s === null) {
    return 'bro · no board'
  }
  const attention = s.watch?.attention ?? 0
  const base = boardLines(s)[0]
  const attentionSuffix = attention > 0 ? ` · ⚠ ${attention} attention` : ''
  const pendingSuffix = pending ? ' · refreshing…' : ''
  return `${base}${attentionSuffix}${pendingSuffix}`
}

const FOOTER = ' ↑↓/jk move · ←→/enter collapse · r refresh · q close'

/** End index of the escape sequence starting at `data[i]` (an ESC): a
 *  CSI/SS3 sequence runs to its final byte, an alt+<char> pair eats two
 *  bytes, a lone ESC is one. A run that never reaches a final byte
 *  falls back to the two-byte form. */
function escapeEnd(data: string, i: number): number {
  const next = data[i + 1]
  if (next === '[' || next === 'O') {
    let j = i + 2
    while (j < data.length && data[j] >= ' ' && data[j] <= '?') {
      j++ // parameter and intermediate bytes
    }
    if (j < data.length) {
      return j + 1
    }
  }
  return next === undefined ? i + 1 : i + 2
}

/**
 * Split a raw input chunk into key tokens. pi-tui hands the focused
 * component whatever bytes arrived together — one key during typing, a
 * whole run during paste/autorepeat — and the action map must see every
 * key in it. CSI/SS3 escape sequences stay intact as one token; a bare
 * ESC followed by a non-sequence char is alt+<char> (unknown, ignored);
 * an ESC alone is the escape key.
 */
export function splitKeys(data: string): string[] {
  const keys: string[] = []
  let i = 0
  while (i < data.length) {
    if (data[i] === '\x1b') {
      const end = escapeEnd(data, i)
      keys.push(data.slice(i, end))
      i = end
      continue
    }
    keys.push(data[i])
    i++
  }
  return keys
}

class BoardPanelImpl implements BoardPanelComponent {
  private readonly collapsed = new Set<string>()
  private cursor = 0
  private pending = false
  private closed = false
  private dirty = true
  private lastWidth = -1
  private cached: readonly string[] = []

  /** Key → action. A table keeps the keymap's cyclomatic cost flat —
   *  a switch over a dozen keys reads the same and measures the same. */
  private readonly actions: Record<string, () => void>

  constructor(private readonly options: BoardPanelOptions) {
    const moveUp = (): void => this.move(-1)
    const moveDown = (): void => this.move(1)
    const collapse = (): void => this.setUnderCursor(true)
    const expand = (): void => this.setUnderCursor(false)
    const toggle = (): void => this.toggleUnderCursor()
    const refresh = (): void => this.refresh()
    const close = (): void => this.close()
    this.actions = {
      '\x1b[A': moveUp,
      k: moveUp,
      '\x1b[B': moveDown,
      j: moveDown,
      '\x1b[D': collapse,
      h: collapse,
      '\x1b[C': expand,
      l: expand,
      '\r': toggle,
      '\n': toggle,
      ' ': toggle,
      r: refresh,
      q: close,
      '\x1b': close,
    }
  }

  /** Flatten visible sections into cursor rows; the footer is never a
   *  cursor target. */
  private rows(sections: Section[]): Row[] {
    const rows: Row[] = [{ kind: 'header' }]
    for (const sec of sections) {
      rows.push({ kind: 'section', section: sec.id })
      if (!this.collapsed.has(sec.id)) {
        for (const _ of sec.rows) {
          rows.push({ kind: 'item', section: sec.id })
        }
      }
    }
    rows.push({ kind: 'footer' })
    return rows
  }

  private color(role: string, text: string): string {
    const theme = this.options.theme
    return theme ? theme.fg(role, text) : text
  }

  render(width: number): readonly string[] {
    if (!this.dirty && width === this.lastWidth) {
      return this.cached
    }
    const board = this.options.host.snapshot()
    const sections = buildSections(board)
    const rows = this.rows(sections)
    const footerIndex = rows.length - 1
    // collapse/refresh can shrink the list under the cursor — clamp first
    this.cursor = Math.min(this.cursor, Math.max(0, footerIndex - 1))
    const lines: string[] = []
    /** Which row of its section each item line shows — items are
     *  emitted in section order, so a per-section counter suffices. */
    const itemCounts = new Map<string, number>()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const current = i === this.cursor && row.kind !== 'footer'
      const mark = current ? '›' : ' '
      let text: string
      if (row.kind === 'header') {
        text = `${mark} ${summaryOf(board, this.pending)}`
      } else if (row.kind === 'footer') {
        text = FOOTER
      } else {
        text = this.rowBody(row, sections, itemCounts, mark)
      }
      // strip board text first — escape sequences would drive the
      // terminal and would also spend the width budget — then clip
      // before coloring: clip() is length-based and ANSI-blind
      let line = clip(sanitizeTerminalText(text), width)
      if (row.kind === 'header' || row.kind === 'footer' || current) {
        line = this.color(row.kind === 'footer' ? 'muted' : 'accent', line)
      }
      lines.push(line)
    }
    this.cached = lines
    this.lastWidth = width
    this.dirty = false
    return this.cached
  }

  /** The section-arrow or item-body line — extracted so render's loop
   *  stays inside the cognitive-complexity ceiling. */
  private rowBody(
    row: Row,
    sections: Section[],
    itemCounts: Map<string, number>,
    mark: string
  ): string {
    const sec = sections.find((x) => x.id === row.section)
    if (row.kind === 'section') {
      const arrow = sec !== undefined && this.collapsed.has(sec.id) ? '▸' : '▾'
      return `${mark} ${arrow} ${sec?.title ?? ''}`
    }
    const id = row.section ?? ''
    const n = itemCounts.get(id) ?? 0
    itemCounts.set(id, n + 1)
    return `${mark}   ${sec?.rows[n] ?? ''}`
  }

  handleInput(data: string): void {
    for (const key of splitKeys(data)) {
      if (this.closed) {
        return
      }
      this.dispatch(key)
    }
  }

  private dispatch(data: string): void {
    if (this.options.keybindings?.matches(data, 'app.interrupt')) {
      this.close()
      return
    }
    this.actions[data]?.()
  }

  private move(delta: number): void {
    const rows = this.rows(buildSections(this.options.host.snapshot()))
    const last = Math.max(0, rows.length - 2) // footer is not a target
    this.cursor = Math.min(Math.max(this.cursor + delta, 0), last)
    this.dirty = true
  }

  private currentSection(): string | undefined {
    const rows = this.rows(buildSections(this.options.host.snapshot()))
    this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 2))
    return rows[this.cursor]?.section
  }

  private setCollapsed(sectionId: string | undefined, collapsed: boolean): void {
    if (sectionId === undefined) {
      return
    }
    if (collapsed) {
      this.collapsed.add(sectionId)
    } else {
      this.collapsed.delete(sectionId)
    }
    this.dirty = true
  }

  /** ←/h and →/l — collapse/expand the section under the cursor. */
  private setUnderCursor(collapsed: boolean): void {
    this.setCollapsed(this.currentSection(), collapsed)
  }

  private toggleUnderCursor(): void {
    const id = this.currentSection()
    if (id !== undefined) {
      this.setCollapsed(id, !this.collapsed.has(id))
    }
  }

  private refresh(): void {
    if (this.pending || this.closed) {
      return
    }
    this.pending = true
    this.dirty = true
    this.options.tui?.requestRender?.()
    const settle = (): void => {
      this.pending = false
      this.dirty = true
      this.options.tui?.requestRender?.()
    }
    void this.options.host.refresh().then(settle, settle)
  }

  private close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.options.done(undefined)
  }

  invalidate(): void {
    this.dirty = true
  }

  dispose(): void {
    this.closed = true
  }
}

/** Build the board panel for `ui.custom(..., { overlay: true })`. */
export function createBoardPanel(options: BoardPanelOptions): BoardPanelComponent {
  return new BoardPanelImpl(options)
}

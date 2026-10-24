/**
 * The interactive board panel's contract — the parts the omp TUI mount
 * depends on: section rendering, cursor navigation, collapse/expand,
 * the refresh flow, and close semantics (docs/tui.md: same array
 * reference while unchanged, width-safe lines, `done` exactly once).
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createBoardPanel,
  splitKeys,
  type BoardPanelComponent,
  type BoardPanelOptions,
} from './board-panel.ts'
import type { BoardStatus } from './core.ts'

const FIXTURE: BoardStatus = {
  dir: '/repo',
  branch: 'work/panel',
  dirty: 2,
  worktrees: [{ name: 'bro--x', branch: 'work/x', state: 'clean' }],
  beads: {
    inProgress: [
      { id: 'bro-aaa', title: 'Fix the board', assignee: 'pepl' },
      { id: 'bro-bbb', title: 'Ship the panel' },
    ],
    ready: [
      { id: 'bro-ccc', title: 'Third' },
      { id: 'bro-ddd', title: 'Fourth' },
    ],
    readyTotal: 42,
  },
  fleet: {
    maxConcurrent: 3,
    agents: [
      { id: 'bro-run1', backend: 'native', state: 'running', step: 'build' },
      { id: 'bro-idle', backend: 'docker', state: 'exited', cause: 'cap' },
    ],
  },
  loop: { runs: [{ beadId: 'bro-eee', state: 'running', pid: 1234, silentMs: 120_000 }] },
  drill: { frame: { id: 'dr-1', title: 'Panel work', depth: 2 } },
  watch: { attention: 3 },
}

/** A panel over a mutable fake host — the driver stand-in. */
function harness(board: BoardStatus | null = FIXTURE) {
  const state = {
    board,
    refreshes: 0,
    done: 0,
    renders: 0,
  }
  const options: BoardPanelOptions = {
    host: {
      snapshot: () => state.board,
      refresh: async () => {
        state.refreshes++
        state.board = { ...FIXTURE, beads: { ...FIXTURE.beads, readyTotal: 99 } }
        return state.board
      },
    },
    done: () => {
      state.done++
    },
    tui: {
      requestRender: () => {
        state.renders++
      },
    },
  }
  const panel: BoardPanelComponent = createBoardPanel(options)
  return { panel, state }
}

const cursorLine = (lines: readonly string[]): number =>
  lines.findIndex((l) => l.startsWith('›'))

test('renders the summary, every section, and the key footer', () => {
  const { panel } = harness()
  const text = panel.render(160).join('\n')
  assert.match(text, /bro · ◐ 2 beads · fleet 1\/3 · ready 42 · drill dr-1 · dirty 2 · ⚠ 3 attention/)
  assert.match(text, /▾ beads \(2\)/)
  assert.match(text, /◐ bro-aaa {2}Fix the board {2}\[pepl\]/)
  assert.match(text, /▾ ready \(42\)/)
  assert.match(text, /… 40 more ready/)
  assert.match(text, /bro-run1 {2}native {2}running {2}build/)
  assert.match(text, /bro-idle {2}docker {2}exited {2}\(cap\)/)
  assert.match(text, /loop \(1\)/)
  assert.match(text, /silent 2m/)
  assert.match(text, /worktrees \(1\)/)
  assert.match(text, /▾ drill/)
  assert.match(text, /branch {2}work\/panel/)
  assert.match(text, /dirty {3}2 file\(s\)/)
  assert.match(text, /r refresh · q close/)
})

test('the cursor starts on the header and arrows move it down', () => {
  const { panel } = harness()
  assert.equal(cursorLine(panel.render(120)), 0)
  panel.handleInput('\x1b[B')
  const lines = panel.render(120)
  assert.equal(cursorLine(lines), 1)
  assert.match(lines[1], /▾ beads/)
  panel.handleInput('\x1b[A')
  assert.equal(cursorLine(panel.render(120)), 0)
})

test('j/k move like the arrows', () => {
  const { panel } = harness()
  panel.handleInput('j')
  assert.equal(cursorLine(panel.render(120)), 1)
  panel.handleInput('k')
  assert.equal(cursorLine(panel.render(120)), 0)
})

test('enter collapses the section under the cursor; right expands it back', () => {
  const { panel } = harness()
  panel.handleInput('j') // beads section
  const before = panel.render(120).length
  panel.handleInput('\r')
  let lines = panel.render(120)
  assert.ok(lines.length < before, 'rows collapsed away')
  assert.ok(!lines.join('\n').includes('◐ bro-aaa'), 'items hidden')
  assert.ok(lines.some((l) => l.includes('▸ beads (2)')), 'arrow flips closed')
  panel.handleInput('\x1b[C')
  lines = panel.render(120)
  assert.equal(lines.length, before)
  assert.ok(lines.join('\n').includes('◐ bro-aaa'), 'items back')
})

test('left collapses without a prior toggle, space toggles', () => {
  const { panel } = harness()
  panel.handleInput('j')
  panel.handleInput('\x1b[D')
  assert.ok(panel.render(120).some((l) => l.includes('▸ beads (2)')))
  panel.handleInput(' ')
  assert.ok(panel.render(120).some((l) => l.includes('▾ beads (2)')))
})

test('the cursor never lands on the footer and survives a shrinking list', () => {
  const { panel } = harness()
  for (let i = 0; i < 50; i++) {
    panel.handleInput('j')
  }
  let lines = panel.render(120)
  assert.equal(cursorLine(lines), lines.length - 2, 'last target is above the footer')
  // collapse the section under the cursor — the list shrinks, the
  // cursor must clamp instead of falling past the end
  panel.handleInput('\r')
  lines = panel.render(120)
  assert.ok(cursorLine(lines) >= 0 && cursorLine(lines) <= lines.length - 2)
})

test('r re-probes once while pending and renders the fresh snapshot', async () => {
  const { panel, state } = harness()
  panel.handleInput('r')
  panel.handleInput('r') // still in flight — no second probe
  assert.equal(state.refreshes, 1)
  assert.match(panel.render(120).join('\n'), /refreshing…/)
  const flushed = Promise.withResolvers<void>()
  setImmediate(flushed.resolve)
  await flushed.promise
  assert.ok(state.renders >= 2, 'repainted on start and on settle')
  const text = panel.render(120).join('\n')
  assert.ok(!text.includes('refreshing…'), 'pending cleared')
  assert.match(text, /ready \(99\)/)
})

test('q closes once and later input is ignored', () => {
  const { panel, state } = harness()
  panel.handleInput('q')
  assert.equal(state.done, 1)
  panel.handleInput('q')
  panel.handleInput('\x1b')
  assert.equal(state.done, 1, 'done exactly once')
})

test('Esc and the host interrupt binding close the panel', () => {
  const closed = harness()
  closed.panel.handleInput('\x1b')
  assert.equal(closed.state.done, 1)

  const interrupted = harness()
  const withKeys = createBoardPanel({
    host: { snapshot: () => FIXTURE, refresh: async () => FIXTURE },
    done: () => {
      interrupted.state.done++
    },
    keybindings: { matches: (data, action) => data === '\x03' && action === 'app.interrupt' },
  })
  withKeys.handleInput('\x03')
  assert.equal(interrupted.state.done, 1)
})

test('render is width-safe and reference-stable until something changes', () => {
  const { panel } = harness()
  const first = panel.render(40)
  for (const line of first) {
    assert.ok(line.length <= 40, `overwide line: ${line}`)
  }
  assert.equal(panel.render(40), first, 'unchanged render returns the same array')
  panel.handleInput('j')
  assert.notEqual(panel.render(40), first, 'cursor move repaints')
})

test('a missing board renders its own row instead of throwing', () => {
  const { panel } = harness(null)
  const text = panel.render(80).join('\n')
  assert.match(text, /bro · no board/)
  assert.match(text, /no board yet — press r to load/)
})

test('splitKeys: sequences stay whole, plain runs split per char', () => {
  assert.deepEqual(splitKeys('jj'), ['j', 'j'])
  assert.deepEqual(splitKeys('\x1b[B'), ['\x1b[B'])
  assert.deepEqual(splitKeys('\x1b[Bj'), ['\x1b[B', 'j'])
  assert.deepEqual(splitKeys('\x1b'), ['\x1b'])
  // alt+<char> is one unknown token — not an escape that closes
  assert.deepEqual(splitKeys('\x1bj'), ['\x1bj'])
})

test('one chunk carries every key: moves, collapse, expand in order', () => {
  const { panel } = harness()
  panel.handleInput('jj') // two moves in one chunk
  assert.equal(cursorLine(panel.render(120)), 2)
  panel.handleInput('h') // collapse the beads section under the cursor
  let lines = panel.render(120)
  assert.ok(lines.some((l) => l.includes('▸ beads (2)')))
  // collapse shrinks the list under the cursor — step back onto the
  // section header, then expand it again
  panel.handleInput('k')
  panel.handleInput('l')
  lines = panel.render(120)
  assert.ok(lines.some((l) => l.includes('▾ beads (2)')))
  panel.handleInput('\x1b[Bj') // arrow + j in one chunk = two moves
  assert.equal(cursorLine(panel.render(120)), 3)
})

test('present-but-empty loop and worktrees show their empty state', () => {
  const { panel } = harness({
    branch: 'x',
    loop: { stallMin: 5, runs: [] },
    worktrees: [],
  })
  const text = panel.render(120).join('\n')
  assert.match(text, /— no runs —/, 'a configured loop with no runs is visible')
  assert.match(text, /— none —/, 'an empty worktree list is visible')
})

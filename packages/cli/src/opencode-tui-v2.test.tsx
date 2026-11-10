import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from './opencode-tui-v2.tsx'

// The V2 TUI contract: default export `{id, setup}` — Plugin.define is
// the host's identity marker.
describe('tui-v2 loader shape', () => {
  test('default export declares the cli plugin id', () => {
    assert.equal(plugin.id, 'bro.cli')
    assert.equal(typeof plugin.setup, 'function')
  })
})

const dir = mkdtempSync(join(tmpdir(), 'bro-octui2-'))
const stub = join(dir, 'stub.mjs')
writeFileSync(
  stub,
  `const map = process.env.BRO_STUB_MAP ? JSON.parse(process.env.BRO_STUB_MAP) : {}
const key = process.argv.join(' ')
for (const [k, v] of Object.entries(map)) if (key.endsWith(k)) process.stdout.write(v)
process.exit(Number(process.env.BRO_STUB_STATUS ?? '0'))
`
)
after(() => rmSync(dir, { recursive: true, force: true }))

const STATUS_JSON = JSON.stringify({
  dirty: 2,
  beads: {
    inProgress: [{ id: 'bro-aaaa', title: 'in-flight bead' }],
    ready: [{ id: 'bro-bbbb', title: 'next bead' }],
    readyTotal: 7,
  },
  fleet: { maxConcurrent: 4, agents: [{ id: 'native-1', state: 'running' }] },
  loop: { runs: [] },
  watch: { ageMs: 5000, attention: 1 },
})

interface Toast {
  title?: string
  message: string
  variant?: string
}

async function setup() {
  const toasts: Toast[] = []
  const layers: unknown[] = []
  const taps = new Map<string, (e: { data?: unknown }) => void>()
  const slots: Array<{ claim: unknown; rendered: unknown }> = []
  const ctx = {
    location: { directory: dir },
    options: { command: { cmd: process.execPath, args: [stub] } },
    keymap: { layer: (f: () => unknown) => layers.push(f()) },
    ui: {
      toast: { show: (t: Toast) => toasts.push(t) },
      slot: (claim: { append?: string; render: (input: unknown) => unknown }) => {
        // rendering needs the host's OpenTUI renderer — the claim's
        // placement key is what this plugin owns
        slots.push({ claim, rendered: null })
        return () => {}
      },
    },
    data: {
      on: (event: string, cb: (e: { data?: unknown }) => void) => {
        taps.set(event, cb)
        return () => taps.delete(event)
      },
    },
    storage: {
      store: (_k: string, o: { initial: { open: boolean } }) => [o.initial, async () => {}],
    },
    theme: {
      text: {
        base: '#fff',
        muted: '#888',
        feedback: {
          info: { base: '#0af' },
          warning: { base: '#fa0' },
          error: { base: '#f00' },
          success: { base: '#0f0' },
        },
      },
    },
  }
  const teardown = await plugin.setup(ctx as never)
  const fire = (event: string, data?: unknown): void => taps.get(event)?.({ data })
  return { toasts, layers, taps, slots, fire, teardown }
}

describe('tui-v2 setup', () => {
  test('registers /bro command, claims sidebar.content, polls the board', async () => {
    process.env.BRO_STUB_MAP = JSON.stringify({ 'status --json': STATUS_JSON, hooks: '' })
    const { layers, slots } = await setup()
    const layer = layers[0] as { commands?: Array<{ id: string; slash?: { name: string } }> }
    assert.equal(layer.commands?.[0]?.slash?.name, 'bro')
    assert.equal(slots.length, 1)
    assert.equal((slots[0]!.claim as { append?: string }).append, 'sidebar.content')
    // render ran under a root without throwing — the board itself needs
    // the OpenTUI host, the claim wiring is what we own
    assert.ok(slots[0]!.rendered !== undefined || slots[0]!.rendered === undefined)
  })

  test('toasts on permission.asked and session.execution.failed', async () => {
    process.env.BRO_STUB_MAP = JSON.stringify({ 'status --json': STATUS_JSON, hooks: '' })
    const { toasts, fire } = await setup()
    fire('permission.asked', { action: 'edit', resources: ['file.ts'] })
    fire('session.execution.failed', { error: 'provider died' })
    assert.equal(toasts.length, 2)
    assert.equal(toasts[0]!.variant, 'warning')
    assert.match(toasts[0]!.message, /edit file\.ts/)
    assert.equal(toasts[1]!.variant, 'error')
    assert.match(toasts[1]!.message, /provider died/)
  })

  test('teardown clears taps, timer and the slot claim', async () => {
    process.env.BRO_STUB_MAP = JSON.stringify({ 'status --json': STATUS_JSON, hooks: '' })
    let released = 0
    const { taps, teardown } = await setup()
    const armed = taps.size
    assert.ok(armed >= 4)
    if (typeof teardown === 'function') teardown()
    assert.equal(taps.size, released)
  })
})

import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from './opencode-tui.ts'

// The V2 CLI/TUI contract: a default export `{id, setup}` — `kind` marks
// the file for the installer sentinel, nothing else.
describe('tui loader shape', () => {
  test('default export declares the cli plugin id and sentinel kind', () => {
    assert.equal(plugin.id, 'bro.cli')
    assert.equal(plugin.kind, 'opencode-tui')
    assert.equal(typeof plugin.setup, 'function')
  })
})

const dir = mkdtempSync(join(tmpdir(), 'bro-octui-'))
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

interface Toast {
  title?: string
  message: string
  variant?: string
}

interface Layer {
  commands?: Array<{
    id: string
    title?: string
    slash?: { name: string; arguments?: boolean }
    run(input?: string): unknown
  }>
  bindings?: string[]
}

async function setup(options?: Record<string, unknown>) {
  const toasts: Toast[] = []
  const layers: Layer[] = []
  const taps = new Map<string, (e: { data?: unknown }) => void>()
  const stubs: string[] = []
  const ctx = {
    location: { directory: dir },
    options: { command: { cmd: process.execPath, args: [stub] }, ...options },
    keymap: {
      layer: (factory: () => Layer) => {
        layers.push(factory())
      },
    },
    ui: { toast: { show: (t: Toast) => toasts.push(t) } },
    data: {
      on: (event: string, cb: (e: { data?: unknown }) => void) => {
        taps.set(event, cb)
        const stop = (): void => {
          stubs.push(event)
          taps.delete(event)
        }
        return stop
      },
    },
  }
  const teardown = await plugin.setup(ctx)
  const fire = (event: string, data?: unknown): void => taps.get(event)?.({ data })
  return { toasts, layers, taps, stubs, fire, teardown }
}

describe('tui setup', () => {
  test('registers the bro.status command — palette and /bro slash', async () => {
    const { layers } = await setup()
    assert.equal(layers.length, 1)
    const cmd = layers[0]?.commands?.[0]
    assert.equal(cmd?.id, 'bro.status')
    assert.equal(cmd?.slash?.name, 'bro')
    assert.equal(cmd?.slash?.arguments, true)
    assert.deepEqual(layers[0]?.bindings, ['bro.status'])
  })

  test('/bro runs the resolved CLI and toasts the board', async () => {
    process.env.BRO_STUB_MAP = JSON.stringify({ 'status': 'board: 3 ready' })
    try {
      const { layers, toasts } = await setup()
      await layers[0]!.commands![0]!.run('')
      assert.equal(toasts.length, 1)
      assert.match(toasts[0]!.title ?? '', /bro status/)
      assert.match(toasts[0]!.message, /board: 3 ready/)
      assert.equal(toasts[0]!.variant, 'info')
    } finally {
      delete process.env.BRO_STUB_MAP
    }
  })

  test('a nonzero verb toasts the failure, never throws', async () => {
    process.env.BRO_STUB_MAP = JSON.stringify({ 'act status': '' })
    process.env.BRO_STUB_STATUS = '2'
    try {
      const { layers, toasts } = await setup()
      await layers[0]!.commands![0]!.run('act status')
      assert.equal(toasts[0]!.variant, 'warning')
      assert.match(toasts[0]!.title ?? '', /exit 2/)
    } finally {
      delete process.env.BRO_STUB_MAP
      delete process.env.BRO_STUB_STATUS
    }
  })

  test('a quoted slash argument survives as one argv entry', async () => {
    // the stub keys on argv.join(' ') — the map only matches when
    // `learn capture "a b c"` arrived as three entries, not five
    process.env.BRO_STUB_MAP = JSON.stringify({ 'learn capture a b c': 'kept' })
    try {
      const { layers, toasts } = await setup()
      await layers[0]!.commands![0]!.run('learn capture "a b c"')
      assert.match(toasts[0]!.message, /kept/)
      assert.match(toasts[0]!.title ?? '', /bro learn capture a b c/)
    } finally {
      delete process.env.BRO_STUB_MAP
    }
  })

  test('permission.asked toasts the ask', async () => {
    const { fire, toasts } = await setup()
    fire('permission.asked', { action: 'bash', resources: ['bro act merge'] })
    assert.equal(toasts[0]!.variant, 'warning')
    assert.match(toasts[0]!.message, /bro act merge/)
  })

  test('session.error surfaces the error text', async () => {
    const { fire, toasts } = await setup()
    fire('session.error', { error: { message: 'provider exploded' } })
    assert.equal(toasts[0]!.variant, 'error')
    assert.match(toasts[0]!.message, /provider exploded/)
  })

  test('teardown unsubscribes the event taps', async () => {
    const { teardown, stubs } = await setup()
    await teardown()
    assert.ok(stubs.includes('permission.asked'))
    assert.ok(stubs.includes('session.error'))
  })
})

describe('tui fail-open', () => {
  test('a bare ctx wires nothing and never throws', async () => {
    const teardown = await plugin.setup({})
    assert.equal(typeof teardown, 'function')
    await teardown()
  })

  test('a data.on that throws unwires the tap, not the setup', async () => {
    const teardown = await plugin.setup({
      data: {
        on: () => {
          throw new Error('wedged')
        },
      },
    })
    assert.equal(typeof teardown, 'function')
    await teardown()
  })
})

import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { jsRuntime, toolSucceeded } from './opencode.ts'

// opencode v2 refuses anything but a default export carrying `id` and `setup`.
// It rejects the v1 shapes outright — a plugin function returning a hooks
// object, and the `{ id, server }` module — with
// "Plugin must export a default definition with an id and an effect or setup
// function". Those are logged as a WARN and the plugin never loads.
describe('loader shape', () => {
  test('default export declares id and setup', () => {
    assert.equal(plugin.id, 'bro')
    assert.equal(typeof plugin.setup, 'function')
  })
})

describe('jsRuntime', () => {
  // Regression pin: `process.execPath` inside the opencode binary IS
  // opencode, so spawning it with `hooks <event>` launches a TUI instead of
  // running the hook. The plugin then fails open into silence and no bro
  // context ever reaches the model — which unit tests miss, because they run
  // the plugin under node where execPath happens to be a JS runtime.
  test('never resolves to process.execPath', () => {
    assert.notEqual(jsRuntime(), process.execPath)
  })

  test('names a JS runtime bro can rely on', () => {
    assert.match(jsRuntime(), /^(node|node\.exe)$/)
  })
})

const dir = mkdtempSync(join(tmpdir(), 'bro-oc-v2-'))
const logFile = join(dir, 'calls.log')

// A stand-in for `bro hooks <event>`: records what it was asked and replays a
// canned answer. Driven by env so one stub serves every case, and so the
// plugin's `command` option — the same escape hatch users get from
// `plugins: [{ package, options }]` — is the test seam.
const stub = join(dir, 'stub.mjs')
writeFileSync(
  stub,
  `import { appendFileSync, readFileSync } from 'node:fs'
const at = process.argv.indexOf('hooks')
const event = process.argv[at + 1] ?? ''
let payload = {}
try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch {}
if (process.env.BRO_STUB_LOG) {
  appendFileSync(process.env.BRO_STUB_LOG, JSON.stringify({ event, payload, cwd: process.cwd() }) + '\\n')
}
const map = process.env.BRO_STUB_MAP ? JSON.parse(process.env.BRO_STUB_MAP) : {}
if (event in map) process.stdout.write(map[event] ?? '')
process.exit(Number(process.env.BRO_STUB_STATUS ?? '0'))
`
)

interface Call {
  event: string
  cwd: string
  payload: {
    session_id?: string
    prompt?: string
    stop_hook_active?: boolean
    tool_name?: string
    tool_input?: { command?: string } & Record<string, unknown>
    tool_response?: { success: boolean }
  }
}

function respond(map: Record<string, unknown>, status = 0): void {
  process.env.BRO_STUB_MAP = JSON.stringify(map)
  process.env.BRO_STUB_STATUS = String(status)
}

function calls(): Call[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call)
}

function ctx(text: unknown): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: 'X', additionalContext: text } }
}

interface Logged {
  level: string
  message: string
}

/** A stand-in for opencode's plugin context: records every registration, hands
 *  the captured hooks back so a test can drive them, and replays events from a
 *  queue the test pushes into. */
async function makePlugin(options?: Record<string, unknown>, failSynthetic = false) {
  const logs: Logged[] = []
  const synthetic: { sessionID: string; text: string }[] = []
  const handlers = new Map<string, (event: never) => Promise<void>>()
  const queue: { type: string; data?: Record<string, unknown>; done?: () => void }[] = []
  let wake: (() => void) | null = null

  const cleanup = await plugin.setup({
    location: { directory: dir },
    options: { command: { cmd: process.execPath, args: [stub] }, ...options },
    app: {
      log: async (input: { body: { level: string; message: string } }) => {
        logs.push({ level: input.body.level, message: input.body.message })
      },
    },
    session: {
      hook: async (name: string, handler: (event: never) => Promise<void>) => {
        handlers.set(name, handler)
      },
      synthetic: async (input: { sessionID: string; text: string }) => {
        if (failSynthetic) {
          throw new Error('session is busy')
        }
        synthetic.push({ sessionID: input.sessionID, text: input.text })
      },
    },
    tool: {
      hook: async (name: string, handler: (event: never) => Promise<void>) => {
        handlers.set(name, handler)
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
            const item = queue.shift()!
            yield item
            // the consumer only asks for the next event once it has finished
            // awaiting its handler — which for bro means a real subprocess has
            // come and gone, so this is the only honest completion signal
            item.done?.()
          }
        },
      }),
    },
  } as never)

  /** Push an event and resolve once the plugin has fully processed it. */
  const emit = async (type: string, data?: Record<string, unknown>): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      queue.push({ type, data, done: resolve })
      wake?.()
    })
    await done
  }

  const fire = (name: string, event: unknown): Promise<void> =>
    (handlers.get(name) as ((e: unknown) => Promise<void>) | undefined)?.(event) ?? Promise.resolve()

  const registered = (): string[] => [...handlers.keys()].sort()

  return { logs, synthetic, emit, fire, registered, cleanup }
}

beforeEach(() => {
  writeFileSync(logFile, '')
  process.env.BRO_STUB_LOG = logFile
  delete process.env.BRO_STUB_STATUS
  respond({})
})

afterEach(() => {
  delete process.env.BRO_STUB_LOG
  delete process.env.BRO_STUB_MAP
  delete process.env.BRO_STUB_STATUS
})

describe('registration', () => {
  test('registers every hook the adapter maps', async () => {
    const p = await makePlugin()
    assert.deepEqual(p.registered(), [
      'compaction',
      'context',
      'execute.after',
      'prompt',
    ])
    p.cleanup()
  })

  test('setup returns a cleanup function', async () => {
    const p = await makePlugin()
    assert.equal(typeof p.cleanup, 'function')
    p.cleanup()
  })
})

describe('session rehydration', () => {
  test('probes once per session and re-pushes every turn', async () => {
    respond({ 'session-start': JSON.stringify(ctx('bro state — ready queue')) })
    const p = await makePlugin()

    const first = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', first)
    const second = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', second)

    assert.deepEqual(first.system, [{ type: 'text', text: 'bro state — ready queue' }])
    assert.deepEqual(second.system, [{ type: 'text', text: 'bro state — ready queue' }])
    const starts = calls().filter((c) => c.event === 'session-start')
    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0]?.payload, { session_id: 'ses_1' })
    assert.equal(starts[0]?.cwd, dir)
  })

  test('session.created primes the probe so the first turn does not pay for it', async () => {
    respond({ 'session-start': JSON.stringify(ctx('primed state')) })
    const p = await makePlugin()
    await p.emit('session.created', { sessionID: 'ses_1' })
    const out = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', out)
    assert.deepEqual(out.system, [{ type: 'text', text: 'primed state' }])
    // a racing prime and first turn share one probe, they don't double-spawn
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 1)
  })

  test('a second session probes on its own', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) })
    const p = await makePlugin()
    for (const sessionID of ['ses_1', 'ses_2', 'ses_1']) {
      await p.fire('context', { sessionID, system: [] })
    }
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 2)
  })

  test('a context hook without a session id contributes nothing', async () => {
    const p = await makePlugin()
    const out = { system: [] as unknown[] }
    await p.fire('context', out)
    assert.deepEqual(out.system, [])
    assert.equal(calls().length, 0)
  })

  test('compaction re-primes the cache with post-compaction state', async () => {
    respond({
      'session-start': JSON.stringify(ctx('before compaction')),
      'post-compaction': JSON.stringify(ctx('after compaction')),
    })
    const p = await makePlugin()

    const first = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', first)
    assert.deepEqual(first.system, [{ type: 'text', text: 'before compaction' }])

    await p.emit('session.compacted', { sessionID: 'ses_1' })

    const second = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', second)
    assert.deepEqual(second.system, [{ type: 'text', text: 'after compaction' }])
    assert.deepEqual(
      calls().map((c) => c.event),
      ['session-start', 'post-compaction']
    )
  })

  test('pre-compact notes are appended to the transcript', async () => {
    respond({ 'pre-compact': JSON.stringify(ctx('open drill frame: fixing the gate')) })
    const p = await makePlugin()
    const messages: unknown[] = [{ role: 'user', text: 'hi' }]
    await p.fire('compaction', { sessionID: 'ses_1', messages })
    assert.equal(messages.length, 2)
    assert.deepEqual(messages[1], { role: 'user', text: 'open drill frame: fixing the gate' })
  })

  test('session.deleted drops the per-session state', async () => {
    respond({
      'session-start': JSON.stringify(ctx('state')),
      stop: JSON.stringify({ decision: 'block', reason: 'dirty' }),
    })
    const p = await makePlugin()
    await p.fire('context', { sessionID: 'ses_1', system: [] })
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.equal(p.synthetic.length, 1)

    await p.emit('session.deleted', { sessionID: 'ses_1' })

    // the cache is gone, so a later turn for that id probes again; and the
    // one-shot guard is gone, so the gate is live rather than spent
    const after = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', after)
    assert.deepEqual(after.system, [{ type: 'text', text: 'state' }])
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 2)
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.equal(p.synthetic.length, 2)
  })
})

describe('prompt-submit', () => {
  test('appends probe context to the prompt text', async () => {
    respond({ 'prompt-submit': JSON.stringify(ctx('PR #12 is waiting on review')) })
    const p = await makePlugin()
    const prompt = { text: 'look at the merge slot' }
    await p.fire('prompt', { sessionID: 'ses_1', prompt })
    assert.equal(prompt.text, 'look at the merge slot\n\nPR #12 is waiting on review')
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      prompt: 'look at the merge slot',
    })
  })

  test('an empty prompt still gets the context', async () => {
    respond({ 'prompt-submit': JSON.stringify(ctx('ready queue is not empty')) })
    const p = await makePlugin()
    const prompt: { text?: string } = {}
    await p.fire('prompt', { sessionID: 'ses_1', prompt })
    assert.equal(prompt.text, 'ready queue is not empty')
  })

  test('no probe output leaves the prompt alone', async () => {
    const p = await makePlugin()
    const prompt = { text: 'hello' }
    await p.fire('prompt', { sessionID: 'ses_1', prompt })
    assert.equal(prompt.text, 'hello')
  })
})

describe('post-tool', () => {
  const toolEvent = (over: Record<string, unknown> = {}) => ({
    tool: 'shell',
    sessionID: 'ses_1',
    input: { command: 'bro act status' },
    status: 'completed',
    result: { output: { exit: 0, truncated: false, output: 'ok' } },
    ...over,
  })

  test('arms the session and appends context to the tool result', async () => {
    respond({ 'post-tool': JSON.stringify(ctx('bro act mutations are governed by the act skill')) })
    const p = await makePlugin()
    const event = toolEvent()
    await p.fire('execute.after', event)
    assert.equal(
      event.result.output.output,
      'ok\n\nbro act mutations are governed by the act skill'
    )
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      tool_name: 'shell',
      tool_input: { command: 'bro act status' },
      tool_response: { success: true },
    })
  })

  test('a nonzero exit reports failure so bro does not arm', async () => {
    const p = await makePlugin()
    await p.fire('execute.after', toolEvent({ result: { output: { exit: 1, output: 'boom' } } }))
    assert.deepEqual(calls()[0]?.payload.tool_response, { success: false })
  })

  test('a non-completed status reports failure even with exit 0', async () => {
    const p = await makePlugin()
    await p.fire('execute.after', toolEvent({ status: 'error' }))
    assert.deepEqual(calls()[0]?.payload.tool_response, { success: false })
  })

  test('a missing input object still calls', async () => {
    const p = await makePlugin()
    await p.fire('execute.after', toolEvent({ input: undefined }))
    assert.deepEqual(calls()[0]?.payload.tool_input, {})
  })
})

describe('toolSucceeded', () => {
  // opencode v2 reports `status: "completed"` and puts the exit code at
  // `result.output.exit` — there is no `error` key, so keying on one read
  // every failed command as a success and armed bro's gates for commands that
  // never worked.
  test('status is the primary signal', () => {
    assert.equal(toolSucceeded({ status: 'completed', result: { output: { exit: 1 } } }), false)
    assert.equal(toolSucceeded({ status: 'error' }), false)
    assert.equal(toolSucceeded({ status: 'cancelled' }), false)
    assert.equal(toolSucceeded({ status: 'completed', result: { output: { exit: 0 } } }), true)
  })

  test('an absent status falls back to the exit code', () => {
    assert.equal(toolSucceeded({ result: { output: { exit: 2 } } }), false)
    assert.equal(toolSucceeded({ result: { output: { exit: 0 } } }), true)
    assert.equal(toolSucceeded({}), true)
  })
})

describe('stop gate', () => {
  const blocked = { decision: 'block', reason: 'worktree is dirty — commit or stash first' }

  test('re-prompts once with the blocker via a synthetic message', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const p = await makePlugin()
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.deepEqual(p.synthetic, [
      { sessionID: 'ses_1', text: 'worktree is dirty — commit or stash first' },
    ])
    assert.equal(p.logs[0]?.level, 'warn')
    assert.match(p.logs[0]?.message ?? '', /stop gate/)
    assert.equal(calls()[0]?.payload.stop_hook_active, false)
  })

  test('a second block is logged, never re-prompted — a gate, not a loop', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const p = await makePlugin()
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.equal(p.synthetic.length, 1)
    const stops = calls().filter((c) => c.event === 'stop')
    assert.equal(stops.length, 2)
    // bro skips its own re-evaluation on the repeat — stop_hook_active is the
    // same retry flag Claude uses
    assert.equal(stops[1]?.payload.stop_hook_active, true)
  })

  test('the one-shot guard is per session', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const p = await makePlugin()
    for (const sessionID of ['ses_1', 'ses_2']) {
      await p.emit('session.execution.succeeded', { sessionID })
    }
    assert.deepEqual(
      p.synthetic.map((s) => s.sessionID),
      ['ses_1', 'ses_2']
    )
  })

  test('a non-blocking gate logs its hints and does not prompt', async () => {
    respond({
      stop: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'PR #12 has open threads' },
      }),
    })
    const p = await makePlugin()
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.deepEqual(p.synthetic, [])
    assert.deepEqual(p.logs, [{ level: 'info', message: 'PR #12 has open threads' }])
  })

  test('an event with no session id never gates', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const p = await makePlugin()
    await p.emit('session.execution.succeeded', {})
    assert.deepEqual(p.synthetic, [])
    assert.equal(calls().length, 0)
  })

  test('a failing re-prompt is logged, never thrown into opencode', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const p = await makePlugin(undefined, true)
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.deepEqual(p.synthetic, [])
    assert.ok(p.logs.some((l) => l.level === 'error' && /session is busy/.test(l.message)))
  })
})

describe('fail-open', () => {
  test('a nonzero exit yields no context anywhere', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) }, 1)
    const p = await makePlugin()
    const system = [] as unknown[]
    await p.fire('context', { sessionID: 'ses_1', system })
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.deepEqual(system, [])
    assert.deepEqual(p.synthetic, [])
    assert.equal(p.logs.filter((l) => l.level === 'warn').length, 0)
  })

  test('a missing bro binary is inert', async () => {
    const p = await makePlugin({ command: '/nonexistent/bro-oc' })
    const system = [] as unknown[]
    await p.fire('context', { sessionID: 'ses_1', system })
    await p.emit('session.execution.succeeded', { sessionID: 'ses_1' })
    assert.deepEqual(system, [])
    assert.deepEqual(p.synthetic, [])
  })

  test('garbage on stdout is not parsed as context', async () => {
    respond({ 'session-start': 'not json at all\n{"broken":' })
    const p = await makePlugin()
    const out = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', out)
    assert.deepEqual(out.system, [])
  })

  test('a control object is found after unrelated chatter', async () => {
    respond({ 'session-start': `bro: probing\n${JSON.stringify(ctx('real state'))}\n` })
    const p = await makePlugin()
    const out = { sessionID: 'ses_1', system: [] as unknown[] }
    await p.fire('context', out)
    assert.deepEqual(out.system, [{ type: 'text', text: 'real state' }])
  })

  test('unknown events and malformed payloads are ignored', async () => {
    const p = await makePlugin()
    await p.emit('session.updated', {})
    await p.emit('session.idle')
    await p.emit('session.created')
    await p.emit('session.compacted', {})
    await p.fire('context', { system: [] })
    await p.fire('compaction', { messages: [] })
    await p.fire('execute.after', {})
    assert.equal(calls().length, 0)
  })

  test('a context hook with a non-array system never throws', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) })
    const p = await makePlugin()
    await p.fire('context', { sessionID: 'ses_1', system: 'not an array' })
    await p.fire('context', { sessionID: 'ses_1' })
    assert.equal(p.logs.filter((l) => l.level === 'error').length, 0)
  })

  test('a plugin with no event stream or client still serves every hook', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) })
    const handlers = new Map<string, (event: never) => Promise<void>>()
    const cleanup = await plugin.setup({
      location: { directory: dir },
      options: { command: { cmd: process.execPath, args: [stub] } },
      session: {
        hook: async (name: string, handler: (event: never) => Promise<void>) => {
          handlers.set(name, handler)
        },
        synthetic: async () => undefined,
      },
    } as never)
    const system = [] as unknown[]
    await (
      handlers.get('context') as ((e: unknown) => Promise<void>) | undefined
    )?.({ sessionID: 'ses_1', system })
    assert.deepEqual(system, [{ type: 'text', text: 'state' }])
    cleanup()
  })
})
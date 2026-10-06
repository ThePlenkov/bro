import { describe, test, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from './opencode.ts'

// The V2 loader contract: a default export with a stable `id` and a
// `setup(ctx)` — plus `server` so the same module serves V1.
describe('v2 loader shape', () => {
  test('default export declares id, setup, and the V1 server', () => {
    assert.equal(plugin.id, 'bro')
    assert.equal(typeof plugin.setup, 'function')
    assert.equal(typeof plugin.server, 'function')
  })
})

const dir = mkdtempSync(join(tmpdir(), 'bro-oc2-'))
const logFile = join(dir, 'calls.log')

// The same `bro hooks <event>` stand-in the V1 suite drives — records the
// payload, replays a canned answer, exits env-controlled.
const stub = join(dir, 'stub.mjs')
writeFileSync(
  stub,
  `import { appendFileSync, readFileSync } from 'node:fs'
const at = process.argv.indexOf('hooks')
// no 'hooks' token → a tool/command exec; argv joined is the map key
const event = at >= 0 ? (process.argv[at + 1] ?? '') : process.argv.slice(2).join(' ')
let payload = {}
try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch {}
if (process.env.BRO_STUB_LOG && at >= 0) {
  appendFileSync(process.env.BRO_STUB_LOG, JSON.stringify({ event, payload, cwd: process.cwd() }) + '\\n')
}
const map = process.env.BRO_STUB_MAP ? JSON.parse(process.env.BRO_STUB_MAP) : {}
if (event in map) process.stdout.write(map[event] ?? '')
process.exit(Number(process.env.BRO_STUB_STATUS ?? '0'))
`
)

after(() => rmSync(dir, { recursive: true, force: true }))

interface Call {
  event: string
  cwd: string
  payload: Record<string, unknown> & {
    session_id?: string
    prompt?: string
    stop_hook_active?: boolean
    tool_name?: string
    tool_input?: Record<string, unknown>
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

// the harness calls hooks with hand-rolled event literals — the shape is
// the point, not the type (the module under test is structural anyway)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCb = (event: any) => any

/** A structural V2 ctx: hook domains record callbacks, transforms record
 *  the editors' edits, `event.subscribe` serves a test-driven queue, and
 *  storage is a Map — the shape opencode hands `setup`, nothing more. */
async function makeSetup(
  options?: Record<string, unknown>,
  storageGet?: (key: string) => Promise<unknown>
) {
  const logs: Logged[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const sessionHooks = new Map<string, AnyCb>()
  const toolHooks = new Map<string, AnyCb>()
  const permissionHooks = new Map<string, AnyCb>()
  const shellHooks = new Map<string, AnyCb>()
  const toolsAdded: Record<string, unknown>[] = []
  const commands: Array<{ name: string; execute: (i: unknown) => Promise<void> }> = []
  const mcpSet = new Map<string, unknown>()
  const storage = new Map<string, unknown>()
  const disposed: string[] = []

  const eventQueue: unknown[] = []
  let aborted = false

  const registerHook =
    (m: Map<string, AnyCb>, tag: string) =>
    async (name: string, cb: AnyCb) => {
      m.set(`${tag}:${name}`, cb)
      return {
        dispose: async () => {
          disposed.push(`${tag}:${name}`)
        },
      }
    }

  const ctx = {
    location: { directory: dir },
    options: { command: { cmd: process.execPath, args: [stub] }, ...options },
    app: {
      log: async (input: { body: { level: string; message: string } }) => {
        logs.push({ level: input.body.level, message: input.body.message })
      },
    },
    session: {
      hook: registerHook(sessionHooks, 'session'),
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text })
      },
    },
    tool: {
      hook: registerHook(toolHooks, 'tool'),
      transform: async (
        cb: (e: {
          namespace(n: unknown): void
          add(t: Record<string, unknown>): void
        }) => void
      ) => {
        cb({ namespace: () => {}, add: (t) => toolsAdded.push(t) })
        return {
          dispose: async () => {
            disposed.push('tool:transform')
          },
        }
      },
    },
    command: {
      transform: async (cb: (e: { add(d: unknown): void }) => void) => {
        cb({
          add: (d) =>
            commands.push(d as { name: string; execute: (i: unknown) => Promise<void> }),
        })
        return {
          dispose: async () => {
            disposed.push('command:transform')
          },
        }
      },
    },
    mcp: {
      transform: async (cb: (e: { set(n: string, c: unknown): void }) => void) => {
        cb({ set: (n, c) => mcpSet.set(n, c) })
        return {
          dispose: async () => {
            disposed.push('mcp:transform')
          },
        }
      },
    },
    permission: { hook: registerHook(permissionHooks, 'permission') },
    shell: { hook: registerHook(shellHooks, 'shell') },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<{ value: unknown; done: boolean }> {
              return new Promise((resolve) => {
                const check = (): void => {
                  if (eventQueue.length > 0) {
                    resolve({ value: eventQueue.shift(), done: false })
                  } else if (aborted || signal?.aborted === true) {
                    resolve({ value: undefined, done: true })
                  } else {
                    // unref'd — a test that skips teardown must not pin the loop
                    setTimeout(check, 5).unref()
                  }
                }
                check()
              })
            },
            return: () => Promise.resolve({ value: undefined, done: true }),
          }
        },
      }),
    },
    storage: {
      get: storageGet ?? (async (key: string) => storage.get(key)),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
  }

  const teardown = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  const emit = (type: string, properties: Record<string, unknown>): void => {
    eventQueue.push({ type, properties })
  }
  return {
    logs,
    prompts,
    sessionHooks,
    toolHooks,
    permissionHooks,
    shellHooks,
    toolsAdded,
    commands,
    mcpSet,
    storage,
    disposed,
    emit,
    abortEvents: () => {
      aborted = true
    },
    teardown,
  }
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
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

describe('v2 session hooks', () => {
  test('context pushes the hydrated text as a system part', async () => {
    respond({ 'session-start': JSON.stringify(ctx('bro state — ready queue')) })
    const { sessionHooks } = await makeSetup()
    const event = { sessionID: 'ses_1', system: [] as { type: string; text: string }[] }
    await sessionHooks.get('session:context')?.(event)
    assert.deepEqual(event.system, [{ type: 'text', text: 'bro state — ready queue' }])
    assert.deepEqual(calls()[0]?.payload, { session_id: 'ses_1' })
    assert.equal(calls()[0]?.cwd, dir)
  })

  test('the context probe is cached per session, re-pushed each request', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) })
    const { sessionHooks } = await makeSetup()
    for (let i = 0; i < 2; i++) {
      const event = { sessionID: 'ses_1', system: [] as unknown[] }
      await sessionHooks.get('session:context')?.(event)
    }
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 1)
  })

  test('context without a system slot or session id never probes', async () => {
    const { sessionHooks } = await makeSetup()
    await sessionHooks.get('session:context')?.({ sessionID: 'ses_1' })
    await sessionHooks.get('session:context')?.({ system: [] })
    assert.equal(calls().length, 0)
  })

  test('compaction pushes pre-compact state into the summary request', async () => {
    respond({ 'pre-compact': JSON.stringify(ctx('open drill frame')) })
    const { sessionHooks } = await makeSetup()
    const event = { sessionID: 'ses_1', system: [] as { type: string; text: string }[] }
    await sessionHooks.get('session:compaction')?.(event)
    assert.deepEqual(event.system, [{ type: 'text', text: 'open drill frame' }])
    assert.equal(calls()[0]?.event, 'pre-compact')
  })

  test('prompt appends probe context to the admission draft', async () => {
    respond({ 'prompt-submit': JSON.stringify(ctx('PR #12 waits on review')) })
    const { sessionHooks } = await makeSetup()
    const event = { sessionID: 'ses_1', prompt: { text: 'look at the queue' } }
    await sessionHooks.get('session:prompt')?.(event)
    assert.equal(event.prompt.text, 'look at the queue\n\nPR #12 waits on review')
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      prompt: 'look at the queue',
    })
  })

  test('a prompt without a draft never probes', async () => {
    const { sessionHooks } = await makeSetup()
    await sessionHooks.get('session:prompt')?.({ sessionID: 'ses_1' })
    assert.equal(calls().length, 0)
  })
})

describe('v2 tool guard', () => {
  test('a block verdict throws and vetoes the call', async () => {
    respond({ 'pre-tool': JSON.stringify({ decision: 'block', reason: 'act gate is red' }) })
    const { toolHooks } = await makeSetup()
    const event = { sessionID: 'ses_1', tool: 'bash', input: { command: 'gh pr merge 12' } }
    await assert.rejects(toolHooks.get('tool:execute.before')?.(event), /act gate is red/)
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      tool_name: 'bash',
      tool_input: { command: 'gh pr merge 12' },
    })
  })

  test('a tool_input override merges over the original args', async () => {
    respond({
      'pre-tool': JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          tool_input: { command: 'bro act status' },
        },
      }),
    })
    const { toolHooks } = await makeSetup()
    const event = {
      sessionID: 'ses_1',
      tool: 'bash',
      input: { command: 'bro act', workdir: '/repo' },
    }
    await toolHooks.get('tool:execute.before')?.(event)
    // the override patches one field — unrelated args survive
    assert.deepEqual(event.input, { command: 'bro act status', workdir: '/repo' })
  })

  test('silence from the probe leaves the call untouched', async () => {
    const { toolHooks } = await makeSetup()
    const event = { sessionID: 'ses_1', tool: 'read', input: { filePath: 'x' } }
    await toolHooks.get('tool:execute.before')?.(event)
    assert.deepEqual(event.input, { filePath: 'x' })
    assert.equal(calls()[0]?.event, 'pre-tool')
  })
})

describe('v2 tool enrichment', () => {
  test('context lands on the result output', async () => {
    respond({ 'post-tool': JSON.stringify(ctx('armed act gate')) })
    const { toolHooks } = await makeSetup()
    const event = {
      sessionID: 'ses_1',
      tool: 'bash',
      status: 'completed',
      input: { command: 'bro act status' },
      result: { output: 'exit 0', metadata: { exit: 0 } },
    }
    await toolHooks.get('tool:execute.after')?.(event)
    assert.deepEqual(event.result, { output: 'exit 0\n\narmed act gate', metadata: { exit: 0 } })
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      tool_name: 'bash',
      tool_input: { command: 'bro act status' },
      tool_response: { success: true },
    })
  })

  test('a failed tool reports failure and a result-less one rides metadata', async () => {
    respond({ 'post-tool': JSON.stringify(ctx('drained mailbox')) })
    const { toolHooks } = await makeSetup()
    const failed = {
      sessionID: 'ses_1',
      tool: 'bash',
      status: 'error',
      input: { command: 'false' },
      result: { metadata: { exit: 1 } },
    }
    await toolHooks.get('tool:execute.after')?.(failed)
    assert.deepEqual(calls()[0]?.payload.tool_response, { success: false })

    const bare: Record<string, unknown> = { sessionID: 'ses_1', tool: 'read', status: 'completed' }
    await toolHooks.get('tool:execute.after')?.(bare)
    assert.deepEqual(bare.result, { metadata: { broContext: 'drained mailbox' } })
  })
})

describe('v2 permission', () => {
  test('approve maps to allow, deny/block to deny + message', async () => {
    respond({ permission: JSON.stringify({ decision: 'approve' }) })
    const { permissionHooks } = await makeSetup()
    const allowed = { sessionID: 'ses_1', resources: ['bro act status'], effect: 'ask' }
    await permissionHooks.get('permission:evaluate')?.(allowed)
    assert.equal(allowed.effect, 'allow')
    assert.deepEqual(calls()[0]?.payload.tool_input, { command: 'bro act status' })

    respond({ permission: JSON.stringify({ decision: 'deny', reason: 'gate is red' }) })
    const denied: Record<string, unknown> = {
      sessionID: 'ses_1',
      resources: ['gh pr merge 12'],
      effect: 'ask',
    }
    await permissionHooks.get('permission:evaluate')?.(denied)
    assert.equal(denied.effect, 'deny')
    assert.equal(denied.message, 'gate is red')
  })

  test('compound asks join resources; no command never calls bro', async () => {
    respond({ permission: JSON.stringify({}) })
    const { permissionHooks } = await makeSetup()
    await permissionHooks.get('permission:evaluate')?.({
      sessionID: 'ses_1',
      resources: ['bd ready', 'rm -rf x'],
      effect: 'ask',
    })
    assert.equal(calls()[0]?.payload.tool_input?.command, 'bd ready && rm -rf x')

    const n = calls().length
    await permissionHooks.get('permission:evaluate')?.({
      sessionID: 'ses_1',
      resources: [],
      metadata: {},
      effect: 'ask',
    })
    assert.equal(calls().length, n)
  })
})

describe('v2 shell env', () => {
  test('provenance lands without clobbering operator values', async () => {
    const { shellHooks } = await makeSetup()
    const fresh = { command: 'ls', env: {} as Record<string, string | undefined> }
    await shellHooks.get('shell:create.before')?.(fresh)
    assert.equal(fresh.env.BRO_AGENT_ID, 'opencode')

    const own = { command: 'ls', env: { BRO_AGENT_ID: 'manual' } }
    await shellHooks.get('shell:create.before')?.(own)
    assert.equal(own.env.BRO_AGENT_ID, 'manual')
  })
})

describe('v2 transforms', () => {
  test('the bro namespace registers its read tools', async () => {
    const { toolsAdded } = await makeSetup()
    const names = toolsAdded.map((t) => t.name)
    assert.deepEqual(names, ['status', 'convoy_status', 'act_status', 'fleet'])
    for (const t of toolsAdded) {
      assert.deepEqual(t.options, { namespace: 'bro' })
      assert.equal(typeof t.execute, 'function')
    }
  })

  test('a tool execute returns the cli output; a failing gate keeps the code', async () => {
    respond({ 'status --json': '{"beads":[]}' })
    const { toolsAdded } = await makeSetup()
    const status = toolsAdded[0]!
    const out = (await (
      status.execute as (i: unknown, c: unknown) => Promise<{ content: string }>
    )({}, {})) as { content: string }
    assert.equal(out.content, '{"beads":[]}')

    respond({ 'act status --json': '' }, 2)
    const act = toolsAdded.find((t) => t.name === 'act_status')!
    const gated = (await (
      act.execute as (i: unknown, c: unknown) => Promise<{ content: string }>
    )({}, {})) as { content: string }
    assert.match(gated.content, /^exit 2/)
  })

  test('/bro runs the verb and submits its output as a prompt', async () => {
    const { commands, prompts } = await makeSetup()
    assert.equal(commands[0]?.name, 'bro')
    await commands[0]!.execute({ sessionID: 'ses_1', prompt: { text: 'status' } })
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.sessionID, 'ses_1')
    assert.match(prompts[0]?.text ?? '', /^bro status/)
  })

  test('/bro keeps a quoted multiword argument in one argv entry', async () => {
    // exact argv-join key — only matches when "a b c" arrives unsplit
    respond({ 'learn capture a b c': 'note kept' })
    const { commands, prompts } = await makeSetup()
    await commands[0]!.execute({ sessionID: 'ses_1', prompt: { text: 'learn capture "a b c"' } })
    assert.match(prompts[0]?.text ?? '', /note kept/)
    assert.match(prompts[0]?.text ?? '', /^bro learn capture a b c/)
  })

  test('the mcp transform registers only when mcpPort is configured', async () => {
    const without = await makeSetup()
    assert.equal(without.mcpSet.size, 0)
    const withPort = await makeSetup({ mcpPort: 4173 })
    assert.deepEqual(withPort.mcpSet.get('bro'), {
      type: 'remote',
      url: 'http://127.0.0.1:4173',
    })
  })
})

describe('v2 event stream', () => {
  test('a clean turn followed by a blocked stop re-prompts once', async () => {
    respond({ stop: JSON.stringify({ decision: 'block', reason: 'dirty worktree' }) })
    const { emit, prompts } = await makeSetup()
    emit('message.updated', {
      info: { role: 'assistant', sessionID: 'ses_1', time: { completed: 2 } },
    })
    emit('session.idle', { sessionID: 'ses_1' })
    await waitFor(() => prompts.length === 1)
    assert.deepEqual(prompts, [{ sessionID: 'ses_1', text: 'dirty worktree' }])
  })

  test('the gated set persists through ctx.storage and survives teardown', async () => {
    respond({ stop: JSON.stringify({ decision: 'block', reason: 'dirty' }) })
    const { emit, storage, prompts, teardown } = await makeSetup()
    emit('message.updated', {
      info: { role: 'assistant', sessionID: 'ses_1', time: { completed: 2 } },
    })
    emit('session.idle', { sessionID: 'ses_1' })
    await waitFor(() => prompts.length === 1)
    await waitFor(() => (storage.get('stop-gated') as string[] | undefined)?.includes('ses_1') === true)
    await teardown()
    assert.deepEqual(storage.get('stop-gated'), ['ses_1'])
  })

  test('a session deleted while the gated store loads does not resurrect as gated', async () => {
    respond({ stop: JSON.stringify({ decision: 'block', reason: 'dirty' }) })
    let releaseLoad: () => void = () => {}
    const held = new Promise<void>((r) => (releaseLoad = r))
    const { emit, prompts, teardown } = await makeSetup(undefined, async () => {
      await held
      return ['ses_1']
    })

    // the persisted snapshot is still in flight — a delete for a stored id
    // must win over the merge, or the gate resurrects onto the session
    // reusing it and its first block is swallowed as a repeat
    emit('session.deleted', { info: { id: 'ses_1' } })
    // anchor for the ordering: the stream dispatches FIFO, so a prompt
    // earned by ses_2 proves the delete has already run
    emit('message.updated', {
      info: { role: 'assistant', sessionID: 'ses_2', time: { completed: 2 } },
    })
    emit('session.idle', { sessionID: 'ses_2' })
    await waitFor(() => prompts.length === 1)

    releaseLoad()
    // the merge is a microtask chain — a macrotask hop drains it
    await new Promise((r) => setTimeout(r, 0))

    emit('session.created', { sessionID: 'ses_1' })
    emit('message.updated', {
      info: { role: 'assistant', sessionID: 'ses_1', time: { completed: 2 } },
    })
    emit('session.idle', { sessionID: 'ses_1' })
    await waitFor(() => prompts.length === 2)
    await teardown()
    assert.equal(prompts[1]?.sessionID, 'ses_1')
    assert.equal(prompts[1]?.text, 'dirty')
  })

  test('teardown disposes registrations and stops the stream', async () => {
    const { teardown, disposed, abortEvents } = await makeSetup()
    abortEvents()
    await teardown()
    for (const name of [
      'session:context',
      'session:compaction',
      'session:prompt',
      'tool:execute.before',
      'tool:execute.after',
      'permission:evaluate',
      'shell:create.before',
      'tool:transform',
      'command:transform',
    ]) {
      assert.ok(disposed.includes(name), `${name} not disposed`)
    }
  })
})

describe('v2 fail-open', () => {
  test('a bare ctx wires nothing and never throws', async () => {
    const teardown = await plugin.setup({})
    assert.equal(typeof teardown, 'function')
    await teardown()
  })

  test('domains without hook/transform methods degrade to unwired', async () => {
    const teardown = await plugin.setup({
      location: { directory: dir },
      session: {},
      tool: {},
      event: {},
    })
    await teardown()
    assert.equal(calls().length, 0)
  })

  test('a failing storage backend still gates in memory', async () => {
    respond({ stop: JSON.stringify({ decision: 'block', reason: 'dirty' }) })
    const prompts: { sessionID: string; text: string }[] = []
    const events: unknown[] = []
    const teardown = await plugin.setup({
      location: { directory: dir },
      options: { command: { cmd: process.execPath, args: [stub] } },
      session: {
        prompt: async (i: { sessionID: string; text: string }) => {
          prompts.push(i)
        },
      },
      storage: {
        get: () => Promise.reject(new Error('wedged')),
        set: () => Promise.reject(new Error('wedged')),
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise((r) => {
                  const check = (): void => {
                    if (events.length > 0) r({ value: events.shift(), done: false })
                    else setTimeout(check, 5).unref()
                  }
                  check()
                }),
              return: () => Promise.resolve({ value: undefined, done: true }),
            }
          },
        }),
      },
    })
    events.push(
      { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 's', time: { completed: 1 } } } },
      { type: 'session.idle', properties: { sessionID: 's' } }
    )
    await waitFor(() => prompts.length === 1)
    await teardown()
    assert.equal(prompts[0]?.text, 'dirty')
  })
})

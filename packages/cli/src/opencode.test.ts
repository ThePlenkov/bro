import { describe, test, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { jsRuntime, toolSucceeded } from './opencode.ts'

// opencode's plugin loader only accepts a v1 module — a default export with an
// `id` (mandatory for file plugins) and a `server` function. A module that
// misses either is silently skipped, not reported.
describe('loader shape', () => {
  test('default export declares id and server', () => {
    assert.equal(plugin.id, 'bro')
    assert.equal(typeof plugin.server, 'function')
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

const dir = mkdtempSync(join(tmpdir(), 'bro-oc-'))
const logFile = join(dir, 'calls.log')

// A stand-in for `bro hooks <event>`: records what it was asked and replays a
// canned answer. Driven by env so one stub serves every case, and so the
// plugin's `command` option — the same escape hatch users get from
// `"plugin": [["@broject/bro", { command: … }]]` — is the test seam.
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
const done = () => process.exit(Number(process.env.BRO_STUB_STATUS ?? '0'))
const perEvent = process.env.BRO_STUB_SLEEP_EVENTS ? JSON.parse(process.env.BRO_STUB_SLEEP_EVENTS) : {}
const sleep = Number(perEvent[event] ?? process.env.BRO_STUB_SLEEP_MS ?? '0')
sleep > 0 ? setTimeout(done, sleep) : done()
`
)

after(() => rmSync(dir, { recursive: true, force: true }))

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

async function makeHooks(options?: Record<string, unknown>, onLog?: () => Promise<void>) {
  const logs: Logged[] = []
  const prompts: { id: string; text: string }[] = []
  const hooks = await plugin.server(
    {
      directory: dir,
      client: {
        app: {
          log: async (input: { body: { level: string; message: string } }) => {
            logs.push({ level: input.body.level, message: input.body.message })
            await onLog?.()
          },
        },
        session: {
          promptAsync: async (input: {
            path: { id: string }
            body: { parts: { text: string }[] }
          }) => {
            prompts.push({ id: input.path.id, text: input.body.parts[0]?.text ?? '' })
          },
        },
      },
    },
    { command: { cmd: process.execPath, args: [stub] }, ...options }
  )
  return { hooks, logs, prompts }
}

/** opencode delivers message.updated before the matching session.idle. */
async function finishTurn(
  hooks: NonNullable<Awaited<ReturnType<typeof makeHooks>>>['hooks'],
  sessionID: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await hooks.event?.({
    event: {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID,
          time: { created: 1, completed: 2 },
          ...extra,
        },
      },
    },
  })
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
  delete process.env.BRO_STUB_SLEEP_MS
  delete process.env.BRO_STUB_SLEEP_EVENTS
})

describe('session rehydration', () => {
  test('probes once per session and re-pushes every turn', async () => {
    respond({ 'session-start': JSON.stringify(ctx('bro state — ready queue')) })
    const { hooks } = await makeHooks()

    const first = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(first, first)
    const second = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(second, second)

    assert.deepEqual(first.system, ['bro state — ready queue'])
    assert.deepEqual(second.system, ['bro state — ready queue'])
    const starts = calls().filter((c) => c.event === 'session-start')
    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0]?.payload, { session_id: 'ses_1' })
    assert.equal(starts[0]?.cwd, dir)
  })

  test('session.created primes the probe so the first turn does not pay for it', async () => {
    respond({ 'session-start': JSON.stringify(ctx('primed state')) })
    const { hooks } = await makeHooks()
    // the prime is deliberately not awaited by the event handler
    await hooks.event?.({ event: { type: 'session.created', properties: { sessionID: 'ses_1' } } })
    const out = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, out)
    assert.deepEqual(out.system, ['primed state'])
    // a racing prime and first turn share one probe, they don't double-spawn
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 1)
  })

  test('a second session probes on its own', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) })
    const { hooks } = await makeHooks()
    for (const sessionID of ['ses_1', 'ses_2', 'ses_1']) {
      const out = { system: [] as string[] }
      await hooks['experimental.chat.system.transform']?.({ sessionID }, out)
    }
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 2)
  })

  test('a failed probe is not cached — the next turn retries', async () => {
    respond({ 'session-start': JSON.stringify(ctx('never')) }, 1)
    const { hooks } = await makeHooks()

    const first = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(first, first)
    assert.deepEqual(first.system, [])

    respond({ 'session-start': JSON.stringify(ctx('recovered state')) })
    const second = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(second, second)

    assert.deepEqual(second.system, ['recovered state'])
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 2)
  })

  test('an answered-but-empty probe stays cached — no per-turn re-probe', async () => {
    respond({ 'session-start': '{}' })
    const { hooks } = await makeHooks()

    for (let i = 0; i < 2; i++) {
      const out = { sessionID: 'ses_1', system: [] as string[] }
      await hooks['experimental.chat.system.transform']?.(out, out)
      assert.deepEqual(out.system, [])
    }
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 1)
  })

  test('an empty session without an id contributes nothing', async () => {
    const { hooks } = await makeHooks()
    const out = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({}, out)
    assert.deepEqual(out.system, [])
    assert.equal(calls().length, 0)
  })

  test('compaction re-primes the cache with post-compaction state', async () => {
    respond({
      'session-start': JSON.stringify(ctx('before compaction')),
      'post-compaction': JSON.stringify(ctx('after compaction')),
    })
    const { hooks } = await makeHooks()

    const first = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(first, first)
    assert.deepEqual(first.system, ['before compaction'])

    await hooks.event?.({ event: { type: 'session.compacted', properties: { sessionID: 'ses_1' } } })

    const second = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(second, second)
    assert.deepEqual(second.system, ['after compaction'])
    const events = calls().map((c) => c.event)
    assert.deepEqual(events, ['session-start', 'post-compaction'])
  })

  test('pre-compact feeds bro state into the compaction prompt', async () => {
    respond({ 'pre-compact': JSON.stringify(ctx('open drill frame: fixing the gate')) })
    const { hooks } = await makeHooks()
    const out = { context: [] as string[] }
    await hooks['experimental.session.compacting']?.({ sessionID: 'ses_1' }, out)
    assert.deepEqual(out.context, ['open drill frame: fixing the gate'])
  })
})

describe('prompt-submit', () => {
  test('appends probe context as a part', async () => {
    respond({ 'prompt-submit': JSON.stringify(ctx('PR #12 is waiting on review')) })
    const { hooks } = await makeHooks()
    const out = { parts: [{ type: 'text', text: 'look at the merge slot' }] }
    await hooks['chat.message']?.({ sessionID: 'ses_1' }, out)
    assert.equal(out.parts.length, 2)
    assert.deepEqual(out.parts[1], { type: 'text', text: 'PR #12 is waiting on review' })
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      prompt: 'look at the merge slot',
    })
  })

  test('joins the text parts and skips non-text ones', async () => {
    const { hooks } = await makeHooks()
    const out = {
      parts: [
        { type: 'text', text: 'first' },
        { type: 'file', text: 'ignored' },
        { type: 'text', text: 'second' },
      ],
    }
    await hooks['chat.message']?.({ sessionID: 'ses_1' }, out)
    assert.equal(out.parts.length, 3)
    assert.equal(calls()[0]?.payload.prompt, 'first\nsecond')
  })

  test('no probe output leaves the message alone', async () => {
    const { hooks } = await makeHooks()
    const out = { parts: [{ type: 'text', text: 'hello' }] }
    await hooks['chat.message']?.({ sessionID: 'ses_1' }, out)
    assert.deepEqual(out.parts, [{ type: 'text', text: 'hello' }])
  })
})

describe('post-tool', () => {
  test('arms the session and appends context to the tool output', async () => {
    respond({ 'post-tool': JSON.stringify(ctx('bro act mutations are governed by the act skill')) })
    const { hooks } = await makeHooks()
    const out = { output: 'exit 0', metadata: {} }
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'ses_1', args: { command: 'bro act status' } },
      out
    )
    assert.equal(out.output, 'exit 0\n\nbro act mutations are governed by the act skill')
    assert.deepEqual(calls()[0]?.payload, {
      session_id: 'ses_1',
      tool_name: 'bash',
      tool_input: { command: 'bro act status' },
      tool_response: { success: true },
    })
  })

  test('a tool error reports failure, a missing args object still calls', async () => {
    const { hooks } = await makeHooks()
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'ses_1' },
      { output: 'boom', metadata: { error: 'exit 1' } }
    )
    assert.deepEqual(calls()[0]?.payload.tool_input, {})
    assert.deepEqual(calls()[0]?.payload.tool_response, { success: false })
  })

  // opencode's bash metadata is `{ output, exit, truncated }` — a nonzero exit
  // sets no `error` key, so keying on `error` alone read every failure as a
  // success and armed bro's gates for commands that never worked.
  test('a nonzero exit with no error key still reports failure', async () => {
    const { hooks } = await makeHooks()
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'ses_1', args: { command: 'gh pr create' } },
      { output: 'fatal', metadata: { exit: 1, truncated: false } }
    )
    assert.deepEqual(calls()[0]?.payload.tool_response, { success: false })
  })

  test('exit 0 and a metadata-free tool both report success', async () => {
    const { hooks } = await makeHooks()
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'ses_1' },
      { output: 'ok', metadata: { exit: 0, truncated: false } }
    )
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'ses_1' },
      { output: 'ok' }
    )
    assert.deepEqual(
      calls().map((call) => call.payload.tool_response),
      [{ success: true }, { success: true }]
    )
  })
})

describe('toolSucceeded', () => {
  test('exit code wins over a missing error key', () => {
    assert.equal(toolSucceeded({ exit: 0 }), true)
    assert.equal(toolSucceeded({ exit: 1 }), false)
    assert.equal(toolSucceeded({ error: 'boom' }), false)
    assert.equal(toolSucceeded({ error: 'boom', exit: 0 }), false)
    assert.equal(toolSucceeded({}), true)
    assert.equal(toolSucceeded(null), true)
  })
})

describe('permission', () => {
  test('auto-allows a self-tool command', async () => {
    respond({ permission: JSON.stringify({ decision: 'approve' }) })
    const { hooks } = await makeHooks()
    const out = { status: 'ask' as const }
    await hooks['permission.ask']?.({ pattern: 'bro act status', sessionID: 'ses_1' }, out)
    assert.equal(out.status, 'allow')
  })

  test('leaves other asks to the user', async () => {
    respond({ permission: JSON.stringify({}) })
    const { hooks } = await makeHooks()
    const out = { status: 'ask' as const }
    await hooks['permission.ask']?.({ pattern: 'gh pr merge 12', sessionID: 'ses_1' }, out)
    assert.equal(out.status, 'ask')
  })

  test('reads the native patterns array and keeps every segment visible', async () => {
    respond({ permission: JSON.stringify({ decision: 'approve' }) })
    const { hooks } = await makeHooks()
    const out = { status: 'ask' as const }
    await hooks['permission.ask']?.(
      { permission: 'bash', patterns: ['bd ready'], sessionID: 'ses_1' },
      out
    )
    assert.equal(out.status, 'allow')
    assert.equal(calls()[0]?.payload.tool_input?.command, 'bd ready')

    // a compound ask reaches bro as the whole chain — the classifier, not
    // this hook, decides that `bd ready && rm -rf x` is not a self-tool call
    const chained = { status: 'ask' as const }
    await hooks['permission.ask']?.(
      { permission: 'bash', patterns: ['bd ready', 'rm -rf x'] },
      chained
    )
    assert.equal(calls()[1]?.payload.tool_input?.command, 'bd ready && rm -rf x')
  })

  test('reads the command out of metadata and single-entry patterns', async () => {
    respond({ permission: JSON.stringify({ decision: 'approve' }) })
    const { hooks } = await makeHooks()
    const fromMeta = { status: 'ask' as const }
    await hooks['permission.ask']?.({ metadata: { command: 'bd ready' } }, fromMeta)
    assert.equal(fromMeta.status, 'allow')

    const fromList = { status: 'ask' as const }
    await hooks['permission.ask']?.({ pattern: ['bd ready'] }, fromList)
    assert.equal(fromList.status, 'allow')
    assert.equal(calls()[0]?.payload.tool_input?.command, 'bd ready')
  })

  test('an ask with no command never calls bro', async () => {
    const { hooks } = await makeHooks()
    const out = { status: 'ask' as const }
    await hooks['permission.ask']?.({ metadata: {} }, out)
    assert.equal(out.status, 'ask')
    assert.equal(calls().length, 0)
  })
})

describe('stop gate', () => {
  const blocked = { decision: 'block', reason: 'worktree is dirty — commit or stash first' }

  test('re-prompts once with the blocker', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, logs, prompts } = await makeHooks()

    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })

    assert.deepEqual(prompts, [
      { id: 'ses_1', text: 'worktree is dirty — commit or stash first' },
    ])
    assert.equal(logs[0]?.level, 'warn')
    assert.match(logs[0]?.message ?? '', /stop gate/)
    assert.equal(calls()[0]?.payload.stop_hook_active, false)
  })

  test('a whitespace-only reason re-prompts the fallback, not an empty turn', async () => {
    respond({ stop: JSON.stringify({ decision: 'block', reason: '   ' }) })
    const { hooks, logs, prompts } = await makeHooks()

    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })

    assert.deepEqual(prompts, [{ id: 'ses_1', text: 'unfinished bro work' }])
    assert.match(logs[0]?.message ?? '', /stop gate: unfinished bro work/)
  })

  test('a second block is logged, never re-prompted — a gate, not a loop', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, logs, prompts } = await makeHooks()

    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })

    assert.equal(prompts.length, 1)
    const stops = calls().filter((c) => c.event === 'stop')
    assert.equal(stops.length, 2)
    // bro skips its own re-evaluation on the repeat — stop_hook_active is the
    // same retry flag Claude uses
    assert.equal(stops[1]?.payload.stop_hook_active, true)
    // the suppressed repeat is still traceable — the warn answers "why
    // didn't it re-prompt?"
    const gateLogs = logs.filter((l) => (l.message ?? '').includes('stop gate'))
    assert.equal(gateLogs.length, 2)
    assert.equal(gateLogs[1]?.level, 'info')
    assert.match(gateLogs[1]?.message ?? '', /already gated/)
  })

  test('the one-shot guard is per session', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, prompts } = await makeHooks()
    for (const sessionID of ['ses_1', 'ses_2']) {
      await finishTurn(hooks, sessionID)
      await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID } } })
    }
    assert.deepEqual(
      prompts.map((p) => p.id),
      ['ses_1', 'ses_2']
    )
  })

  test('an aborted turn never gates', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, prompts } = await makeHooks()

    await finishTurn(hooks, 'ses_1', { error: { name: 'MessageAbortedError' } })
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    // and a turn still streaming when idle arrives
    await hooks.event?.({
      event: {
        type: 'message.updated',
        properties: { info: { role: 'assistant', sessionID: 'ses_2', time: { created: 1 } } },
      },
    })
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } })

    assert.deepEqual(prompts, [])
    assert.equal(calls().length, 0)
  })

  test('a clean step followed by an abort in the same turn never gates', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, prompts } = await makeHooks()

    await finishTurn(hooks, 'ses_1')
    // the next assistant step of the same turn dies — its message.updated is
    // the verdict, not the earlier clean one
    await hooks.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'ses_1',
            time: { created: 3 },
            error: { name: 'MessageAbortedError' },
          },
        },
      },
    })
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })

    assert.deepEqual(prompts, [])
    assert.equal(calls().length, 0)
  })

  test('a session deleted mid-gate is not re-prompted and does not stay gated', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, prompts } = await makeHooks()

    await finishTurn(hooks, 'ses_1')
    const idle = hooks.event?.({
      event: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    })
    // the stop probe is in flight — the session dies before the gate lands
    await hooks.event?.({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_1' } } },
    })
    await idle
    assert.deepEqual(prompts, [])

    // a session reusing the id gets a fresh one-shot, not a suppressed gate
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.equal(prompts.length, 1)
  })

  test('a session deleted during the gate log is not re-prompted', async () => {
    respond({ stop: JSON.stringify(blocked) })
    let release: () => void = () => {}
    const suspended = new Promise<void>((r) => (release = r))
    let held = false
    const { hooks, logs, prompts } = await makeHooks(undefined, async () => {
      if (!held) {
        held = true
        await suspended
      }
    })

    await finishTurn(hooks, 'ses_1')
    const idle = hooks.event?.({
      event: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    })
    // wait until the gate is provably parked inside its warn log —
    // only then is the deletion guaranteed to land in the suspended window
    const deadline = Date.now() + 5_000
    while (!logs.some((l) => l.message.startsWith('stop gate:')) && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r))
    }
    await hooks.event?.({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_1' } } },
    })
    release()
    await idle
    assert.deepEqual(prompts, [])
  })

  test('a failed pre-compaction probe does not evict the post-compaction one', async () => {
    respond({ 'post-compaction': JSON.stringify(ctx('fresh')) })
    // the session-start probe lingers and resolves to nothing (the event is
    // absent from the map) — only after the faster post-compaction probe has
    // already taken the slot. Identity-checked eviction keeps it in place.
    process.env.BRO_STUB_SLEEP_EVENTS = JSON.stringify({ 'session-start': 100 })
    const { hooks } = await makeHooks()

    await hooks.event?.({ event: { type: 'session.created', properties: { sessionID: 'ses_1' } } })
    await hooks.event?.({ event: { type: 'session.compacted', properties: { sessionID: 'ses_1' } } })
    // let both children settle before the transform reads the cache —
    // eviction of a live entry would surface as a *second* session-start probe
    await new Promise((r) => setTimeout(r, 300))

    const out = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(out, out)
    assert.deepEqual(out.system, ['fresh'])
    assert.equal(
      calls().filter((c) => c.event === 'session-start').length,
      1,
      'evicted post-compaction entry re-probed on transform'
    )
  })

  test('session.deleted clears rehydration and the one-shot gate', async () => {
    respond({
      'session-start': JSON.stringify(ctx('state')),
      stop: JSON.stringify(blocked),
    })
    const { hooks, prompts } = await makeHooks()

    const first = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(first, first)
    assert.deepEqual(first.system, ['state'])
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.equal(prompts.length, 1)

    await hooks.event?.({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_1' } } },
    })

    // a session reusing the id probes fresh and gets a fresh one-shot
    const second = { sessionID: 'ses_1', system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.(second, second)
    assert.equal(calls().filter((c) => c.event === 'session-start').length, 2)
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.equal(prompts.length, 2)
  })

  test('idle without a finished turn never gates', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const { hooks, prompts } = await makeHooks()
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.deepEqual(prompts, [])
    assert.equal(calls().length, 0)
  })

  test('a non-blocking gate logs its hints and does not prompt', async () => {
    respond({
      stop: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'PR #12 has open threads' } }),
    })
    const { hooks, logs, prompts } = await makeHooks()
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.deepEqual(prompts, [])
    assert.deepEqual(logs, [{ level: 'info', message: 'PR #12 has open threads' }])
  })

  test('a failing re-prompt is logged, never thrown into opencode', async () => {
    respond({ stop: JSON.stringify(blocked) })
    const logs: Logged[] = []
    const hooks = await plugin.server(
      {
        directory: dir,
        client: {
          app: {
            log: async (input: { body: { level: string; message: string } }) => {
              logs.push({ level: input.body.level, message: input.body.message })
            },
          },
          session: {
            promptAsync: async () => {
              throw new Error('session is busy')
            },
          },
        },
      },
      { command: { cmd: process.execPath, args: [stub] } }
    )
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.ok(logs.some((l) => l.level === 'error' && /session is busy/.test(l.message)))
  })
})

describe('fail-open', () => {
  test('a nonzero exit yields no context anywhere', async () => {
    respond({ 'session-start': JSON.stringify(ctx('state')) }, 1)
    const { hooks, logs, prompts } = await makeHooks()
    const system = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, system)
    await hooks.event?.({
      event: {
        type: 'message.updated',
        properties: { info: { role: 'assistant', sessionID: 'ses_1', time: { completed: 2 } } },
      },
    })
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    assert.deepEqual(system.system, [])
    assert.deepEqual(prompts, [])
    assert.equal(logs.filter((l) => l.level === 'warn').length, 0)
  })

  test('a missing bro binary is inert', async () => {
    const logs: Logged[] = []
    const hooks = await plugin.server(
      {
        directory: dir,
        client: { app: { log: async () => logs.push({ level: 'info', message: '' }) } },
      },
      { command: '/nonexistent/bro-oc' }
    )
    const system = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, system)
    const perm = { status: 'ask' as const }
    await hooks['permission.ask']?.({ pattern: 'bro act status' }, perm)
    assert.deepEqual(system.system, [])
    assert.equal(perm.status, 'ask')
  })

  test('a probe that outlives its budget resolves with no context', async (t) => {
    // the stub sleeps past HOOK_TIMEOUT_MS; fake timers fire the reap without
    // waiting the real 15s — process.kill on the child is still real
    t.mock.timers.enable({ apis: ['setTimeout'] })
    process.env.BRO_STUB_SLEEP_MS = '60000'
    try {
      const { hooks } = await makeHooks()
      const out = { sessionID: 'ses_1', system: [] as string[] }
      const pending = hooks['experimental.chat.system.transform']?.(out, out)
      // the stub logs on startup, before its sleep — give the real child a
      // bounded wall-clock window to boot (Date is not a mocked api), then
      // fire the fake reap timer
      const deadline = Date.now() + 5_000
      while (calls().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      t.mock.timers.tick(60_000)
      await pending
      assert.deepEqual(out.system, [])
      assert.equal(calls().length, 1, 'stub child did not start within 5s')
    } finally {
      t.mock.timers.reset()
    }
  })

  test('garbage on stdout is not parsed as context', async () => {
    respond({ 'session-start': 'not json at all\n{"broken":' })
    const { hooks } = await makeHooks()
    const out = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, out)
    assert.deepEqual(out.system, [])
  })

  test('a control object is found after unrelated chatter', async () => {
    respond({ 'session-start': `bro: probing\n${JSON.stringify(ctx('real state'))}\n` })
    const { hooks } = await makeHooks()
    const out = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, out)
    assert.deepEqual(out.system, ['real state'])
  })

  test('unknown events and malformed properties are ignored', async () => {
    const { hooks } = await makeHooks()
    await hooks.event?.({ event: { type: 'session.updated', properties: {} } })
    await hooks.event?.({ event: { type: 'message.updated' } })
    await hooks.event?.({ event: { type: 'session.idle' } })
    await hooks.event?.({ event: { type: 'session.compacted', properties: {} } })
    assert.equal(calls().length, 0)
  })

  test('a plugin with no client still serves every hook', async () => {
    respond({
      'session-start': JSON.stringify(ctx('state')),
      stop: JSON.stringify({ decision: 'block', reason: 'dirty' }),
    })
    const hooks = await plugin.server(
      { directory: dir },
      { command: { cmd: process.execPath, args: [stub] } }
    )
    const out = { system: [] as string[] }
    await hooks['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, out)
    assert.deepEqual(out.system, ['state'])
    await finishTurn(hooks, 'ses_1')
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
  })
})

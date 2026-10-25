/** serve `/api/v1/acp` — the native ACP transport (spec bro-ymbq1):
 *  brokered sessions over ACP Streamable HTTP against the pooled
 *  upstream peer (fakeAcpAgent on the `acp.peer` seam, a real
 *  `createHttpStream` client downstream — the whole wire is real). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { client, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type {
  ClientContext,
  InitializeRequest,
  SessionUpdate,
  ClientConnection,
} from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import { fakeAcpAgent, type FakeAcpAgent } from '@broject/providers/testkit'
import { acpTransport } from './serve-acp.ts'
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts'

const CFG = {
  backend: 'dv-acp',
  entry: { type: 'acp' as const, command: 'dv acp' },
  cwd: '/repo',
  timeoutMs: 10_000,
  agents: {},
}

const INIT_PARAMS: InitializeRequest = {
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: 'test-client', version: '0' },
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  },
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      throw new Error(`until() timed out — ${what}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface TestClient {
  conn: ClientConnection
  agent: ClientContext
  /** session/update notifications as they arrive downstream. */
  updates: { sessionId: string; update: SessionUpdate }[]
  /** Requests the upstream agent sent downstream (bridge traffic). */
  fsReads: { sessionId: string; path: string }[]
}

/** A downstream client app on the real Streamable-HTTP wire — the
 *  session/update sink plus an fs/read_text_file handler so bridge
 *  tests can answer the agent's calls. */
function openClient(url: string): TestClient {
  const t: TestClient = {
    conn: undefined as never,
    agent: undefined as never,
    updates: [],
    fsReads: [],
  }
  const app = client({ name: 'test-client' })
    .onNotification('session/update', (ctx) => {
      t.updates.push({ sessionId: ctx.params.sessionId, update: ctx.params.update })
    })
    .onRequest('fs/read_text_file', (ctx) => {
      t.fsReads.push({ sessionId: ctx.params.sessionId, path: ctx.params.path })
      return { content: `contents of ${ctx.params.path}` }
    })
    .onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    }))
  t.conn = app.connect(
    createHttpStream(`${url}/api/v1/acp`, { headers: authHeaders })
  )
  t.agent = t.conn.agent
  return t
}

/** The serve wiring every test repeats — a fake upstream agent behind
 *  the real brokered transport. */
const listenAcp = (fake: FakeAcpAgent) =>
  listen(deps({ acp: acpTransport(CFG, { acp: { peer: fake.app } }) }))

describe('serve /api/v1/acp — the native ACP transport', () => {
  test('initialize answers the upstream handshake minus loadSession', async () => {
    const fake = fakeAcpAgent({
      authMethods: [{ id: 'devin', name: 'Devin login' }],
      agentCapabilities: { loadSession: true },
    })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      const res = await c.agent.request('initialize', INIT_PARAMS)
      assert.equal(res.protocolVersion, PROTOCOL_VERSION)
      assert.equal(res.agentInfo?.name, 'fake-acp')
      assert.deepEqual(res.authMethods, [{ id: 'devin', name: 'Devin login' }])
      // loadSession is stripped — the broker never joins a session it
      // did not open
      assert.equal(res.agentCapabilities?.loadSession !== true, true)
      // and upstream saw the broker's capability union, not the
      // client's literal advertisement (the fake's schema parse adds
      // normalized fields like auth:{terminal:false} — assert the
      // advertised surface)
      const caps = fake.clientCapabilities as {
        fs?: { readTextFile?: boolean; writeTextFile?: boolean }
        terminal?: boolean
      }
      assert.deepEqual(caps.fs, { readTextFile: true, writeTextFile: true })
      assert.equal(caps.terminal, true)
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('session/new passes client params verbatim', async () => {
    const fake = fakeAcpAgent({})
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      const mcpServers = [
        { type: 'stdio', name: 'mine', command: 'mcp-server', args: ['--x'], env: [] },
      ]
      const s = (await c.agent.request('session/new', {
        cwd: '/work/bro--bro-ymbq1',
        mcpServers,
        _meta: { bead: 'bro-ymbq1' },
      })) as { sessionId: string }
      assert.equal(s.sessionId, 'sess-1')
      // verbatim passthrough: cwd, mcpServers, _meta all reached the
      // agent (the fake's schema parse normalizes the shape — assert
      // the values it must not have touched)
      const req = fake.sessionRequests[0]
      assert.equal(req?.cwd, '/work/bro--bro-ymbq1')
      assert.equal(req?._meta?.bead, 'bro-ymbq1')
      assert.equal(req?.mcpServers?.[0]?.name, 'mine')
      assert.equal(
        (req?.mcpServers?.[0] as { command?: string } | undefined)?.command,
        'mcp-server'
      )
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('session/update notifications fan out live mid-turn', async () => {
    const gate = defer()
    const fake = fakeAcpAgent({
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello ' },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'ls /tmp',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
      ],
      holdPromptUntil: gate.promise,
    })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await c.agent.request('session/new', { cwd: '/w', mcpServers: [] })
      const p = c.agent.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'say hi' }],
      })
      // the upstream turn is HELD — updates arriving now are live
      // fan-out, not a post-hoc batch
      await until(() => c.updates.length === 2, 'session/update fan-out')
      assert.equal(c.updates[0]?.update.sessionUpdate, 'agent_message_chunk')
      assert.equal(c.updates[1]?.update.sessionUpdate, 'tool_call')
      gate.resolve()
      const r = (await p) as { stopReason: string }
      assert.equal(r.stopReason, 'end_turn')
      assert.deepEqual(fake.prompts, ['say hi'])
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('agent→client requests ride the bridge — permission and fs/read_text_file', async () => {
    const fake = fakeAcpAgent({
      replyText: 'done',
      askPermission: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      probeClient: (cl, sid) =>
        cl.request('fs/read_text_file', { sessionId: sid, path: '/etc/motd' }),
    })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await c.agent.request('session/new', { cwd: '/w', mcpServers: [] })
      const r = (await c.agent.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      })) as { stopReason: string }
      assert.equal(r.stopReason, 'end_turn')
      // the permission answer came back from the DOWNSTREAM client
      assert.deepEqual(fake.permissionOutcome, { outcome: 'selected', optionId: 'allow' })
      // and so did the fs read — verbatim, by sessionId routing
      assert.deepEqual(c.fsReads, [{ sessionId: 'sess-1', path: '/etc/motd' }])
      assert.deepEqual(fake.probeResult, { content: 'contents of /etc/motd' })
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('session/cancel forwards upstream mid-turn', async () => {
    const gate = defer()
    const fake = fakeAcpAgent({
      updates: [],
      holdPromptUntil: gate.promise,
      stopReason: 'cancelled',
    })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await c.agent.request('session/new', { cwd: '/w', mcpServers: [] })
      const p = c.agent.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'long work' }],
      })
      await until(() => fake.prompts.length === 1, 'prompt in flight')
      await c.agent.notify('session/cancel', { sessionId: 'sess-1' })
      await until(() => fake.cancels.includes('sess-1'), 'cancel forwarded')
      gate.resolve()
      const r = (await p) as { stopReason: string }
      assert.equal(r.stopReason, 'cancelled')
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('client disconnect (DELETE) closes the session upstream', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await c.agent.request('session/new', { cwd: '/w', mcpServers: [] })
      await c.conn.close()
      await until(() => fake.closes.includes('sess-1'), 'upstream session/close')
      assert.deepEqual(fake.closes, ['sess-1'])
    } finally {
      await close()
    }
  })

  test('a second prompt on a mid-turn session errors instead of stealing updates', async () => {
    const gate = defer()
    const fake = fakeAcpAgent({ holdPromptUntil: gate.promise })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await c.agent.request('session/new', { cwd: '/w', mcpServers: [] })
      const p = c.agent.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'one' }],
      })
      await until(() => fake.prompts.length === 1, 'first prompt in flight')
      await assert.rejects(
        c.agent.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'two' }],
        }),
        (e: unknown) =>
          e instanceof RequestError && e.code === -32001 && /mid-turn/.test(e.message)
      )
      gate.resolve()
      await p
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('upstream auth_required survives the wrap — session/new and prompt keep -32000', async () => {
    const fake = fakeAcpAgent({
      failNew: 'auth',
      authMethods: [{ id: 'oauth', name: 'OAuth' }],
    })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      // a client that can't tell auth_required from internal-error can
      // never drive the forwarded `authenticate` recovery
      await assert.rejects(
        c.agent.request('session/new', { cwd: '/w', mcpServers: [] }),
        (e: unknown) => e instanceof RequestError && e.code === -32000
      )
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('a failed prompt closes upstream and evicts the brokered session', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'auth' })
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await c.agent.request('session/new', { cwd: '/w', mcpServers: [] })
      await assert.rejects(
        c.agent.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        }),
        (e: unknown) => e instanceof RequestError && e.code === -32000
      )
      // evicted + closed upstream — a retry gets session-not-found,
      // not a stale handle talking to a dead session
      await until(() => fake.closes.includes('sess-1'), 'upstream session/close')
      await assert.rejects(
        c.agent.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'again' }],
        }),
        (e: unknown) => e instanceof RequestError && e.code === -32002
      )
      assert.deepEqual(fake.prompts, ['go'])
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('unregistered methods (session/load) answer method-not-found', async () => {
    const fake = fakeAcpAgent({})
    const { url, close } = await listenAcp(fake)
    const c = openClient(url)
    try {
      await c.agent.request('initialize', INIT_PARAMS)
      await assert.rejects(
        c.agent.request('session/load', { sessionId: 'sess-1', cwd: '/w', mcpServers: [] }),
        (e: unknown) => e instanceof RequestError && e.code === -32601
      )
    } finally {
      await c.conn.close()
      await close()
    }
  })

  test('guard parity — 401 without the session token', async () => {
    const fake = fakeAcpAgent({})
    const { url, close } = await listenAcp(fake)
    try {
      const r = await fetch(`${url}/api/v1/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: INIT_PARAMS,
        }),
      })
      assert.equal(r.status, 401)
      const g = await fetch(`${url}/api/v1/acp`, {
        headers: { accept: 'text/event-stream' },
      })
      assert.equal(g.status, 401)
      // and unwired → 404 like any unknown path (a serve with no
      // acp backend configured)
      const r2 = await fetch(`${url}/api/v1/acp`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: INIT_PARAMS,
        }),
      })
      assert.equal(r2.status, 200) // wired here — the 404 case is below
    } finally {
      await close()
    }
    const bare = await listen(deps({}))
    try {
      const r = await fetch(`${bare.url}/api/v1/acp`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS }),
      })
      assert.equal(r.status, 404)
    } finally {
      await bare.close()
    }
  })
})

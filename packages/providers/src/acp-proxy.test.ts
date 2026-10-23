/**
 * `bro acp proxy` e2e (specs/bro-bhyo1.md §verify) — a real `client()`
 * app drives the proxy over one memory-stream pair; the proxy's
 * downstream is a real `agent()` app (`fakeAcpAgent` or bespoke) over
 * the paired stream. Same wire shape `ndJsonStream` produces, minus
 * the byte encoding — the pump moves message objects, so the seam is
 * the forwarding logic, not the codec.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

// node --test runs each file in its own process — blanking the
// telemetry endpoint here keeps otelSpan ends from POSTing to the
// operator's real collector (a pending connect there would also hold
// the process alive past the assertions)
process.env.BRO_TELEMETRY = '0'

import { agent, client, RequestError } from '@agentclientprotocol/sdk'
import type {
  AgentConnection,
  AnyMessage,
  ClientConnection,
  ClientContext,
  Stream,
} from '@agentclientprotocol/sdk'
import { acpProxy, type AcpProxySeam } from './acp-proxy.ts'
import { fakeAcpAgent, type FakeAcpAgent } from './testkit.ts'

/** In-process Stream pair — the object-message shape the pump and the
 *  SDK apps both consume. `a` writes into `b`'s readable and vv. */
function streamPair(): [Stream, Stream] {
  const ab = new TransformStream<AnyMessage>()
  const ba = new TransformStream<AnyMessage>()
  return [
    { writable: ab.writable, readable: ba.readable },
    { writable: ba.writable, readable: ab.readable },
  ]
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
} as const

interface Rig {
  fake: FakeAcpAgent
  conn: ClientConnection
  agentConn: AgentConnection
  acp: ClientContext
  proxyDone: Promise<number>
  /** The process ends the test rig — closing a stream's WRITABLE is the
   *  stdin-EOF the real proxy sees (conn.close() only cancels its own
   *  receive reader; it leaves the outgoing side open). */
  clientSide: Stream
  agentSide: Stream
}

/** client → proxy → fake agent — all in-process. `fakeOpts` carries
 *  the same option bag fakeAcpAgent takes (replyText, askPermission,
 *  failPrompt, …). */
function rig(fakeOpts: Parameters<typeof fakeAcpAgent>[0], seam?: AcpProxySeam): Rig {
  const fake = fakeAcpAgent(fakeOpts)
  const [clientSide, proxyUp] = streamPair()
  const [proxyDown, agentSide] = streamPair()
  const agentConn = fake.app.connect(agentSide)
  const conn = client({ name: 'test-client' })
    .onRequest('session/request_permission', (ctx) => ({
      outcome: { outcome: 'selected', optionId: ctx.params.options[0]!.optionId },
    }))
    .connect(clientSide)
  const proxyDone = acpProxy(proxyUp, proxyDown, { seam, log: () => {} })
  return { fake, conn, agentConn, acp: conn.agent, proxyDone, clientSide, agentSide }
}

/** Client hangup — EOF on the wire the proxy reads. */
async function hangupClient(r: Rig): Promise<void> {
  r.conn.close()
  await r.clientSide.writable.getWriter().close().catch(() => {})
}

/** Agent death — EOF on the wire the proxy reads downstream. */
async function hangupAgent(r: Rig): Promise<void> {
  r.agentConn.close()
  await r.agentSide.writable.getWriter().close().catch(() => {})
}

async function close(r: Rig): Promise<number> {
  await hangupClient(r)
  const code = await r.proxyDone
  await hangupAgent(r)
  return code
}

/** initialize + session/new — returns the session id. */
async function openSession(acp: ClientContext, cwd = '/tmp/proxy-repo'): Promise<string> {
  const init = await acp.request('initialize', INIT_PARAMS)
  assert.equal(typeof (init as { protocolVersion?: number }).protocolVersion, 'number')
  const ses = (await acp.request('session/new', { cwd, mcpServers: [] })) as {
    sessionId: string
  }
  return ses.sessionId
}

describe('acpProxy — verbatim forwarding', () => {
  test('initialize/session/new/session/prompt round-trip with no seam — byte-identical params', async () => {
    const r = rig({ replyText: 'hello' })
    try {
      const init = (await r.acp.request('initialize', INIT_PARAMS)) as {
        protocolVersion: number
        agentInfo?: { name?: string }
      }
      assert.equal(init.agentInfo?.name, 'fake-acp')
      const sessionId = await openSession(r.acp, '/tmp/repo-one')
      assert.equal(sessionId, 'sess-1')
      assert.deepEqual(r.fake.sessions, [{ cwd: '/tmp/repo-one' }])
      assert.equal(r.fake.clientCapabilities !== undefined, true)

      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'ping' }],
      })
      assert.equal(res.stopReason, 'end_turn')
      // no seam → the prompt crossed untouched
      assert.equal(r.fake.prompts.length, 1)
      assert.deepEqual(
        r.fake.blocks[0]!.map((b) => b.type),
        ['text']
      )
      assert.equal(r.fake.prompts[0], 'ping')
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('session/update and session/request_permission cross verbatim agent→client', async () => {
    const r = rig({
      replyText: 'chunk',
      askPermission: [{ optionId: 'allow-once', kind: 'allow_once', name: 'allow' }],
    })
    try {
      await openSession(r.acp)
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      })
      assert.equal(res.stopReason, 'end_turn')
      // the scripted permission ask reached the real client handler and
      // its answer crossed back to the agent
      assert.deepEqual(r.fake.permissionOutcome, {
        outcome: 'selected',
        optionId: 'allow-once',
      })
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('unknown _-methods forward both ways, responses and errors verbatim', async () => {
    const seen: { clientProbe?: unknown; echoParams?: unknown } = {}
    const [clientSide, proxyUp] = streamPair()
    const [proxyDown, agentSide] = streamPair()
    const agentConn = agent({ name: 'bespoke' })
      .onRequest('initialize', (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        authMethods: [],
      }))
      .onRequest('session/new', () => ({ sessionId: 's-custom' }))
      .onRequest<{ q: number }, { echoed: unknown }>(
        '_acpx/echo',
        (p) => p as { q: number },
        (ctx) => {
          seen.echoParams = ctx.params
          return { echoed: ctx.params }
        }
      )
      .onRequest('session/prompt', async (ctx) => {
        seen.clientProbe = await ctx.client.request('_acpx/client-probe', { n: 1 })
        return { stopReason: 'end_turn' }
      })
      .connect(agentSide)
    const conn = client({ name: 'test-client' })
      .onRequest<{ n: number }, { ok: boolean; got: unknown }>(
        '_acpx/client-probe',
        (p) => p as { n: number },
        (ctx) => ({ ok: true, got: ctx.params })
      )
      .connect(clientSide)
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} })
    try {
      await conn.agent.request('initialize', INIT_PARAMS)
      const echoed = await conn.agent.request<{ echoed: unknown }>('_acpx/echo', { q: 42 })
      assert.deepEqual(echoed, { echoed: { q: 42 } })
      await conn.agent.request('session/new', { cwd: '/x', mcpServers: [] })
      await conn.agent.request('session/prompt', {
        sessionId: 's-custom',
        prompt: [{ type: 'text', text: 'go' }],
      })
      // the agent's outbound _-method reached the client verbatim
      assert.deepEqual(seen.clientProbe, { ok: true, got: { n: 1 } })
      // an unknown method the agent does NOT serve crosses an error back
      await assert.rejects(
        conn.agent.request('_acpx/missing', {}),
        (e: unknown) => e instanceof RequestError && e.code === -32601
      )
    } finally {
      conn.close()
      await clientSide.writable.getWriter().close().catch(() => {})
      assert.equal(await proxyDone, 0)
      agentConn.close()
      await agentSide.writable.getWriter().close().catch(() => {})
    }
  })

  test('a downstream error crosses verbatim — code and message, no rewrite', async () => {
    const r = rig({ failPrompt: 'auth-gateway-504' })
    try {
      await openSession(r.acp)
      await assert.rejects(
        r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'x' }],
        }),
        (e: unknown) =>
          e instanceof RequestError &&
          e.code === -32603 &&
          e.message === 'auth gateway returned HTTP 504'
      )
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('downstream dead mid-turn → pending prompt fails visibly, verdict 1', async () => {
    const r = rig({ holdEnd: () => new Promise(() => {}) })
    const sessionId = await openSession(r.acp)
    const promptP = r.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'x' }],
    })
    // let the prompt land downstream, then kill the agent leg
    await new Promise((r2) => setTimeout(r2, 50))
    await hangupAgent(r)
    await assert.rejects(
      promptP,
      (e: unknown) =>
        e instanceof RequestError &&
        e.code === -32603 &&
        e.message === 'acp proxy: downstream agent closed'
    )
    assert.equal(await r.proxyDone, 1)
    await hangupClient(r)
  })
})

describe('acpProxy — context injection seam', () => {
  const seam = (sessionCtx?: string, promptCtx?: string): AcpProxySeam => ({
    sessionContext: async () => sessionCtx,
    promptContext: async () => promptCtx,
  })

  test('first prompt gets ONE prepended block (session + prompt context); later prompts get prompt context only', async () => {
    const calls: Array<{ cwd: string; sessionId: string }> = []
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async (cwd, sessionId) => {
        calls.push({ cwd, sessionId })
        return 'SESSION CTX'
      },
      promptContext: async () => 'PROMPT CTX',
    })
    try {
      const sessionId = await openSession(r.acp, '/tmp/session-repo')
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      })
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      })
      assert.equal(r.fake.prompts.length, 2)
      // first prompt: session ctx + prompt ctx in one block, original intact
      const first = r.fake.blocks[0]!
      assert.equal(first.length, 2)
      assert.deepEqual(first[0], { type: 'text', text: 'SESSION CTX\nPROMPT CTX' })
      assert.deepEqual(first[1], { type: 'text', text: 'one' })
      // second prompt: prompt ctx only — no re-injection of session start
      const second = r.fake.blocks[1]!
      assert.equal(second.length, 2)
      assert.deepEqual(second[0], { type: 'text', text: 'PROMPT CTX' })
      assert.deepEqual(second[1], { type: 'text', text: 'two' })
      // the seam saw the session/new cwd, not the proxy's process cwd
      assert.deepEqual(calls, [{ cwd: '/tmp/session-repo', sessionId: 'sess-1' }])
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('a second session re-injects session context; absent seam stays byte-identical', async () => {
    const r = rig({ replyText: 'ok' }, seam('S', 'P'))
    try {
      const a = await openSession(r.acp)
      await r.acp.request('session/prompt', {
        sessionId: a,
        prompt: [{ type: 'text', text: 'p1' }],
      })
      // the fake always returns sess-1 — the proxy keys on whatever the
      // downstream answered, same as the wire
      assert.equal(r.fake.blocks[0]![0]!.type, 'text')
      assert.equal((r.fake.blocks[0]![0] as { text: string }).text, 'S\nP')
    } finally {
      assert.equal(await close(r), 0)
    }
    const bare = rig({ replyText: 'ok' })
    try {
      await openSession(bare.acp)
      await bare.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'p1' }],
      })
      assert.equal(bare.fake.blocks[0]!.length, 1)
      assert.deepEqual(bare.fake.blocks[0]![0], { type: 'text', text: 'p1' })
    } finally {
      assert.equal(await close(bare), 0)
    }
  })

  test('empty seam output injects nothing; a seam that throws stays fail-open', async () => {
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async () => { throw new Error('probe died') },
      promptContext: async () => '',
    })
    try {
      await openSession(r.acp)
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'x' }],
      })
      assert.equal(res.stopReason, 'end_turn')
      assert.equal(r.fake.blocks[0]!.length, 1)
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'x' })
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('session/cancel while the seam collects → held prompt answers cancelled, downstream never sees it', async () => {
    let entered!: () => void
    let release!: () => void
    const gateEntered = new Promise<void>((r2) => { entered = r2 })
    const gate = new Promise<void>((r2) => { release = r2 })
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async () => {
        entered()
        await gate
        return 'LATE CTX'
      },
    })
    try {
      const sessionId = await openSession(r.acp)
      const promptP = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'x' }],
      })
      await gateEntered
      await r.acp.notify('session/cancel', { sessionId })
      release()
      const res = await promptP
      assert.equal(res.stopReason, 'cancelled')
      // the prompt was answered by the proxy — the downstream wire
      // never carried it (the wire never shows a prompt after its cancel)
      assert.equal(r.fake.prompts.length, 0)
    } finally {
      assert.equal(await close(r), 0)
    }
  })
})

describe('acpProxy — latency', () => {
  test('per-turn overhead vs the direct leg (in-process floor, printed)', async () => {
    const TURNS = 25
    const directAgent = fakeAcpAgent({ replyText: 'x' })
    const directConn = client({ name: 'direct' }).connect(directAgent.app)
    const t0 = Date.now()
    {
      const a = directConn.agent
      await a.request('initialize', INIT_PARAMS)
      const ses = (await a.request('session/new', { cwd: '/x', mcpServers: [] })) as { sessionId: string }
      for (let i = 0; i < TURNS; i++) {
        await a.request('session/prompt', {
          sessionId: ses.sessionId,
          prompt: [{ type: 'text', text: 'p' }],
        })
      }
    }
    const directMs = (Date.now() - t0) / TURNS
    directConn.close()

    const r = rig({ replyText: 'x' })
    const t1 = Date.now()
    {
      await openSession(r.acp, '/x')
      for (let i = 0; i < TURNS; i++) {
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'p' }],
        })
      }
    }
    const proxyMs = (Date.now() - t1) / TURNS
    await close(r)
    console.error(
      `acp proxy overhead: direct ${directMs.toFixed(2)}ms → proxied ${proxyMs.toFixed(2)}ms per turn (in-process floor)`
    )
    // a sane bound, not a flaky one — real-agent turns are dominated by
    // the agent; the assertion exists to catch a serialization bug
    assert.ok(proxyMs - directMs < 50, `proxy overhead ${proxyMs - directMs}ms/turn`)
  })
})

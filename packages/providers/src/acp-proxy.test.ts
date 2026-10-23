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
  JsonRpcId,
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
  /** session/update notifications the client leg received — verbatim
   *  forwarding assertions read this, not just the agent's emit. */
  updates: unknown[]
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
  const updates: unknown[] = []
  const [clientSide, proxyUp] = streamPair()
  const [proxyDown, agentSide] = streamPair()
  const agentConn = fake.app.connect(agentSide)
  const conn = client({ name: 'test-client' })
    .onRequest('session/request_permission', (ctx) => ({
      outcome: { outcome: 'selected', optionId: ctx.params.options[0]!.optionId },
    }))
    .onNotification('session/update', (ctx) => {
      updates.push(ctx.params)
    })
    .connect(clientSide)
  const proxyDone = acpProxy(proxyUp, proxyDown, { seam, log: () => {} })
  return { fake, conn, agentConn, acp: conn.agent, proxyDone, updates, clientSide, agentSide }
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
      // the agent's session/update chunk crossed verbatim — captured
      // client-side, not just emitted downstream
      assert.deepEqual(r.updates, [
        {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk' },
          },
        },
      ])
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
    sessionContext: async () => ({ text: sessionCtx, settled: true }),
    promptContext: async () => promptCtx,
  })

  test('first prompt gets ONE prepended block (session + prompt context); later prompts get prompt context only', async () => {
    const calls: Array<{ cwd: string; sessionId: string }> = []
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async (cwd, sessionId) => {
        calls.push({ cwd, sessionId })
        return { text: 'SESSION CTX', settled: true }
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

  test('each session injects session context on ITS first prompt — state is per session, not global', async () => {
    const sessionCalls: string[] = []
    const r = rig({ replyText: 'ok', uniqueSessions: true }, {
      sessionContext: async (_cwd, sessionId) => {
        sessionCalls.push(sessionId)
        return { text: `S(${sessionId})`, settled: true }
      },
      promptContext: async () => 'P',
    })
    try {
      const a = await openSession(r.acp)
      const b = await openSession(r.acp)
      assert.notEqual(a, b)
      await r.acp.request('session/prompt', {
        sessionId: a,
        prompt: [{ type: 'text', text: 'p1' }],
      })
      await r.acp.request('session/prompt', {
        sessionId: b,
        prompt: [{ type: 'text', text: 'p2' }],
      })
      // both sessions' first prompts got their own session block —
      // a session-keyed flag, not a global "already injected" one
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: `S(${a})\nP` })
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: `S(${b})\nP` })
      assert.deepEqual(sessionCalls, [a, b])
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('absent seam stays byte-identical', async () => {
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

  test('an unsettled session collection injects nothing and retries on the next prompt', async () => {
    let calls = 0
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async () => {
        calls++
        // first attempt times out partial — unsettled; the retry settles
        return calls === 1
          ? { text: 'PARTIAL', settled: false }
          : { text: 'SETTLED', settled: true }
      },
      promptContext: async () => 'P',
    })
    try {
      const sessionId = await openSession(r.acp)
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      })
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      })
      // prompt 1: unsettled → partial text rides (the hook emits
      // partial output the same way) but the slot stays open
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'PARTIAL\nP' })
      // prompt 2: the retry settled → full session ctx lands and the
      // slot closes
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: 'SETTLED\nP' })
      assert.equal(calls, 2)
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('a cancelled held first prompt yields the slot — the retry gets session context', async () => {
    let release!: () => void
    const gate = new Promise<void>((r2) => { release = r2 })
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async () => {
        await gate
        return { text: 'S', settled: true }
      },
      promptContext: async () => 'P',
    })
    try {
      const sessionId = await openSession(r.acp)
      const a = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'a' }],
      })
      // cancel while A's seam collection is held → answered upstream,
      // never crosses, and does NOT burn the session's first-prompt slot
      await new Promise((r2) => setTimeout(r2, 50))
      await r.acp.notify('session/cancel', { sessionId })
      release()
      assert.equal((await a).stopReason, 'cancelled')
      assert.equal(r.fake.prompts.length, 0)
      // the next prompt IS the first to cross — session ctx must ride it
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'b' }],
      })
      assert.equal(res.stopReason, 'end_turn')
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'S\nP' })
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('session/fork registers the fork by its RESPONSE id — prompts on it get the seam', async () => {
    const r = rig({ replyText: 'ok' }, seam('S', 'P'))
    try {
      const a = await openSession(r.acp)
      const fork = (await r.acp.request('session/fork', {
        sessionId: a,
        cwd: '/tmp/proxy-repo',
        mcpServers: [],
      })) as { sessionId: string }
      assert.equal(fork.sessionId, 'sess-fork-1')
      assert.deepEqual(r.fake.forks, [a])
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: fork.sessionId,
        prompt: [{ type: 'text', text: 'x' }],
      })
      assert.equal(res.stopReason, 'end_turn')
      // stamped by the response id → the fork is a real session with
      // its own first-prompt slot, not a bypass around the seam
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'S\nP' })
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('session/close releases the session — a later prompt on the id skips the seam', async () => {
    const promptCalls: string[] = []
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async () => ({ text: 'S', settled: true }),
      promptContext: async (cwd, sessionId) => {
        promptCalls.push(sessionId)
        return 'P'
      },
    })
    try {
      const sessionId = await openSession(r.acp)
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      })
      assert.deepEqual(promptCalls, [sessionId])
      await r.acp.request('session/close', { sessionId })
      assert.deepEqual(r.fake.closes, [sessionId])
      // after close the session entry is gone — this prompt takes the
      // un-stamped path: verbatim forward, no seam calls, no injection
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      })
      assert.deepEqual(promptCalls, [sessionId])
      assert.equal(r.fake.blocks[1]!.length, 1)
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: 'two' })
    } finally {
      assert.equal(await close(r), 0)
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
        return { text: 'LATE CTX', settled: true }
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
      // and the cancel itself never crossed either — its whole target
      // set was held prompts the proxy already answered
      assert.deepEqual(r.fake.cancels, [])
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('cancel crosses while crossed work still runs — held sibling aborted, in-flight prompt keeps its own answer', async () => {
    let releaseTurn!: () => void
    let releaseSeam!: () => void
    let seamEntered!: () => void
    const turnGate = new Promise<void>((r2) => { releaseTurn = r2 })
    const seamGate = new Promise<void>((r2) => { releaseSeam = r2 })
    const entered = new Promise<void>((r2) => { seamEntered = r2 })
    const r = rig({ replyText: 'ok', holdEnd: () => turnGate }, {
      sessionContext: async () => ({ text: 'S', settled: true }),
      promptContext: async (_c, _s, text) => {
        if (text === 'b-text') {
          seamEntered()
          await seamGate
        }
        return 'P'
      },
    })
    try {
      const sessionId = await openSession(r.acp)
      // A crosses (fast seam) and runs — the fake's holdEnd keeps its
      // turn open downstream
      const a = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'a-text' }],
      })
      await new Promise((r2) => setTimeout(r2, 50))
      assert.equal(r.fake.prompts.length, 1)
      // B queues behind its gated prompt-submit collection — held
      const b = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'b-text' }],
      })
      await entered
      await r.acp.notify('session/cancel', { sessionId })
      releaseSeam()
      releaseTurn()
      // B was held → the proxy answered it; A was crossed → the
      // agent's own answer still lands (no duplicate/forked response)
      assert.equal((await b).stopReason, 'cancelled')
      assert.equal((await a).stopReason, 'end_turn')
      // the cancel's downstream write settles a few microtasks behind
      // A's upstream answer — give the wire a tick, then assert: the
      // cancel crossed exactly once, A was its real target
      await new Promise((r2) => setTimeout(r2, 30))
      assert.deepEqual(r.fake.cancels, ['sess-1'])
      assert.equal(r.fake.prompts.length, 1)
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('two prompts held behind one collection are both aborted — the second never crosses after its upstream answer', async () => {
    let release!: () => void
    const gate = new Promise<void>((r2) => { release = r2 })
    const r = rig({ replyText: 'ok' }, {
      sessionContext: async () => { await gate; return { text: 'S', settled: true } },
      promptContext: async () => 'P',
    })
    try {
      const sessionId = await openSession(r.acp)
      const a = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'a' }],
      })
      // B arrives while A is still held — it is held too, not just
      // tracked by a single-slot injecting flag
      const b = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'b' }],
      })
      await new Promise((r2) => setTimeout(r2, 50))
      await r.acp.notify('session/cancel', { sessionId })
      release()
      assert.equal((await a).stopReason, 'cancelled')
      assert.equal((await b).stopReason, 'cancelled')
      assert.equal(r.fake.prompts.length, 0)
      assert.deepEqual(r.fake.cancels, [])
    } finally {
      assert.equal(await close(r), 0)
    }
  })

  test('a session without a cwd skips the seam — byte-identical forwarding, no proxy-cwd fallback', async () => {
    const calls: string[] = []
    const seen: { prompts?: unknown } = {}
    const [clientSide, proxyUp] = streamPair()
    const [proxyDown, agentSide] = streamPair()
    // bespoke downstream as a RAW responder — a typed agent() app
    // schema-validates inbound and rejects a cwd-less session before
    // the wire question is even asked
    const agentReader = agentSide.readable.getReader()
    const agentWriter = agentSide.writable.getWriter()
    const responder = (async () => {
      for (;;) {
        const { value, done } = await agentReader.read()
        if (done) return
        const m = value as { id?: JsonRpcId; method?: string; params?: { prompt?: unknown } }
        if (m.method === 'initialize') {
          await agentWriter.write({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } } as AnyMessage)
        } else if (m.method === 'session/new') {
          // malformed but plausible — no cwd field
          await agentWriter.write({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's-nc' } } as AnyMessage)
        } else if (m.method === 'session/prompt') {
          seen.prompts = m.params?.prompt
          await agentWriter.write({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } } as AnyMessage)
        }
      }
    })()
    const conn = client({ name: 'test-client' }).connect(clientSide)
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      seam: {
        sessionContext: async (cwd) => { calls.push(cwd); return { text: 'S', settled: true } },
        promptContext: async (cwd) => { calls.push(cwd); return 'P' },
      },
      log: () => {},
    })
    try {
      await conn.agent.request('initialize', INIT_PARAMS)
      const ses = (await conn.agent.request('session/new', { mcpServers: [] } as never)) as {
        sessionId: string
      }
      assert.equal(ses.sessionId, 's-nc')
      const res = await conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 's-nc',
        prompt: [{ type: 'text', text: 'x' }],
      })
      assert.equal(res.stopReason, 'end_turn')
      assert.deepEqual(seen.prompts, [{ type: 'text', text: 'x' }])
      // the seam never ran — cwd-less session, not the proxy's cwd
      assert.deepEqual(calls, [])
    } finally {
      conn.close()
      await clientSide.writable.getWriter().close().catch(() => {})
      assert.equal(await proxyDone, 0)
      agentWriter.close().catch(() => {})
      await responder
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

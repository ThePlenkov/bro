/** `bro serve` conductor — /v1/messages answers from an acp provider
 *  session instead of an HTTP upstream (spec bro-xeozo). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { fakeAcpAgent } from '@broject/providers'
import { conductorConfig, conductorProxy, parseReply } from './serve-conductor.ts'
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts'

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'swe-x',
  options: [
    { value: 'swe-x', name: 'SWE X' },
    { value: 'swe-y', name: 'SWE Y' },
  ],
}

const auth = authHeaders

const CFG = {
  backend: 'dv-acp',
  entry: { type: 'acp' as const, command: 'dv acp' },
  cwd: '/repo',
  timeoutMs: 10_000,
}

describe('conductorConfig', () => {
  const providers = {
    'dv-acp': { type: 'acp' as const, command: 'dv acp', model: 'swe-y' },
    cli1: { type: 'cli' as const, command: 'x run' },
  }
  test('unset env → undefined; resolves backend+model pin', () => {
    assert.equal(conductorConfig({}, '/r', providers), undefined)
    assert.equal(conductorConfig({ BRO_PROVIDER_BACKEND: ' ' }, '/r', providers), undefined)
    const cfg = conductorConfig({ BRO_PROVIDER_BACKEND: 'dv-acp' }, '/r', providers)
    assert.equal(cfg?.backend, 'dv-acp')
    assert.equal(cfg?.model, 'swe-y')
    assert.equal(
      conductorConfig(
        { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_MODEL: 'swe-z' },
        '/r',
        providers
      )?.model,
      'swe-z'
    )
  })
  test('a negative/zero timeout falls back to the default', () => {
    for (const raw of ['-5', '0', 'abc']) {
      const cfg = conductorConfig(
        { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_TIMEOUT_MS: raw },
        '/r',
        providers
      )
      assert.equal(cfg?.timeoutMs, 120_000, raw)
    }
  })
  test('unknown backend and non-acp kind are loud errors', () => {
    assert.throws(
      () => conductorConfig({ BRO_PROVIDER_BACKEND: 'nope' }, '/r', providers),
      /providers\.nope is not configured/
    )
    assert.throws(
      () => conductorConfig({ BRO_PROVIDER_BACKEND: 'cli1' }, '/r', providers),
      /type 'cli' — the conductor needs an 'acp' entry/
    )
  })
  test('BRO_PROVIDER_CATALOG resolves a second entry for /v1/models', () => {
    const cfg = conductorConfig(
      { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_CATALOG: 'cli1' },
      '/r',
      providers
    )
    assert.equal(cfg?.catalog?.name, 'cli1')
    assert.equal(conductorConfig({ BRO_PROVIDER_BACKEND: 'dv-acp' }, '/r', providers)?.catalog, undefined)
    assert.throws(
      () =>
        conductorConfig(
          { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_CATALOG: 'nope' },
          '/r',
          providers
        ),
      /providers\.nope is not configured/
    )
  })
})

describe('parseReply', () => {
  test('text segments + tool_use blocks keep reply order', () => {
    const blocks = parseReply(
      'hello <tool_call>{"name":"ls","input":{"dir":"/"}}</tool_call> done'
    )
    assert.equal(blocks.length, 3)
    assert.equal(blocks[0]?.type, 'text')
    assert.equal(blocks[1]?.type, 'tool_use')
    assert.equal(blocks[1]?.name, 'ls')
    assert.match(blocks[1]?.id ?? '', /^toolu_[0-9a-f]{16}$/)
    assert.equal(blocks[2]?.type, 'text')
  })
  test('a scalar tool input lands wrapped — anthropic needs an object', () => {
    const blocks = parseReply('<tool_call>{"name":"ls","input":"/tmp"}</tool_call>')
    assert.deepEqual(blocks[0]?.input, { value: '/tmp' })
  })
  test('unparseable tool_call stays raw text — no invented calls', () => {
    const blocks = parseReply('x <tool_call>{nope</tool_call> y')
    assert.equal(blocks.length, 1)
    assert.match(blocks[0]?.text ?? '', /<tool_call>\{nope/)
  })
})

async function sseEvents(r: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const raw = await r.text()
  return raw
    .split('\n\n')
    .filter((b) => b.trim() !== '')
    .map((b) => {
      const event = b.match(/^event: (.+)$/m)?.[1] ?? ''
      const data = JSON.parse(b.match(/^data: (.+)$/m)?.[1] ?? '{}')
      return { event, data }
    })
}

describe('serve /v1/* — the conductor plane', () => {
  test('POST /v1/messages streams the anthropic SSE shape from an acp turn', async () => {
    const fake = fakeAcpAgent({ replyText: 'hi there', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'say hi' }],
          stream: true,
        }),
      })
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-type'), 'text/event-stream')
      const ev = await sseEvents(r)
      const kinds = ev.map((e) => e.event)
      assert.deepEqual(kinds.slice(0, 2), ['message_start', 'content_block_start'])
      assert.equal(kinds.at(-1), 'message_stop')
      const delta = ev.find((e) => e.event === 'content_block_delta')
      assert.deepEqual(delta?.data.delta, { type: 'text_delta', text: 'hi there' })
      const start = ev.find((e) => e.event === 'message_start')
      assert.equal((start?.data.message as { model: string }).model, 'swe-x')
      const md = ev.find((e) => e.event === 'message_delta')
      assert.equal((md?.data.delta as { stop_reason: string }).stop_reason, 'end_turn')
      // the conversation reached the agent serialized, not the client's model id
      assert.match(fake.prompts[0] ?? '', /say hi/)
      assert.match(fake.prompts[0] ?? '', /<turn role="user">/)
    } finally {
      await close()
    }
  })

  test('a <tool_call> reply lands as tool_use + stop_reason tool_use', async () => {
    const fake = fakeAcpAgent({
      replyText: 'checking <tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>',
      configOptions: [MODEL_OPTION],
    })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'list' }], stream: true }),
      })
      const ev = await sseEvents(r)
      const tu = ev.find(
        (e) => e.event === 'content_block_delta' && (e.data.delta as { type: string }).type === 'input_json_delta'
      )
      assert.ok(tu, 'tool_use delta present')
      assert.deepEqual(JSON.parse((tu.data.delta as { partial_json: string }).partial_json), {
        d: '/tmp',
      })
      const md = ev.find((e) => e.event === 'message_delta')
      assert.equal((md?.data.delta as { stop_reason: string }).stop_reason, 'tool_use')
    } finally {
      await close()
    }
  })

  test('a provider/model request id pins the acp session model', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'dv-acp/swe-y',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        }),
      })
      assert.equal(r.status, 200)
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }])
      assert.equal((await r.json()).model, 'swe-y')
    } finally {
      await close()
    }
  })

  test('stream:false answers a buffered anthropic message', async () => {
    const fake = fakeAcpAgent({ replyText: 'plain', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        }),
      })
      assert.equal(r.headers.get('content-type'), 'application/json')
      const body = await r.json()
      assert.equal(body.type, 'message')
      assert.equal(body.model, 'swe-x')
      assert.equal(body.stop_reason, 'end_turn')
      assert.deepEqual(body.content, [{ type: 'text', text: 'plain' }])
    } finally {
      await close()
    }
  })

  test('GET /v1/models enumerates the backend catalog; count_tokens estimates', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/models`, { headers: auth })
      const body = await r.json()
      assert.deepEqual(
        body.data.map((m: { id: string }) => m.id),
        ['dv-acp/swe-x', 'dv-acp/swe-y']
      )
      // acp catalog names surface as display_name — pickers show the
      // human label, clients pin the id
      assert.deepEqual(
        body.data.map((m: { display_name: string }) => m.display_name),
        ['SWE X', 'SWE Y']
      )
      const c = await fetch(`${url}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: 'x'.repeat(400),
      })
      assert.equal((await c.json()).input_tokens, 100)
    } finally {
      await close()
    }
  })

  test('a tool-less backend serves its configured pin as label and catalog row', async () => {
    const fake = fakeAcpAgent({ replyText: 'sum' })
    const cfg = { ...CFG, entry: { ...CFG.entry, model: 'swe-sum' } }
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      })
      assert.equal(r.status, 200)
      assert.equal((await r.json()).model, 'swe-sum')
      assert.deepEqual(fake.configSets, [])
      // the pin is a one-row catalog — a tool-less backend still names itself
      const m = await fetch(`${url}/v1/models`, { headers: auth })
      assert.deepEqual(
        (await m.json()).data.map((x: { id: string }) => x.id),
        ['dv-acp/swe-sum']
      )
    } finally {
      await close()
    }
  })

  test('an unpinned tool-less backend answers "unknown" and an empty catalog', async () => {
    const fake = fakeAcpAgent({ replyText: 'sum' })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      })
      assert.equal(r.status, 200)
      assert.equal((await r.json()).model, 'unknown')
      const m = await fetch(`${url}/v1/models`, { headers: auth })
      assert.deepEqual((await m.json()).data, [])
    } finally {
      await close()
    }
  })

  test('BRO_PROVIDER_CATALOG models come from the catalog entry, not the backend', async () => {
    const fake = fakeAcpAgent({ replyText: 'sum' })
    const cfg = {
      ...CFG,
      catalog: {
        name: 'orcarouter',
        entry: {
          type: 'api' as const,
          baseUrl: 'https://x',
          models: { 'typesafe/jev-1.13': 'systemone' as const },
        },
      },
    }
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/models`, { headers: auth })
      assert.deepEqual(
        (await r.json()).data.map((m: { id: string }) => m.id),
        ['orcarouter/typesafe/jev-1.13']
      )
      // the backend itself still answers messages
      const msg = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      })
      assert.equal(msg.status, 200)
    } finally {
      await close()
    }
  })

  test('backend errors map to anthropic-shaped errors, never a hang', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'generic' })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
      })
      assert.equal(r.status, 529)
      const body = await r.json()
      assert.equal(body.type, 'error')
      assert.match(body.error.message, /conductor/)
    } finally {
      await close()
    }
  })
})

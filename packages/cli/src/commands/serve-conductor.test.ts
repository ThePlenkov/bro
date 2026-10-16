/** `bro serve` conductor — /v1/messages answers from an acp provider
 *  session instead of an HTTP upstream (spec bro-xeozo). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { fakeAcpAgent } from '@broject/providers/testkit'
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

  // bro-7izjx — base64 image blocks ride the wire as real ACP image
  // content when the agent advertised promptCapabilities.image;
  // without the capability they degrade to the `[image]` marker.
  const IMAGE_BODY = {
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
          },
        ],
      },
    ],
    stream: true,
  }

  test('an image-capable agent receives the image block on the wire', async () => {
    const fake = fakeAcpAgent({
      replyText: 'a png',
      configOptions: [MODEL_OPTION],
      imageCapable: true,
    })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(IMAGE_BODY),
      })
      assert.equal(r.status, 200)
      await r.text()
      const img = fake.blocks[0]?.find((b) => b.type === 'image')
      assert.deepEqual(img, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' })
      // the turn wrapper still frames the text around the image
      assert.match(fake.prompts[0] ?? '', /<turn role="user">what is this/)
    } finally {
      await close()
    }
  })

  test('an agent without the image capability gets the [image] marker instead', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(IMAGE_BODY),
      })
      assert.equal(r.status, 200)
      await r.text()
      assert.equal(fake.blocks[0]?.every((b) => b.type === 'text'), true)
      assert.match(fake.prompts[0] ?? '', /\[image\]/)
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

  test('a composite <base>-<level> id applies model + thought_level together', async () => {
    // devin's swe-2 family: -medium/-high/-max are the thinking dimension,
    // not catalog ids — 'swe-2-max' = model swe-2-high + thought_level max
    const DEVIN_OPTIONS: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'swe-2-high',
        options: [
          { value: 'swe-2-high', name: 'SWE-2 High' },
          { value: 'swe-1-7-lightning-medium', name: 'Lightning' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'medium', name: 'medium' },
          { value: 'high', name: 'high' },
          { value: 'max', name: 'max' },
        ],
      },
    ]
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: DEVIN_OPTIONS })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'dv-acp/swe-2-max',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        }),
      })
      assert.equal(r.status, 200)
      assert.deepEqual(fake.configSets, [
        { configId: 'model', value: 'swe-2-high' },
        { configId: 'thought_level', value: 'max' },
      ])
      assert.equal((await r.json()).model, 'swe-2-max')
    } finally {
      await close()
    }
  })

  test('a spawn-pinned composite already live skips the set calls', async () => {
    const LIVE: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'swe-2-high',
        options: [{ value: 'swe-2-high', name: 'SWE-2 High' }],
      },
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'max',
        options: [
          { value: 'medium', name: 'm' },
          { value: 'max', name: 'x' },
        ],
      },
    ]
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: LIVE })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'dv-acp/swe-2-max',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        }),
      })
      assert.equal(r.status, 200)
      assert.deepEqual(fake.configSets, [])
      assert.equal((await r.json()).model, 'swe-2-max')
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

// bro-whn25 — the messages API is stateless but a claude client resends
// full history anyway, so the conductor retains one acp session per
// conversation and feeds it only the delta. Identity is the history
// fingerprint; a pinned x-bro-session namespaces explicitly.
describe('serve /v1/* — retained acp sessions', () => {
  const post = (
    url: string,
    messages: unknown[],
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ messages, stream: false }),
    })

  test('a continued conversation reuses one session and sends only the delta', async () => {
    const fake = fakeAcpAgent({ replyText: 'r1', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const t1 = await post(url, [{ role: 'user', content: 'first' }])
      assert.equal(t1.status, 200)
      // the client resends full history — own echo included
      const t2 = await post(url, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'second' },
      ])
      assert.equal(t2.status, 200)
      const t3 = await post(url, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'third' },
      ])
      assert.equal(t3.status, 200)
      // one session/new carried all three turns
      assert.equal(fake.sessions.length, 1)
      assert.equal(fake.prompts.length, 3)
      // turn 2 saw only its delta — the prior turns are session context
      assert.match(fake.prompts[1] ?? '', /second/)
      assert.doesNotMatch(fake.prompts[1] ?? '', /first/)
      assert.match(fake.prompts[2] ?? '', /third/)
      assert.doesNotMatch(fake.prompts[2] ?? '', /first|second/)
      // the internal f: fingerprint is NEVER echoed — a client must not
      // pin back into the fingerprint namespace
      assert.equal(t1.headers.get('x-bro-session'), null)
    } finally {
      await close()
    }
  })

  test('an identical resend replays the reply without a new turn', async () => {
    const fake = fakeAcpAgent({ replyText: 'same answer', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const msgs = [{ role: 'user', content: 'ping' }]
      assert.equal((await post(url, msgs)).status, 200)
      const retry = await post(url, msgs)
      assert.equal(retry.status, 200)
      assert.equal((await retry.json()).content[0].text, 'same answer')
      // a retry never reaches the agent — one prompt total
      assert.equal(fake.prompts.length, 1)
      assert.equal(fake.sessions.length, 1)
    } finally {
      await close()
    }
  })

  test('x-bro-session keys explicitly; different pins get different sessions', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const msgs = [{ role: 'user', content: 'same first turn' }]
      const ra = await post(url, msgs, { 'x-bro-session': 'a' })
      assert.equal(ra.status, 200)
      // a client pin is echoed back for the client to confirm
      assert.equal(ra.headers.get('x-bro-session'), 'h:a')
      assert.equal((await post(url, msgs, { 'x-bro-session': 'b' })).status, 200)
      // identical bodies, different pins — two sessions, no replay
      assert.equal(fake.sessions.length, 2)
      assert.equal(fake.prompts.length, 2)
      // pin a keeps its session across a real continuation
      assert.equal(
        (
          await post(
            url,
            [
              { role: 'user', content: 'same first turn' },
              { role: 'assistant', content: 'x' },
              { role: 'user', content: 'more' },
            ],
            { 'x-bro-session': 'a' }
          )
        ).status,
        200
      )
      assert.equal(fake.sessions.length, 2)
      assert.match(fake.prompts[2] ?? '', /more/)
    } finally {
      await close()
    }
  })

  test('an edited prefix under a pinned key evicts and restarts', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      assert.equal(
        (await post(url, [{ role: 'user', content: 'orig' }], { 'x-bro-session': 's' })).status,
        200
      )
      // the client rewrote history — the stored prefix proof fails
      const r = await post(
        url,
        [
          { role: 'user', content: 'EDITED' },
          { role: 'assistant', content: 'x' },
          { role: 'user', content: 'next' },
        ],
        { 'x-bro-session': 's' }
      )
      assert.equal(r.status, 200)
      // a fresh session got the FULL body, not a delta
      assert.equal(fake.sessions.length, 2)
      assert.match(fake.prompts[1] ?? '', /EDITED/)
      assert.match(fake.prompts[1] ?? '', /next/)
    } finally {
      await close()
    }
  })

  test('a differing model mid-conversation re-pins the live session', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const headers = { 'x-bro-session': 'pin' }
      assert.equal((await post(url, [{ role: 'user', content: 'a' }], headers)).status, 200)
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          model: 'dv-acp/swe-y',
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'x' },
            { role: 'user', content: 'b' },
          ],
          stream: false,
        }),
      })
      assert.equal(r.status, 200)
      // same session, the new pin applied on it
      assert.equal(fake.sessions.length, 1)
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }])
    } finally {
      await close()
    }
  })

  test('a failed turn evicts — the retry opens a fresh session', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', failPrompt: 'generic' })
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const headers = { 'x-bro-session': 's' }
      assert.equal(
        (await post(url, [{ role: 'user', content: 'a' }], headers)).status,
        529
      )
      assert.equal((await post(url, [{ role: 'user', content: 'a' }], headers)).status, 529)
      // each attempt opened (and lost) its own session — a poisoned
      // session is never implicitly retried
      assert.equal(fake.sessions.length, 2)
    } finally {
      await close()
    }
  })
})

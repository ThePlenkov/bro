/** `bro serve` conductor — /v1/messages answers from an acp provider
 *  session instead of an HTTP upstream (spec bro-xeozo). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import { fakeAcpAgent } from '@broject/providers/testkit'
import { conductorConfig, conductorProxy, parseReply } from './serve-conductor.ts'
import type { ConductorConfig } from './serve-conductor.ts'
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

/** Each entry becomes its own agent_message_chunk — splits inside a
 *  <tool_call> tag exercise the conductor's incremental parser. */
const chunks = (...texts: string[]): SessionUpdate[] =>
  texts.map((text) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text' as const, text },
  }))

/** Boot the conductor over `fake` — caller owns close() and gets a
 *  bound post() for repeated /v1/messages sends. */
async function boot(
  fake: ReturnType<typeof fakeAcpAgent>,
  cfg: ConductorConfig = CFG
): Promise<{
  url: string
  post: (body: unknown) => Promise<Response>
  close: () => Promise<void>
}> {
  const { url, close } = await listen(
    deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
  )
  const post = (body: unknown) =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { url, post, close }
}

/** Boot the conductor over `fake` and POST /v1/messages —
 *  caller owns close() and reads `r`. */
async function postMessages(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { messages: [{ role: 'user', content: 'x' }], stream: false },
  cfg: ConductorConfig = CFG
): Promise<{ r: Response; url: string; close: () => Promise<void> }> {
  const { url, post, close } = await boot(fake, cfg)
  return { r: await post(body), url, close }
}

/** Collected text_delta payloads from a parsed SSE stream. */
function textDeltas(ev: Awaited<ReturnType<typeof sseEvents>>): string[] {
  return ev
    .filter(
      (e) =>
        e.event === 'content_block_delta' &&
        (e.data.delta as { type: string }).type === 'text_delta'
    )
    .map((e) => (e.data.delta as { text: string }).text)
}

/** The turn's terminal stop_reason off the message_delta event. */
function stopReason(ev: Awaited<ReturnType<typeof sseEvents>>): string {
  const md = ev.find((e) => e.event === 'message_delta')
  return (md?.data.delta as { stop_reason: string }).stop_reason
}

/** Boot the conductor over `fake` and POST a streamed /v1/messages —
 *  caller owns close() (stream:true is the shape under test here). */
async function postStream(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { messages: [{ role: 'user', content: 'x' }], stream: true },
  cfg: ConductorConfig = CFG
): Promise<{ r: Response; url: string; close: () => Promise<void> }> {
  return postMessages(fake, body, cfg)
}

const CFG: ConductorConfig = {
  backend: 'dv-acp',
  entry: { type: 'acp' as const, command: 'dv acp' } as {
    type: 'acp'
    command: string
    model?: string
  },
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
  test('serve.backend in config is the env-less backend pin; env wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'))
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp' },
        providers: {
          'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' },
          other: { type: 'acp', command: 'o acp' },
        },
      })
    )
    // no env — the config section carries the backend
    const cfg = conductorConfig({}, dir)
    assert.equal(cfg?.backend, 'dv-acp')
    assert.equal(cfg?.model, 'swe-y')
    // env is the explicit operator pin — it overrides the config
    assert.equal(
      conductorConfig({ BRO_PROVIDER_BACKEND: 'other' }, dir)?.backend,
      'other'
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
    const { r, close } = await postStream(fake, {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'say hi' }],
      stream: true,
    })
    try {
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-type'), 'text/event-stream')
      const ev = await sseEvents(r)
      const kinds = ev.map((e) => e.event)
      assert.deepEqual(kinds.slice(0, 2), ['message_start', 'content_block_start'])
      assert.equal(kinds.at(-1), 'message_stop')
      const delta = ev.find((e) => e.event === 'content_block_delta')
      assert.deepEqual(delta?.data.delta, { type: 'text_delta', text: 'hi there' })
      const start = ev.find((e) => e.event === 'message_start')
      // message_start names the served label at turn start — the bare
      // request id echoes as a display label (a real pin would win)
      assert.equal(
        (start?.data.message as { model: string }).model,
        'claude-sonnet-4-5'
      )
      assert.equal(stopReason(ev), 'end_turn')
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
    const { r, close } = await postStream(fake, IMAGE_BODY)
    try {
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
    const { r, close } = await postStream(fake, IMAGE_BODY)
    try {
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
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
    })
    try {
      const ev = await sseEvents(r)
      const tu = ev.find(
        (e) => e.event === 'content_block_delta' && (e.data.delta as { type: string }).type === 'input_json_delta'
      )
      assert.ok(tu, 'tool_use delta present')
      assert.deepEqual(JSON.parse((tu.data.delta as { partial_json: string }).partial_json), {
        d: '/tmp',
      })
      assert.equal(stopReason(ev), 'tool_use')
    } finally {
      await close()
    }
  })

  test('a provider/model request id pins the acp session model', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
    const { r, close } = await postMessages(fake, {
      model: 'dv-acp/swe-y',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    })
    try {
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
    const { r, close } = await postMessages(fake, {
      model: 'dv-acp/swe-2-max',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    })
    try {
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
    const { r, close } = await postMessages(fake, {
      model: 'dv-acp/swe-2-max',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    })
    try {
      assert.equal(r.status, 200)
      assert.deepEqual(fake.configSets, [])
      assert.equal((await r.json()).model, 'swe-2-max')
    } finally {
      await close()
    }
  })

  test('stream:false answers a buffered anthropic message', async () => {
    const fake = fakeAcpAgent({ replyText: 'plain', configOptions: [MODEL_OPTION] })
    const { r, close } = await postMessages(fake)
    try {
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
    const { r, url, close } = await postMessages(
      fake,
      { messages: [{ role: 'user', content: 'x' }], stream: false },
      { ...CFG, entry: { ...CFG.entry, model: 'swe-sum' } }
    )
    try {
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
    const { r, url, close } = await postMessages(fake)
    try {
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
    const { r, close } = await postMessages(fake)
    try {
      assert.equal(r.status, 529)
      const body = await r.json()
      assert.equal(body.type, 'error')
      assert.match(body.error.message, /conductor/)
    } finally {
      await close()
    }
  })

  test('streamed deltas reach the wire before the turn completes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeAcpAgent({
      updates: chunks('he', 'llo'),
      holdEnd: () => gate,
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake)
    try {
      assert.equal(r.status, 200)
      const reader = (r.body as NonNullable<typeof r.body>).getReader()
      const dec = new TextDecoder()
      let buf = ''
      // the turn is still held open — every byte here proves the
      // response left before end_turn, not in a buffered burst
      const readOnce = () =>
        Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('no live deltas — the turn buffered until end_turn')),
              5000
            )
          ),
        ])
      while (!buf.includes('llo')) {
        const { done, value } = await readOnce()
        if (done) break
        buf += dec.decode(value, { stream: true })
      }
      assert.match(buf, /"text":"he"/)
      assert.match(buf, /"text":"llo"/)
      release()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
      }
      assert.match(buf, /event: message_stop/)
    } finally {
      await close()
    }
  })

  test('a <tool_call> split across deltas lands as one tool_use block', async () => {
    const fake = fakeAcpAgent({
      updates: chunks(
        'checking <tool_ca',
        'll>{"name":"ls","input":{"d":"/tmp"}}</tool',
        '_call> done'
      ),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
    })
    try {
      const ev = await sseEvents(r)
      const texts = textDeltas(ev)
      assert.deepEqual(texts, ['checking ', ' done'])
      const tu = ev.find(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      )
      assert.ok(tu, 'tool_use delta present')
      assert.equal(tu.data.index, 1)
      assert.deepEqual(JSON.parse((tu.data.delta as { partial_json: string }).partial_json), {
        d: '/tmp',
      })
      assert.equal(stopReason(ev), 'tool_use')
    } finally {
      await close()
    }
  })

  test('malformed and unclosed <tool_call> markup streams as plain text', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('x <tool_call>{nope</tool_call> y <tool_call>{"na'),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake)
    try {
      const ev = await sseEvents(r)
      const text = textDeltas(ev).join('')
      assert.equal(text, 'x <tool_call>{nope</tool_call> y <tool_call>{"na')
      assert.equal(stopReason(ev), 'end_turn')
    } finally {
      await close()
    }
  })

  test('agent-side tool_call lifecycle narrates as text edges — never tool_use', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('thinking '),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'exec: ls /tmp',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks('then '),
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          title: 'exec: ls /tmp',
        } as SessionUpdate,
        // non-terminal chatter and a duped terminal both emit nothing
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          status: 'in_progress',
          title: 'ignored',
        } as SessionUpdate,
        // a tool_call arriving already terminal closes its own edge
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-3',
          title: 'instant',
          kind: 'execute',
          status: 'completed',
        } as SessionUpdate,
        // an id-only terminal update reuses the label cached at start
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-4',
          title: 'exec: pwd',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-4',
          status: 'completed',
        } as SessionUpdate,
        // a repeated tool_call carrying the terminal edge narrates too
        // (tool_call updates keep their title per the acp schema)
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-5',
          title: 'exec: df',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-5',
          title: 'exec: df',
          kind: 'execute',
          status: 'completed',
        } as SessionUpdate,
        ...chunks('done'),
      ],
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake)
    try {
      const ev = await sseEvents(r)
      const text = textDeltas(ev).join('')
      assert.match(text, /⏺ exec: ls \/tmp/)
      assert.match(text, /✓ exec: ls \/tmp/)
      assert.match(text, /⏺ instant\n✓ instant/)
      assert.match(text, /✓ exec: pwd/)
      assert.match(text, /✓ exec: df/)
      assert.equal((text.match(/✓/g) ?? []).length, 4)
      assert.ok(!text.includes('ignored'))
      // narration is text — no tool_use block invented, no tool_use stop
      assert.equal(
        ev.filter((e) => (e.data.delta as { type: string } | undefined)?.type === 'input_json_delta').length,
        0
      )
      assert.equal(stopReason(ev), 'end_turn')
    } finally {
      await close()
    }
  })

  test('narration landing mid partial-tag keeps stream order — held tail completes into the block', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('work <tool_ca'),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-9',
          title: 'exec: ls',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks('ll>{"name":"ls","input":{}}</tool_call> end'),
      ],
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake)
    try {
      const ev = await sseEvents(r)
      const texts = textDeltas(ev)
      assert.deepEqual(texts, ['work ', '\n⏺ exec: ls\n', ' end'])
      const tu = ev.find(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      )
      assert.ok(tu, 'the split tag still completes into one tool_use block')
    } finally {
      await close()
    }
  })

  test('a failed streamed turn lands as an in-stream error event', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'generic' })
    const { r, close } = await postStream(fake)
    try {
      // headers commit at turn start — the failure can only travel
      // as an SSE event on the open stream
      assert.equal(r.status, 200)
      const ev = await sseEvents(r)
      const err = ev.find((e) => e.event === 'error')
      assert.ok(err, 'error event present')
      // the wrapped acp failure is availability-class — the anthropic
      // wire's own name for a backend outage mid-stream
      assert.equal((err.data.error as { type: string }).type, 'overloaded_error')
      assert.match((err.data.error as { message: string }).message, /conductor/)
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
    opts: { headers?: Record<string, string>; model?: string } = {}
  ): Promise<Response> =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify({ model: opts.model, messages, stream: false }),
    })

  /** Every case needs the same listener over a scripted acp peer — the
   *  helper carries the boilerplate so each test is just the posts. */
  const withConductor = async (
    fakeOpts: Parameters<typeof fakeAcpAgent>[0],
    fn: (ctx: { fake: ReturnType<typeof fakeAcpAgent>; url: string }) => Promise<void>
  ): Promise<void> => {
    const fake = fakeAcpAgent(fakeOpts)
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      await fn({ fake, url })
    } finally {
      await close()
    }
  }

  test('a continued conversation reuses one session and sends only the delta', () =>
    withConductor({ replyText: 'r1', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
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
    }))

  test('an identical resend replays the reply without a new turn', () =>
    withConductor(
      { replyText: 'same answer', configOptions: [MODEL_OPTION] },
      async ({ fake, url }) => {
        const msgs = [{ role: 'user', content: 'ping' }]
        assert.equal((await post(url, msgs)).status, 200)
        const retry = await post(url, msgs)
        assert.equal(retry.status, 200)
        assert.equal((await retry.json()).content[0].text, 'same answer')
        // a retry never reaches the agent — one prompt total
        assert.equal(fake.prompts.length, 1)
        assert.equal(fake.sessions.length, 1)
      }
    ))

  test('x-bro-session keys explicitly; different pins get different sessions', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const msgs = [{ role: 'user', content: 'same first turn' }]
      const ra = await post(url, msgs, { headers: { 'x-bro-session': 'a' } })
      assert.equal(ra.status, 200)
      // a client pin is echoed back for the client to confirm
      assert.equal(ra.headers.get('x-bro-session'), 'h:a')
      assert.equal(
        (await post(url, msgs, { headers: { 'x-bro-session': 'b' } })).status,
        200
      )
      // identical bodies, different pins — two sessions, no replay
      assert.equal(fake.sessions.length, 2)
      assert.equal(fake.prompts.length, 2)
      // pin a keeps its session across a real continuation
      const more = [
        { role: 'user', content: 'same first turn' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: 'more' },
      ]
      assert.equal(
        (await post(url, more, { headers: { 'x-bro-session': 'a' } })).status,
        200
      )
      assert.equal(fake.sessions.length, 2)
      assert.match(fake.prompts[2] ?? '', /more/)
    }))

  test('an edited prefix under a pinned key evicts and restarts', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 's' } }
      assert.equal((await post(url, [{ role: 'user', content: 'orig' }], pin)).status, 200)
      // the client rewrote history — the stored prefix proof fails
      const r = await post(
        url,
        [
          { role: 'user', content: 'EDITED' },
          { role: 'assistant', content: 'x' },
          { role: 'user', content: 'next' },
        ],
        pin
      )
      assert.equal(r.status, 200)
      // a fresh session got the FULL body, not a delta
      assert.equal(fake.sessions.length, 2)
      assert.match(fake.prompts[1] ?? '', /EDITED/)
      assert.match(fake.prompts[1] ?? '', /next/)
    }))

  test('a differing model mid-conversation re-pins the live session', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 'pin' } }
      assert.equal((await post(url, [{ role: 'user', content: 'a' }], pin)).status, 200)
      const cont = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: 'b' },
      ]
      assert.equal((await post(url, cont, { ...pin, model: 'dv-acp/swe-y' })).status, 200)
      // same session, the new pin applied on it
      assert.equal(fake.sessions.length, 1)
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }])
    }))

  test('histories differing only in image data never collide', () =>
    withConductor({ replyText: 'x', imageCapable: true }, async ({ fake, url }) => {
      const img = (data: string) => [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          ],
        },
      ]
      // serTurn collapses both to `[image]` — the fingerprint must
      // still tell them apart (codeant #569)
      assert.equal((await post(url, img('aGVsbG8='))).status, 200)
      assert.equal((await post(url, img('d29ybGQ='))).status, 200)
      assert.equal(fake.sessions.length, 2)
      assert.equal(fake.prompts.length, 2)
    }))

  test('a resend pinning a different model re-pins without a new turn', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 's' } }
      assert.equal((await post(url, [{ role: 'user', content: 'a' }], pin)).status, 200)
      // same history, new model pin — the session re-pins and the
      // recorded reply replays; no duplicate turn reaches the agent
      const r = await post(url, [{ role: 'user', content: 'a' }], { ...pin, model: 'dv-acp/swe-y' })
      assert.equal(r.status, 200)
      assert.equal(fake.sessions.length, 1)
      assert.equal(fake.prompts.length, 1)
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }])
    }))

  test('a failed turn evicts — the retry opens a fresh session', () =>
    withConductor({ replyText: 'x', failPrompt: 'generic' }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 's' } }
      const turn = { role: 'user', content: 'a' }
      assert.equal((await post(url, [turn], pin)).status, 529)
      assert.equal((await post(url, [turn], pin)).status, 529)
      // each attempt opened (and lost) its own session — a poisoned
      // session is never implicitly retried
      assert.equal(fake.sessions.length, 2)
    }))

  test('a claude [1m] context suffix resolves to the base model pin', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      // claude pins 1M-context variants as `model[1m]` — the bracket is
      // client-side context opt-in, not a different catalog model
      const r = await post(url, [{ role: 'user', content: 'a' }], {
        model: 'dv-acp/swe-y[1m]',
      })
      assert.equal(r.status, 200)
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }])
    }))
})

// bro-bvipw.1 — the anthropic surface beyond the happy path:
// tool_choice steers the contract, stop_sequences truncate the wire,
// errors classify into the wire's own taxonomy, and a held turn keeps
// the stream alive with pings.
describe('serve /v1/* — tool_choice, stop_sequences, error taxonomy, keepalive', () => {
  const tools = [
    { name: 'ls', description: 'list', input_schema: { type: 'object' } },
  ]
  const withTools = (choice?: unknown) => ({
    messages: [{ role: 'user', content: 'go' }],
    tools,
    tool_choice: choice,
    stream: false,
  })

  // one boot + one prompt assertion per row — the contract text each
  // tool_choice mode produces (or withholds)
  const choiceCases: { name: string; choice: unknown; want?: RegExp; notWant?: string }[] = [
    { name: 'auto leaves the contract alone', choice: { type: 'auto' }, want: /<tools>/, notWant: 'MUST' },
    {
      name: 'any appends a must-call line to the contract',
      choice: { type: 'any' },
      want: /<tools>[\s\S]*MUST respond with a tool call/,
    },
    { name: 'tool names the required call', choice: { type: 'tool', name: 'ls' }, want: /MUST call the tool "ls"/ },
    { name: 'none withholds the tools contract', choice: { type: 'none' }, notWant: '<tools>' },
  ]
  for (const c of choiceCases) {
    test(`tool_choice ${c.name}`, async () => {
      const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
      const { close } = await postMessages(fake, withTools(c.choice))
      try {
        const prompt = fake.prompts[0] ?? ''
        if (c.want !== undefined) assert.match(prompt, c.want)
        if (c.notWant !== undefined) assert.ok(!prompt.includes(c.notWant), prompt)
      } finally {
        await close()
      }
    })
  }

  test('stop_sequences cut streamed text at a marker split across deltas', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('hello ST', 'OP world'),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['STOP'],
      stream: true,
    })
    try {
      const ev = await sseEvents(r)
      assert.equal(textDeltas(ev).join(''), 'hello ')
      assert.equal(stopReason(ev), 'stop_sequence')
      const md = ev.find((e) => e.event === 'message_delta')
      assert.equal((md?.data.delta as { stop_sequence: string }).stop_sequence, 'STOP')
    } finally {
      await close()
    }
  })

  test('stop_sequences truncate the buffered reply and report stop_sequence', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] })
    const { r, close } = await postMessages(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['MARK'],
      stream: false,
    })
    try {
      const body = await r.json()
      assert.equal(body.stop_reason, 'stop_sequence')
      assert.equal(body.stop_sequence, 'MARK')
      assert.equal(body.content[0].text, 'abc ')
    } finally {
      await close()
    }
  })

  test('an absent stop_sequence holds nothing back — tail flushes whole', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('end without ma', 'rker'),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['NOMATCH'],
      stream: true,
    })
    try {
      const ev = await sseEvents(r)
      assert.equal(textDeltas(ev).join(''), 'end without marker')
    } finally {
      await close()
    }
  })

  test('a missing messages array answers 400 invalid_request_error', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' })
    const { r, close } = await postMessages(fake, { model: 'x', stream: false })
    try {
      assert.equal(r.status, 400)
      const body = await r.json()
      assert.equal(body.error.type, 'invalid_request_error')
    } finally {
      await close()
    }
  })

  test('a rate-limited backend answers 429 + Retry-After', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'rate-limit' })
    const { r, close } = await postMessages(fake)
    try {
      assert.equal(r.status, 429)
      assert.ok(r.headers.get('retry-after') !== null)
      const body = await r.json()
      assert.equal(body.error.type, 'rate_limit_error')
    } finally {
      await close()
    }
  })

  test('a held stream emits keepalive pings until the turn lands', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeAcpAgent({
      updates: chunks('after'),
      holdEnd: () => gate,
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postStream(
      fake,
      { messages: [{ role: 'user', content: 'x' }], stream: true },
      { ...CFG, keepaliveMs: 40 }
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      release()
      const ev = await sseEvents(r)
      assert.ok(ev.some((e) => e.event === 'ping'), 'ping event present')
      assert.equal(stopReason(ev), 'end_turn')
    } finally {
      await close()
    }
  })

  test('a streamed stop_sequence hit still records the cut reply for replay', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const body = {
        messages: [{ role: 'user', content: 'x' }],
        stop_sequences: ['MARK'],
        stream: true,
      }
      const ev = await sseEvents(await post(body))
      assert.equal(textDeltas(ev).join(''), 'abc ')
      // the resend replays the recorded reply — the cut text, not ''
      const re = await sseEvents(await post(body))
      assert.equal(textDeltas(re).join(''), 'abc ')
      assert.equal(stopReason(re), 'stop_sequence')
    } finally {
      await close()
    }
  })

  test('a cross-chunk stop hit records the streamed cut, not a full-text re-match', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('abc', 'd'),
      configOptions: [MODEL_OPTION],
    })
    const { post, close } = await boot(fake)
    try {
      const body = {
        messages: [{ role: 'user', content: 'x' }],
        stop_sequences: ['abcd', 'bc'],
        stream: true,
      }
      // 'bc' completes first in stream order — the cut is 'a', even
      // though 'abcd' sits earlier in the settled text
      const ev = await sseEvents(await post(body))
      assert.equal(textDeltas(ev).join(''), 'a')
      assert.equal(stopReason(ev), 'stop_sequence')
      const replay = await sseEvents(await post(body))
      assert.equal(textDeltas(replay).join(''), 'a')
      assert.equal(stopReason(replay), 'stop_sequence')
    } finally {
      await close()
    }
  })

  test('changed stop_sequences on identical history take a fresh turn, not a replay', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const postSeq = (stop_sequences: string[]) =>
        post({
          messages: [{ role: 'user', content: 'x' }],
          stop_sequences,
          stream: false,
        })
      const first = await (await postSeq(['MARK'])).json()
      assert.equal(first.content[0].text, 'abc ')
      // same history, different markers — the recorded reply must not
      // replay; a fresh turn runs and answers under the new stops
      const second = await (await postSeq(['NOMATCH'])).json()
      assert.equal(second.content[0].text, 'abc MARK tail')
      assert.equal(fake.prompts.length, 2)
    } finally {
      await close()
    }
  })

  test('a non-array stop_sequences answers 400 invalid_request_error', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const r = await post({
        messages: [{ role: 'user', content: 'x' }],
        stop_sequences: 'STOP',
      })
      assert.equal(r.status, 400)
      const body = await r.json()
      assert.equal(body.error.type, 'invalid_request_error')
    } finally {
      await close()
    }
  })
})

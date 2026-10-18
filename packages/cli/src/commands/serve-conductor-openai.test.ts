/** `bro serve` conductor — the openai dialects (/v1/responses and
 *  /v1/chat/completions) answering from the same acp turn machinery
 *  as /v1/messages (spec bro-zkpju, epic bro-bvipw). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import { fakeAcpAgent } from '@broject/providers/testkit'
import { conductorProxy } from './serve-conductor.ts'
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

const THOUGHT_OPTION: SessionConfigOption = {
  id: 'thought',
  name: 'Thought',
  category: 'thought_level',
  type: 'select',
  currentValue: 'medium',
  options: [
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
}

const auth = authHeaders

const chunks = (...texts: string[]): SessionUpdate[] =>
  texts.map((text) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text' as const, text },
  }))

const CFG: ConductorConfig = {
  backend: 'dv-acp',
  entry: { type: 'acp', command: 'dv acp' },
  cwd: '/repo',
  timeoutMs: 10_000,
}

/** Loopback URL for a test listener — the hostname check is the
 *  allowlist the SSRF rule needs: tests fetch nothing off 127.0.0.1. */
function api(port: number, path: string): URL {
  const u = new URL(path, `http://127.0.0.1:${port}`)
  if (u.hostname !== '127.0.0.1') throw new Error('test listener must bind loopback')
  return u
}

/** Boot the conductor over `fake` and POST /v1/responses —
 *  caller owns close() and reads `r`. */
async function postResponses(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { input: 'x', stream: false }
): Promise<{ r: Response; port: number; close: () => Promise<void> }> {
  const { port, close } = await listen(
    deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
  )
  const r = await fetch(api(port, '/v1/responses'), { // nosemgrep: test loopback listener
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { r, port, close }
}

async function evs(r: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const raw = await r.text()
  return raw
    .split('\n\n')
    .filter((b) => b.trim() !== '')
    .map((b) => ({
      event: b.match(/^event: (.+)$/m)?.[1] ?? '',
      data: JSON.parse(b.match(/^data: (.+)$/m)?.[1] ?? '{}') as Record<string, unknown>,
    }))
}

describe('serve /v1/responses — the openai dialect', () => {
  test('input string answers a buffered Response object with usage', async () => {
    const fake = fakeAcpAgent({ replyText: 'pong', configOptions: [MODEL_OPTION] })
    const { r, close } = await postResponses(fake, { input: 'ping', stream: false })
    try {
      assert.equal(r.status, 200)
      const body = await r.json()
      assert.equal(body.object, 'response')
      assert.match(body.id, /^resp_/)
      assert.equal(body.status, 'completed')
      assert.equal(body.output[0].type, 'message')
      assert.equal(body.output[0].content[0].text, 'pong')
      assert.ok(body.usage.input_tokens > 0)
      assert.ok(body.usage.output_tokens > 0)
      assert.equal(body.usage.total_tokens, body.usage.input_tokens + body.usage.output_tokens)
      // the prompt reached the agent as a canonical user turn
      assert.match(fake.prompts[0] ?? '', /<turn role="user">ping/)
    } finally {
      await close()
    }
  })

  test('instructions land as the system prefix; reasoning.effort folds into the pin', async () => {
    const fake = fakeAcpAgent({
      replyText: 'ok',
      configOptions: [MODEL_OPTION, THOUGHT_OPTION],
    })
    const { close } = await postResponses(fake, {
      input: 'x',
      instructions: 'be terse',
      model: 'dv-acp/swe-y',
      reasoning: { effort: 'high' },
      stream: false,
    })
    try {
      assert.match(fake.prompts[0] ?? '', /<system>\nbe terse\n<\/system>/)
      // swe-y-high → model swe-y + thought_level high
      assert.deepEqual(fake.configSets, [
        { configId: 'model', value: 'swe-y' },
        { configId: 'thought', value: 'high' },
      ])
    } finally {
      await close()
    }
  })

  test('function_call items round-trip through the tool contract', async () => {
    const fake = fakeAcpAgent({
      replyText: 'checking <tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>',
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postResponses(fake, {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'list it' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'ls',
          arguments: '{"d":"/var"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'var-file',
        },
      ],
      tools: [
        { type: 'function', name: 'ls', description: 'list', parameters: { type: 'object' } },
      ],
      stream: false,
    })
    try {
      const body = await r.json()
      // inbound items serialized into the transcript markup
      assert.match(fake.prompts[0] ?? '', /<tool_call>\{"name":"ls","input":\{"d":"\/var"\}\}<\/tool_call>/)
      assert.match(fake.prompts[0] ?? '', /<tool_result for="call_1">var-file<\/tool_result>/)
      assert.match(fake.prompts[0] ?? '', /<tools>/)
      // the reply's tool_call became a function_call output item
      const fc = body.output.find((o: { type: string }) => o.type === 'function_call')
      assert.equal(fc.name, 'ls')
      assert.deepEqual(JSON.parse(fc.arguments), { d: '/tmp' })
    } finally {
      await close()
    }
  })

  test('stream emits the item-ordered event sequence', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('he', 'llo ', 'there'),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postResponses(fake, { input: 'x', stream: true })
    try {
      const ev = await evs(r)
      const kinds = ev.map((e) => e.event)
      assert.equal(kinds[0], 'response.created')
      assert.ok(kinds.includes('response.output_item.added'))
      assert.ok(kinds.includes('response.output_text.delta'))
      assert.equal(kinds.at(-1), 'response.completed')
      const text = ev
        .filter((e) => e.event === 'response.output_text.delta')
        .map((e) => (e.data.delta as string) ?? '')
        .join('')
      assert.equal(text, 'hello there')
      const done = ev.find((e) => e.event === 'response.completed')
      const resp = done?.data.response as { usage: { total_tokens: number } }
      assert.ok(resp.usage.total_tokens > 0)
    } finally {
      await close()
    }
  })

  test('previous_response_id chains into the retained session', async () => {
    const fake = fakeAcpAgent({ replyText: 'r1', configOptions: [MODEL_OPTION] })
    const { port, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const post = (body: unknown) =>
        fetch(api(port, '/v1/responses'), { // nosemgrep: test loopback listener
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const t1 = await post({ input: 'first', stream: false })
      const id1 = ((await t1.json()) as { id: string }).id
      const t2 = await post({
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] }],
        previous_response_id: id1,
        stream: false,
      })
      assert.equal(t2.status, 200)
      // ONE acp session served both hops — the second prompt carried
      // only the delta (the session holds the rest)
      assert.equal(fake.sessions.length, 1)
      assert.match(fake.prompts[1] ?? '', /second/)
      assert.ok(!fake.prompts[1]?.includes('first'))
    } finally {
      await close()
    }
  })

  test('a store:false continuation still consumes the session — the same predecessor then reads as superseded', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
    const { port, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const post = (body: unknown) =>
        fetch(api(port, '/v1/responses'), { // nosemgrep: test loopback listener
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const a = await post({ input: 'one', stream: false })
      const idA = ((await a.json()) as { id: string }).id
      // non-stored B chains from A — runs in A's session but registers
      // no chain id; the session's consumed point must still advance
      const b = await post({ input: 'two', previous_response_id: idA, store: false })
      assert.equal(b.status, 200)
      // C chained from A is now a branch: the session already holds B's
      // turn — answering would silently include hidden context
      const c = await post({ input: 'three', previous_response_id: idA, stream: false })
      assert.equal(c.status, 400)
      const errBody = (await c.json()) as { error: { message: string } }
      assert.match(errBody.error.message, /superseded/)
    } finally {
      await close()
    }
  })

  test('missing input answers 400 in the openai error envelope', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' })
    const { r, close } = await postResponses(fake, { stream: false })
    try {
      assert.equal(r.status, 400)
      const body = await r.json()
      assert.equal(body.error.type, 'invalid_request_error')
      assert.equal(body.error.param, null)
    } finally {
      await close()
    }
  })

  test('a backend quota wall answers 429 + Retry-After', async () => {
    const fake = fakeAcpAgent({
      configOptions: [MODEL_OPTION],
      failPrompt: 'rate-limit',
    })
    const { r, close } = await postResponses(fake)
    try {
      assert.equal(r.status, 429)
      assert.ok(r.headers.get('retry-after') !== null)
      const body = await r.json()
      assert.equal(body.error.type, 'rate_limit_error')
    } finally {
      await close()
    }
  })
})

async function postChat(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { messages: [{ role: 'user', content: 'x' }] }
): Promise<{ r: Response; port: number; close: () => Promise<void> }> {
  const { port, close } = await listen(
    deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
  )
  const r = await fetch(api(port, '/v1/chat/completions'), { // nosemgrep: test loopback listener
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { r, port, close }
}

describe('serve /v1/chat/completions — the stateless chat dialect', () => {
  test('a user message answers a chat.completion with usage', async () => {
    const fake = fakeAcpAgent({ replyText: 'pong', configOptions: [MODEL_OPTION] })
    const { r, close } = await postChat(fake)
    try {
      assert.equal(r.status, 200)
      const body = await r.json()
      assert.equal(body.object, 'chat.completion')
      assert.match(body.id, /^chatcmpl-/)
      assert.equal(body.choices[0].message.role, 'assistant')
      assert.equal(body.choices[0].message.content, 'pong')
      assert.equal(body.choices[0].finish_reason, 'stop')
      assert.ok(body.usage.total_tokens > 0)
      assert.match(fake.prompts[0] ?? '', /<turn role="user">x/)
    } finally {
      await close()
    }
  })

  test('system + tool history serialize into the canonical transcript', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
    const { close } = await postChat(fake, {
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'list it' },
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{"d":"/var"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'var-file' },
        { role: 'user', content: 'and now?' },
      ],
    })
    try {
      const prompt = fake.prompts[0] ?? ''
      assert.match(prompt, /<system>\nbe terse\n<\/system>/)
      assert.match(prompt, /<tool_call>\{"name":"ls","input":\{"d":"\/var"\}\}<\/tool_call>/)
      assert.match(prompt, /<tool_result for="call_1">var-file<\/tool_result>/)
      assert.match(prompt, /and now\?/)
    } finally {
      await close()
    }
  })

  test('a tool_call reply lands as tool_calls + finish_reason tool_calls', async () => {
    const fake = fakeAcpAgent({
      replyText: 'checking <tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>',
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'list it' }],
      tools: [{ type: 'function', function: { name: 'ls', description: 'list', parameters: {} } }],
    })
    try {
      const body = await r.json()
      const msg = body.choices[0].message
      assert.equal(msg.content, 'checking ')
      assert.equal(msg.tool_calls[0].function.name, 'ls')
      assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { d: '/tmp' })
      assert.equal(body.choices[0].finish_reason, 'tool_calls')
      assert.match(fake.prompts[0] ?? '', /<tools>/)
    } finally {
      await close()
    }
  })

  test('stream emits delta chunks and [DONE]; include_usage adds the usage chunk', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('he', 'llo'),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      stream_options: { include_usage: true },
    })
    try {
      const raw = await r.text()
      const frames = raw.split('\n\n').filter((f) => f.trim() !== '')
      const deltas = frames
        .map((f) => f.replace(/^data: /, ''))
        .filter((d) => d !== '[DONE]')
        .map((d) => JSON.parse(d) as Record<string, unknown>)
      assert.equal(frames.at(-1)?.trim(), 'data: [DONE]')
      const text = deltas
        .flatMap((d) => (d.choices as { delta: { content?: string } }[]))
        .map((c) => c.delta.content ?? '')
        .join('')
      assert.equal(text, 'hello')
      const usage = deltas.find((d) => Array.isArray(d.choices) && d.choices.length === 0)
      assert.ok((usage?.usage as { total_tokens: number }).total_tokens > 0)
      const fin = [...deltas]
        .reverse()
        .find(
          (d: Record<string, unknown>) =>
            (d.choices as { finish_reason?: string | null }[])[0]?.finish_reason != null
        )
      assert.equal((fin?.choices as { finish_reason: string }[])[0].finish_reason, 'stop')
    } finally {
      await close()
    }
  })

  test('an identical resend replays without a second acp turn', async () => {
    const fake = fakeAcpAgent({ replyText: 'r1', configOptions: [MODEL_OPTION] })
    const { port, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    )
    try {
      const post = () =>
        fetch(api(port, '/v1/chat/completions'), { // nosemgrep: test loopback listener
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        })
      await post()
      const t2 = await post()
      assert.equal(t2.status, 200)
      const body = await t2.json()
      assert.equal(body.choices[0].message.content, 'r1')
      // ONE prompt total — the resend replayed the recorded reply
      assert.equal(fake.prompts.length, 1)
      assert.equal(fake.sessions.length, 1)
    } finally {
      await close()
    }
  })

  test('reasoning_effort folds into the composite pin', async () => {
    const fake = fakeAcpAgent({
      replyText: 'ok',
      configOptions: [MODEL_OPTION, THOUGHT_OPTION],
    })
    const { close } = await postChat(fake, {
      model: 'dv-acp/swe-y',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'x' }],
    })
    try {
      assert.deepEqual(fake.configSets, [
        { configId: 'model', value: 'swe-y' },
        { configId: 'thought', value: 'high' },
      ])
    } finally {
      await close()
    }
  })

  test('empty messages answers 400; a quota wall answers 429', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' })
    const { r, close } = await postChat(fake, { messages: [] })
    try {
      assert.equal(r.status, 400)
      const body = await r.json()
      assert.equal(body.error.type, 'invalid_request_error')
    } finally {
      await close()
    }
    const fake2 = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'rate-limit' })
    const { r: r2, close: c2 } = await postChat(fake2)
    try {
      assert.equal(r2.status, 429)
      assert.ok(r2.headers.get('retry-after') !== null)
    } finally {
      await c2()
    }
  })
})

describe('output caps + loud input failures', () => {
  test('max_output_tokens truncates a buffered response to incomplete', async () => {
    const fake = fakeAcpAgent({ replyText: 'x'.repeat(400) })
    const { r, close } = await postResponses(fake, { input: 'x', max_output_tokens: 5 })
    try {
      const body = await r.json()
      assert.equal(body.status, 'incomplete')
      const text = body.output[0].content[0].text as string
      assert.equal(text.length, 20)
      assert.equal(body.incomplete_details.reason, 'max_output_tokens')
    } finally {
      await close()
    }
  })

  test('a streamed cap ends as response.incomplete, not completed', async () => {
    const fake = fakeAcpAgent({ replyText: 'y'.repeat(400) })
    const { r, close } = await postResponses(fake, {
      input: 'x',
      stream: true,
      max_output_tokens: 4,
    })
    try {
      const ev = await evs(r)
      assert.equal(ev.filter((e) => e.event === 'response.incomplete').length, 1)
      assert.equal(ev.filter((e) => e.event === 'response.completed').length, 0)
    } finally {
      await close()
    }
  })

  test('max_tokens flips chat finish_reason to length', async () => {
    const fake = fakeAcpAgent({ replyText: 'z'.repeat(400) })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 3,
    })
    try {
      const body = await r.json()
      assert.equal(body.choices[0].finish_reason, 'length')
    } finally {
      await close()
    }
  })

  test('a stream:true resend answers SSE, never a JSON snapshot', async () => {
    const fake = fakeAcpAgent({ replyText: 'r1' })
    const { port, close } = await postChat(fake)
    try {
      const post = (body: unknown) =>
        fetch(api(port, '/v1/chat/completions'), { // nosemgrep: test loopback listener
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      await post({ messages: [{ role: 'user', content: 'x' }] })
      const r2 = await post({ messages: [{ role: 'user', content: 'x' }], stream: true })
      assert.match(r2.headers.get('content-type') ?? '', /text\/event-stream/)
      const raw = await r2.text()
      assert.match(raw, /chat\.completion\.chunk/)
      assert.match(raw, /\[DONE\]/)
    } finally {
      await close()
    }
  })

  test('an input_file part answers 400, never a silent drop', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' })
    const { r, close } = await postResponses(fake, {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_file', file_url: 'https://x/f.pdf' }],
        },
      ],
    })
    try {
      assert.equal(r.status, 400)
      const body = await r.json()
      assert.match(body.error.message, /input_file/)
    } finally {
      await close()
    }
  })
})

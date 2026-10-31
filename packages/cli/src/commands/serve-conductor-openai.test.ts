/** `bro serve` conductor — the openai dialects (/v1/responses and
 *  /v1/chat/completions) answering from the same acp turn machinery
 *  as /v1/messages (spec bro-zkpju, epic bro-bvipw). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfigOption, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import { otelJournal } from '@broject/providers'
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
} as ConductorConfig

/** Boot the conductor over `fake` — caller owns close() and gets a
 *  bound post(path, body) for /v1/* sends. */
async function boot(fake: ReturnType<typeof fakeAcpAgent>): Promise<{
  url: string
  post: (path: string, body: unknown) => Promise<Response>
  close: () => Promise<void>
}> {
  const { url, close } = await listen(
    deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
  )
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { url, post, close }
}

/** boot() + one /v1/responses POST — caller reads `r`, owns close(). */
async function postResponses(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { input: 'x', stream: false }
): Promise<{ r: Response; url: string; close: () => Promise<void> }> {
  const { url, post, close } = await boot(fake)
  return { r: await post('/v1/responses', body), url, close }
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

  // bro-6fk80 — a cancelled or backend-ended turn reports its own
  // Response status, never a silent 'completed'.
  test('a cancelled turn answers status cancelled', async () => {
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'cancelled',
    })
    const { r, close } = await postResponses(fake, { input: 'x', stream: false })
    try {
      assert.equal(r.status, 200)
      const body = await r.json()
      assert.equal(body.status, 'cancelled')
    } finally {
      await close()
    }
  })

  test('a streamed cancelled turn ends on response.cancelled, not completed', async () => {
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'cancelled',
    })
    const { r, close } = await postResponses(fake, { input: 'x', stream: true })
    try {
      const ev = await evs(r)
      assert.equal(ev.filter((e) => e.event === 'response.cancelled').length, 1)
      assert.equal(ev.filter((e) => e.event === 'response.completed').length, 0)
    } finally {
      await close()
    }
  })

  test('a non-enum acp reason answers status failed naming the reason', async () => {
    // devin's adapter emits error/auth_required outside the acp enum —
    // those used to report a clean 'completed'
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'auth_required' as StopReason,
    })
    const { r, close } = await postResponses(fake, { input: 'x', stream: false })
    try {
      const body = await r.json()
      assert.equal(body.status, 'failed')
      assert.match(body.error?.message ?? '', /auth_required/)
    } finally {
      await close()
    }
  })

  test('a prototype-member backend reason forwards raw — never an inherited Object value', async () => {
    // 'constructor'/'toString' tokens must not resolve through the
    // prototype chain into a fake mapping or status
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'constructor' as StopReason,
    })
    const { r, close } = await postResponses(fake, { input: 'x', stream: false })
    try {
      const body = await r.json()
      assert.equal(body.status, 'failed')
      assert.equal(body.error?.message, 'bro conductor: turn ended — constructor')
    } finally {
      await close()
    }
  })

  test('a cancelled stream closes the message item under its own status', async () => {
    // the item's own status must not read 'incomplete' (a token cap)
    // when the turn was cancelled
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'cancelled',
    })
    const { r, close } = await postResponses(fake, { input: 'x', stream: true })
    try {
      const ev = await evs(r)
      const done = ev.filter((e) => e.event === 'response.output_item.done')
      assert.ok(done.length > 0)
      const last = done.at(-1)?.data.item as { type: string; status: string }
      assert.equal(last.type, 'message')
      assert.equal(last.status, 'cancelled')
    } finally {
      await close()
    }
  })

  test('a tool_call turn cancelled backend-side replays the delivered status', async () => {
    // tool_use outranks the backend reason on the wire — the record must
    // store that verdict or the replay answers 'cancelled' for a turn the
    // client saw complete
    const fake = fakeAcpAgent({
      replyText: 'checking <tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>',
      configOptions: [MODEL_OPTION],
      stopReason: 'cancelled',
    })
    const { post, close } = await boot(fake)
    try {
      const call = () =>
        post('/v1/responses', {
          input: 'x',
          tools: [{ type: 'function', name: 'ls', parameters: { type: 'object' } }],
          stream: false,
        })
      const t1 = await call()
      assert.equal(((await t1.json()) as { status: string }).status, 'completed')
      const t2 = await call()
      assert.equal(((await t2.json()) as { status: string }).status, 'completed')
      assert.equal(fake.prompts.length, 1)
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
    const { post, close } = await boot(fake)
    try {
      const t1 = await post('/v1/responses', { input: 'first', stream: false })
      const id1 = ((await t1.json()) as { id: string }).id
      const t2 = await post('/v1/responses', {
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
    const { post, close } = await boot(fake)
    try {
      const a = await post('/v1/responses', { input: 'one', stream: false })
      const idA = ((await a.json()) as { id: string }).id
      // non-stored B chains from A — runs in A's session but registers
      // no chain id; the session's consumed point must still advance
      const b = await post('/v1/responses', { input: 'two', previous_response_id: idA, store: false })
      assert.equal(b.status, 200)
      // C chained from A is now a branch: the session already holds B's
      // turn — answering would silently include hidden context
      const c = await post('/v1/responses', { input: 'three', previous_response_id: idA, stream: false })
      assert.equal(c.status, 400)
      const errBody = (await c.json()) as { error: { message: string } }
      assert.match(errBody.error.message, /superseded/)
    } finally {
      await close()
    }
  })

  // bro-d63hu — an unknown predecessor must 400, never answer the bare
  // delta history-less as if it were a fresh fingerprinted turn.

  test('an unknown previous_response_id answers 400 — never a history-less turn', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const gone = await post('/v1/responses', {
        input: 'x',
        previous_response_id: 'resp_gone',
        stream: false,
      })
      assert.equal(gone.status, 400)
      const err = (await gone.json()) as { error: { type: string; message: string } }
      assert.equal(err.error.type, 'invalid_request_error')
      assert.match(err.error.message, /resp_gone.*expired or evicted/)
      // a non-stored response registers no chain id either — chaining
      // from it is equally refused, not a fresh fingerprint
      const a = await post('/v1/responses', { input: 'one', store: false })
      const idA = ((await a.json()) as { id: string }).id
      const b = await post('/v1/responses', {
        input: 'two',
        previous_response_id: idA,
        stream: false,
      })
      assert.equal(b.status, 400)
      // the refused turns never reached the agent — only 'one' did
      assert.equal(fake.prompts.length, 1)
    } finally {
      await close()
    }
  })

  // a non-string previous_response_id must 400 at the shape gate — the
  // unknown-chain template interpolates it, and an object with a
  // non-callable toString throws outside the turn's try instead.
  test('a non-string previous_response_id answers 400 — never a template throw', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' })
    const { post, close } = await boot(fake)
    try {
      const r = await post('/v1/responses', {
        input: 'x',
        previous_response_id: { toString: 5 },
        stream: false,
      })
      assert.equal(r.status, 400)
      const err = (await r.json()) as { error: { type: string; message: string } }
      assert.equal(err.error.type, 'invalid_request_error')
      assert.match(err.error.message, /previous_response_id: a string is required/)
      assert.equal(fake.prompts.length, 0)
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

/** boot() + one /v1/chat/completions POST — same shape as
 *  postResponses. */
async function postChat(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { messages: [{ role: 'user', content: 'x' }] }
): Promise<{ r: Response; url: string; close: () => Promise<void> }> {
  const { url, post, close } = await boot(fake)
  return { r: await post('/v1/chat/completions', body), url, close }
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

  // bro-6fk80 — the finish_reason enum can't carry a cancelled/backend
  // reason, so it forwards raw: a marker, never a silent 'stop'.
  test('a cancelled turn reports finish_reason cancelled, not stop', async () => {
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'cancelled',
    })
    const { r, close } = await postChat(fake)
    try {
      const body = await r.json()
      assert.equal(body.choices[0].finish_reason, 'cancelled')
    } finally {
      await close()
    }
  })

  test('a non-enum acp reason forwards raw as finish_reason', async () => {
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'error' as StopReason,
    })
    const { r, close } = await postChat(fake)
    try {
      const body = await r.json()
      assert.equal(body.choices[0].finish_reason, 'error')
    } finally {
      await close()
    }
  })

  test('mapped canonical reasons land on real chat finish values', async () => {
    // pause_turn/refusal are KNOWN canonicals — they must not leak raw
    // past the enum; only genuinely unmapped reasons forward raw
    const pause = fakeAcpAgent({
      replyText: 'x',
      configOptions: [MODEL_OPTION],
      stopReason: 'max_turn_requests',
    })
    const { r: r1, close: c1 } = await postChat(pause)
    try {
      assert.equal(((await r1.json()) as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason, 'stop')
    } finally {
      await c1()
    }
    const refusal = fakeAcpAgent({
      replyText: 'x',
      configOptions: [MODEL_OPTION],
      stopReason: 'refusal',
    })
    const { r: r2, close: c2 } = await postChat(refusal)
    try {
      assert.equal(((await r2.json()) as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason, 'content_filter')
    } finally {
      await c2()
    }
  })

  test('a prototype-member backend reason forwards raw as finish_reason', async () => {
    // 'constructor' resolves through Object.prototype on a naive map
    // lookup — it must forward as the raw token, not an inherited value
    const fake = fakeAcpAgent({
      replyText: 'x',
      configOptions: [MODEL_OPTION],
      stopReason: 'constructor' as StopReason,
    })
    const { r, close } = await postChat(fake)
    try {
      const body = await r.json()
      assert.equal(body.choices[0].finish_reason, 'constructor')
    } finally {
      await close()
    }
  })

  test('an unmapped reason overridden by a tool call still logs its otel breadcrumb', async () => {
    // tool_use outranks the backend reason on the wire, but the anomaly
    // stays observable — canonicalize before precedence (bro-6fk80)
    const dir = mkdtempSync(join(tmpdir(), 'bro-otel-test-'))
    const journalPath = join(dir, 'turns.jsonl')
    otelJournal(journalPath)
    const fake = fakeAcpAgent({
      replyText: 'checking <tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>',
      configOptions: [MODEL_OPTION],
      stopReason: 'auth_required' as StopReason,
    })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'list it' }],
      tools: [{ type: 'function', function: { name: 'ls', description: 'list', parameters: {} } }],
    })
    try {
      const body = await r.json()
      assert.equal(body.choices[0].finish_reason, 'tool_calls')
      const rows = readFileSync(journalPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { event: string; reason?: string })
      const unmapped = rows.filter((e) => e.event === 'conductor.stop_reason.unmapped')
      assert.equal(unmapped.length, 1)
      assert.equal(unmapped[0]!.reason, 'auth_required')
    } finally {
      await close()
      otelJournal(undefined)
      rmSync(dir, { recursive: true, force: true })
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
    const { post, close } = await boot(fake)
    try {
      const call = () =>
        post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
      await call()
      const t2 = await call()
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

  // bro-vfbyc — a trimmed reply leaves the retained session holding text
  // the client never received: it may replay, never continue.

  test('a capped response id refuses to chain — the session diverged', async () => {
    const fake = fakeAcpAgent({ replyText: 'x'.repeat(400), configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const t1 = await post('/v1/responses', { input: 'first', max_output_tokens: 5 })
      const id1 = ((await t1.json()) as { id: string }).id
      const t2 = await post('/v1/responses', {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] }],
        previous_response_id: id1,
      })
      assert.equal(t2.status, 400)
      const body = (await t2.json()) as { error: { message: string } }
      assert.match(body.error.message, /trimmed at the wire/)
      // the delta never reached the divergent session
      assert.equal(fake.prompts.length, 1)
      assert.equal(fake.sessions.length, 1)
    } finally {
      await close()
    }
  })

  test('a capped turn still replays on an identical resend', async () => {
    const fake = fakeAcpAgent({ replyText: 'x'.repeat(400), configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const body = { input: 'first', max_output_tokens: 5 }
      await post('/v1/responses', body)
      const t2 = await post('/v1/responses', body)
      assert.equal(t2.status, 200)
      const b2 = (await t2.json()) as { status: string; output: { content: { text: string }[] }[] }
      assert.equal(b2.status, 'incomplete')
      // the recorded cut answer replays — no second turn reaches the agent
      assert.equal(fake.prompts.length, 1)
    } finally {
      await close()
    }
  })

  test('a capped chat turn retires the session — the trimmed echo reseeds fresh', async () => {
    const fake = fakeAcpAgent({ replyText: 'z'.repeat(400), configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const t1 = await post('/v1/chat/completions', {
        messages: [{ role: 'user', content: 'first' }],
        max_tokens: 5,
      })
      // the echo is the wire reply itself — exactly what the client saw
      const echo =
        ((await t1.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message
          .content ?? ''
      assert.notEqual(echo, '')
      const cont = await post('/v1/chat/completions', {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: echo },
          { role: 'user', content: 'second' },
        ],
      })
      assert.equal(cont.status, 200)
      // a NEW session opened — the resent history (trimmed echo
      // included) is serialized whole, so its context IS the client's view
      assert.equal(fake.sessions.length, 2)
      assert.match(fake.prompts[1] ?? '', /first/)
      assert.ok(fake.prompts[1]?.includes(echo) === true)
      assert.match(fake.prompts[1] ?? '', /second/)
    } finally {
      await close()
    }
  })

  test('concurrent same-key continuations never twin a session mid-settle', async () => {
    const fake = fakeAcpAgent({ replyText: 'z'.repeat(400), configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      await post('/v1/chat/completions', {
        messages: [{ role: 'user', content: 'first' }],
        max_tokens: 5,
      })
      const cont = {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'zzzzz' },
          { role: 'user', content: 'second' },
        ],
      }
      // two continuations race the same conversation — the loser takes
      // the one-shot path (or replays, if the winner's settle lands
      // first) rather than prompting a session whose wire verdict
      // (divergent) is still unwritten
      const [a, b] = await Promise.all([
        post('/v1/chat/completions', cont),
        post('/v1/chat/completions', cont),
      ])
      assert.equal(a.status, 200)
      assert.equal(b.status, 200)
      // nobody prompted mid-settle with a bare delta — every prompt
      // after the first carries the full client-visible history
      assert.ok(
        fake.prompts.slice(1).every((p) => p.includes('first') && p.includes('second')),
        `a continuation prompted hidden context: ${JSON.stringify(fake.prompts)}`
      )
    } finally {
      await close()
    }
  })

  test('a stream:true resend answers SSE, never a JSON snapshot', async () => {
    const fake = fakeAcpAgent({ replyText: 'r1' })
    const { post, close } = await boot(fake)
    try {
      await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })
      const r2 = await post('/v1/chat/completions', {
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })
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

  test('a null body answers 400 in the openai envelope, never a 500', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' })
    const { post, close } = await boot(fake)
    try {
      for (const path of ['/v1/responses', '/v1/chat/completions']) {
        const r = await post(path, null)
        assert.equal(r.status, 400)
        const body = await r.json()
        assert.equal(body.error.type, 'invalid_request_error')
      }
    } finally {
      await close()
    }
  })

  test('a non-function tool answers 400 — the agent cannot lose it silently', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' })
    const { post, close } = await boot(fake)
    try {
      const r1 = await post('/v1/responses', {
        input: 'x',
        tools: [{ type: 'web_search' }],
      })
      assert.equal(r1.status, 400)
      assert.match(((await r1.json()) as { error: { message: string } }).error.message, /web_search/)
      const r2 = await post('/v1/chat/completions', {
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'web_search_preview' }],
      })
      assert.equal(r2.status, 400)
      assert.match(
        ((await r2.json()) as { error: { message: string } }).error.message,
        /web_search_preview/
      )
      // and nothing reached the agent — no turn was paid for
      assert.equal(fake.prompts.length, 0)
    } finally {
      await close()
    }
  })

  test('chat stop truncates the buffered reply at the marker', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop: 'MARK',
    })
    try {
      assert.equal(r.status, 200)
      const body = await r.json()
      assert.equal(body.choices[0].message.content, 'abc ')
      assert.equal(body.choices[0].finish_reason, 'stop')
    } finally {
      await close()
    }
  })

  test('chat stop cuts streamed deltas at a marker split across chunks', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('hello ST', 'OP world'),
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop: ['STOP'],
      stream: true,
    })
    try {
      const raw = await r.text()
      const deltas = raw
        .split('\n\n')
        .filter((f) => f.trim() !== '')
        .map((f) => f.replace(/^data: /, ''))
        .filter((d) => d !== '[DONE]')
        .map((d) => JSON.parse(d) as Record<string, unknown>)
      const text = deltas
        .flatMap((d) => (d.choices as { delta: { content?: string } }[]))
        .map((c) => c.delta.content ?? '')
        .join('')
      assert.equal(text, 'hello ')
    } finally {
      await close()
    }
  })

  test('a streamed chat stop hit records the cut reply — a resend replays it', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] })
    const { post, close } = await boot(fake)
    try {
      const body = {
        messages: [{ role: 'user', content: 'x' }],
        stop: ['MARK'],
        stream: true,
      }
      // drain the first stream — post() resolves at headers; the resend
      // must wait for the turn to record or it opens a second ACP turn
      const r1 = await post('/v1/chat/completions', body)
      await r1.text()
      // the resend replays the recorded view — the cut text, not the raw
      const r2 = await post('/v1/chat/completions', { ...body, stream: false })
      const b2 = await r2.json()
      assert.equal(b2.choices[0].message.content, 'abc ')
      assert.equal(fake.prompts.length, 1)
    } finally {
      await close()
    }
  })

  test('a malformed chat stop answers 400', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop: 5,
    })
    try {
      assert.equal(r.status, 400)
      const body = await r.json()
      assert.equal(body.error.type, 'invalid_request_error')
      assert.match(body.error.message, /stop/)
    } finally {
      await close()
    }
  })

  test('a function tool_choice without a name answers 400', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' })
    const { post, close } = await boot(fake)
    try {
      const r1 = await post('/v1/chat/completions', {
        messages: [{ role: 'user', content: 'x' }],
        tool_choice: { type: 'function', function: {} },
      })
      assert.equal(r1.status, 400)
      assert.match(
        ((await r1.json()) as { error: { message: string } }).error.message,
        /tool_choice/
      )
      const r2 = await post('/v1/responses', {
        input: 'x',
        tool_choice: { type: 'function' },
      })
      assert.equal(r2.status, 400)
      // and nothing reached the agent — no turn was paid for
      assert.equal(fake.prompts.length, 0)
    } finally {
      await close()
    }
  })

  test('a stop marker after a tool call keeps finish_reason tool_calls', async () => {
    const fake = fakeAcpAgent({
      replyText: '<tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>MARK',
      configOptions: [MODEL_OPTION],
    })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'ls', description: 'list', parameters: {} } }],
      stop: 'MARK',
    })
    try {
      const body = await r.json()
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'ls')
      assert.equal(body.choices[0].finish_reason, 'tool_calls')
    } finally {
      await close()
    }
  })

  test('buffered stop picks the marker a stream would complete first', async () => {
    const fake = fakeAcpAgent({ replyText: 'abcd tail', configOptions: [MODEL_OPTION] })
    const { r, close } = await postChat(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop: ['abcd', 'bc'],
    })
    try {
      assert.equal(r.status, 200)
      const body = await r.json()
      // chunked streaming hits 'bc' the moment 'abc' lands — the buffered
      // cut must answer the same 'a', not the longer marker's ''
      assert.equal(body.choices[0].message.content, 'a')
      assert.equal(body.choices[0].finish_reason, 'stop')
    } finally {
      await close()
    }
  })
})

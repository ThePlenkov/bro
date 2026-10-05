import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { openaiCompatChat } from './openai.ts'
import { fakeFetch } from './testkit.ts'

const ENTRY: Extract<ProviderEntry, { type: 'openai-compat' }> = {
  type: 'openai-compat',
  baseUrl: 'https://orca.example/v1/',
  model: 'qwen3-coder',
  apiKeyEnv: 'ORCA_TEST_KEY',
}

const OK_BODY = {
  model: 'qwen3-coder-r2',
  choices: [{ message: { content: '{"answers":{}}' } }],
  usage: { prompt_tokens: 42, completion_tokens: 10 },
}

const DEADLINE = () => Date.now() + 3_000

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.ORCA_TEST_KEY
  process.env.ORCA_TEST_KEY = 'sk-test'
  return fn().finally(() => {
    if (prev === undefined) {
      delete process.env.ORCA_TEST_KEY
    } else {
      process.env.ORCA_TEST_KEY = prev
    }
  })
}

describe('openaiCompatChat', () => {
  test('posts a single user message with json_object + temperature 0', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      const res = await openaiCompatChat(ENTRY, { fetch })('the prompt', DEADLINE())
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.url, 'https://orca.example/v1/chat/completions')
      assert.equal(calls[0]!.init.headers?.authorization, 'Bearer sk-test')
      const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>
      assert.equal(body.model, 'qwen3-coder')
      assert.deepEqual(body.messages, [{ role: 'user', content: 'the prompt' }])
      assert.deepEqual(body.response_format, { type: 'json_object' })
      assert.equal(body.temperature, 0)
      assert.equal(res.content, '{"answers":{}}')
      assert.equal(res.model, 'qwen3-coder-r2')
      assert.equal(res.usage?.inputTokens, 42)
    }))

  test('a wire with no model echoes the sent one; opts.model overrides the pin', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: { choices: OK_BODY.choices } })
      const res = await openaiCompatChat(ENTRY, { fetch })('p', DEADLINE())
      assert.equal(res.model, 'qwen3-coder')
      await openaiCompatChat(ENTRY, { fetch, model: 'other-model' })('p', DEADLINE())
      assert.equal(
        (JSON.parse(calls[1]!.init.body!) as { model: string }).model,
        'other-model'
      )
    }))

  test('no apiKeyEnv means no auth header — some endpoints are open', async () => {
    const open: Extract<ProviderEntry, { type: 'openai-compat' }> = {
      type: 'openai-compat',
      baseUrl: 'http://localhost:8080/v1',
      model: 'm',
    }
    const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
    await openaiCompatChat(open, { fetch })('p', DEADLINE())
    assert.equal(calls[0]!.init.headers?.authorization, undefined)
  })

  test('a missing key fails open naming the field, never the env name', () =>
    withKey(async () => {
      delete process.env.ORCA_TEST_KEY
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      await assert.rejects(
        openaiCompatChat(ENTRY, { fetch, keyField: 'providers.orca.apiKeyEnv' })(
          'p',
          DEADLINE()
        ),
        (e: unknown) =>
          e instanceof JudgeUnavailable &&
          /providers\.orca\.apiKeyEnv/.test((e as Error).message) &&
          !/ORCA_TEST_KEY/.test((e as Error).message)
      )
      assert.equal(calls.length, 0)
    }))

  test('400/404 are the caller\'s bug; everything else is unavailable', () =>
    withKey(async () => {
      for (const status of [400, 404]) {
        const { fetch } = fakeFetch({ status, body: { error: { message: 'bad' } } })
        await assert.rejects(
          openaiCompatChat(ENTRY, { fetch })('p', DEADLINE()),
          (e: unknown) => e instanceof Error && !(e instanceof JudgeUnavailable)
        )
      }
      for (const status of [401, 403]) {
        const { fetch } = fakeFetch({ status, body: { error: { message: 'denied' } } })
        await assert.rejects(
          openaiCompatChat(ENTRY, { fetch })('p', DEADLINE()),
          JudgeUnavailable
        )
      }
    }))

  test('a reply with no message content is JudgeUnavailable — no verdict', () =>
    withKey(async () => {
      const { fetch } = fakeFetch({ status: 200, body: { choices: [] } })
      await assert.rejects(
        openaiCompatChat(ENTRY, { fetch })('p', DEADLINE()),
        JudgeUnavailable
      )
    }))
})

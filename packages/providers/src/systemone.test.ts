import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { JudgeQuestion, ProviderEntry } from '@broject/core'
import { systemoneCall } from './systemone.ts'
import type { FetchFn } from './http.ts'

const ENTRY: Extract<ProviderEntry, { type: 'systemone' }> = {
  type: 'systemone',
  baseUrl: 'https://systemone.example/api',
  apiKeyEnv: 'SYSTEMONE_TEST_KEY',
  model: 'jev-test',
}

interface Call {
  url: string
  init: { headers?: Record<string, string>; body?: string }
}

function fakeFetch(
  ...queue: Array<{ status: number; body: unknown }>
): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Call['init'] })
    const next = queue[Math.min(calls.length - 1, queue.length - 1)]!
    return {
      status: next.status,
      text: async () => JSON.stringify(next.body),
    } as Response
  }) as FetchFn
  return { fetch, calls }
}

const QUESTIONS: Record<string, JudgeQuestion> = {
  route: {
    type: 'choice',
    instructions: 'where?',
    criteria: { a: 'option a', b: 'option b' },
  },
}

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: {
    route: {
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.81,
    },
  },
  usage: { input_tokens: 62 },
}

const DEADLINE = () => Date.now() + 3_000

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.SYSTEMONE_TEST_KEY
  process.env.SYSTEMONE_TEST_KEY = 'ts_live_test'
  return fn().finally(() => {
    if (prev === undefined) {
      delete process.env.SYSTEMONE_TEST_KEY
    } else {
      process.env.SYSTEMONE_TEST_KEY = prev
    }
  })
}

describe('systemoneCall', () => {
  test('decidedBy stamps the caller-chosen provenance', () =>
    withKey(async () => {
      const { fetch } = fakeFetch({ status: 200, body: OK_BODY })
      const res = await systemoneCall('provider:typesafe', ENTRY, { fetch })(
        's',
        QUESTIONS,
        DEADLINE()
      )
      assert.equal(res.answers.route!.decidedBy, 'provider:typesafe')
    }))

  test('the wire carries the entry model; opts.model overrides it', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      await systemoneCall('b', ENTRY, { fetch })('s', QUESTIONS, DEADLINE())
      assert.equal(
        (JSON.parse(calls[0]!.init.body!) as { model: string }).model,
        'jev-test'
      )
      await systemoneCall('b', ENTRY, { fetch, model: 'jev-pinned' })(
        's',
        QUESTIONS,
        DEADLINE()
      )
      assert.equal(
        (JSON.parse(calls[1]!.init.body!) as { model: string }).model,
        'jev-pinned'
      )
    }))

  test('a missing key fails open naming the config FIELD, never the env name', () =>
    withKey(async () => {
      delete process.env.SYSTEMONE_TEST_KEY
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      await assert.rejects(
        systemoneCall('b', ENTRY, { fetch, keyField: 'providers.typesafe.apiKeyEnv' })(
          's',
          QUESTIONS,
          DEADLINE()
        ),
        (e: unknown) =>
          e instanceof JudgeUnavailable &&
          /providers\.typesafe\.apiKeyEnv/.test((e as Error).message) &&
          !/SYSTEMONE_TEST_KEY/.test((e as Error).message)
      )
      assert.equal(calls.length, 0)
    }))

  test('a non-NAME apiKeyEnv is a config bug — a plain error, not fail-open', () =>
    withKey(async () => {
      const bad = { ...ENTRY, apiKeyEnv: 'ts_live_pasted' }
      await assert.rejects(
        systemoneCall('b', bad, { keyField: 'judge.apiKeyEnv' })('s', QUESTIONS, DEADLINE()),
        (e: unknown) =>
          e instanceof Error &&
          !(e instanceof JudgeUnavailable) &&
          /judge\.apiKeyEnv/.test(e.message)
      )
    }))

  test('absent baseUrl falls back to the hosted API; TYPESAFE_BASE_URL overrides both', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      const bare: Extract<ProviderEntry, { type: 'systemone' }> = {
        type: 'systemone',
        apiKeyEnv: 'SYSTEMONE_TEST_KEY',
        model: 'm',
      }
      await systemoneCall('b', bare, { fetch })('s', QUESTIONS, DEADLINE())
      assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone')
      const prev = process.env.TYPESAFE_BASE_URL
      process.env.TYPESAFE_BASE_URL = 'https://proxy.example/'
      try {
        await systemoneCall('b', ENTRY, { fetch })('s', QUESTIONS, DEADLINE())
        assert.equal(calls[1]!.url, 'https://proxy.example/v1/systemone')
      } finally {
        if (prev === undefined) {
          delete process.env.TYPESAFE_BASE_URL
        } else {
          process.env.TYPESAFE_BASE_URL = prev
        }
      }
    }))
})

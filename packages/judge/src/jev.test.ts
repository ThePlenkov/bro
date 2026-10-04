import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { JudgeQuestion } from '@broject/core'
import { jevJudge } from './jev.ts'
import type { JudgeConfig } from './config.ts'
import type { FetchFn } from './http.ts'

const CFG: JudgeConfig = {
  mode: 'off',
  baseUrl: 'https://jev.example/api',
  apiKeyEnv: 'JEV_TEST_KEY',
  confidence: 0.6,
  timeoutMs: 3_000,
  maxDecisionsPerRun: 50,
}

interface Call {
  url: string
  init: { headers?: Record<string, string>; body?: string }
}

/** Scripted transport — records calls, serves each queued response. */
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
  urgency: {
    type: 'score',
    instructions: 'how urgent?',
    criteria: ['low', 'high'],
  },
  escalate: { type: 'noul', instructions: 'escalate?' },
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
    urgency: {
      type: 'score',
      score: 1.8,
      probabilities: { '0': 0.1, '1': 0.9 },
      confidence: 0.8,
    },
    escalate: { type: 'noul', noul: 0.12 },
  },
  usage: { input_tokens: 62, cost_usd: 0.000026 },
}

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.JEV_TEST_KEY
  process.env.JEV_TEST_KEY = 'jv_live_test'
  return fn().finally(() => {
    if (prev === undefined) {
      delete process.env.JEV_TEST_KEY
    } else {
      process.env.JEV_TEST_KEY = prev
    }
  })
}

describe('jevJudge', () => {
  test('maps the three answer types; noul confidence is derived', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      const res = await jevJudge(CFG, { fetch }).decide('state text', { ...QUESTIONS })
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.url, 'https://jev.example/api/v1/decide')
      assert.equal(calls[0]!.init.headers?.authorization, 'Bearer jv_live_test')
      const route = res.answers.route!
      assert.equal(route.type, 'choice')
      assert.equal((route as { choice: string }).choice, 'a')
      assert.equal(route.confidence, 0.81)
      assert.equal(route.decidedBy, 'jev')
      const urg = res.answers.urgency!
      assert.equal(urg.type, 'score')
      assert.equal((urg as { score: number }).score, 1.8)
      const esc = res.answers.escalate!
      assert.equal(esc.type, 'noul')
      assert.equal((esc as { noul: number }).noul, 0.12)
      // a confident "no" is still confident: max(0.12, 0.88)
      assert.equal(esc.confidence, 0.88)
      assert.equal(res.model, 'jev-1.13.0')
      assert.equal(res.usage?.inputTokens, 62)
      assert.equal(res.usage?.costUsd, 0.000026)
    }))

  test('sends model only when configured', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      await jevJudge(CFG, { fetch }).decide('s', { ...QUESTIONS })
      assert.ok(!('model' in JSON.parse(calls[0]!.init.body!)))
      const pinned = { ...CFG, model: 'jev-1.13.0' }
      await jevJudge(pinned, { fetch }).decide('s', { ...QUESTIONS })
      assert.equal(
        (JSON.parse(calls[1]!.init.body!) as { model?: string }).model,
        'jev-1.13.0'
      )
    }))

  test('missing API key fails open — no request leaves the process', () =>
    withKey(async () => {
      delete process.env.JEV_TEST_KEY
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      await assert.rejects(
        jevJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }),
        (e: unknown) => e instanceof JudgeUnavailable && /JEV_TEST_KEY/.test((e as Error).message)
      )
      assert.equal(calls.length, 0)
    }))

  test('401/402 are JudgeUnavailable; 400 is the caller\'s bug — a plain error', () =>
    withKey(async () => {
      for (const [status, kind] of [
        [401, 'unavailable'],
        [403, 'unavailable'],
        [402, 'unavailable'],
        [400, 'error'],
      ] as const) {
        const { fetch } = fakeFetch({ status, body: { error: 'nope' } })
        await assert.rejects(
          jevJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }),
          (e: unknown) =>
            kind === 'unavailable'
              ? e instanceof JudgeUnavailable
              : e instanceof Error && !(e instanceof JudgeUnavailable)
        )
      }
      // max_tokens_exceeded surfaces as an ordinary error — callers trim
      const { fetch } = fakeFetch({
        status: 400,
        body: { error: { code: 'max_tokens_exceeded', message: 'too big' } },
      })
      await assert.rejects(jevJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }), Error)
    }))

  test('502 retries with backoff then succeeds; persistent 502 is JudgeUnavailable', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch(
        { status: 502, body: {} },
        { status: 200, body: OK_BODY }
      )
      const res = await jevJudge(CFG, { fetch }).decide('s', { ...QUESTIONS })
      assert.equal(calls.length, 2)
      assert.equal(res.model, 'jev-1.13.0')

      const dead = fakeFetch({ status: 502, body: {} })
      await assert.rejects(
        jevJudge(CFG, { fetch: dead.fetch }).decide('s', { ...QUESTIONS }),
        JudgeUnavailable
      )
      assert.equal(dead.calls.length, 3)
    }))

  test('a malformed answer is JudgeUnavailable — drift fails open', () =>
    withKey(async () => {
      const { fetch } = fakeFetch({
        status: 200,
        body: { model: 'm', answers: { escalate: { type: 'noul' } } },
      })
      await assert.rejects(
        jevJudge(CFG, { fetch }).decide('s', { escalate: QUESTIONS.escalate }),
        JudgeUnavailable
      )
    }))

  test('decideWithin honors a spent budget before any fetch', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: OK_BODY })
      await assert.rejects(
        jevJudge(CFG, { fetch }).decideWithin('s', { ...QUESTIONS }, Date.now() - 1),
        JudgeUnavailable
      )
      assert.equal(calls.length, 0)
    }))
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { JudgeQuestion } from '@broject/core'
import { llmJudge } from './llm-judge.ts'
import type { JudgeConfig } from './config.ts'
import type { FetchFn } from './http.ts'

const CFG: JudgeConfig = {
  mode: 'off',
  model: 'jev-test',
  baseUrl: 'https://systemone.example/api',
  apiKeyEnv: 'SYSTEMONE_TEST_KEY',
  confidence: 0.6,
  timeoutMs: 3_000,
  maxDecisionsPerRun: 50,
  llm: {
    baseUrl: 'https://llm.example/v1',
    model: 'test-model',
    apiKeyEnv: 'LLM_TEST_KEY',
  },
}

function fakeFetch(
  status: number,
  body: unknown
): { fetch: FetchFn; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), body: JSON.parse((init as { body: string }).body) })
    return {
      status,
      text: async () => JSON.stringify(body),
    } as Response
  }) as FetchFn
  return { fetch, calls }
}

const chatBody = (answers: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'test-model-r1',
  choices: [
    {
      message: {
        content: typeof answers === 'string' ? answers : JSON.stringify({ answers }),
      },
    },
  ],
  usage: { prompt_tokens: 42, completion_tokens: 10 },
  ...extra,
})

const QUESTIONS: Record<string, JudgeQuestion> = {
  route: {
    type: 'choice',
    instructions: 'where?',
    criteria: { a: 'option a', b: 'option b' },
  },
  urgency: { type: 'score', instructions: 'how urgent?', criteria: ['low', 'high'] },
  escalate: { type: 'noul', instructions: 'escalate?' },
}

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.LLM_TEST_KEY
  process.env.LLM_TEST_KEY = 'sk-test'
  return fn().finally(() => {
    if (prev === undefined) {
      delete process.env.LLM_TEST_KEY
    } else {
      process.env.LLM_TEST_KEY = prev
    }
  })
}

describe('llmJudge', () => {
  test('maps a JSON reply onto typed answers, decidedBy llm-judge', () =>
    withKey(async () => {
      const { fetch, calls } = fakeFetch(
        200,
        chatBody({
          route: { type: 'choice', choice: 'b', confidence: 0.7 },
          urgency: { type: 'score', score: 0.8, confidence: 0.66 },
          escalate: { type: 'noul', noul: 0.9, confidence: 0.8 },
        })
      )
      const res = await llmJudge(CFG, { fetch }).decide('state', { ...QUESTIONS })
      assert.equal(calls[0]!.url, 'https://llm.example/v1/chat/completions')
      assert.equal((calls[0]!.body as { model: string }).model, 'test-model')
      assert.equal(res.answers.route!.type, 'choice')
      assert.equal((res.answers.route as { choice: string }).choice, 'b')
      assert.equal(res.answers.route!.decidedBy, 'llm-judge')
      assert.equal(res.answers.route!.confidence, 0.7)
      assert.equal(res.answers.urgency!.type, 'score')
      assert.equal((res.answers.urgency as { score: number }).score, 0.8)
      assert.equal(res.answers.escalate!.type, 'noul')
      assert.equal(res.usage?.inputTokens, 42)
      assert.equal(res.model, 'test-model-r1')
    }))

  test('absent confidence maps to 0.5 — never fabricated high', () =>
    withKey(async () => {
      const { fetch } = fakeFetch(
        200,
        chatBody({ escalate: { type: 'noul', noul: 0.9 } })
      )
      const res = await llmJudge(CFG, { fetch }).decide('s', {
        escalate: QUESTIONS.escalate,
      })
      assert.equal(res.answers.escalate!.confidence, 0.5)
    }))

  test('off-criteria choices and missing answers are omitted, not thrown', () =>
    withKey(async () => {
      const { fetch } = fakeFetch(
        200,
        chatBody({
          route: { type: 'choice', choice: 'not-an-option', confidence: 0.9 },
          escalate: { type: 'noul', noul: 0.3 },
          // urgency unanswered
        })
      )
      const res = await llmJudge(CFG, { fetch }).decide('s', { ...QUESTIONS })
      assert.equal(res.answers.route, undefined)
      assert.equal(res.answers.urgency, undefined)
      assert.equal(res.answers.escalate!.type, 'noul')
    }))

  test('unparseable reply is JudgeUnavailable — no verdict, never a gate input', () =>
    withKey(async () => {
      const { fetch } = fakeFetch(200, chatBody('not json at all'))
      await assert.rejects(
        llmJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }),
        JudgeUnavailable
      )
    }))

  test('401/403/429 are JudgeUnavailable; 400 is the caller\'s bug', () =>
    withKey(async () => {
      for (const status of [401, 403, 429]) {
        const { fetch } = fakeFetch(status, { error: { message: 'denied' } })
        await assert.rejects(
          llmJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }),
          JudgeUnavailable
        )
      }
      const { fetch } = fakeFetch(400, { error: { message: 'bad request' } })
      await assert.rejects(
        llmJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }),
        (e: unknown) => e instanceof Error && !(e instanceof JudgeUnavailable)
      )
    }))

  test('missing judge.llm config is JudgeUnavailable', async () => {
    const bare = { ...CFG }
    delete bare.llm
    await assert.rejects(
      llmJudge(bare).decide('s', { ...QUESTIONS }),
      JudgeUnavailable
    )
  })

  test('missing api key env is JudgeUnavailable — no request leaves', () =>
    withKey(async () => {
      delete process.env.LLM_TEST_KEY
      const { fetch, calls } = fakeFetch(200, chatBody({}))
      await assert.rejects(
        llmJudge(CFG, { fetch }).decide('s', { ...QUESTIONS }),
        (e: unknown) =>
          // the message names the config field, never the configured
          // value — an all-caps pasted key would echo the secret
          e instanceof JudgeUnavailable && !/LLM_TEST_KEY/.test((e as Error).message)
      )
      assert.equal(calls.length, 0)
    }))
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JudgeUnavailable, UnknownProviderError } from '@broject/core'
import type { JudgeQuestion, ProviderEntry } from '@broject/core'
import { judgeFacade } from './chain.ts'
import type { JudgeConfig } from './config.ts'
import type { FetchFn } from './http.ts'
import {
  providerJudge,
  providerJudgeAuth,
  synthesizedProviders,
} from './provider-judge.ts'

const CFG: JudgeConfig = {
  mode: 'off',
  model: 'jev-test',
  baseUrl: 'https://systemone.example/api',
  apiKeyEnv: 'SYSTEMONE_TEST_KEY',
  confidence: 0.6,
  timeoutMs: 3_000,
  maxDecisionsPerRun: 50,
  provided: [],
}

const QUESTIONS: Record<string, JudgeQuestion> = {
  route: {
    type: 'choice',
    instructions: 'where?',
    criteria: { a: 'option a', b: 'option b' },
  },
}

const TYPED_BODY = {
  model: 'jev-1.13.0',
  answers: {
    route: {
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.81,
    },
  },
}

const chatBody = (answers: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'chat-model-r1',
  choices: [
    { message: { content: JSON.stringify({ answers }) } },
  ],
  ...extra,
})

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

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  return fn().finally(() => {
    if (prev === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = prev
    }
  })
}

/** A tmpdir holding just a bro.config.json — judgeConfig reads it
 *  through the same loadConfig the CLI uses. */
function withConfig(config: unknown, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-provider-judge-'))
  writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(config))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('providerJudge', () => {
  test('a systemone entry decides typed answers stamped provider:<name>', () =>
    withEnv('TYPESAFE_TEST_KEY', 'ts_live_test', async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: TYPED_BODY })
      const entry: ProviderEntry = {
        type: 'systemone',
        apiKeyEnv: 'TYPESAFE_TEST_KEY',
        model: 'jev-1.13.0',
      }
      const res = await providerJudge('typesafe', entry, CFG, { fetch }).decide(
        's',
        QUESTIONS
      )
      assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone')
      assert.equal(res.answers.route!.decidedBy, 'provider:typesafe')
      assert.equal(res.model, 'jev-1.13.0')
    }))

  test('an openai-compat entry is a prose call — decidedBy still names the provider', () =>
    withEnv('ORCA_TEST_KEY', 'sk-test', async () => {
      const { fetch, calls } = fakeFetch({
        status: 200,
        body: chatBody({
          route: { type: 'choice', choice: 'b', confidence: 0.7 },
        }),
      })
      const entry: ProviderEntry = {
        type: 'openai-compat',
        baseUrl: 'https://orca.example/v1',
        apiKeyEnv: 'ORCA_TEST_KEY',
        model: 'qwen3-coder',
      }
      const res = await providerJudge('orca', entry, CFG, { fetch }).decide('s', QUESTIONS)
      assert.equal(calls[0]!.url, 'https://orca.example/v1/chat/completions')
      assert.equal(res.answers.route!.decidedBy, 'provider:orca')
      assert.equal(res.answers.route!.confidence, 0.7)
      assert.equal(res.model, 'chat-model-r1')
    }))

  test('judge.model overrides the entry pin only when the user wrote it', () =>
    withEnv('TYPESAFE_TEST_KEY', 'k', async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: TYPED_BODY })
      const entry: ProviderEntry = {
        type: 'systemone',
        apiKeyEnv: 'TYPESAFE_TEST_KEY',
        model: 'jev-entry',
      }
      await providerJudge('t', entry, CFG, { fetch }).decide('s', QUESTIONS)
      assert.equal(
        (JSON.parse(calls[0]!.init.body!) as { model: string }).model,
        'jev-entry'
      )
      const wrote = { ...CFG, model: 'jev-override', provided: ['model'] as const }
      await providerJudge('t', entry, wrote, { fetch }).decide('s', QUESTIONS)
      assert.equal(
        (JSON.parse(calls[1]!.init.body!) as { model: string }).model,
        'jev-override'
      )
    }))

  test('a kind with no binding yet is a startup error naming provider + kind', () => {
    const entry: ProviderEntry = { type: 'acp', command: 'kilo --acp' }
    assert.throws(
      () => providerJudge('kilo', entry, CFG),
      /providers\.kilo \(type 'acp'\) has no client binding yet/
    )
  })
})

describe('synthesizedProviders', () => {
  test('legacy judge.* materializes under the connector aliases', () => {
    const cfg = {
      ...CFG,
      llm: { baseUrl: 'https://llm.example/v1', model: 'm', apiKeyEnv: 'K' },
    }
    const out = synthesizedProviders(cfg, {})
    assert.deepEqual(out.systemone, {
      type: 'systemone',
      baseUrl: 'https://systemone.example/api',
      apiKeyEnv: 'SYSTEMONE_TEST_KEY',
      model: 'jev-test',
    })
    assert.deepEqual(out['llm-judge'], {
      type: 'openai-compat',
      baseUrl: 'https://llm.example/v1',
      apiKeyEnv: 'K',
      model: 'm',
    })
  })

  test('a named entry wins over the synthesized alias — the user claimed it', () => {
    const mine: ProviderEntry = {
      type: 'openai-compat',
      baseUrl: 'https://my-systemone-mirror.example/v1',
      model: 'mine',
    }
    const out = synthesizedProviders(CFG, { systemone: mine })
    assert.equal(out.systemone, mine)
  })

  test('no judge.llm, no llm-judge alias', () => {
    const out = synthesizedProviders(CFG, {})
    assert.equal(out['llm-judge'], undefined)
  })
})

describe('providerJudgeAuth', () => {
  test('no apiKeyEnv means no auth to probe', () => {
    assert.equal(
      providerJudgeAuth('cli', { type: 'cli', command: 'x' }),
      null
    )
  })

  test('missing env names the field, never the var name', async () => {
    await withEnv('MISSING_PROVIDER_KEY', undefined, async () => {
      const msg = providerJudgeAuth('typesafe', {
        type: 'systemone',
        apiKeyEnv: 'MISSING_PROVIDER_KEY',
        model: 'm',
      })
      assert.match(msg!, /providers\.typesafe\.apiKeyEnv/)
      assert.doesNotMatch(msg!, /MISSING_PROVIDER_KEY/)
    })
    await withEnv('PRESENT_PROVIDER_KEY', 'v', async () => {
      assert.equal(
        providerJudgeAuth('typesafe', {
          type: 'systemone',
          apiKeyEnv: 'PRESENT_PROVIDER_KEY',
          model: 'm',
        }),
        null
      )
    })
  })
})

describe('judgeFacade provider mode', () => {
  test('judge.provider resolves the registry entry — no connector involved', () =>
    withEnv('TYPESAFE_TEST_KEY', 'k', async () => {
      await withConfig(
        {
          providers: {
            typesafe: {
              type: 'systemone',
              apiKeyEnv: 'TYPESAFE_TEST_KEY',
              model: 'jev-1.13.0',
            },
          },
          judge: { provider: 'typesafe' },
        },
        async (dir) => {
          const { fetch, calls } = fakeFetch({ status: 200, body: TYPED_BODY })
          const res = await judgeFacade(dir, { fetch }).decide('s', QUESTIONS)
          assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone')
          assert.equal(res.answers.route!.decidedBy, 'provider:typesafe')
        }
      )
    }))

  test('an unknown provider name is a startup error, never a fallthrough', () =>
    withConfig({ judge: { provider: 'nope' } }, async (dir) => {
      assert.throws(
        () => judgeFacade(dir),
        (e: unknown) => e instanceof UnknownProviderError && /providers\.nope/.test(e.message)
      )
    }))

  test('judge.fallback in provider mode names a provider — incl. the llm-judge alias', () =>
    withEnv('TYPESAFE_TEST_KEY', 'k', async () =>
      withConfig(
        {
          providers: {
            typesafe: {
              type: 'systemone',
              apiKeyEnv: 'TYPESAFE_TEST_KEY',
              model: 'jev-1.13.0',
            },
          },
          judge: {
            provider: 'typesafe',
            fallback: 'llm-judge',
            confidence: 0.9,
            llm: { baseUrl: 'https://llm.example/v1', model: 'm' },
          },
        },
        async (dir) => {
          const { fetch, calls } = fakeFetch(
            // primary answers under the 0.9 threshold → escalation
            {
              status: 200,
              body: {
                model: 'jev-1.13.0',
                answers: {
                  route: {
                    type: 'choice',
                    choice: 'a',
                    probabilities: { a: 0.5, b: 0.5 },
                    confidence: 0.5,
                  },
                },
              },
            },
            {
              status: 200,
              body: chatBody({
                route: { type: 'choice', choice: 'a', confidence: 0.95 },
              }),
            }
          )
          // the llm-judge alias is a synthesized entry — resolving it
          // consumes legacy judge.llm config, so the deprecation line
          // lands once even in provider mode
          const stderr: string[] = []
          const orig = console.error
          console.error = (...a: unknown[]) => stderr.push(a.map(String).join(' '))
          try {
            const res = await judgeFacade(dir, { fetch }).decide('s', QUESTIONS)
            assert.equal(calls.length, 2)
            assert.equal(calls[1]!.url, 'https://llm.example/v1/chat/completions')
            assert.equal(res.answers.route!.decidedBy, 'provider:llm-judge')
            assert.equal(res.answers.route!.confidence, 0.95)
          } finally {
            console.error = orig
          }
          assert.ok(
            stderr.some((l) => /deprecated/.test(l) && /judge\.provider/.test(l)),
            `expected a deprecation line — got: ${stderr.join(' | ') || '(none)'}`
          )
        }
      )
    ))
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JudgeUnavailable, UnknownProviderError } from '@broject/core'
import type { JudgeQuestion, ProviderEntry } from '@broject/core'
import { judgeFacade } from './chain.ts'
import type { JudgeConfig } from './config.ts'
import { fakeAcpAgent, fakeFetch } from '@broject/providers'
import {
  providerJudge,
  providerJudgeAuth,
  providerKeyField,
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

/** A category:"model" select option advertising exactly `value`. */
const modelOption = (value: string) => ({
  type: 'select' as const,
  id: 'm',
  name: 'Model',
  category: 'model' as const,
  currentValue: value,
  options: [{ value, name: value }],
})

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
        type: 'api',
        baseUrl: 'https://api.typesafe.ai',
        apiKeyEnv: 'TYPESAFE_TEST_KEY',
        models: { ['jev-1.13.0']: 'systemone' },
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
        type: 'api',
        baseUrl: 'https://orca.example/v1',
        apiKeyEnv: 'ORCA_TEST_KEY',
        models: { ['qwen3-coder']: 'openai-compat' },
      }
      const res = await providerJudge('orca', entry, CFG, { fetch }).decide('s', QUESTIONS)
      assert.equal(calls[0]!.url, 'https://orca.example/v1/chat/completions')
      // an api host serves both wires — the :prose stamp keeps a
      // prompt-and-parsed answer out of the provider's typed bucket
      assert.equal(res.answers.route!.decidedBy, 'provider:orca:prose')
      assert.equal(res.answers.route!.confidence, 0.7)
      assert.equal(res.model, 'chat-model-r1')
    }))

  test('opts.model overrides the entry pin; absent, the pin stands', () =>
    withEnv('TYPESAFE_TEST_KEY', 'k', async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: TYPED_BODY })
      const entry: ProviderEntry = {
        type: 'api',
        baseUrl: 'https://api.typesafe.ai',
        apiKeyEnv: 'TYPESAFE_TEST_KEY',
        model: 'jev-entry',
        models: { 'jev-entry': 'systemone', 'jev-override': 'systemone' },
      }
      await providerJudge('t', entry, CFG, { fetch }).decide('s', QUESTIONS)
      assert.equal(
        (JSON.parse(calls[0]!.init.body!) as { model: string }).model,
        'jev-entry'
      )
      await providerJudge('t', entry, CFG, { fetch, model: 'jev-override' }).decide(
        's',
        QUESTIONS
      )
      assert.equal(
        (JSON.parse(calls[1]!.init.body!) as { model: string }).model,
        'jev-override'
      )
    }))

  test('a cli entry is a prose call — the command runs the prompt file, stdout parses', async () => {
    const entry: ProviderEntry = {
      type: 'cli',
      // the prompt file arg lands harmlessly — node -e ignores extra argv
      command: `node -e 'console.log(JSON.stringify({answers:{route:{type:"choice",choice:"a",probabilities:{a:0.9,b:0.1},confidence:0.8}}}))'`,
      model: 'devin-1',
    }
    const res = await providerJudge('local', entry, CFG).decide('s', QUESTIONS)
    const route = res.answers.route
    assert.ok(route?.type === 'choice')
    assert.equal(route.choice, 'a')
    // always-prose kinds need no :prose marker — the kind says the grade
    assert.equal(route.decidedBy, 'provider:local')
    assert.equal(res.model, 'devin-1')
  })

  test('an acp entry on a systemone-family model is a typed call', async () => {
    const peer = fakeAcpAgent({
      replyText: JSON.stringify({
        answers: {
          route: {
            type: 'choice',
            choice: 'a',
            probabilities: { a: 0.9, b: 0.1 },
            confidence: 0.9,
          },
        },
      }),
      configOptions: [modelOption('typesafe/jev-1.13')],
    })
    const entry: ProviderEntry = {
      type: 'acp',
      command: 'kilo --acp',
      model: 'typesafe/jev-1.13',
    }
    const res = await providerJudge('kilo', entry, CFG, {
      acp: { peer: peer.app },
    }).decide('s', QUESTIONS)
    assert.equal(res.answers.route!.decidedBy, 'provider:kilo')
    assert.equal(res.answers.route!.confidence, 0.9)
  })

  test('an acp entry on a prose model flags decidedBy :prose — uncalibrated', async () => {
    const peer = fakeAcpAgent({
      replyText: JSON.stringify({
        answers: { route: { type: 'choice', choice: 'b', confidence: 0.7 } },
      }),
      configOptions: [modelOption('qwen3-coder')],
    })
    const entry: ProviderEntry = {
      type: 'acp',
      command: 'kilo --acp',
      model: 'qwen3-coder',
    }
    const res = await providerJudge('kilo', entry, CFG, {
      acp: { peer: peer.app },
    }).decide('s', QUESTIONS)
    // parsed answers never share the provider's typed bucket in stats
    assert.equal(res.answers.route!.decidedBy, 'provider:kilo:prose')
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
        type: 'api',
        baseUrl: 'https://systemone.example/api',
        apiKeyEnv: 'SYSTEMONE_TEST_KEY',
        models: { ['jev-test']: 'systemone' },
      })
    assert.deepEqual(out['llm-judge'], {
        type: 'api',
        baseUrl: 'https://llm.example/v1',
        apiKeyEnv: 'K',
        models: { ['m']: 'openai-compat' },
      })
  })

  test('a named entry wins over the synthesized alias — the user claimed it', () => {
    const mine: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://my-systemone-mirror.example/v1',
      models: { ['mine']: 'openai-compat' },
    }
    const out = synthesizedProviders(CFG, { systemone: mine })
    assert.equal(out.systemone, mine)
  })

  test('no judge.llm, no llm-judge alias', () => {
    const out = synthesizedProviders(CFG, {})
    assert.equal(out['llm-judge'], undefined)
  })
})

describe('providerKeyField', () => {
  test('synthesized aliases name the legacy field that feeds them', () => {
    assert.equal(providerKeyField('systemone', {}), 'judge.apiKeyEnv')
    assert.equal(providerKeyField('llm-judge', {}), 'judge.llm.apiKeyEnv')
    assert.equal(
      providerKeyField('typesafe', {}),
      'providers.typesafe.apiKeyEnv'
    )
    // a user-defined entry claimed the alias — its registry path is real
    const mine: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://api.typesafe.ai',
      apiKeyEnv: 'K',
      models: { ['m']: 'systemone' },
    }
    assert.equal(
      providerKeyField('systemone', { systemone: mine }),
      'providers.systemone.apiKeyEnv'
    )
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
          type: 'api',
          baseUrl: 'https://api.typesafe.ai',
          apiKeyEnv: 'MISSING_PROVIDER_KEY',
          models: { ['m']: 'systemone' },
        })
      assert.match(msg!, /providers\.typesafe\.apiKeyEnv/)
      assert.doesNotMatch(msg!, /MISSING_PROVIDER_KEY/)
    })
    await withEnv('PRESENT_PROVIDER_KEY', 'v', async () => {
      assert.equal(
        providerJudgeAuth('typesafe', {
            type: 'api',
            baseUrl: 'https://api.typesafe.ai',
            apiKeyEnv: 'PRESENT_PROVIDER_KEY',
            models: { ['m']: 'systemone' },
          }),
        null
      )
    })
  })

  test('a configured apiKeyCommand satisfies auth — the env var is not probed', async () => {
    await withEnv('MISSING_PROVIDER_KEY', undefined, async () => {
      assert.equal(
        providerJudgeAuth('typesafe', {
            type: 'api',
            baseUrl: 'https://api.typesafe.ai',
            apiKeyEnv: 'MISSING_PROVIDER_KEY',
            apiKeyCommand: 'pass show bro/typesafe',
            models: { ['m']: 'systemone' },
          }),
        null
      )
    })
  })

  test('a synthesized alias names its legacy field — the registry path does not exist', async () => {
    await withEnv('TYPESAFE_API_KEY', undefined, async () => {
      const msg = providerJudgeAuth(
        'systemone',
        {
   type: 'api',
   baseUrl: 'https://api.typesafe.ai',
   apiKeyEnv: 'TYPESAFE_API_KEY',
   models: { ['m']: 'systemone' },
 },
        providerKeyField('systemone', {})
      )
      assert.match(msg!, /judge\.apiKeyEnv/)
      assert.doesNotMatch(msg!, /providers\./)
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
                type: 'api',
                baseUrl: 'https://api.typesafe.ai',
                apiKeyEnv: 'TYPESAFE_TEST_KEY',
                models: { ['jev-1.13.0']: 'systemone' },
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
                type: 'api',
                baseUrl: 'https://api.typesafe.ai',
                apiKeyEnv: 'TYPESAFE_TEST_KEY',
                models: { 'jev-entry-pin': 'systemone', 'jev-override': 'systemone' },
              },
          },
          judge: {
            provider: 'typesafe',
            fallback: 'llm-judge',
            model: 'jev-override',
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
            // judge.model overrides the primary's pin — the fallback's
            // pin ('m' from judge.llm) is its own contract, untouched
            assert.equal(
              (JSON.parse(calls[0]!.init.body!) as { model: string }).model,
              'jev-override'
            )
            assert.equal(
              (JSON.parse(calls[1]!.init.body!) as { model: string }).model,
              'm'
            )
            assert.equal(calls[1]!.url, 'https://llm.example/v1/chat/completions')
            // the alias serves on the openai-compat wire — :prose keeps
            // the prompt-and-parsed answer out of any typed bucket
            assert.equal(res.answers.route!.decidedBy, 'provider:llm-judge:prose')
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

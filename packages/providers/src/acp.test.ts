import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AuthMethod, SessionConfigOption } from '@agentclientprotocol/sdk'
import { JudgeUnavailable } from '@broject/core'
import type { JudgeQuestion, ProviderEntry } from '@broject/core'
import { acpClient, isSystemoneFamily } from './acp.ts'
import { providerClient } from './registry.ts'
import { fakeAcpAgent } from './testkit.ts'

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>

const QUESTIONS: Record<string, JudgeQuestion> = {
  route: {
    type: 'choice',
    instructions: 'where?',
    criteria: { a: 'option a', b: 'option b' },
  },
  blocks: { type: 'noul', instructions: 'blocking?' },
}

const TYPED_REPLY = JSON.stringify({
  model: 'typesafe/jev-1.13',
  answers: {
    route: {
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.85,
    },
    blocks: { type: 'noul', noul: 0.7 },
  },
})

const MODEL_OPTION: SessionConfigOption = {
  type: 'select',
  id: 'model-pick',
  name: 'Model',
  category: 'model',
  currentValue: 'typesafe/jev-1.13',
  options: [
    { value: 'typesafe/jev-1.13', name: 'jev' },
    { value: 'qwen3-coder', name: 'qwen' },
  ],
}

const deadline = (ms = 10_000): number => Date.now() + ms

describe('isSystemoneFamily', () => {
  test('typesafe/jev-* and bare jev-* are family; others and absent are not', () => {
    assert.equal(isSystemoneFamily('typesafe/jev-1.13'), true)
    assert.equal(isSystemoneFamily('jev-1.13.0'), true)
    assert.equal(isSystemoneFamily('qwen3-coder'), false)
    assert.equal(isSystemoneFamily('other/jev-1'), false)
    assert.equal(isSystemoneFamily(undefined), false)
  })
})

describe('acpClient surface split', () => {
  const entry: AcpEntry = { type: 'acp', command: 'kilo --acp' }

  test('a systemone-family model binds the typed call surface', () => {
    const client = acpClient('provider:kilo', { ...entry, model: 'typesafe/jev-1.13' })
    assert.equal(typeof client.call, 'function')
    assert.equal(client.chat, undefined)
  })

  test('a prose model binds the chat surface', () => {
    const client = acpClient('provider:kilo', { ...entry, model: 'qwen3-coder' })
    assert.equal(typeof client.chat, 'function')
    assert.equal(client.call, undefined)
  })

  test('no model pin → prose — an unknown model is never trusted typed', () => {
    const client = acpClient('provider:kilo', entry)
    assert.equal(typeof client.chat, 'function')
    assert.equal(client.call, undefined)
  })

  test('opts.model wins over the entry pin for the grade decision', () => {
    const client = acpClient('provider:kilo', { ...entry, model: 'typesafe/jev-1.13' }, {
      model: 'qwen3-coder',
      acp: { peer: fakeAcpAgent().app },
    })
    assert.equal(client.chat !== undefined, true)
    assert.equal(client.call, undefined)
  })
})

describe('acp call surface — typed mode', () => {
  const entry: AcpEntry = {
    type: 'acp',
    command: 'kilo --acp',
    model: 'typesafe/jev-1.13',
  }

  test('a typed reply maps to typed answers stamped provider:<name>', async () => {
    const fake = fakeAcpAgent({ replyText: TYPED_REPLY, configOptions: [MODEL_OPTION] })
    const res = await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      { note: 'state' },
      QUESTIONS,
      deadline()
    )
    assert.equal(res.answers.route!.type, 'choice')
    assert.equal(res.answers.route!.decidedBy, 'provider:kilo')
    assert.equal(res.answers.route!.confidence, 0.85)
    assert.equal(res.answers.blocks!.type, 'noul')
    // the reply's own model report wins over the observed pin
    assert.equal(res.model, 'typesafe/jev-1.13')
  })

  test('the prompt carries {state, questions} as JSON', async () => {
    const fake = fakeAcpAgent({ replyText: TYPED_REPLY, configOptions: [MODEL_OPTION] })
    await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      'the-state',
      QUESTIONS,
      deadline()
    )
    const sent = JSON.parse(fake.prompts[0]!) as Record<string, unknown>
    assert.equal(sent.state, 'the-state')
    assert.deepEqual(Object.keys(sent.questions as object), ['route', 'blocks'])
  })

  test('the model rides session/set_config_option on the category:model option', async () => {
    const fake = fakeAcpAgent({ replyText: TYPED_REPLY, configOptions: [MODEL_OPTION] })
    await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      's',
      QUESTIONS,
      deadline()
    )
    assert.deepEqual(fake.configSets, [{ configId: 'model-pick', value: 'typesafe/jev-1.13' }])
  })

  test('a requested model with no advertised option fails — never silently unpinned', async () => {
    const fake = fakeAcpAgent({ replyText: TYPED_REPLY })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof JudgeUnavailable) &&
        /provider:kilo/.test(e.message) &&
        /typesafe\/jev-1\.13/.test(e.message) &&
        /no model config option/.test(e.message)
    )
    assert.equal(fake.prompts.length, 0)
  })

  test('an agent requiring interactive auth is a startup error naming the methods', async () => {
    const fake = fakeAcpAgent({
      authMethods: [{ id: 'oauth', name: 'OAuth' } as AuthMethod],
      configOptions: [MODEL_OPTION],
    })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      (e: unknown) =>
        e instanceof Error && !(e instanceof JudgeUnavailable) && /oauth/.test(e.message)
    )
  })

  test('a non-end_turn stop fails open — JudgeUnavailable, never a verdict', async () => {
    const fake = fakeAcpAgent({ stopReason: 'refusal', replyText: 'no', configOptions: [MODEL_OPTION] })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      (e: unknown) => e instanceof JudgeUnavailable && /refusal/.test(e.message)
    )
  })

  test('a non-JSON reply is JudgeUnavailable — prose is not a typed answer', async () => {
    const fake = fakeAcpAgent({ replyText: 'looks fine to me', configOptions: [MODEL_OPTION] })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      JudgeUnavailable
    )
  })

  test('a malformed typed answer fails open naming the question', async () => {
    const bad = JSON.stringify({ answers: { route: { type: 'noul', noul: 0.5 } } })
    const fake = fakeAcpAgent({ replyText: bad, configOptions: [MODEL_OPTION] })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      (e: unknown) => e instanceof JudgeUnavailable && /route/.test(e.message)
    )
  })

  test('an already-spent deadline fails before any session work', async () => {
    const fake = fakeAcpAgent({ replyText: TYPED_REPLY })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
        's',
        QUESTIONS,
        Date.now() - 1
      ),
      JudgeUnavailable
    )
    assert.equal(fake.sessions.length, 0)
  })
})

describe('acp chat surface — prose mode', () => {
  const entry: AcpEntry = { type: 'acp', command: 'kilo --acp', model: 'qwen3-coder' }

  test('the rendered prompt goes in; the agent text comes out raw', async () => {
    const fake = fakeAcpAgent({
      replyText: '{"answers":{"route":{"type":"choice","choice":"b","confidence":0.6}}}',
      configOptions: [MODEL_OPTION],
    })
    const res = await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).chat!(
      'rendered prompt text',
      deadline()
    )
    assert.equal(fake.prompts[0], 'rendered prompt text')
    assert.match(res.content, /"route"/)
    // currentValue observed after set_config_option is the provenance
    assert.equal(res.model, 'qwen3-coder')
  })

  test('no model pin → no set_config_option; the session value is provenance', async () => {
    const fake = fakeAcpAgent({ replyText: 'answer', configOptions: [MODEL_OPTION] })
    const res = await acpClient('provider:kilo', { type: 'acp', command: 'kilo --acp' }, { acp: { peer: fake.app } }).chat!(
      'p',
      deadline()
    )
    assert.equal(fake.configSets.length, 0)
    assert.equal(res.model, 'typesafe/jev-1.13')
  })
})

describe('providerClient wiring', () => {
  test('an acp entry binds through the registry — call or chat by model', () => {
    const typed = providerClient('kilo', {
      type: 'acp',
      command: 'kilo --acp',
      model: 'typesafe/jev-1.13',
    })
    assert.equal(typeof typed.call, 'function')
    const prose = providerClient('kilo', { type: 'acp', command: 'kilo --acp' })
    assert.equal(typeof prose.chat, 'function')
  })

  test('cli is still the unbound kind — startup error naming provider + kind', () => {
    assert.throws(
      () => providerClient('d', { type: 'cli', command: 'devin -p' }),
      /providers\.d \(type 'cli'\) has no client binding yet/
    )
  })
})

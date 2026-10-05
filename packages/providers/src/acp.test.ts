import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthMethod, SessionConfigOption } from '@agentclientprotocol/sdk'
import { JudgeUnavailable } from '@broject/core'
import type { JudgeQuestion, ProviderEntry } from '@broject/core'
import { acpClient, isSystemoneFamily, shellWords } from './acp.ts'
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

describe('shellWords', () => {
  test('splits whitespace, honors quotes and escapes, no expansion', () => {
    assert.deepEqual(shellWords('kilo --acp'), ['kilo', '--acp'])
    assert.deepEqual(shellWords('  a   b  '), ['a', 'b'])
    assert.deepEqual(shellWords(`bin "arg with spaces" x`), ['bin', 'arg with spaces', 'x'])
    assert.deepEqual(shellWords(`bin 'a b'`), ['bin', 'a b'])
    assert.deepEqual(shellWords(String.raw`bin a\ b`), ['bin', 'a b'])
    assert.deepEqual(shellWords('bin "" tail'), ['bin', '', 'tail'])
    // no shell: metacharacters stay literal argv, never re-parse
    assert.deepEqual(shellWords('bin $HOME; rm -rf / | cat'), [
      'bin', '$HOME;', 'rm', '-rf', '/', '|', 'cat',
    ])
  })
  test('unclosed quote and empty command are config errors', async () => {
    assert.throws(() => shellWords(`bin 'oops`), /unclosed/)
    await assert.rejects(
      acpClient('provider:x', { type: 'acp', command: '   ' }).chat!(
        'p',
        deadline()
      ),
      /command is empty/
    )
  })
})

describe('isSystemoneFamily', () => {
  test('typesafe/jev-* and bare jev-* are family; others and absent are not', () => {
    assert.equal(isSystemoneFamily('typesafe/jev-1.13'), true)
    assert.equal(isSystemoneFamily('jev-1.13.0'), true)
    assert.equal(isSystemoneFamily('jev-latest'), true)
    // router-prefixed ids kilo serves — the upstream jev model reached
    // through orcarouter is still the typed contract
    assert.equal(isSystemoneFamily('kilo/orcarouter/typesafe/jev-1.13'), true)
    // jev-router is a router product, not a jev model — never family
    assert.equal(isSystemoneFamily('kilo/typesafe/jev-router'), false)
    assert.equal(isSystemoneFamily('typesafe/jev-router'), false)
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

  test('the prompt carries the typed contract + {state, questions} as JSON', async () => {
    const fake = fakeAcpAgent({ replyText: TYPED_REPLY, configOptions: [MODEL_OPTION] })
    await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      'the-state',
      QUESTIONS,
      deadline()
    )
    const [preamble, body] = fake.prompts[0]!.split('BODY:\n')
    assert.match(preamble!, /System One decision endpoint/)
    const sent = JSON.parse(body!) as Record<string, unknown>
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

  test('advertised authMethods do not gate the call — stored creds may already cover it', async () => {
    const fake = fakeAcpAgent({
      authMethods: [{ id: 'oauth', name: 'OAuth' } as AuthMethod],
      replyText: TYPED_REPLY,
      configOptions: [MODEL_OPTION],
    })
    const res = await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      's',
      QUESTIONS,
      deadline()
    )
    assert.equal(res.answers.blocks!.type, 'noul')
    assert.equal(fake.prompts.length, 1)
  })

  test('a prompt-time auth failure is a startup error naming the methods', async () => {
    const fake = fakeAcpAgent({
      authMethods: [{ id: 'oauth', name: 'OAuth' } as AuthMethod],
      configOptions: [MODEL_OPTION],
      failPrompt: 'auth',
    })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      (e: unknown) =>
        e instanceof Error && !(e instanceof JudgeUnavailable) && /oauth/.test(e.message)
    )
  })

  test('a non-auth prompt failure stays JudgeUnavailable — backend flake, not config', async () => {
    const fake = fakeAcpAgent({
      configOptions: [MODEL_OPTION],
      failPrompt: 'generic',
    })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!('s', QUESTIONS, deadline()),
      JudgeUnavailable
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

  test('an agent reporting another family is refused — a swap never parses typed', async () => {
    const fake = fakeAcpAgent({
      replyText: TYPED_REPLY,
      configOptions: [MODEL_OPTION],
      reportedModel: 'qwen3-coder',
    })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
        's',
        QUESTIONS,
        deadline()
      ),
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof JudgeUnavailable) &&
        /qwen3-coder/.test(e.message) &&
        /model-family swap/.test(e.message)
    )
  })

  test('a same-family model report canonicalizes — provenance carries it', async () => {
    const fake = fakeAcpAgent({
      replyText: TYPED_REPLY,
      configOptions: [MODEL_OPTION],
      reportedModel: 'typesafe/jev-2.0',
    })
    const res = await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      's',
      QUESTIONS,
      deadline()
    )
    assert.equal(res.model, 'typesafe/jev-1.13')
  })

  test('a peer refusal of set_config_option is a config error naming the model', async () => {
    const fake = fakeAcpAgent({
      replyText: TYPED_REPLY,
      configOptions: [MODEL_OPTION],
      failConfig: 'refuse',
    })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
        's',
        QUESTIONS,
        deadline()
      ),
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof JudgeUnavailable) &&
        /refused model 'typesafe\/jev-1\.13'/.test(e.message)
    )
  })

  test('a cancelled set_config_option fails open — availability, not config', async () => {
    const fake = fakeAcpAgent({
      replyText: TYPED_REPLY,
      configOptions: [MODEL_OPTION],
      failConfig: 'cancel',
    })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
        's',
        QUESTIONS,
        deadline()
      ),
      (e: unknown) => e instanceof JudgeUnavailable
    )
  })

  test('choice probabilities keyed off the asked options are drift — fail open', async () => {
    const bad = JSON.stringify({
      answers: {
        route: { type: 'choice', choice: 'a', probabilities: { other: 1 } },
      },
    })
    const fake = fakeAcpAgent({ replyText: bad, configOptions: [MODEL_OPTION] })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
        's',
        QUESTIONS,
        deadline()
      ),
      (e: unknown) => e instanceof JudgeUnavailable && /route/.test(e.message)
    )
  })

  test('score probabilities keyed off the level range are drift — fail open', async () => {
    const questions: Record<string, JudgeQuestion> = {
      rate: {
        type: 'score',
        instructions: 'rate?',
        criteria: ['low', 'mid', 'high'],
      },
    }
    const bad = JSON.stringify({
      answers: { rate: { type: 'score', score: 1, probabilities: { x: 1 } } },
    })
    const fake = fakeAcpAgent({ replyText: bad, configOptions: [MODEL_OPTION] })
    await assert.rejects(
      acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
        's',
        questions,
        deadline()
      ),
      (e: unknown) => e instanceof JudgeUnavailable && /rate/.test(e.message)
    )
  })

  test('a "__proto__" question id lands as an own answer key', async () => {
    const questions = Object.fromEntries([
      ['__proto__', { type: 'noul', instructions: 'blocking?' } as JudgeQuestion],
    ])
    const body = JSON.stringify({
      model: 'typesafe/jev-1.13',
      answers: Object.fromEntries([
        ['__proto__', { type: 'noul', noul: 0.6 }],
      ]),
    })
    const fake = fakeAcpAgent({ replyText: body, configOptions: [MODEL_OPTION] })
    const res = await acpClient('provider:kilo', entry, { acp: { peer: fake.app } }).call!(
      's',
      questions,
      deadline()
    )
    assert.equal(Object.hasOwn(res.answers, '__proto__'), true)
    assert.equal(res.answers['__proto__' as keyof typeof res.answers]?.type, 'noul')
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

describe('spawn path — a real child process on stdio', () => {
  test('node script serving ACP answers a typed turn; the child is reaped', async () => {
    // lives under the package dir so the SDK resolves from node_modules
    const dir = mkdtempSync(join(process.cwd(), '.acp-fake-'))
    const script = join(dir, 'agent.mjs')
    writeFileSync(
      script,
      `import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
await agent({ name: 'fake' })
  .onRequest('initialize', (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    authMethods: [],
  }))
  .onRequest('session/new', () => ({
    sessionId: 's1',
    configOptions: [
      {
        type: 'select',
        id: 'm',
        name: 'Model',
        category: 'model',
        currentValue: 'typesafe/jev-1.13',
        options: [{ value: 'typesafe/jev-1.13', name: 'jev' }],
      },
    ],
  }))
  .onRequest('session/set_config_option', (ctx) => ({
    configOptions: [
      {
        type: 'select',
        id: 'm',
        name: 'Model',
        category: 'model',
        currentValue: ctx.params.value,
        options: [{ value: 'typesafe/jev-1.13', name: 'jev' }],
      },
    ],
  }))
  .onRequest('session/prompt', async (ctx) => {
    await ctx.client.notify('session/update', {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"answers":{"route":{"type":"choice","choice":"a","probabilities":{"a":0.8,"b":0.2},"confidence":0.8}},"model":"typesafe/jev-1.13"}' },
      },
    })
    return { stopReason: 'end_turn' }
  })
  .connectWith(stream, () => new Promise(() => {}))
`
    )
    try {
      const res = await acpClient(
        'provider:fake',
        {
          type: 'acp',
          command: `"${process.execPath}" "${script}"`,
          model: 'typesafe/jev-1.13',
        },
        {}
      ).call!('s', QUESTIONS, deadline(30_000))
      const route = res.answers.route!
      assert.ok(route.type === 'choice')
      assert.equal(route.choice, 'a')
      assert.equal(res.model, 'typesafe/jev-1.13')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing binary is a config error naming the provider', async () => {
    await assert.rejects(
      acpClient(
        'provider:kilo',
        { type: 'acp', command: 'definitely-not-a-real-bin-xyz' },
        {}
      ).chat!('p', deadline()),
      /cannot exec acp command/
    )
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

  test('a cli entry binds the prose chat surface', () => {
    const client = providerClient('d', { type: 'cli', command: 'devin -p' })
    assert.equal(typeof client.chat, 'function')
    assert.equal(client.call, undefined)
  })
})

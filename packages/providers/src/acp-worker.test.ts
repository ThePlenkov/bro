import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { acpWorkerArgv } from './acp.ts'
import { renderAcpUpdate, runAcpWorker } from './acp-worker.ts'
import type { AcpWorkerSpec } from './acp-worker.ts'
import { fakeAcpAgent } from './testkit.ts'

const MODEL_OPTION: SessionConfigOption = {
  type: 'select',
  id: 'model-pick',
  name: 'Model',
  category: 'model',
  currentValue: 'typesafe/jev-1.13',
  options: [{ value: 'typesafe/jev-1.13', name: 'jev' }],
}

/** A worker spec over the in-process peer — prompt on disk, cwd a real
 *  dir, log lines captured. */
function workerSpec(
  over: Partial<AcpWorkerSpec> = {}
): { spec: AcpWorkerSpec; lines: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-acpw-'))
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, 'PROMPT-TEXT')
  const lines: string[] = []
  return {
    dir,
    lines,
    spec: {
      command: 'unused-with-peer',
      promptFile,
      cwd: dir,
      provider: 'kilo',
      signals: false,
      log: (l) => lines.push(l),
      ...over,
    },
  }
}

describe('acpWorkerArgv', () => {
  test('argv is slots, never a shell string — metachars stay in their element', () => {
    const argv = acpWorkerArgv(
      ['bro'],
      { type: 'acp', command: 'kilo --acp' },
      { model: 'm; rm -rf /' }
    )
    assert.deepEqual(argv, [
      'bro', 'acp-worker', '--command', 'kilo --acp',
      '--model', 'm; rm -rf /',
    ])
  })

  test('entry pins apply: profile shell-quotes into command, model + autoApprove render flags', () => {
    const argv = acpWorkerArgv(
      ['npx', '-y', '@broject/bro@0'],
      {
        type: 'acp',
        command: 'kilo --acp',
        profile: "it's work",
        model: 'jev',
        autoApprove: true,
      }
    )
    assert.deepEqual(argv, [
      'npx', '-y', '@broject/bro@0', 'acp-worker',
      '--command', `kilo --acp --profile 'it'\\''s work'`,
      '--model', 'jev',
      '--auto-approve',
    ])
  })

  test('opts beat the entry pin piecewise — model override, autoApprove off stays off', () => {
    const argv = acpWorkerArgv(
      ['bro'],
      { type: 'acp', command: 'kilo --acp', model: 'entry-m', autoApprove: false },
      { model: 'flag-m' }
    )
    assert.ok(argv.includes('flag-m'))
    assert.ok(!argv.includes('entry-m'))
    assert.ok(!argv.includes('--auto-approve'))
  })
})

describe('runAcpWorker', () => {
  test('end_turn exits 0; prompt text and session id land where they should', async () => {
    const fake = fakeAcpAgent({ replyText: 'done', configOptions: [MODEL_OPTION] })
    const recorded: { acpSessionId?: string; model?: string }[] = []
    const { spec, lines, dir } = workerSpec({
      peer: fake.app,
      record: (p) => recorded.push(p),
    })
    try {
      const code = await runAcpWorker(spec)
      assert.equal(code, 0)
      assert.deepEqual(fake.prompts, ['PROMPT-TEXT'])
      assert.deepEqual(fake.sessions, [{ cwd: dir }])
      assert.deepEqual(recorded, [{ acpSessionId: 'sess-1' }, { model: 'typesafe/jev-1.13' }])
      assert.match(lines.join('\n'), /session sess-1/)
      assert.match(lines.join('\n'), /done/)
      assert.match(lines.join('\n'), /turn stopped — end_turn/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-end_turn stop exits non-zero and says why', async () => {
    const fake = fakeAcpAgent({ stopReason: 'refusal' })
    const { spec, lines, dir } = workerSpec({ peer: fake.app })
    try {
      assert.equal(await runAcpWorker(spec), 1)
      assert.match(lines.join('\n'), /turn stopped — refusal/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a requested model rides set_config_option on the category:model option', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION] })
    const { spec, dir } = workerSpec({ peer: fake.app, model: 'qwen3-coder' })
    try {
      assert.equal(await runAcpWorker(spec), 0)
      assert.deepEqual(fake.configSets, [{ configId: 'model-pick', value: 'qwen3-coder' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a requested model with no advertised option fails — never runs unpinned', async () => {
    const fake = fakeAcpAgent()
    const { spec, lines, dir } = workerSpec({ peer: fake.app, model: 'qwen3-coder' })
    try {
      assert.equal(await runAcpWorker(spec), 1)
      assert.match(lines.join('\n'), /no model config option/)
      assert.equal(fake.prompts.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an agent requiring interactive auth is a startup failure naming the methods', async () => {
    const fake = fakeAcpAgent({
      authMethods: [{ id: 'oauth', name: 'OAuth' }],
    })
    const { spec, lines, dir } = workerSpec({ peer: fake.app })
    try {
      assert.equal(await runAcpWorker(spec), 1)
      assert.match(lines.join('\n'), /interactive auth.*oauth/)
      assert.equal(fake.sessions.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('permission requests default-deny and log; autoApprove selects the allow option', async () => {
    const options = [
      { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'deny-1', name: 'Deny', kind: 'reject_once' as const },
    ]
    const denying = fakeAcpAgent({ askPermission: options })
    const d = workerSpec({ peer: denying.app })
    try {
      assert.equal(await runAcpWorker(d.spec), 0)
      assert.deepEqual(denying.permissionOutcome, {
        outcome: 'selected',
        optionId: 'deny-1',
      })
      assert.match(d.lines.join('\n'), /permission run tests — denied/)
    } finally {
      rmSync(d.dir, { recursive: true, force: true })
    }

    const approving = fakeAcpAgent({ askPermission: options })
    const a = workerSpec({ peer: approving.app, autoApprove: true })
    try {
      assert.equal(await runAcpWorker(a.spec), 0)
      assert.deepEqual(approving.permissionOutcome, {
        outcome: 'selected',
        optionId: 'allow-1',
      })
      assert.match(a.lines.join('\n'), /permission run tests — approved \(autoApprove\)/)
    } finally {
      rmSync(a.dir, { recursive: true, force: true })
    }
  })

  test('an allow-less option set still denies under autoApprove — approval is never invented', async () => {
    const fake = fakeAcpAgent({
      askPermission: [
        { optionId: 'deny-1', name: 'Deny', kind: 'reject_once' },
      ],
    })
    const { spec, lines, dir } = workerSpec({ peer: fake.app, autoApprove: true })
    try {
      assert.equal(await runAcpWorker(spec), 0)
      assert.deepEqual(fake.permissionOutcome, { outcome: 'selected', optionId: 'deny-1' })
      assert.match(lines.join('\n'), /no allow option offered; denying/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unadvertised agent→client call gets method-not-found and a log line', async () => {
    // a custom peer asking fs/read_text_file mid-prompt — v1 does not
    // advertise filesystem and the worker must say so, not emulate it
    const { agent } = await import('@agentclientprotocol/sdk')
    const app = agent({ name: 'fs-asker' })
      .onRequest('initialize', (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        authMethods: [],
      }))
      .onRequest('session/new', () => ({ sessionId: 's1', configOptions: [] }))
      .onRequest('session/prompt', async (ctx) => {
        try {
          await ctx.client.request('fs/read_text_file', {
            sessionId: ctx.params.sessionId,
            path: '/etc/passwd',
          })
        } catch {
          // method-not-found — expected; the turn still completes
        }
        return { stopReason: 'end_turn' }
      })
    const { spec, lines, dir } = workerSpec({ peer: app })
    try {
      assert.equal(await runAcpWorker(spec), 0)
      assert.match(lines.join('\n'), /fs\/read_text_file.*method-not-found/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing prompt file fails before any session work', async () => {
    const fake = fakeAcpAgent()
    const dir = mkdtempSync(join(tmpdir(), 'bro-acpw-'))
    try {
      const code = await runAcpWorker({
        command: 'x',
        promptFile: join(dir, 'nope.md'),
        cwd: dir,
        signals: false,
        peer: fake.app,
        log: () => {},
      })
      assert.equal(code, 1)
      // session/new ran (handshake precedes the prompt read) but no prompt went out
      assert.equal(fake.prompts.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderAcpUpdate', () => {
  test('text chunks render raw; other kinds render discriminator + detail', () => {
    assert.equal(
      renderAcpUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      } as never),
      'hello'
    )
    assert.match(
      renderAcpUpdate({
        sessionUpdate: 'tool_call',
        title: 'bash ls',
        status: 'running',
      } as never),
      /tool_call bash ls \(running\)/
    )
    assert.match(
      renderAcpUpdate({ sessionUpdate: 'plan', entries: [] } as never),
      /^plan/
    )
  })
})

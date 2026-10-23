import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  loadAgentEnv,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { readAgentRegistry, writeAgentRegistry } from '@broject/core'
import { fakeAcpAgent } from '@broject/providers/testkit'
import { capture, initRepo, installFakeBd } from './testrepo.ts'
import { delegate } from './delegate.ts'
import { runDelegateCommand } from './delegate-cli.ts'

interface Fixture {
  root: string
  main: string
  beads: string
  restore(): void
}

/** Detached workers outlive a failed assertion — kill whatever the
 *  registry still points at before the tmpdir goes away (tests fake
 *  'running' with their own pid — never kill self or the runner). */
function registeredPids(main: string): number[] {
  try {
    return Object.values(readAgentRegistry(main)).map((e) =>
      typeof e.pid === 'number' ? e.pid : 0
    )
  } catch {
    return [] // no readable registry — nothing spawned
  }
}

const killable = (pid: number): boolean =>
  pid > 0 && pid !== process.pid && pid !== process.ppid

function killRegistered(main: string): void {
  for (const pid of registeredPids(main)) {
    if (!killable(pid)) {
      continue
    }
    try {
      process.kill(-pid, 'SIGKILL') // detached → own process group
    } catch {
      // already gone
    }
  }
}

function restoreEnv(scrubbed: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(scrubbed)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
}

/** Real git repo + fake bd on PATH + agents.native.command — the
 *  agents.test fixture pattern: wait tests only need the repo (the
 *  registry wall read is real); detach spawns `node {promptFile}` so
 *  the prompt text IS the program. */
function fixture(): Fixture {
  const { root, main } = initRepo('bro-delegate-')
  const beads = join(root, 'beads')
  mkdirSync(beads)
  const { binDir } = installFakeBd(beads, [])
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      agents: { native: { command: 'node {promptFile}' } },
      providers: { p: { type: 'acp', command: 'no-such-acp-binary', model: 'm-acp' } },
    })
  )
  const prev = {
    cwd: process.cwd(),
    PATH: process.env.PATH ?? '',
    scrubbed: {} as Record<string, string | undefined>,
  }
  for (const k of Object.keys(process.env)) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|BEADS_DIR|BRO_)/.test(k)) {
      prev.scrubbed[k] = process.env[k]
      delete process.env[k]
    }
  }
  process.env.PATH = `${binDir}:${prev.PATH}`
  process.chdir(main)
  return {
    root,
    main,
    beads,
    restore() {
      killRegistered(main)
      process.chdir(prev.cwd)
      process.env.PATH = prev.PATH
      restoreEnv(prev.scrubbed)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const env = (over: Partial<AgentConnectorEnv> = {}): AgentConnectorEnv => ({
  agents: {},
  connectors: {},
  providers: {
    p: { type: 'acp', command: 'no-such-acp-binary', model: 'm-acp' },
    cli1: { type: 'cli', command: 'no-such-cli' },
  },
  ...over,
})

const LONG_RUN = 'setTimeout(() => {}, 30000)'

describe('bro fleet delegate — --wait', () => {
  test('pooled turn over the acp peer — prompt in, text + provenance out', async () => {
    const fx = fixture()
    try {
      const fake = fakeAcpAgent({ replyText: 'answer from B' })
      const r = await delegate(
        fx.main,
        env(),
        { prompt: 'review this diff', provider: 'p', mode: 'wait' },
        { acp: { peer: fake.app } }
      )
      assert.equal(r.mode, 'wait')
      assert.equal(r.provider, 'p')
      assert.equal(r.model, 'm-acp')
      assert.equal(r.stopReason, 'end_turn')
      assert.equal(r.text, 'answer from B')
      assert.deepEqual(fake.prompts, ['review this diff'])
    } finally {
      fx.restore()
    }
  })

  test('BRO_AGENT_ID on the caller pins delegatedBy into the wait result', async () => {
    const fx = fixture()
    try {
      process.env.BRO_AGENT_ID = 'native-asker'
      const fake = fakeAcpAgent({ replyText: 'with provenance' })
      const r = await delegate(
        fx.main,
        env(),
        { prompt: 'who asked', provider: 'p', mode: 'wait' },
        { acp: { peer: fake.app } }
      )
      assert.equal(r.mode, 'wait')
      if (r.mode !== 'wait') {
        return assert.fail('wait mode expected')
      }
      assert.equal(r.delegatedBy, 'native-asker')
    } finally {
      fx.restore()
    }
  })

  test('--class routes through fleet.routing — chain[0] supplies provider + model', async () => {
    const fx = fixture()
    try {
      const fake = fakeAcpAgent({ replyText: 'routed answer' })
      const e = env({
        fleet: {
          maxConcurrent: 0,
          routing: { review: { chain: [{ provider: 'p', model: 'm-chain' }] } },
        },
      })
      const r = await delegate(
        fx.main,
        e,
        { prompt: 'ask the review lane', class: 'review', mode: 'wait' },
        { acp: { peer: fake.app } }
      )
      assert.equal(r.mode, 'wait')
      if (r.mode !== 'wait') {
        return assert.fail('wait mode expected')
      }
      assert.equal(r.provider, 'p')
      assert.equal(r.class, 'review')
      assert.equal(r.model, 'm-chain')
    } finally {
      fx.restore()
    }
  })

  test('a provider wall refuses the wait — the delegate lane waits like the batch lane', async () => {
    const fx = fixture()
    try {
      writeAgentRegistry(fx.main, {
        'dead-worker': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          provider: 'p',
          cause: 'rate_limited',
        },
      })
      const fake = fakeAcpAgent({ replyText: 'never reached' })
      await assert.rejects(
        () =>
          delegate(fx.main, env(), { prompt: 'hi', provider: 'p', mode: 'wait' }, { acp: { peer: fake.app } }),
        (err: unknown) => {
          assert.match(String(err), /p walled — rate_limited/)
          return true
        }
      )
      assert.deepEqual(fake.prompts, [])
    } finally {
      fx.restore()
    }
  })

  test('input errors — no provider, non-acp provider, exclusive flags, empty prompt', async () => {
    const fx = fixture()
    try {
      const fake = fakeAcpAgent()
      const opts = { acp: { peer: fake.app } }
      // no provider and no routing → usage-grade input error
      await assert.rejects(
        () => delegate(fx.main, env({ providers: {} }), { prompt: 'hi', mode: 'wait' }, opts),
        /needs a provider/
      )
      // a cli-kind provider cannot serve a pooled turn
      await assert.rejects(
        () => delegate(fx.main, env(), { prompt: 'hi', provider: 'cli1', mode: 'wait' }, opts),
        /cannot serve a delegate turn/
      )
      // --provider + --class
      await assert.rejects(
        () => delegate(fx.main, env(), { prompt: 'hi', provider: 'p', class: 'review', mode: 'wait' }, opts),
        /mutually exclusive/
      )
      // --class with no routing declared
      await assert.rejects(
        () => delegate(fx.main, env(), { prompt: 'hi', class: 'review', mode: 'wait' }, opts),
        /no fleet\.routing is declared/
      )
      // no prompt
      await assert.rejects(
        () => delegate(fx.main, env(), { provider: 'p', mode: 'wait' }, opts),
        /requires a prompt/
      )
      assert.deepEqual(fake.prompts, [])
    } finally {
      fx.restore()
    }
  })
})

describe('bro fleet delegate — --detach', () => {
  test('registers an agent entry — adhoc step, delegatedBy stamp, batch lane marker', async () => {
    const fx = fixture()
    try {
      process.env.BRO_AGENT_ID = 'native-caller'
      const r = await delegate(fx.main, loadAgentEnv(fx.main), {
        prompt: LONG_RUN,
        mode: 'detach',
        beadsDir: fx.beads,
      })
      assert.equal(r.mode, 'detach')
      const info = r.agent
      assert.match(info.molStep, /^adhoc-[0-9a-f]{8}$/)
      const entry = readAgentRegistry(fx.main)[info.molStep]
      assert.ok(entry, 'registry entry for the adhoc step')
      assert.equal(entry.agentId, info.id)
      assert.equal(entry.delegatedBy, 'native-caller')
      assert.equal(info.delegatedBy, 'native-caller')
      // BRO_BATCH marks the fleet's lane inside the worker's env
      if (info.pid !== undefined && existsSync(`/proc/${info.pid}/environ`)) {
        const environ = readFileSync(`/proc/${info.pid}/environ`, 'utf8')
        assert.match(environ, /BRO_BATCH=1/)
        assert.match(environ, /BRO_DELEGATED_BY=native-caller/)
      }
    } finally {
      fx.restore()
    }
  })
})

describe('bro fleet delegate — CLI surface', () => {
  test('--wait + --detach and mode-foreign flags are usage errors', async () => {
    const fx = fixture()
    try {
      const both = await capture(() => runDelegateCommand(['--wait', '--detach', 'hi']))
      assert.equal(both.code, 1)
      assert.match(both.err.join('\n'), /mutually exclusive/)
      const wrongMode = await capture(() =>
        runDelegateCommand(['--detach', '--timeout', '5', 'hi'])
      )
      assert.equal(wrongMode.code, 1)
      assert.match(wrongMode.err.join('\n'), /--timeout only applies to --wait/)
      const wrongMode2 = await capture(() =>
        runDelegateCommand(['--wait', '--connector', 'native', 'hi'])
      )
      assert.equal(wrongMode2.code, 1)
      assert.match(wrongMode2.err.join('\n'), /only apply to --detach/)
    } finally {
      fx.restore()
    }
  })

  test('--wait --json emits the provenance document — parse → env → delegate end-to-end', async () => {
    const fx = fixture()
    try {
      const fake = fakeAcpAgent({ replyText: 'json answer' })
      const r = await capture(() =>
        runDelegateCommand(
          ['--wait', '--json', '--provider', 'p', 'hi there'],
          { acp: { peer: fake.app } }
        )
      )
      assert.equal(r.code, 0)
      const doc = JSON.parse(r.out.join('')) as Record<string, unknown>
      assert.equal(doc['mode'], 'wait')
      assert.equal(doc['provider'], 'p')
      assert.equal(doc['model'], 'm-acp')
      assert.equal(doc['stopReason'], 'end_turn')
      assert.equal(doc['text'], 'json answer')
      assert.deepEqual(fake.prompts, ['hi there'])
    } finally {
      fx.restore()
    }
  })

  test('--wait plain output — reply on stdout, provenance on stderr', async () => {
    const fx = fixture()
    try {
      const fake = fakeAcpAgent({ replyText: 'the answer' })
      const r = await capture(() =>
        runDelegateCommand(['--wait', '--provider', 'p', 'ask it'], { acp: { peer: fake.app } })
      )
      assert.equal(r.code, 0)
      assert.deepEqual(r.out, ['the answer'])
      assert.match(r.err.join('\n'), /provider p · model m-acp · end_turn/)
    } finally {
      fx.restore()
    }
  })
})

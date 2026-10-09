import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  bdTry,
  SpawnError,
  type FleetProfile,
  type ProviderEntry,
  type SpawnWorker,
} from '@broject/core'
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from '@broject/loop'
import { loopRefTails, loopWatch, resolveBeadsDir, resolveLoopLane } from './loop.ts'
import type { AgentConnectorEnv } from '../agent-connectors.ts'
import { git, initRepo, inside } from './testrepo.ts'

// --- resolveLoopLane — the provider-registry vs raw-template pick -------------

const laneCfg = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  ...DEFAULT_LOOP_CONFIG,
  ...over,
})

const laneEnv = (
  providers: Record<string, ProviderEntry> = {},
  profiles: Record<string, FleetProfile> = {},
  agents: Record<string, Record<string, unknown>> = {}
): AgentConnectorEnv => ({
  agents,
  connectors: {},
  fleet: { maxConcurrent: 3, profiles, routing: {} },
  providers,
})

const argvOf = (w: SpawnWorker | undefined): string[] => (w?.kind === 'argv' ? w.argv : [])

describe('resolveLoopLane', () => {
  test('no provider anywhere → the raw template lane (empty pick)', async () => {
    const lane = await resolveLoopLane(laneEnv(), { agent: 'devin -p {promptFile}' }, laneCfg())
    assert.deepEqual(lane, {})
  })

  test('loop.provider config resolves a cli provider to its command template', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ fakecli: { type: 'cli', command: 'fake run {promptFile}', model: 'm-1' } }),
      {},
      laneCfg({ provider: 'fakecli', agent: 'devin -p {promptFile}' })
    )
    assert.equal(lane.provider, 'fakecli')
    assert.equal(lane.model, 'm-1')
    assert.deepEqual(lane.worker, { kind: 'template', command: 'fake run {promptFile}' })
  })

  test('--agent <provider-name> engages the provider lane (acp → argv worker)', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ devin: { type: 'acp', command: 'devin acp', model: 'swe-2' } }),
      { agent: 'devin' },
      laneCfg()
    )
    assert.equal(lane.provider, 'devin')
    assert.equal(lane.model, 'swe-2')
    assert.equal(lane.worker?.kind, 'argv')
    const argv = argvOf(lane.worker)
    const i = argv.indexOf('acp-worker')
    assert.ok(i > 0, `argv: ${argv.join(' ')}`)
    assert.deepEqual(argv.slice(i + 1), ['--command', 'devin acp', '--model', 'swe-2'])
    assert.equal(argv.includes('--auto-approve'), false)
    // provenance badge is the agent cli, not the driver
    assert.equal(lane.worker?.kind === 'argv' ? lane.worker.cliName : undefined, 'devin')
  })

  test('--auto-approve reaches the acp worker argv', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ devin: { type: 'acp', command: 'devin acp' } }),
      { provider: 'devin', autoApprove: true },
      laneCfg()
    )
    assert.equal(argvOf(lane.worker).includes('--auto-approve'), true)
  })

  test('an api provider has no spawn surface — loud error', async () => {
    await assert.rejects(
      resolveLoopLane(
        laneEnv({
          judge: {
            type: 'api',
            baseUrl: 'http://x',
            models: { m: 'openai-compat' },
            apiKeyEnv: 'K',
          },
        }),
        { agent: 'judge' },
        laneCfg()
      ),
      (err) =>
        err instanceof SpawnError && /no spawn surface/.test(err.message)
    )
  })

  test('an unknown --provider name is an input error naming the key', async () => {
    await assert.rejects(
      resolveLoopLane(laneEnv(), { provider: 'nope' }, laneCfg()),
      (err) =>
        err instanceof SpawnError && /providers\.nope is not configured/.test(err.message)
    )
  })

  test('--profile fills provider and model piecewise', async () => {
    const lane = await resolveLoopLane(
      laneEnv(
        { kilo: { type: 'acp', command: 'kilo --acp' } },
        { cheap: { provider: 'kilo', model: 'jev-1.13', autoApprove: true } }
      ),
      { profile: 'cheap' },
      laneCfg()
    )
    assert.equal(lane.provider, 'kilo')
    assert.equal(lane.model, 'jev-1.13')
    const argv = argvOf(lane.worker)
    assert.equal(argv.includes('--auto-approve'), true)
    assert.equal(argv.includes('jev-1.13'), true)
  })

  test('agents.native.provider is the backend default for a bare run', async () => {
    const lane = await resolveLoopLane(
      laneEnv(
        { devin: { type: 'acp', command: 'devin acp' } },
        {},
        { native: { provider: 'devin' } }
      ),
      {},
      laneCfg({ agent: 'devin -p {promptFile}' })
    )
    assert.equal(lane.provider, 'devin')
    assert.equal(lane.worker?.kind, 'argv')
  })

  test('a template --agent beside provider flags is contradictory', async () => {
    await assert.rejects(
      resolveLoopLane(
        laneEnv({ devin: { type: 'acp', command: 'devin acp' } }),
        { agent: 'devin -p {promptFile}', provider: 'devin' },
        laneCfg()
      ),
      (err) => err instanceof SpawnError && /raw template/.test(err.message)
    )
  })

  test('--agent <provider> and a disagreeing --provider is a usage error', async () => {
    await assert.rejects(
      resolveLoopLane(
        laneEnv({
          a: { type: 'acp', command: 'a acp' },
          b: { type: 'acp', command: 'b acp' },
        }),
        { agent: 'a', provider: 'b' },
        laneCfg()
      ),
      (err) => err instanceof SpawnError && /different providers/.test(err.message)
    )
  })

  test('--model with no resolvable provider is refused, not silently dropped', async () => {
    await assert.rejects(
      resolveLoopLane(laneEnv(), { model: 'm-1' }, laneCfg({ agent: 'devin -p' })),
      (err) => err instanceof SpawnError && /ride the provider lane/.test(err.message)
    )
  })

  test('a configured loop.model with no provider is refused the same way', async () => {
    await assert.rejects(
      resolveLoopLane(laneEnv(), {}, laneCfg({ model: 'm-1' })),
      (err) => err instanceof SpawnError && /ride the provider lane/.test(err.message)
    )
  })

  test('the escape hatch: a template --agent bypasses a configured loop.provider', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ devin: { type: 'acp', command: 'devin acp' } }),
      { agent: 'raw -p {promptFile}' },
      laneCfg({ provider: 'devin' })
    )
    assert.deepEqual(lane, {})
  })
})

describe('loopRefTails', () => {
  test('a clean repo reports no tails', () => {
    const { root, main } = initRepo('bro-loop-audit-')
    inside(main, root, () => {
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [])
      assert.deepEqual(branches, [])
    })
  })

  test('a loop worktree and a bare loop branch are both reported', () => {
    const { root, main } = initRepo('bro-loop-audit-')
    inside(main, root, () => {
      const linked = join(root, 'main--bro-x')
      git(['worktree', 'add', '-q', linked, '-b', 'loop/bro-x'], main)
      git(['branch', 'loop/bro-y'], main)
      git(['branch', 'work/not-a-loop'], main)
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [`${linked} [loop/bro-x]`])
      assert.deepEqual(branches, ['loop/bro-y'])
    })
  })

  test('non-loop worktrees are not tails', () => {
    const { root, main } = initRepo('bro-loop-audit-')
    inside(main, root, () => {
      git(['worktree', 'add', '-q', join(root, 'main--w'), '-b', 'work/z'], main)
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [])
      assert.deepEqual(branches, [])
    })
  })
})

describe('loopWatch — the loop supervisor heartbeat (bro-0aa87)', () => {
  test('claims merge+cleanup supervision and bounds the TTL to the item budget', () => {
    const w = loopWatch(7, '[#7](https://x/pull/7)', '/wt/bro--bro-x', DEFAULT_LOOP_CONFIG)
    assert.equal(w.pr, 7)
    assert.equal(w.merge, true)
    assert.equal(w.cleanup, true)
    assert.equal(w.workdir, '/wt/bro--bro-x')
    // (stall 45 + merge 45) × (fixRounds 3 + 1) — the worst-case item minutes
    assert.equal(w.timeoutMin, (45 + 45) * (3 + 1))
    const scaled = loopWatch(7, 'l', '/wt', { stallMin: 1, mergeTimeoutMin: 2, fixRounds: 0 })
    assert.equal(scaled.timeoutMin, 3)
  })
})

describe('resolveBeadsDir', () => {
  // bdTry inherits process.env — an ambient BEADS_DIR would redirect the
  // bd init/where calls below to an external store instead of the temp repo
  const ambientBeadsDir = process.env.BEADS_DIR
  delete process.env.BEADS_DIR
  after(() => {
    if (ambientBeadsDir !== undefined) process.env.BEADS_DIR = ambientBeadsDir
  })

  test('a repo without beads resolves nothing', () => {
    const { root, main } = initRepo('bro-loop-beads-')
    inside(main, root, () => {
      assert.equal(resolveBeadsDir(main), undefined)
    })
  })

  test('an initialized repo resolves its .beads dir', (t) => {
    if (bdTry(['--version']).code !== 0) {
      t.skip('bd not installed')
      return
    }
    const { root, main } = initRepo('bro-loop-beads-')
    inside(main, root, () => {
      const init = bdTry(['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'], 30_000, main)
      assert.equal(init.code, 0, init.err)
      assert.equal(resolveBeadsDir(main), join(main, '.beads'))
    })
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConvoyStep } from '@broject/convoy'
import type { AgentInfo } from '@broject/core'
import {
  agentCell,
  fleetArgs,
  liveFrame,
  worktreeOf,
  type FleetPayload,
  type FleetRow,
} from './fleet.ts'
import type { WorktreeInfo } from './work.ts'

const step = (state: ConvoyStep['state']): ConvoyStep => ({
  id: 'bro-x',
  title: 't',
  description: '',
  type: 'agent',
  kind: 'agent',
  state,
  blockedBy: [],
})

const agent = (state: AgentInfo['state'], pid?: number): AgentInfo => ({
  id: 'native-ab12',
  molStep: 'bro-x',
  backend: 'native',
  state,
  pid,
})

describe('agentCell', () => {
  test('running agent renders state + pid', () => {
    assert.equal(agentCell(step('in_progress'), agent('running', 4242), 'me', false), 'running (pid 4242)')
  })

  test('a dead agent on a claimed step is the respawn surface', () => {
    assert.equal(
      agentCell(step('in_progress'), agent('lost', 4242), 'me', false),
      'lost — respawn?'
    )
  })

  test('a dead agent on an unclaimed step is just lost', () => {
    assert.equal(agentCell(step('ready'), agent('lost'), undefined, false), 'lost')
  })

  test('a degraded backend read renders unknown, never lost', () => {
    assert.equal(agentCell(step('in_progress'), undefined, 'me', true), 'unknown')
  })

  test('a claimed step with no agent names the assignee', () => {
    assert.equal(agentCell(step('in_progress'), undefined, 'alice', false), 'claimed — alice')
    assert.equal(agentCell(step('in_progress'), undefined, undefined, false), 'claimed — ?')
  })

  test('an unclaimed step with no agent is empty', () => {
    assert.equal(agentCell(step('ready'), undefined, undefined, false), '—')
    assert.equal(agentCell(step('blocked'), undefined, undefined, false), '—')
  })

  test('exited and stopped render plainly', () => {
    assert.equal(agentCell(step('done'), agent('exited'), undefined, false), 'exited')
    assert.equal(agentCell(step('in_progress'), agent('stopped'), undefined, false), 'stopped')
  })

  test('an exited agent on a claimed step is the respawn surface too', () => {
    assert.equal(
      agentCell(step('in_progress'), agent('exited'), 'me', false),
      'lost — respawn?'
    )
  })
})

const wt = (path: string): WorktreeInfo => ({ path, head: 'x', bare: false, detached: false })

describe('worktreeOf', () => {
  test("the agent's recorded worktree wins over name matching", () => {
    const a = { ...agent('running'), worktree: '/elsewhere/custom-dir' }
    assert.equal(worktreeOf('bro-x', a, [wt('/r/main')]), '/elsewhere/custom-dir')
  })

  test('an exact <repo>--<step> sibling counts as the checkout', () => {
    const trees = [wt('/r/main'), wt('/r/main--bro-x')]
    assert.equal(worktreeOf('bro-x', undefined, trees), '/r/main--bro-x')
  })

  test("another repo's same-suffixed sibling does not match", () => {
    const trees = [wt('/r/main'), wt('/r/other--bro-x'), wt('/elsewhere/main--bro-x')]
    // 'other--bro-x' is a different repo's worktree; '/elsewhere/…' is
    // ours by name but not a sibling of main — neither counts
    assert.equal(worktreeOf('bro-x', undefined, trees), undefined)
  })

  test('no agent, no worktrees → undefined', () => {
    assert.equal(worktreeOf('bro-x', undefined, []), undefined)
  })
})

describe('fleetArgs', () => {
  test('bare fleet is the one-shot table', () => {
    assert.deepEqual(fleetArgs([]), { json: false, live: false, everySec: 2 })
    assert.deepEqual(fleetArgs(['--json']), { json: true, live: false, everySec: 2 })
  })

  test('--live paints the dashboard at the default cadence', () => {
    assert.deepEqual(fleetArgs(['--live']), { json: false, live: true, everySec: 2 })
  })

  test('--every sets the cadence and implies --live', () => {
    assert.deepEqual(fleetArgs(['--every', '5']), { json: false, live: true, everySec: 5 })
    assert.deepEqual(fleetArgs(['--live', '--every=0.5']), {
      json: false,
      live: true,
      everySec: 0.5,
    })
  })

  test('a non-positive or overflowing --every fails closed', () => {
    for (const bad of ['0', '-1', 'abc', '9999999999']) {
      assert.throws(() => fleetArgs(['--live', '--every', bad]), /--every needs a positive/)
    }
  })

  test('--live --json is a usage error — a repaint loop is not JSON', () => {
    assert.throws(() => fleetArgs(['--live', '--json']), /does not combine with --json/)
    assert.throws(() => fleetArgs(['--json', '--every', '2']), /does not combine with --json/)
  })
})

const payloadRow = (agent: string): FleetRow => ({
  mol: 'bro-mol-x',
  step: 'bro-x',
  title: 't',
  kind: 'agent',
  state: 'in_progress',
  agent,
})

const payload = (over: Partial<FleetPayload> = {}): FleetPayload => ({
  rows: [payloadRow('running (pid 42)')],
  degraded: [],
  conflicts: [],
  prErrors: [],
  ...over,
})

describe('liveFrame', () => {
  test('header, table, and footer compose one frame', () => {
    const f = liveFrame(payload(), new Date('2026-01-01T00:00:00Z'), 2)
    assert.match(f, /^bro fleet — live · 2026-01-01T00:00:00\.000Z · every 2s\n/)
    assert.match(f, /mol\s+step\s+state/)
    assert.match(f, /bro-mol-x\s+bro-x\s+in_progress\s+running \(pid 42\)/)
    assert.match(f, /\nq quit$/)
  })

  test('an empty fleet still frames', () => {
    const f = liveFrame(payload({ rows: [] }), new Date(0), 5)
    assert.match(f, /no open molecules — nothing in the fleet/)
    assert.match(f, /every 5s/)
  })

  test('warnings render in-frame — degraded, conflict, PR lookup', () => {
    const f = liveFrame(
      payload({
        degraded: ['tmux: socket gone'],
        conflicts: ['bro-x: tmux agent t1 ignored — native holds the step'],
        prErrors: ['work/x: gh failed'],
      }),
      new Date(0),
      2
    )
    assert.match(f, /warning: backend degraded — tmux: socket gone/)
    assert.match(f, /warning: agent conflict — bro-x: tmux agent t1 ignored/)
    assert.match(f, /warning: PR lookup failed — work\/x: gh failed/)
  })
})

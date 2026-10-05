import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ConvoyStep, Molecule } from '@broject/convoy'
import type { AgentConnector, AgentInfo, ListResult, ReviewFacade } from '@broject/core'
import {
  agentCell,
  collectAgents,
  fleetArgs,
  fleetRows,
  liveFrame,
  worktreeOf,
  type FleetPayload,
  type FleetRow,
} from './fleet.ts'
import { registerAgentConnector } from '../agent-connectors.ts'
import { initRepo } from './testrepo.ts'
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

  test('a blocked agent renders cause and reset, never respawn?', () => {
    const reset = { ...agent('blocked'), cause: 'rate_limited' as const, resetAt: '2026-10-06T00:00:00Z' }
    assert.equal(
      agentCell(step('in_progress'), reset, 'me', false),
      'blocked — rate_limited til 2026-10-06T00:00:00Z'
    )
    const noReset = { ...agent('blocked'), cause: 'quota' as const }
    assert.equal(agentCell(step('in_progress'), noReset, 'me', false), 'blocked — quota')
    assert.equal(agentCell(step('in_progress'), agent('blocked'), 'me', false), 'blocked — ?')
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

  test('a sub-floor --every is a busy loop, not a cadence', () => {
    assert.throws(() => fleetArgs(['--live', '--every', '0.01']), /at least 0\.1s/)
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

const STUB_BUDGET: FleetPayload['budget'] = {
  basis: 'local-estimate',
  limits: [],
  entries: 0,
  live: 0,
  blocked: 0,
  maxConcurrent: 3,
  spawnedLastHour: 0,
  spawnedPerHour: [],
  resets: [],
  causes: [],
}

const payload = (over: Partial<FleetPayload> = {}): FleetPayload => ({
  rows: [payloadRow('running (pid 42)')],
  degraded: [],
  conflicts: [],
  prErrors: [],
  occupancy: { occupied: 1, maxConcurrent: 3 },
  budget: STUB_BUDGET,
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

// --- composition: collectAgents + fleetRows ------------------------------------
//
// The cell helpers above are pinned in isolation; these tests prove the
// states actually reach a FleetRow. fleetRows enumerates molecules through
// `bd` — a shim on PATH answers `list --type molecule` / `mol show` from
// files the test writes. collectAgents merges every registered connector's
// list() — fixture connectors script the degraded/conflict cases, the
// native one reads a real agents.json in the fixture repo.

const FLEET_BD = `#!/bin/sh
if [ "$1" = "list" ]; then cat "$FLEET_BD_LIST"; exit 0; fi
if [ "$1" = "mol" ] && [ "$2" = "show" ]; then cat "$FLEET_BD_SHOW"; exit 0; fi
echo "fake bd: unhandled $*" >&2
exit 1
`

/** Install the bd shim on PATH, pointed at list/show payload files.
 *  Returns a restore() that puts PATH back and drops the shim dir. */
function installFleetBd(dir: string, mol: Molecule): () => void {
  const bin = mkdtempSync(join(tmpdir(), 'bro-fleet-bd-'))
  writeFileSync(join(dir, 'list.json'), JSON.stringify([mol.root]))
  writeFileSync(join(dir, 'show.json'), JSON.stringify(mol))
  writeFileSync(join(bin, 'bd'), FLEET_BD)
  chmodSync(join(bin, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevList = process.env.FLEET_BD_LIST
  const prevShow = process.env.FLEET_BD_SHOW
  process.env.PATH = `${bin}:${prevPath ?? ''}`
  process.env.FLEET_BD_LIST = join(dir, 'list.json')
  process.env.FLEET_BD_SHOW = join(dir, 'show.json')
  let restored = false
  return () => {
    if (restored) {
      return
    }
    restored = true
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevList === undefined) delete process.env.FLEET_BD_LIST
    else process.env.FLEET_BD_LIST = prevList
    if (prevShow === undefined) delete process.env.FLEET_BD_SHOW
    else process.env.FLEET_BD_SHOW = prevShow
    rmSync(bin, { recursive: true, force: true })
  }
}

const molWith = (issues: Molecule['issues']): Molecule => ({
  root: { id: 'm-1', title: 'mol', status: 'open', issue_type: 'molecule' },
  issues: [{ id: 'm-1', title: 'mol', status: 'open', issue_type: 'molecule' }, ...issues],
  dependencies: [],
})

const molIssue = (
  id: string,
  status: string,
  assignee?: string
): Molecule['issues'][number] =>
  // bd issues carry assignee — MolIssue types only the fields bro reads
  ({ id, title: id, status, issue_type: 'task', assignee }) as Molecule['issues'][number]

/** A facade stub — fleetRows only reads prsForBranch + prLink. */
const stubRev = (prs: number[], seen: string[]): ReviewFacade =>
  ({
    prsForBranch: (branch: string) => {
      seen.push(branch)
      return prs
    },
    prLink: (repo: string, pr: number) => `[#${pr}](https://example.test/${repo}/pull/${pr})`,
  }) as unknown as ReviewFacade

describe('fleetRows', () => {
  test('lost agent, degraded read, and pr wiring all reach the row', () => {
    const { root, main } = initRepo('bro-fleetrows-')
    try {
      const restore = installFleetBd(
        root,
        molWith([molIssue('s-1', 'in_progress', 'me'), molIssue('s-2', 'in_progress'), molIssue('s-3', 'open')])
      )
      try {
        const seen: string[] = []
        const rev = stubRev([42, 43], seen)
        const byStep = new Map<string, AgentInfo>([
          [
            's-1',
            {
              ...agent('lost', 4242),
              id: 'native-dead1',
              worktree: main,
              provider: 'kilo',
              model: 'typesafe/jev-1.13',
            },
          ],
        ])
        const prErrors: string[] = []
        const rows = fleetRows(byStep, true, rev, 'o/r', [wt(main)], prErrors)
        assert.equal(rows.length, 3)
        const r1 = rows.find((r) => r.step === 's-1')!
        // the respawn cell survives composition — this is the assertion the
        // review asked for: agentCell's 'lost — respawn?' on a real FleetRow
        assert.equal(r1.agent, 'lost — respawn?')
        // provenance rides the same row — the table renders it verbatim
        assert.equal(r1.provider, 'kilo')
        assert.equal(r1.model, 'typesafe/jev-1.13')
        assert.equal(r1.worktree, basename(main))
        assert.equal(r1.pr, '[#42](https://example.test/o/r/pull/42)')
        assert.equal(r1.prNum, 42)
        assert.deepEqual(r1.prNums, [42, 43])
        assert.deepEqual(seen, ['main'])
        // a claimed step with no agent under a degraded read is 'unknown',
        // never 'lost' — the failed read must not look like a dead fleet
        assert.equal(rows.find((r) => r.step === 's-2')!.agent, 'unknown')
        assert.equal(rows.find((r) => r.step === 's-3')!.agent, '—')
        assert.deepEqual(prErrors, [])
      } finally {
        restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a healthy read names the claim holder instead of unknown', () => {
    const { root, main } = initRepo('bro-fleetrows-')
    try {
      const restore = installFleetBd(
        root,
        molWith([molIssue('s-1', 'in_progress', 'alice'), molIssue('s-2', 'open')])
      )
      try {
        const seen: string[] = []
        const rows = fleetRows(new Map(), false, stubRev([], seen), 'o/r', [wt(main)])
        assert.equal(rows.find((r) => r.step === 's-1')!.agent, 'claimed — alice')
        // no worktree anywhere → no branch probe at all
        assert.deepEqual(seen, [])
      } finally {
        restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** A connector stub — fleet only ever calls list(). */
const stubConn = (name: string, res: ListResult): AgentConnector => ({
  name,
  spawn: async () => {
    throw new Error(`${name}: spawn not stubbed`)
  },
  list: async () => res,
  status: async () => {
    throw new Error(`${name}: status not stubbed`)
  },
  stop: async () => {},
  capabilities: () => ({ supervisor: 'none' }),
})

const regAgent = (id: string, molStep: string, backend: string): AgentInfo => ({
  id,
  molStep,
  backend,
  state: 'running',
})

describe('collectAgents', () => {
  // registers fixture connectors — the registry is module-global, so this
  // describe runs last: the additions must not shadow earlier tests
  test('registry agents merge across backends; degraded and conflicts are reported', async () => {
    const { root, main } = initRepo('bro-collect-')
    // a native entry with no pid and no death record reads 'lost' — the
    // shared registry is <common>/bro/agents.json
    mkdirSync(join(main, '.git', 'bro'), { recursive: true })
    writeFileSync(
      join(main, '.git', 'bro', 'agents.json'),
      JSON.stringify({
        's-1': { agentId: 'native-dead1', backend: 'native', spawnedAt: '2026-01-01T00:00:00Z' },
      })
    )
    // disposers bind to the entry THIS registration added — a skipped
    // duplicate can't remove a foreign connector under the same name
    const fixtureDisposers: (() => void)[] = []
    const registerFixture = (
      name: string,
      make: Parameters<typeof registerAgentConnector>[1]
    ) => {
      const dispose = registerAgentConnector(name, make)
      if (dispose !== undefined) {
        fixtureDisposers.push(dispose)
      }
    }
    registerFixture('dupa', () =>
      stubConn('dupa', {
        agents: [regAgent('dupa-1', 's-1', 'dupa'), regAgent('dupa-9', 's-9', 'dupa')],
      })
    )
    registerFixture('dupb', () =>
      stubConn('dupb', { agents: [regAgent('dupb-9', 's-9', 'dupb')] })
    )
    registerFixture('gone', () => stubConn('gone', { agents: [], degraded: 'socket gone' }))
    registerFixture('explody', () => {
      throw new Error('factory boom')
    })
    try {
      const { byStep, degraded, conflicts } = await collectAgents(main)
      // registry order decides: native (registered at module load) holds
      // s-1, dupa's report is the conflict — and dupa holds s-9 over dupb
      assert.equal(byStep.get('s-1')?.id, 'native-dead1')
      assert.equal(byStep.get('s-1')?.state, 'lost')
      assert.equal(byStep.get('s-9')?.id, 'dupa-9')
      assert.ok(
        conflicts.some((c) => c.includes('s-1: dupa agent dupa-1 ignored — native holds the step')),
        `conflicts: ${JSON.stringify(conflicts)}`
      )
      assert.ok(
        conflicts.some((c) => c.includes('s-9: dupb agent dupb-9 ignored — dupa holds the step')),
        `conflicts: ${JSON.stringify(conflicts)}`
      )
      // a degraded list() and a throwing factory are both notes — other
      // backends (tmux may or may not be on PATH) degrade or not, so
      // membership is asserted, never exact equality
      assert.ok(degraded.includes('gone: socket gone'), `degraded: ${JSON.stringify(degraded)}`)
      assert.ok(degraded.includes('explody: factory boom'), `degraded: ${JSON.stringify(degraded)}`)

      // the composition the collector feeds: a collected byStep +
      // degraded flag must reach the rows unchanged
      const restore = installFleetBd(
        root,
        molWith([molIssue('s-1', 'in_progress'), molIssue('s-2', 'in_progress'), molIssue('s-9', 'open')])
      )
      try {
        const rows = fleetRows(byStep, degraded.length > 0, undefined, '', [])
        assert.equal(rows.find((r) => r.step === 's-1')!.agent, 'lost — respawn?')
        assert.equal(rows.find((r) => r.step === 's-2')!.agent, 'unknown')
        assert.equal(rows.find((r) => r.step === 's-9')!.agent, 'running')
      } finally {
        restore()
      }
    } finally {
      // the registry is module-global — fixture connectors must not leak
      // into whatever runs after this file's process
      for (const dispose of fixtureDisposers) {
        dispose()
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})

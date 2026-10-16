import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import {
  patchAgentRegistry,
  procStat,
  readAgentRegistry,
  type AgentInfo,
  type TaskRow,
  type TaskStore,
} from '@broject/core'
import type { ListedWatch } from '@broject/act'
import {
  agentProcessesIn,
  branchSlug,
  buildCiFixerPrompt,
  buildFixerPrompt,
  buildRebaseFixerPrompt,
  buildSastFixerPrompt,
  candidateBranches,
  detailMatches,
  driveArgs,
  ensureFixerWorktree,
  fixerAttemptSpent,
  fixerBeadFor,
  fixerRef,
  freshOccupancy,
  greenOccupancy,
  liveWorkDetails,
  liveWorkEntries,
  occupied,
  occupancyProofs,
  processesRootedIn,
  recordFixerAttempt,
  registryAgents,
  registryEntryState,
  supervisedBy,
  supervisorFresh,
  worktreeClaim,
  worktreeClaimInfo,
  type WorkEntry,
} from './drive.ts'
import { driveSection } from './drive-config.ts'
import { git, initRepo, inside } from './testrepo.ts'

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'native-aaa',
  molStep: 'bro-x',
  backend: 'native',
  state: 'running',
  ...over,
})

describe('driveArgs', () => {
  test('defaults: one pass, merge on', () => {
    assert.deepEqual(driveArgs([]), { json: false, merge: true, connector: undefined })
    assert.deepEqual(driveArgs(['--once']), { json: false, merge: true, connector: undefined })
  })

  test('flags parse', () => {
    assert.deepEqual(driveArgs(['--every', '60', '--no-merge', '--json', '--connector', 'tmux']), {
      everySec: 60,
      merge: false,
      json: true,
      connector: 'tmux',
    })
    assert.equal(driveArgs(['--every=15']).everySec, 15)
    // a bare --every takes the configured cadence
    assert.equal(driveArgs(['--every']).everySec, 300)
    assert.equal(driveArgs(['--every'], 60).everySec, 60)
    assert.equal(driveArgs(['--every', '--json']).everySec, 300)
  })

  test('a bad --every fails closed', () => {
    for (const v of ['abc', '0', '-5', 'NaN', '3000000000', '0.01']) {
      assert.throws(() => driveArgs(['--every', v]), /--every/)
    }
    // the floor fleet already enforces — below it is a busy loop
    assert.equal(driveArgs(['--every', '0.1']).everySec, 0.1)
  })
})

describe('driveSection', () => {
  test('defaults', () => {
    assert.deepEqual(driveSection(undefined), {
      intervalSec: 300,
      merge: 'auto',
      occupancyTtlSec: 7200,
    })
    assert.deepEqual(driveSection({}), {
      intervalSec: 300,
      merge: 'auto',
      occupancyTtlSec: 7200,
    })
    assert.deepEqual(driveSection('garbage'), {
      intervalSec: 300,
      merge: 'auto',
      occupancyTtlSec: 7200,
    })
  })

  test('values survive; junk falls back', () => {
    assert.deepEqual(driveSection({ intervalSec: 60, merge: 'never', occupancyTtlSec: 600 }), {
      intervalSec: 60,
      merge: 'never',
      occupancyTtlSec: 600,
    })
    assert.equal(driveSection({ intervalSec: -5 }).intervalSec, 300)
    // a saved cadence below the --every floor would be rejected as its
    // own default — the section normalizes out-of-range values
    assert.equal(driveSection({ intervalSec: 0.05 }).intervalSec, 300)
    assert.equal(driveSection({ intervalSec: Infinity }).intervalSec, 300)
    assert.equal(driveSection({ merge: 'always' }).merge, 'auto')
    // a TTL under the activity floor reads per-pass noise as silence
    assert.equal(driveSection({ occupancyTtlSec: 5 }).occupancyTtlSec, 7200)
    assert.equal(driveSection({ occupancyTtlSec: 'never' }).occupancyTtlSec, 7200)
    assert.equal(driveSection({ occupancyTtlSec: 60 }).occupancyTtlSec, 60)
  })
})

describe('candidateBranches', () => {
  test('worktree branches + fleet-prefixed locals, deduped', () => {
    const { root, main } = initRepo('bro-drive-cand-')
    inside(main, root, () => {
      git(['branch', 'work/bro-a'], main)
      git(['branch', 'loop/bro-b'], main)
      git(['branch', 'stack/s/1-bro-c'], main)
      git(['branch', 'random/topic'], main)
      git(['worktree', 'add', '-q', join(root, 'side'), 'work/bro-a'], main)
      const { branches, complete } = candidateBranches(main)
      assert.equal(complete, true)
      assert.ok(branches.includes('work/bro-a'))
      assert.ok(branches.includes('loop/bro-b'))
      assert.ok(branches.includes('stack/s/1-bro-c'))
      assert.ok(!branches.includes('random/topic'))
      assert.equal(branches.filter((b) => b === 'work/bro-a').length, 1)
    })
  })

  test('a failed git listing is incomplete, never a drained set', () => {
    const { branches, complete } = candidateBranches('/no/such/dir')
    assert.deepEqual(branches, [])
    assert.equal(complete, false)
  })
})

describe('branchSlug', () => {
  test('last path segment', () => {
    assert.equal(branchSlug('work/bro-tui8'), 'bro-tui8')
    assert.equal(branchSlug('stack/s/3-bro-x'), '3-bro-x')
    assert.equal(branchSlug('plain'), 'plain')
  })
})

describe('detailMatches', () => {
  const ctx = { branch: 'work/bro-a', slug: 'bro-a', worktree: '/repos/bro--bro-a' }

  test('bead id / slug / branch', () => {
    assert.ok(detailMatches('bro-a', ctx))
    assert.ok(detailMatches('work/bro-a', ctx))
    assert.ok(!detailMatches('bro-b', ctx))
  })

  test('worktree path and basename', () => {
    assert.ok(detailMatches('bro--bro-a', ctx))
    assert.ok(detailMatches('../bro--bro-a', ctx))
    assert.ok(detailMatches('/repos/bro--bro-a', ctx))
    assert.ok(!detailMatches('bro--bro-b', ctx))
  })

  test('no worktree still matches bead/branch', () => {
    const bare = { branch: 'work/bro-a', slug: 'bro-a' }
    assert.ok(detailMatches('bro-a', bare))
    assert.ok(!detailMatches('../bro--bro-a', bare))
  })
})

describe('liveWorkDetails', () => {
  test('fresh markers yield every detail line; stale ones yield none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-drive-hooks-'))
    try {
      writeFileSync(join(dir, 's1.work'), `${Date.now()}\nbro-a\nwork/bro-b\n`)
      writeFileSync(join(dir, 's2.work'), `${Date.now()}\nbro-c\n`)
      const stale = join(dir, 'old.work')
      writeFileSync(stale, `${Date.now()}\nbro-z\n`)
      // mtime is the freshness signal — age the file past LIVE_MARKER_MS
      const old = Date.now() - 48 * 60 * 60 * 1000
      utimesSync(stale, old / 1000, old / 1000)
      writeFileSync(join(dir, 'note.task'), `${Date.now()}\nbro-q\n`) // not a .work marker
      const details = liveWorkDetails(dir)
      assert.deepEqual(details.sort(), ['bro-a', 'bro-c', 'work/bro-b'].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing dir is empty, not an error', () => {
    assert.deepEqual(liveWorkDetails('/no/such/dir'), [])
  })

  test('a dead owner pid makes a fresh marker residue (bro-b87b)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-drive-hooks-'))
    try {
      // fresh mtime, but the recorded owner pid cannot exist — the
      // session died and nobody owns the claim anymore
      writeFileSync(
        join(dir, 'dead.work'),
        `${Date.now()} 2000000000 1\nbro-x\n`
      )
      writeFileSync(join(dir, 'old.work'), `${Date.now()}\nbro-y\n`)
      assert.deepEqual(liveWorkDetails(dir), ['bro-y'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a live owner pid keeps a marker past the freshness window (bro-xlhm)', { skip: process.platform !== 'linux' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-drive-hooks-'))
    try {
      // mtime aged past the window but the owner pid is us — an idle
      // session still owns its claim; the tag carries our real start —
      // no '1' fallback: a pid with a fabricated start is a shape
      // production never emits (ownerTag omits the tag without a
      // readable start), so assert the real one or skip on non-/proc
      const marker = join(dir, 'idle.work')
      const start = procStat(process.pid)?.start
      assert.ok(start, 'expected a readable /proc start for our own pid')
      writeFileSync(marker, `${Date.now()} ${process.pid} ${start}\nbro-idle\n`)
      const old = Date.now() - 48 * 60 * 60 * 1000
      utimesSync(marker, old / 1000, old / 1000)
      assert.deepEqual(liveWorkDetails(dir), ['bro-idle'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Minimal /proc tree: <pid>/cwd symlink + cmdline/environ files,
 *  plus a status file carrying PPid when the test wires ancestry. */
function fakeProc(): {
  proc: string
  mk: (pid: number, cwd: string, cmdline: string, environ?: string, ppid?: number) => void
  rm: () => void
} {
  const proc = mkdtempSync(join(tmpdir(), 'bro-drive-proc-'))
  return {
    proc,
    rm: () => rmSync(proc, { recursive: true, force: true }),
    mk: (pid, cwd, cmdline, environ, ppid) => {
      const dir = join(proc, String(pid))
      mkdirSync(dir)
      symlinkSync(cwd, join(dir, 'cwd'))
      writeFileSync(join(dir, 'cmdline'), cmdline)
      if (environ !== undefined) {
        writeFileSync(join(dir, 'environ'), environ)
      }
      if (ppid !== undefined) {
        writeFileSync(join(dir, 'status'), `Name:\tx\nPPid:\t${ppid}\n`)
      }
    },
  }
}

describe('agentProcessesIn', () => {
  test('agent-shaped cmdlines inside the worktree count; others do not', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(101, wt, 'devin\0-p\0fix stuff')
      mk(102, join(wt, 'sub', 'dir'), 'claude\0-p\0x') // nested cwd counts
      mk(103, wt, 'node\0tsc\0--watch') // leftover watcher — NOT an agent
      mk(104, '/elsewhere', 'devin\0-p\0x') // right cmdline, wrong tree
      const hits = agentProcessesIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits.sort(), [101, 102])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('BRO_AGENT_ID in environ marks a bro-spawned worker whatever the cmdline', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(201, wt, 'sh\0-c\0worker', 'PATH=/bin\0BRO_AGENT_ID=native-abc\0')
      assert.deepEqual(agentProcessesIn(wt, proc).map((h) => h.pid), [201])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a tool shell inside the worktree counts via its agent ancestor (bro-pywx)', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const main = mkdtempSync(join(tmpdir(), 'bro-drive-main-'))
    const { proc, mk, rm } = fakeProc()
    try {
      // the incident shape: the agent CLI sits at its launch dir while
      // its tool shell holds the worktree cwd — own-cmdline-only scans
      // see nothing agent-shaped in the tree at all
      mk(301, main, 'devin\0-p\0--permission-mode\0dangerous') // the session, cwd = launch dir
      mk(302, main, 'devin\0acp', undefined, 301) // its acp child, still outside
      mk(303, wt, 'bash', undefined, 302) // tool shell inside the worktree
      mk(304, join(wt, 'x'), 'sleep 30', undefined, 303) // its command, one hop deeper
      mk(305, wt, 'bash', undefined, 999) // a human shell — no agent ancestor
      const hits = agentProcessesIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits.sort(), [303, 304])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
      rmSync(main, { recursive: true, force: true })
    }
  })

  test('AI_AGENT in environ badges devin-spawned descendants', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(401, wt, 'node\0server.js', 'PATH=/bin\0AI_AGENT=devin_3000-11-3_agent\0')
      mk(402, wt, 'node\0x.js', 'PATH=/bin\0NOT_AI_AGENT=yep\0') // anchored — no match
      assert.deepEqual(agentProcessesIn(wt, proc).map((h) => h.pid), [401])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a cyclic ppid chain terminates the walk instead of hanging', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(501, wt, 'weird', undefined, 502)
      mk(502, wt, 'weird', undefined, 501)
      assert.deepEqual(agentProcessesIn(wt, proc), [])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a missing procDir is empty — non-Linux degrades, never blocks', () => {
    assert.deepEqual(agentProcessesIn('/tmp', '/no/such/proc'), [])
  })
})

describe('processesRootedIn', () => {
  // bro-1usa8: a merged-PR worktree cleanup kept nothing about what the
  // tree still HOSTED — `node <wt>/dist serve` has cwd in the main repo
  // but its argv executes the tree's code; removal stranded a zombie.

  test('an argv token inside the tree roots the process — cwd elsewhere', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const main = mkdtempSync(join(tmpdir(), 'bro-drive-main-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(601, main, `node\0${join(wt, 'packages', 'cli', 'dist', 'index.js')}\0serve`)
      mk(602, main, 'node\0/other/dist/index.js\0serve') // another repo's serve — not rooted
      const hits = processesRootedIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits, [601])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
      rmSync(main, { recursive: true, force: true })
    }
  })

  test('cwd inside the tree roots any process — agent shape not required', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(701, join(wt, 'sub'), 'tail\0-f\0log.txt') // a watcher, not an agent
      const hits = processesRootedIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits, [701])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a relative argv token resolves against the process cwd', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const outside = mkdtempSync(join(tmpdir(), 'bro-drive-out-'))
    const rel = `${relative(outside, wt)}${sep}dist${sep}index.js`
    const { proc, mk, rm } = fakeProc()
    try {
      mk(901, outside, `node\0${rel}\0serve`)
      const hits = processesRootedIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits, [901])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('unrelated processes and a missing procDir read as unoccupied', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(801, '/elsewhere', 'sleep\x00300')
      assert.deepEqual(processesRootedIn(wt, proc), [])
      assert.deepEqual(processesRootedIn(wt, '/no/such/proc'), [])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })
})

describe('occupied', () => {
  const base = {
    agents: [] as AgentInfo[],
    branch: 'work/bro-a',
    worktree: '/repos/bro--bro-a',
    workDetails: [] as WorkEntry[],
  }

  test('no signals → orphaned', () => {
    assert.equal(occupied(base), undefined)
  })

  test('a live fixer agent is reported as the fixer, not a foreign occupant', () => {
    const why = occupied({ ...base, fixerBead: 'bro-fix1', agents: [agent({ molStep: 'bro-fix1' })] })
    assert.match(why ?? '', /fixer agent live/)
  })

  test('a live agent recorded in the worktree occupies it', () => {
    const why = occupied({
      ...base,
      agents: [agent({ id: 'native-zz', worktree: '/repos/bro--bro-a' })],
    })
    assert.match(why ?? '', /native-zz.*live/)
  })

  test('exited agents do not occupy', () => {
    const why = occupied({
      ...base,
      agents: [agent({ state: 'exited', worktree: '/repos/bro--bro-a' })],
    })
    assert.equal(why, undefined)
  })

  test('a fresh marker detail naming the bead occupies', () => {
    const why = occupied({ ...base, workDetails: [{ detail: 'bro-a' }] })
    assert.match(why ?? '', /armed work/)
  })

  test('a marker for other work does not occupy', () => {
    const why = occupied({ ...base, workDetails: [{ detail: 'bro-unrelated' }] })
    assert.equal(why, undefined)
  })

  test('a live agent-shaped process in the worktree occupies', () => {
    const why = occupied({
      ...base,
      scanProc: () => [{ pid: 42, cmd: 'devin -p x' }],
    })
    assert.match(why ?? '', /process 42/)
  })

  test('the worktree claim marker occupies without any name matching', () => {
    const why = occupied({
      ...base,
      scanClaim: () => ({ detail: 'bro-a', mtimeMs: Date.now(), owner: null }),
    })
    assert.match(why ?? '', /claimed by bro-a/)
  })

  test('a claimed worktree still reports the fixer as the fixer', () => {
    const why = occupied({
      ...base,
      fixerBead: 'bro-fix1',
      agents: [agent({ molStep: 'bro-fix1' })],
      scanClaim: () => ({ detail: 'bro-a', mtimeMs: Date.now(), owner: null }),
    })
    assert.match(why ?? '', /fixer agent live/)
  })
})

describe('greenOccupancy — the merge-path TTL (bro-ihnlv)', () => {
  const NOW = Date.parse('2026-10-12T12:00:00Z')
  const TTL = 2 * 3_600_000
  const ago = (ms: number): number => NOW - ms
  const iso = (ms: number): string => new Date(ago(ms)).toISOString()
  const base = {
    agents: [] as AgentInfo[],
    branch: 'work/bro-a',
    worktree: '/repos/bro--bro-a',
    workDetails: [] as WorkEntry[],
  }

  test('no occupancy → neither fresh nor stale', () => {
    assert.deepEqual(greenOccupancy(base, TTL, NOW), {})
  })

  test('fresh marker activity keeps the PR occupied — detail is the freshest proof', () => {
    const g = greenOccupancy(
      { ...base, workDetails: [{ detail: 'bro-a', mtimeMs: ago(60_000) }] },
      TTL,
      NOW
    )
    assert.match(g.fresh ?? '', /armed work on bro-a/)
    assert.equal(g.stale, undefined)
  })

  test('a stale .work marker reads silent → adopted with the silence measured', () => {
    const g = greenOccupancy(
      { ...base, workDetails: [{ detail: 'bro-a', mtimeMs: ago(3 * 3_600_000) }] },
      TTL,
      NOW
    )
    assert.equal(g.fresh, undefined)
    assert.match(g.stale ?? '', /armed work/)
    assert.equal(g.silentMs, 3 * 3_600_000)
  })

  test('a proof with no activity stamp is unverifiable → adopted, silence unmeasured', () => {
    const g = greenOccupancy({ ...base, workDetails: [{ detail: 'bro-a' }] }, TTL, NOW)
    assert.match(g.stale ?? '', /armed work/)
    assert.equal(g.silentMs, undefined)
  })

  test('a stale fixer beside a fresh marker still vetoes — the freshest proof wins', () => {
    const g = greenOccupancy(
      {
        ...base,
        fixerBead: 'bro-fix1',
        agents: [agent({ molStep: 'bro-fix1', spawnedAt: iso(5 * 3_600_000) })],
        workDetails: [{ detail: 'bro-a', mtimeMs: ago(5 * 60_000) }],
      },
      TTL,
      NOW
    )
    assert.match(g.fresh ?? '', /armed work on bro-a/)
  })

  test('an agent\'s activity is max(log mtime, spawnedAt)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-drive-act-'))
    try {
      const log = join(dir, 'native-a.log')
      writeFileSync(log, 'out')
      // old spawn, fresh log — the log carries the proof
      utimesSync(log, ago(60_000) / 1000, ago(60_000) / 1000)
      const g = greenOccupancy(
        {
          ...base,
          fixerBead: 'bro-fix1',
          agents: [agent({ molStep: 'bro-fix1', spawnedAt: iso(5 * 3_600_000), log })],
        },
        TTL,
        NOW
      )
      assert.match(g.fresh ?? '', /fixer agent live/)
      // fresh spawn, stale log — spawnedAt carries it
      utimesSync(log, ago(5 * 3_600_000) / 1000, ago(5 * 3_600_000) / 1000)
      const g2 = greenOccupancy(
        {
          ...base,
          fixerBead: 'bro-fix1',
          agents: [agent({ molStep: 'bro-fix1', spawnedAt: iso(60_000), log })],
        },
        TTL,
        NOW
      )
      assert.match(g2.fresh ?? '', /fixer agent live/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a pid-less spawned entry bounds by spawnedAt — the bead\'s own case', () => {
    const live = greenOccupancy(
      {
        ...base,
        fixerBead: 'fx',
        agents: [agent({ molStep: 'fx', state: 'spawned', spawnedAt: iso(3_600_000) })],
      },
      TTL,
      NOW
    )
    assert.match(live.fresh ?? '', /fixer agent live/)
    const stale = greenOccupancy(
      {
        ...base,
        fixerBead: 'fx',
        agents: [agent({ molStep: 'fx', state: 'spawned', spawnedAt: iso(5 * 3_600_000) })],
      },
      TTL,
      NOW
    )
    assert.match(stale.stale ?? '', /fixer agent live/)
    // and never-readable (no spawnedAt, no log) is unverifiable → adopted
    const bare = greenOccupancy(
      { ...base, fixerBead: 'fx', agents: [agent({ molStep: 'fx', state: 'spawned' })] },
      TTL,
      NOW
    )
    assert.equal(bare.fresh, undefined)
    assert.match(bare.stale ?? '', /fixer agent live/)
    assert.equal(bare.silentMs, undefined)
  })

  test('a /proc hit ages by the worktree\'s own churn — a parked process is silent', () => {
    const ctx = { ...base, scanProc: () => [{ pid: 42, cmd: 'devin -p x' }] }
    const parked = greenOccupancy({ ...ctx, treeIdleMs: () => 3 * 3_600_000 }, TTL, NOW)
    assert.equal(parked.fresh, undefined)
    assert.match(parked.stale ?? '', /process 42/)
    const active = greenOccupancy({ ...ctx, treeIdleMs: () => 60_000 }, TTL, NOW)
    assert.match(active.fresh ?? '', /process 42/)
    // an unstat-able tree (idle ∞) proves nothing → adopted
    const unverifiable = greenOccupancy(
      { ...ctx, treeIdleMs: () => Number.POSITIVE_INFINITY },
      TTL,
      NOW
    )
    assert.equal(unverifiable.fresh, undefined)
  })

  test('a stale claim marker is adopted; a fresh one vetoes', () => {
    const stale = greenOccupancy(
      { ...base, scanClaim: () => ({ detail: 'bro-a', mtimeMs: ago(3 * 3_600_000), owner: null }) },
      TTL,
      NOW
    )
    assert.match(stale.stale ?? '', /claimed by bro-a/)
    const fresh = greenOccupancy(
      { ...base, scanClaim: () => ({ detail: 'bro-a', mtimeMs: ago(60_000), owner: null }) },
      TTL,
      NOW
    )
    assert.match(fresh.fresh ?? '', /claimed by bro-a/)
  })
})

describe('supervisorFresh — the adopt-path veto bound (bro-ihnlv)', () => {
  // real file mtimes — NOW is the wall clock, not a fixture date
  const NOW = Date.now()
  const TTL = 2 * 3_600_000
  const sup = (file: string): ListedWatch => ({
    watch: {
      pr: 7,
      link: '[#7](https://x/pull/7)',
      pid: 4242,
      merge: true,
      startedAt: NOW - 60_000,
      timeoutMin: 60,
    },
    file,
    alive: true,
  })

  test('a fresh marker file vetoes; a stale one does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-drive-sup-'))
    try {
      const fresh = join(dir, '7-loop-1.json')
      const stale = join(dir, '8-loop-1.json')
      writeFileSync(fresh, '{}')
      writeFileSync(stale, '{}')
      utimesSync(stale, (NOW - 5 * 3_600_000) / 1000, (NOW - 5 * 3_600_000) / 1000)
      assert.equal(supervisorFresh(sup(fresh), TTL, NOW), true)
      assert.equal(supervisorFresh(sup(stale), TTL, NOW), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unreadable stamp stays conservative — veto once more', () => {
    assert.equal(supervisorFresh(sup('/no/such/marker.json'), TTL, NOW), true)
  })
})

describe('supervisedBy — the watch-marker plane (bro-0aa87)', () => {
  const occBase = {
    agents: [] as AgentInfo[],
    branch: 'work/bro-a',
    worktree: '/repos/bro--bro-a',
    workDetails: [] as WorkEntry[],
  }
  /** Marker names carry the kind: `<pr>-loop-<pid>.json` or
   *  `<pr>-<pid>-<nonce>.json` (kind 'wait'). */
  const watch = (
    pr: number,
    kind: string,
    over: Partial<ListedWatch> = {}
  ): ListedWatch => ({
    watch: {
      pr,
      link: `[#${pr}](https://x/pull/${pr})`,
      pid: 4242,
      merge: true,
      startedAt: Date.now(),
      timeoutMin: 60,
    },
    file: `/watches/${pr}-${kind === 'wait' ? '4242-f00bad' : `${kind}-4242`}.json`,
    alive: true,
    ...over,
  })

  test('a live foreign marker supervises — loop heartbeat, wait, convoy', () => {
    for (const kind of ['loop', 'wait', 'convoy']) {
      const sup = supervisedBy([watch(7, kind)], 7)
      assert.equal(sup?.watch.pr, 7, `${kind} marker must supervise`)
    }
  })

  test('a live drive marker does not — drive-vs-drive is dedup elsewhere', () => {
    assert.equal(supervisedBy([watch(7, 'drive')], 7), undefined)
    // a second live drive beside a loop marker still reads supervised
    const sup = supervisedBy([watch(7, 'drive'), watch(7, 'loop')], 7)
    assert.equal(sup?.file, '/watches/7-loop-4242.json')
  })

  test('dead or unrelated markers do not supervise', () => {
    assert.equal(supervisedBy([watch(7, 'loop', { alive: false })], 7), undefined)
    assert.equal(supervisedBy([watch(8, 'loop')], 7), undefined)
    assert.equal(supervisedBy([], 7), undefined)
    assert.equal(supervisedBy(undefined, 7), undefined)
    assert.equal(supervisedBy([watch(7, 'loop')], undefined), undefined)
  })

  test('occupied reports the supervisor, verdicts skip the PR', () => {
    const why = occupied({
      ...occBase,
      pr: 7,
      watches: [watch(7, 'loop')],
    })
    assert.match(why ?? '', /supervised by loop pid 4242/)
  })

  test('a dead supervisor marker frees the PR — coverage self-restores', () => {
    const why = occupied({
      ...occBase,
      pr: 7,
      watches: [watch(7, 'loop', { alive: false })],
    })
    assert.equal(why, undefined)
  })

  test('supervision wins over the weaker planes but not over our own fixer', () => {
    const why = occupied({
      ...occBase,
      pr: 7,
      watches: [watch(7, 'loop')],
      workDetails: [{ detail: 'bro-a' }],
    })
    assert.match(why ?? '', /supervised by loop/)
    const fixer = occupied({
      ...occBase,
      pr: 7,
      watches: [watch(7, 'loop')],
      fixerBead: 'bro-fix1',
      agents: [agent({ molStep: 'bro-fix1' })],
    })
    assert.match(fixer ?? '', /fixer agent live/)
  })
})

describe('worktreeClaim', () => {
  /** A worktree whose .git is the pointer file a linked tree gets. */
  function fakeWorktree(): { wt: string; gitdir: string; rm: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'bro-drive-claim-'))
    const wt = join(root, 'repo--x')
    const gitdir = join(root, 'repo', '.git', 'worktrees', 'repo--x')
    mkdirSync(gitdir, { recursive: true })
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    return { wt, gitdir, rm: () => rmSync(root, { recursive: true, force: true }) }
  }

  test('fresh marker returns its detail; stale or missing reads unclaimed', () => {
    const { wt, gitdir, rm } = fakeWorktree()
    try {
      assert.equal(worktreeClaim(wt), undefined)
      mkdirSync(join(gitdir, 'bro'), { recursive: true })
      const marker = join(gitdir, 'bro', 'work')
      writeFileSync(marker, '123\nbro-x\n')
      assert.equal(worktreeClaim(wt), 'bro-x')
      const old = new Date(Date.now() - 48 * 3_600_000)
      utimesSync(marker, old, old)
      assert.equal(worktreeClaim(wt), undefined)
    } finally {
      rm()
    }
  })

  test('a main checkout reads its .git dir the same way', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-drive-claim-'))
    try {
      const gd = join(root, '.git')
      mkdirSync(join(gd, 'bro'), { recursive: true })
      writeFileSync(join(gd, 'bro', 'work'), '1\n\n')
      assert.equal(worktreeClaim(root), '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('registryEntryState', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    agentId: 'native-a',
    backend: 'native',
    spawnedAt: 't',
    ...over,
  })

  test('a live pid is running; a dead one is lost — the respawn path survives (bro-taq6)', () => {
    assert.equal(registryEntryState(null, entry({ pid: process.pid })), 'running')
    assert.equal(registryEntryState(null, entry({ pid: 2000000000 })), 'lost')
  })

  test('recorded death is terminal', () => {
    assert.equal(registryEntryState(null, entry({ stopped: true })), 'stopped')
    assert.equal(registryEntryState(null, entry({ exitStatus: 3 })), 'exited')
  })

  test('an unharvested .exit file still proves the exit', () => {
    const home = mkdtempSync(join(tmpdir(), 'bro-reg-state-'))
    try {
      writeFileSync(join(home, 'a1.exit'), '0')
      assert.equal(registryEntryState(home, entry({ agentId: 'a1' })), 'exited')
      assert.equal(registryEntryState(home, entry({ agentId: 'a2' })), 'spawned')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a pid-less entry with no death proof is conservatively live', () => {
    assert.equal(
      registryEntryState(null, { agentId: 'gc-1', backend: 'gascity', spawnedAt: 't' }),
      'spawned'
    )
  })

  test("an empty pidStart is unverified identity, not reuse proof — a live agent must not read 'lost' (cubic)", () => {
    assert.equal(
      registryEntryState(null, entry({ pid: process.pid, pidStart: '' })),
      'running'
    )
  })
})

describe('registryAgents', () => {
  test('maps registry entries to agent info — cheap in-lock occupancy view', () => {
    const { root, main } = initRepo('bro-reg-agents-')
    inside(main, root, () => {
      mkdirSync(join(main, '.git', 'bro'), { recursive: true })
      writeFileSync(
        join(main, '.git', 'bro', 'agents.json'),
        JSON.stringify({
          'fx-1': {
            agentId: 'native-a',
            backend: 'native',
            spawnedAt: 't',
            pid: process.pid,
            worktree: join(root, 'main--w'),
          },
          'fx-2': { agentId: 'gc-b', backend: 'gascity', spawnedAt: 't' },
        })
      )
      const agents = registryAgents(main)
      assert.equal(agents.length, 2)
      const live = agents.find((a) => a.molStep === 'fx-1')!
      assert.equal(live.state, 'running')
      assert.equal(live.worktree, join(root, 'main--w'))
      assert.equal(agents.find((a) => a.molStep === 'fx-2')!.state, 'spawned')
    })
  })
})

describe('freshOccupancy', () => {
  test('a respawned same-id entry keeps the live verdict — the pass probed a dead generation (cubic)', () => {
    const { root, main } = initRepo('bro-fresh-occ-')
    inside(main, root, () => {
      mkdirSync(join(main, '.git', 'bro'), { recursive: true })
      writeFileSync(
        join(main, '.git', 'bro', 'agents.json'),
        JSON.stringify({
          'fx-1': { agentId: 'native-a', backend: 'native', spawnedAt: 't2' },
        })
      )
      // the pass probed generation t1 as lost — a respawn landed since;
      // its fresh 'spawned' must not inherit the stale death verdict
      const stale = freshOccupancy(main, [
        agent({ molStep: 'fx-1', id: 'native-a', state: 'lost', spawnedAt: 't1' }),
      ])
      assert.equal(stale.agents.find((a) => a.molStep === 'fx-1')!.state, 'spawned')
      // same generation does inherit — a lost fixer stays respawn-able
      const same = freshOccupancy(main, [
        agent({ molStep: 'fx-1', id: 'native-a', state: 'lost', spawnedAt: 't2' }),
      ])
      assert.equal(same.agents.find((a) => a.molStep === 'fx-1')!.state, 'lost')
    })
  })

  test('a registry read error degrades to the pass snapshot, never an error verdict (bro-yhfj)', () => {
    const { root, main } = initRepo('bro-fresh-deg-')
    inside(main, root, () => {
      // agents.json as a directory → EISDIR — readAgentRegistry
      // rethrows it like EACCES/EIO (degradation, not emptiness)
      mkdirSync(join(main, '.git', 'bro', 'agents.json'), { recursive: true })
      const known = [agent({ molStep: 'fx-1', id: 'native-a', state: 'lost', spawnedAt: 't' })]
      const fresh = freshOccupancy(main, known)
      assert.equal(fresh.agents.find((a) => a.molStep === 'fx-1')!.state, 'lost')
    })
  })
})

describe('fixerBeadFor', () => {
  const stubStore = (rows: TaskRow[]): TaskStore =>
    ({
      list: () => rows,
    }) as unknown as TaskStore

  test('finds the open fixer bead by external_ref', () => {
    const rows = [
      { id: 'b1', external_ref: fixerRef(7), status: 'open', labels: ['fixer'] },
      { id: 'b2', external_ref: 'something-else', status: 'open', labels: ['fixer'] },
    ] as TaskRow[]
    assert.equal(fixerBeadFor(stubStore(rows), 7)?.id, 'b1')
    assert.equal(fixerBeadFor(stubStore(rows), 8), undefined)
  })

  test('a closed fixer bead is not reused', () => {
    const rows = [
      { id: 'b1', external_ref: fixerRef(7), status: 'closed', labels: ['fixer'] },
    ] as TaskRow[]
    assert.equal(fixerBeadFor(stubStore(rows), 7), undefined)
  })
})

describe('buildFixerPrompt', () => {
  test('carries the PR link, branch, worktree, threads, and the no-merge rule', () => {
    const p = buildFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      threads: [
        { path: 'src/x.ts', line: 10, author: 'greptile', body: 'unchecked null' },
        { path: 'src/y.ts', line: 5, author: 'cubic', body: 'drop the cast' },
      ],
    })
    assert.match(p, /#42.*pull\/42/)
    assert.match(p, /work\/bro-a/)
    assert.match(p, /bro--bro-a/)
    assert.match(p, /src\/x\.ts:10 \[greptile\] unchecked null/)
    assert.match(p, /NEVER merge/)
  })
})

describe('buildRebaseFixerPrompt', () => {
  test('carries the PR link, branch, base, worktree, and the no-merge rule', () => {
    const p = buildRebaseFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      base: 'main',
      worktree: '/repos/bro--bro-a',
    })
    assert.match(p, /#42.*pull\/42/)
    assert.match(p, /work\/bro-a/)
    assert.match(p, /bro--bro-a/)
    assert.match(p, /merge conflicts with its base branch `main`/)
    // the work order fetches the PR branch too — a stale local tip would
    // rebase without the remote's newer commits and drop them on push
    assert.match(p, /fetch origin work\/bro-a main/)
    assert.match(p, /rebase origin\/work\/bro-a/)
    assert.match(p, /git rebase origin\/main/)
    assert.match(p, /--force-with-lease/)
    assert.match(p, /NEVER merge/)
  })
})

describe('ensureFixerWorktree', () => {
  /** A remote-backed `work/bro-a` standing at `<root>/main--bro-a` —
   *  bare origin.git + pushed branch + its worktree. Each remote test
   *  then stales refs or moves tips to taste. */
  const remoteBackedCheckout = (root: string, main: string): string => {
    git(['init', '-q', '--bare', join(root, 'origin.git')], root)
    git(['remote', 'add', 'origin', join(root, 'origin.git')], main)
    git(['branch', 'work/bro-a'], main)
    git(['push', '-qu', 'origin', 'work/bro-a'], main)
    const dir = join(root, 'main--bro-a')
    git(['worktree', 'add', '-q', dir, 'work/bro-a'], main)
    return dir
  }

  test('reuses the conventional dir on the right branch; a foreign one falls back', () => {
    const { root, main } = initRepo('bro-drive-wtx-')
    inside(main, root, () => {
      git(['branch', 'work/bro-a'], main)
      git(['branch', 'work/bro-b'], main)
      git(['branch', 'work/bro-c'], main)
      const dir = join(root, 'main--bro-a')
      git(['worktree', 'add', '-q', dir, 'work/bro-a'], main)
      assert.equal(ensureFixerWorktree(main, 'work/bro-a').path, dir)
      // main--bro-c stands on a different branch — never clobbered; the
      // branch-namespaced path takes the checkout instead
      const foreign = join(root, 'main--bro-c')
      git(['worktree', 'add', '-q', foreign, 'work/bro-b'], main)
      const r = ensureFixerWorktree(main, 'work/bro-c')
      assert.equal(r.path, join(root, 'main--work-bro-c'))
      assert.equal(r.created, true)
      assert.equal(git(['-C', r.path!, 'branch', '--show-current'], main).trim(), 'work/bro-c')
      assert.equal(git(['-C', foreign, 'branch', '--show-current'], main).trim(), 'work/bro-b')
    })
  })

  test('every name held by a foreign branch is a named refusal', () => {
    const { root, main } = initRepo('bro-drive-wtf-')
    inside(main, root, () => {
      git(['branch', 'work/bro-b'], main)
      git(['branch', 'work/bro-e'], main)
      git(['worktree', 'add', '-q', join(root, 'main--bro-d'), 'work/bro-b'], main)
      git(['worktree', 'add', '-q', join(root, 'main--work-bro-d'), 'work/bro-e'], main)
      assert.match(ensureFixerWorktree(main, 'work/bro-d').err ?? '', /foreign branch/)
    })
  })

  test('creates the worktree on an existing uncheckout branch', () => {
    const { root, main } = initRepo('bro-drive-wtc-')
    inside(main, root, () => {
      git(['branch', 'work/bro-a'], main)
      const r = ensureFixerWorktree(main, 'work/bro-a')
      assert.equal(r.err, undefined)
      assert.equal(r.created, true)
      assert.equal(git(['-C', r.path!, 'branch', '--show-current'], main).trim(), 'work/bro-a')
    })
  })

  test('a reused checkout fast-forwards to the remote tip', () => {
    const { root, main } = initRepo('bro-drive-wtr-')
    inside(main, root, () => {
      const dir = remoteBackedCheckout(root, main)
      // the remote gains a commit the standing checkout hasn't seen —
      // commit on main and push it across as work/bro-a; the tracking
      // ref is staled so the fetch inside ensure is what restores it
      git(['commit', '-qm', 'remote', '--allow-empty'], main)
      git(['push', '-q', 'origin', 'main:work/bro-a'], main)
      git(['update-ref', '-d', 'refs/remotes/origin/work/bro-a'], main)
      const stale = git(['-C', dir, 'rev-parse', 'HEAD'], main).trim()
      assert.equal(ensureFixerWorktree(main, 'work/bro-a').path, dir)
      const tip = git(['-C', dir, 'rev-parse', 'HEAD'], main).trim()
      assert.notEqual(tip, stale)
      assert.equal(tip, git(['-C', dir, 'rev-parse', 'origin/work/bro-a'], main).trim())
    })
  })

  test('a branch diverged from its remote is refused, never clobbered', () => {
    const { root, main } = initRepo('bro-drive-wtd-')
    inside(main, root, () => {
      const dir = remoteBackedCheckout(root, main)
      // local tip one way, remote the other — the tracking ref is
      // staled so the fetch inside ensure is what proves the divergence
      git(['-C', dir, 'commit', '-qm', 'local', '--allow-empty'], main)
      git(['commit', '-qm', 'remote', '--allow-empty'], main)
      git(['push', '-q', 'origin', 'main:work/bro-a'], main)
      git(['update-ref', '-d', 'refs/remotes/origin/work/bro-a'], main)
      const tip = git(['-C', dir, 'rev-parse', 'HEAD'], main).trim()
      const r = ensureFixerWorktree(main, 'work/bro-a')
      assert.equal(r.path, undefined)
      assert.match(r.err ?? '', /diverged/)
      assert.equal(git(['-C', dir, 'rev-parse', 'HEAD'], main).trim(), tip)
    })
  })
})

describe('buildCiFixerPrompt', () => {
  test('names the failing checks, the log/annotation reads, and the verdict contract', () => {
    const p = buildCiFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
      failing: [
        { name: 'build-test', state: 'FAILURE', bucket: 'fail' },
        { name: 'sonarcloud', state: 'FAILURE', bucket: 'fail' },
      ],
    })
    assert.match(p, /#42.*pull\/42/)
    assert.match(p, /work\/bro-a/)
    assert.match(p, /bro--bro-a/)
    assert.match(p, /2 failing check\(s\)/)
    assert.match(p, /- build-test/)
    // a SAST-named run is told apart — its findings are annotations
    assert.match(p, /- sonarcloud — a SAST check.*annotations, not log lines/)
    assert.match(p, /gh run view --log-failed/)
    assert.match(p, /gh api repos\/o\/r\/check-runs\/<run-id>\/annotations/)
    assert.match(p, /NEVER merge/)
    // the no-push exit contract — a clean exit is terminal for the head
    assert.match(p, /clean exit without a push marks this head as attempted/)
    // the other classes' markers must not collide with this work order
    assert.doesNotMatch(p, /unresolved review thread/)
    assert.doesNotMatch(p, /merge conflicts with its base branch/)
  })

  test('a cancelled run is flagged', () => {
    const p = buildCiFixerPrompt({
      pr: 1,
      link: 'x',
      branch: 'b',
      worktree: 'w',
      repo: 'o/r',
      host: 'github',
      failing: [{ name: 'lint', state: 'CANCELLED', bucket: 'cancel' }],
    })
    assert.match(p, /- lint \(cancelled\)/)
  })

  test('a gitlab reviews connector gets glab api commands — never gh', () => {
    const p = buildCiFixerPrompt({
      pr: 42,
      link: '[!42](https://gitlab.example/o/r/-/merge_requests/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'gitlab',
      failing: [
        { name: 'build-test', state: 'failed', bucket: 'fail' },
        { name: 'sonarcloud', state: 'failed', bucket: 'fail' },
      ],
    })
    assert.match(p, /glab api projects\/o%2Fr\/merge_requests\/42\/pipelines/)
    assert.match(p, /glab api projects\/o%2Fr\/pipelines\/<pipeline-id>\/jobs/)
    assert.match(p, /glab api projects\/o%2Fr\/jobs\/<job-id>\/trace/)
    // no annotations endpoint on gitlab — a SAST job's findings are its report
    assert.match(p, /- sonarcloud — a SAST check.*scanner's report/)
    assert.doesNotMatch(p, /gh pr checks|gh run view|check-runs/)
  })
})

describe('buildSastFixerPrompt', () => {
  test('names checks + counts, points at the annotations API, and keeps the contract', () => {
    const p = buildSastFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
      headSha: 'abc123',
      findings: [
        { name: 'sonarcloud', count: 4 },
        { name: 'codacy', count: null },
      ],
    })
    assert.match(p, /#42.*pull\/42/)
    assert.match(p, /- sonarcloud: 4 finding\(s\)/)
    assert.match(p, /- codacy: annotations unreadable/)
    // the gate counts annotations, not conclusions — the prompt teaches it
    assert.match(p, /GREEN check can/)
    assert.match(p, /gh api repos\/o\/r\/commits\/abc123\/check-runs/)
    assert.match(p, /gh api repos\/o\/r\/check-runs\/<run-id>\/annotations/)
    assert.match(p, /NEVER merge/)
    assert.match(p, /clean exit without a push marks this head as attempted/)
  })

  test('a gitlab reviews connector points at the scanner report — no gh api', () => {
    const p = buildSastFixerPrompt({
      pr: 42,
      link: '[!42](https://gitlab.example/o/r/-/merge_requests/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'gitlab',
      headSha: 'abc123',
      findings: [{ name: 'sonarcloud', count: 2 }],
    })
    assert.match(p, /glab api projects\/o%2Fr/)
    assert.match(p, /no check-run/)
    assert.doesNotMatch(p, /gh api|check-runs\//)
  })
})

describe('fixerAttemptSpent — same-head dedup (bro-atb2g)', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    agentId: 'native-aaa',
    backend: 'native',
    spawnedAt: '2026-01-01',
    ...over,
  })

  test('only a clean-exit attempt on the same head+class spends', () => {
    const e = entry({ cause: 'ok', fixerAttempt: { head: 'abc', spent: [], current: 'ci' } })
    assert.equal(fixerAttemptSpent(e, 'abc', 'ci'), true)
    // a moved head earns a fresh round
    assert.equal(fixerAttemptSpent(e, 'def', 'ci'), false)
    // a different class on the same head still spawns
    assert.equal(fixerAttemptSpent(e, 'abc', 'sast'), false)
    // no attempt record — nothing to dedup
    assert.equal(fixerAttemptSpent(entry({ cause: 'ok' }), 'abc', 'ci'), false)
    assert.equal(fixerAttemptSpent(undefined, 'abc', 'ci'), false)
  })

  test('a promoted class stays spent through a later crash — per-class, not per-entry', () => {
    // ci ran ok then sast ran and crashed: cause describes sast's run —
    // ci keeps its own ok (spent), sast stays respawn-able
    const e = entry({ cause: 'crash', fixerAttempt: { head: 'abc', spent: ['ci'], current: 'sast' } })
    assert.equal(fixerAttemptSpent(e, 'abc', 'ci'), true)
    assert.equal(fixerAttemptSpent(e, 'abc', 'sast'), false)
  })

  test('a later ok run does not spend a class whose own run crashed', () => {
    // sast crashed; a following ci run exited ok — the entry's cause is
    // 'ok' but sast never earned its own ok → still respawn-able
    const e = entry({ cause: 'ok', fixerAttempt: { head: 'abc', spent: ['ci'], current: 'ci' } })
    assert.equal(fixerAttemptSpent(e, 'abc', 'sast'), false)
    assert.equal(fixerAttemptSpent(e, 'abc', 'ci'), true)
  })

  test('non-ok causes stay respawn-able; stopped lifts the dedup', () => {
    const att = { head: 'abc', spent: [], current: 'ci' }
    for (const cause of ['crash', 'rate_limited', 'quota', 'auth']) {
      assert.equal(
        fixerAttemptSpent(entry({ cause, fixerAttempt: att }), 'abc', 'ci'),
        false,
        `cause ${cause} must not dedup`
      )
    }
    // an unharvested exit (status recorded, cause not yet classified)
    assert.equal(
      fixerAttemptSpent(entry({ exitStatus: 0, fixerAttempt: att }), 'abc', 'ci'),
      false
    )
    // `bro agents down` is the operator's manual clear — same as it
    // lifting a rate_limited wall
    assert.equal(
      fixerAttemptSpent(entry({ cause: 'ok', stopped: true, fixerAttempt: att }), 'abc', 'ci'),
      false
    )
  })

  test('the pre-split {head, classes} record still reads — legacy compat', () => {
    // every listed class shared the one cause: all spent iff ok
    const ok = entry({ cause: 'ok', fixerAttempt: { head: 'abc', classes: ['ci'] } })
    assert.equal(fixerAttemptSpent(ok, 'abc', 'ci'), true)
    const crash = entry({ cause: 'crash', fixerAttempt: { head: 'abc', classes: ['ci'] } })
    assert.equal(fixerAttemptSpent(crash, 'abc', 'ci'), false)
  })

  test('a torn record fails open', () => {
    for (const fixerAttempt of [
      'x',
      7,
      null,
      { head: 1 },
      { head: 'a', classes: 'ci' },
      { head: 'a', spent: 'ci', current: 'ci' },
    ]) {
      assert.equal(
        fixerAttemptSpent(entry({ cause: 'ok', fixerAttempt }), 'a', 'ci'),
        false
      )
    }
  })

  test('recordFixerAttempt promotes only the class whose own cause was ok', () => {
    const { root, main } = initRepo('bro-drive-attempt-')
    inside(main, root, () => {
      // the entry the spawn wrote — patchAgentRegistry merges onto it
      // (an agentId-less write reads back as torn and drops)
      patchAgentRegistry(main, 'fx-1', { agentId: 'native-x', backend: 'native' })
      // ci exited ok → the sast spawn promotes 'ci' into spent
      recordFixerAttempt(
        main,
        'fx-1',
        entry({ cause: 'ok', fixerAttempt: { head: 'h', spent: [], current: 'ci' } }),
        'h',
        'sast'
      )
      let att = readAgentRegistry(main)['fx-1']?.fixerAttempt as {
        head: string
        spent: string[]
        current: string
      }
      assert.deepEqual(att, { head: 'h', spent: ['ci'], current: 'sast' })
      // sast crashed → the ci replay must NOT promote sast
      recordFixerAttempt(
        main,
        'fx-1',
        entry({ cause: 'crash', fixerAttempt: { head: 'h', spent: ['ci'], current: 'sast' } }),
        'h',
        'ci'
      )
      att = readAgentRegistry(main)['fx-1']?.fixerAttempt as typeof att
      assert.deepEqual(att, { head: 'h', spent: ['ci'], current: 'ci' })
      // a moved head resets the record
      recordFixerAttempt(main, 'fx-1', entry({ cause: 'ok', fixerAttempt: att }), 'h2', 'sast')
      att = readAgentRegistry(main)['fx-1']?.fixerAttempt as typeof att
      assert.deepEqual(att, { head: 'h2', spent: [], current: 'sast' })
    })
  })
})

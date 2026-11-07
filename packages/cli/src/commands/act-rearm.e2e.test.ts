import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  assertLandedBead,
  bead,
  FAKE_BEAD,
  initRepo,
  installFakeBd,
  installFakeHost,
  installFakeTasks,
  inside,
  readHostState,
  runCli,
  writeHostState,
} from './testrepo.ts'

/** Repo + fake review host — `act rearm` talks to host.json through the
 *  fixture connector; dead markers simulate a rebooted watcher's
 *  leftovers in .git/bro/watches. */
function fixture() {
  const { root, main } = initRepo('bro-act-rearm-')
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
    })
  )
  return { root, main, host }
}

function deadWatch(
  main: string,
  pr: number,
  w: Record<string, unknown> = {},
  name = `${pr}-2000000000.json`
): string {
  const wd = join(main, '.git', 'bro', 'watches')
  mkdirSync(wd, { recursive: true })
  const file = join(wd, name)
  writeFileSync(
    file,
    JSON.stringify({
      pr,
      link: `[#${pr}](https://example.test/o/r/pull/${pr})`,
      pid: 2_000_000_000,
      merge: true,
      timeoutMin: 5,
      startedAt: Date.now(),
      ...w,
    })
  )
  return file
}

/** SIGKILL the resurrected watcher on teardown — the test leaks nothing. */
function reaper(t: TestContext, root: string, pid: { n: number }): void {
  t.after(() => {
    if (pid.n > 0) {
      try {
        process.kill(pid.n, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true })
  })
}

/** Repo + fake host + fake beads store with fx-a claimed in_progress —
 *  the shape a dead loop's armed marker left behind (bro-q6ppv). */
function beadFixture() {
  const { root, main } = fixture()
  const { binDir, db } = installFakeBd(root, [
    { ...FAKE_BEAD, id: 'fx-a', status: 'in_progress' },
  ])
  const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_BD_DB: db }
  return { root, main, db, env }
}

/** `act wait --merge --bead fx-a` on pr 7 with the gate pinned to
 *  `prState` — the invocation both merge-discharge paths share; the
 *  host's `merges` counter afterwards tells which path ran. */
function mergeWait(main: string, env: Record<string, string>, prState: string) {
  writeHostState(join(main, 'host.json'), { prState })
  return runCli(
    ['act', 'wait', '7', '--interval', '1', '--timeout', '1', '--merge', '--bead', 'fx-a'],
    { cwd: main, env }
  )
}

/** The respawned wait writes its own live marker a tick after rearm
 *  returns — poll the watches dir for the child pid, don't assume. */
async function pollMarker(
  wd: string,
  pid: number
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    for (const f of readdirSync(wd)) {
      const w = JSON.parse(readFileSync(join(wd, f), 'utf8')) as Record<string, unknown>
      if (w.pid === pid) return w
    }
    await new Promise((res) => setTimeout(res, 50))
  }
  return null
}

describe('act rearm', () => {
  test('--dry-run reports the plan and mutates nothing', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
      const marker = deadWatch(main, 7)
      const r = runCli(['act', 'rearm', '--dry-run', '--json'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as {
        dryRun: boolean
        rearmed: Array<{ pr: number; pid: number }>
      }
      assert.equal(out.dryRun, true)
      assert.deepEqual(out.rearmed, [{ pr: 7, pid: 0 }])
      assert.equal(existsSync(marker), true)
      // no replacement watcher was spawned — no new live marker
      const files = readdirSync(join(main, '.git', 'bro', 'watches'))
      assert.deepEqual(files, ['7-2000000000.json'])
    })
  })

  test('an open PR gets a detached watcher and the dead marker sweeps', async (t) => {
    const { root, main } = fixture()
    const pid = { n: 0 }
    reaper(t, root, pid)
    // a pending check keeps the gate red — the resurrected watcher
    // stays alive polling instead of merging and exiting instantly
    writeHostState(join(main, 'host.json'), {
      prState: 'OPEN',
      checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
    })
    // workdir records where the original watcher ran — --cleanup is
    // replayed only when that directory still exists (rearm could be
    // invoked from any checkout of the repo). The dead marker uses the
    // real <pr>-<pid>-<nonce>.json shape watchBegin writes — a plan that
    // matched only <pr>-<pid>.json skipped every real marker and
    // reported "no dead watches" (bro-z0k2u)
    const marker = deadWatch(
      main,
      7,
      { merge: true, cleanup: true, workdir: main },
      '7-2000000000-a1b2c3d4e5f6.json'
    )
    const r = runCli(['act', 'rearm', '--json'], { cwd: main })
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout) as {
      rearmed: Array<{ pr: number; pid: number }>
    }
    assert.equal(out.rearmed.length, 1)
    pid.n = out.rearmed[0]!.pid
    assert.ok(pid.n > 0)
    assert.equal(existsSync(marker), false)
    // the respawned `act wait` writes its own live marker — same PR,
    // live pid, replayed mode
    const live = await pollMarker(join(main, '.git', 'bro', 'watches'), pid.n)
    assert.ok(live !== null, 'respawned watcher never wrote its marker')
    assert.equal(live.pr, 7)
    assert.equal(live.merge, true)
    assert.equal(live.cleanup, true)
  })

  test('a settled PR sweeps without spawning anything', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'MERGED' })
      const marker = deadWatch(main, 9)
      const r = runCli(['act', 'rearm', '--json'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as { settled: Array<{ pr: number }> }
      assert.deepEqual(out.settled, [{ pr: 9 }])
      assert.equal(existsSync(marker), false)
    })
  })

  test('a settled PR carrying a bead closes the loop claim (bro-q6ppv)', () => {
    const { root, main, db, env } = beadFixture()
    inside(main, root, () => {
      // the dead loop's marker outlived it AND the PR landed meanwhile —
      // rearm sweeps the marker and runs the finalizeMerge close
      writeHostState(join(main, 'host.json'), { prState: 'MERGED' })
      deadWatch(main, 9, { bead: 'fx-a' })
      const r = runCli(['act', 'rearm'], { cwd: main, env })
      assert.equal(r.code, 0, r.stderr)
      assertLandedBead(db, 'fx-a', r.stderr)
    })
  })

  test('a closed-unmerged settle keeps the bead open', () => {
    const { root, main, db, env } = beadFixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'CLOSED' })
      deadWatch(main, 9, { bead: 'fx-a' })
      const r = runCli(['act', 'rearm'], { cwd: main, env })
      assert.equal(r.code, 0, r.stderr)
      assert.equal(bead(db, 'fx-a')?.status, 'in_progress')
    })
  })

  test('a rearmed wait replays --bead into its own live marker', async (t) => {
    const { root, main } = fixture()
    const pid = { n: 0 }
    reaper(t, root, pid)
    // a pending check keeps the respawned wait alive while we read its marker
    writeHostState(join(main, 'host.json'), {
      prState: 'OPEN',
      checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
    })
    deadWatch(main, 7, { merge: true, workdir: main, bead: 'fx-a' })
    const r = runCli(['act', 'rearm', '--json'], { cwd: main })
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout) as { rearmed: Array<{ pr: number; pid: number }> }
    pid.n = out.rearmed[0]!.pid
    assert.ok(pid.n > 0)
    // the respawned wait re-records the bead in its own marker — a second
    // crash + rearm still carries the identity
    const live = await pollMarker(join(main, '.git', 'bro', 'watches'), pid.n)
    assert.ok(live !== null, 'respawned watcher never wrote its marker')
    assert.equal(live.bead, 'fx-a')
  })

  test('act wait --merge --bead closes the claim once the merge lands', () => {
    const { root, main, db, env } = beadFixture()
    inside(main, root, () => {
      // a green gate settles on the first poll — the merge + bead close
      // run in the same invocation (the shape a respawned wait executes)
      const r = mergeWait(main, env, 'OPEN')
      assert.equal(r.code, 0, r.stderr)
      assert.equal(readHostState(join(main, 'host.json')).merges, 1)
      assertLandedBead(db, 'fx-a', r.stderr)
    })
  })

  test('an external merge mid-wait discharges --bead — the marker is already swept', () => {
    const { root, main, db, env } = beadFixture()
    inside(main, root, () => {
      // the PR landed without this wait — the settle is MERGED, so
      // mergeIfAsked never runs and watchEnd removed the marker a rearm
      // reconcile would have needed
      const r = mergeWait(main, env, 'MERGED')
      assert.equal(r.code, 0, r.stderr)
      assert.equal(readHostState(join(main, 'host.json')).merges, undefined)
      assertLandedBead(db, 'fx-a', r.stderr)
    })
  })

  test('act merge --bead on an already-merged PR still discharges the claim', () => {
    const { root, main, db, env } = beadFixture()
    inside(main, root, () => {
      // landed between the wait's last green poll and merge's own fetch
      writeHostState(join(main, 'host.json'), { prState: 'MERGED' })
      const r = runCli(['act', 'merge', '7', '--bead', 'fx-a'], { cwd: main, env })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /only OPEN PRs/)
      assertLandedBead(db, 'fx-a')
    })
  })

  test('the settle close resolves connectors.tasks, not the default beads store', () => {
    const { root, main } = fixture()
    // connectors.tasks pins a non-beads backend — the dead loop's claim
    // lives there, so a bare taskStore() close would never find the row
    const { db } = installFakeTasks(main, [
      { ...FAKE_BEAD, id: 'fx-a', status: 'in_progress' },
    ])
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({
        plugins: ['./fakehost.ts', './faketasks.ts'],
        connectors: { reviews: 'fakehost', tasks: 'faketasks' },
      })
    )
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'MERGED' })
      deadWatch(main, 9, { bead: 'fx-a' })
      const r = runCli(['act', 'rearm'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assertLandedBead(db, 'fx-a', r.stderr)
    })
  })

  test('act merge --bead on a blocked PR refuses and closes nothing', () => {
    const { root, main, db, env } = beadFixture()
    inside(main, root, () => {
      // a pending check blocks the gate — no merge, no bead close
      writeHostState(join(main, 'host.json'), {
        prState: 'OPEN',
        checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
      })
      const r = runCli(['act', 'merge', '7', '--bead', 'fx-a'], { cwd: main, env })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /exit_gate=BLOCKED/)
      assert.equal(bead(db, 'fx-a')?.status, 'in_progress')
    })
  })
})

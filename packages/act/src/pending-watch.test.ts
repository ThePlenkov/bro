import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deadWatchPlan,
  hasLiveWatch,
  listWatches,
  rearmWatches,
  watchBegin,
  watchEnd,
  watchHeartbeat,
  watchRetire,
  type PendingWatch,
} from './pending-watch.ts'

const base: Omit<PendingWatch, 'pid' | 'startedAt'> = {
  pr: 42,
  link: '[#42](https://github.com/o/r/pull/42)',
  merge: true,
  timeoutMin: 45,
}

const dirs: string[] = []
after(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-watch-'))
  execFileSync('git', ['init', '-q', dir])
  dirs.push(dir)
  return dir
}

describe('pending-watch markers', () => {
  test('outside a git repo everything is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-watch-nogit-'))
    dirs.push(dir)
    assert.equal(watchBegin(dir, base), null)
    assert.deepEqual(listWatches(dir), [])
    watchEnd(null)
  })

  test('begin writes a marker listWatches reports as alive (own pid)', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, true)
    assert.equal(listed[0]!.watch.pr, 42)
    assert.equal(listed[0]!.watch.pid, process.pid)
    assert.equal(listed[0]!.watch.merge, true)
  })

  test('end removes the marker', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.equal(listWatches(dir).length, 1)
    watchEnd(path)
    assert.equal(listWatches(dir).length, 0)
  })

  test('a dead pid reports alive:false — the stale promise', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    // a pid this high cannot exist — dead on every host
    w.pid = 2_000_000_000
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, false)
    assert.equal(watchRetire(listed[0]!.file), true)
    // a racing retire loses the claim — the stale promise reports once
    assert.equal(watchRetire(listed[0]!.file), false)
    // the retired marker stays listed as reported — a warning that never
    // delivered (hook killed after the claim) re-flags at the next
    // session start until the marker ages out (bro-b6qt)
    const after = listWatches(dir)
    assert.equal(after.length, 1)
    assert.equal(after[0]!.reported, true)
    assert.equal(after[0]!.alive, false)
  })

  test('a marker with a non-finite startedAt is residue, not eternal', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    // 1e999 parses to Infinity — typeof passes, the TTL check never fires
    writeFileSync(path!, '{"pr":42,"link":"x","pid":1,"merge":false,"startedAt":1e999,"timeoutMin":5}')
    const listed = listWatches(dir)
    assert.equal(listed.length, 0)
    assert.equal(existsSync(path!), false) // malformed → pruned
  })

  test('a live pid with a different start identity reports alive:false', (t) => {
    if (!existsSync('/proc')) {
      t.skip('pid start identity needs /proc')
      return
    }
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.pidStart = '1' // boot-time start — never this watcher's identity
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, false)
  })

  test('an unreaped zombie reports alive:false — kill(0) lies', async (t) => {
    if (!existsSync('/proc')) {
      t.skip('zombie detection needs /proc')
      return
    }
    try {
      execFileSync('python3', ['--version'], { stdio: 'pipe' })
    } catch {
      t.skip('python3 unavailable for the zombie fixture')
      return
    }
    // a real zombie: python forks a child that exits immediately while
    // the parent sleeps without wait() — the child stays 'Z' until the
    // parent dies
    const py = spawn('python3', [
      '-c',
      'import os,time\n' +
        'pid = os.fork()\n' +
        'if pid:\n' +
        '    print(pid, flush=True)\n' +
        '    time.sleep(60)\n' +
        'else:\n' +
        '    os._exit(0)\n',
    ])
    t.after(() => py.kill('SIGKILL'))
    const zombiePid = await new Promise<number>((resolvePromise, reject) => {
      py.stdout.once('data', (d: Buffer) => {
        resolvePromise(Number(d.toString().trim()))
      })
      py.once('error', reject)
      py.once('exit', () => reject(new Error('python3 exited early')))
    })
    if (!zombiePid) {
      t.skip('zombie fixture did not produce a child pid')
      return
    }
    // wait for the forked child to exit and zombify — a fixed delay is
    // flaky under scheduling load; poll /proc for the 'Z' state instead
    let state = ''
    const deadline = Date.now() + 5_000
    while (state !== 'Z' && Date.now() < deadline) {
      try {
        const stat = readFileSync(`/proc/${zombiePid}/stat`, 'utf8')
        state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? ''
      } catch {
        break // child gone — the assertion below names it either way
      }
      if (state !== 'Z') {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    assert.equal(state, 'Z', 'fixture child never zombified')
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.pid = zombiePid
    delete w.pidStart // identity can't match a different process anyway
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, false)
  })

  test('a dead marker superseded by a live same-PR watch is not reported', () => {
    const dir = repo()
    const live = watchBegin(dir, base)
    assert.ok(live)
    // a dead marker for the same PR — e.g. left by a crashed watcher the
    // new wait replaced; reporting it would be a false stale flag
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({ ...base, pid: 2_000_000_000, startedAt: Date.now() })
    )
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.file, live)
    // the superseded marker stays on disk for the watching process's own
    // retire pass — it is hidden from reports, not deleted
    assert.equal(existsSync(stale), true)
  })

  test('a dead merge marker is not superseded by a watch-only wait', () => {
    const dir = repo()
    const live = watchBegin(dir, { ...base, merge: false })
    assert.ok(live)
    // a dead merge:true marker — the replacement only watches, so the
    // merge promise died with the old process and must still flag
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({ ...base, pid: 2_000_000_000, startedAt: Date.now() })
    )
    const listed = listWatches(dir)
    assert.equal(listed.length, 2)
    const dead = listed.find((l) => !l.alive)
    assert.ok(dead)
    assert.equal(dead.watch.merge, true)
  })

  test('a live merge wait also covers a dead watch-only marker', () => {
    const dir = repo()
    const live = watchBegin(dir, base)
    assert.ok(live)
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({
        ...base,
        merge: false,
        pid: 2_000_000_000,
        startedAt: Date.now(),
      })
    )
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.file, live)
  })

  test('TTL-expired markers are pruned, not listed', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.startedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    assert.equal(listWatches(dir).length, 0)
    // pruned means gone from disk, not merely omitted from the listing
    assert.equal(existsSync(path!), false)
  })

  test('malformed marker files are pruned, not listed', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    writeFileSync(path!, 'not json')
    assert.equal(listWatches(dir).length, 0)
    assert.equal(existsSync(path!), false)
  })

  test('a tmp mid-publication is kept; only abandoned residue is pruned', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    const tmp = `${path!}.tmp`
    writeFileSync(tmp, 'partial')
    // fresh tmp — a writeFileSync→renameSync may be in flight
    assert.equal(listWatches(dir).length, 1)
    assert.equal(existsSync(tmp), true)
    // past the TTL it is crash residue, not an in-flight publish
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(tmp, old, old)
    assert.equal(listWatches(dir).length, 1)
    assert.equal(existsSync(tmp), false)
  })

  test('two waits on the same PR in one process each own a marker', () => {
    const dir = repo()
    const first = watchBegin(dir, base)
    const second = watchBegin(dir, { ...base, merge: false })
    assert.ok(first)
    assert.ok(second)
    assert.notEqual(first, second)
    assert.equal(listWatches(dir).length, 2)
    watchEnd(first)
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.file, second)
    watchEnd(second)
  })

  test('a configured timeout longer than a day extends the marker TTL', () => {
    const dir = repo()
    const path = watchBegin(dir, { ...base, timeoutMin: 3 * 24 * 60 })
    assert.ok(path)
    const w = JSON.parse(readFileSync(path!, 'utf8')) as PendingWatch
    w.startedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, true)
    w.startedAt = Date.now() - 4 * 24 * 60 * 60 * 1000
    writeFileSync(path!, JSON.stringify(w))
    assert.equal(listWatches(dir).length, 0)
  })

  test('a covering watch end retires the dead marker it superseded', () => {
    const dir = repo()
    const path = watchBegin(dir, base)
    assert.ok(path)
    // a second marker from another (now dead) process watching the same PR
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({ ...base, pid: 2_000_000_000, startedAt: Date.now() })
    )
    const next = watchBegin(dir, { ...base, merge: false })
    assert.ok(next)
    // begin does NOT retire: the replacement hasn't kept the promise yet —
    // the dead record stays on disk, hidden from reports while covered
    assert.equal(existsSync(stale), true)
    const listed = listWatches(dir)
    assert.equal(listed.length, 2)
    assert.ok(listed.every((l) => l.watch.pid === process.pid))
    // the merge watch's end retires it — its own outcome was reported in
    // session, so the superseded record must not resurface. The remaining
    // live watch-only wait does not cover a dead merge marker either way
    watchEnd(path)
    assert.equal(existsSync(stale), false)
    watchEnd(next)
  })

  test('an end of a non-covering watch leaves a still-covered dead marker', () => {
    const dir = repo()
    const first = watchBegin(dir, base)
    const second = watchBegin(dir, base)
    assert.ok(first)
    assert.ok(second)
    // a dead watch-only marker covered by BOTH live merge waits
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({
        ...base,
        merge: false,
        pid: 2_000_000_000,
        startedAt: Date.now(),
      })
    )
    // first ends but second still covers — the record stays while any
    // promise is open, so a crashed survivor can still flag it
    watchEnd(first)
    assert.equal(existsSync(stale), true)
    // the last covering watch's end retires it
    watchEnd(second)
    assert.equal(existsSync(stale), false)
  })

  test('begin keeps a dead merge marker a watch-only wait does not cover', () => {
    const dir = repo()
    const seed = watchBegin(dir, base)
    watchEnd(seed) // only to materialize the watches dir
    const stale = join(dir, '.git', 'bro', 'watches', '42-2000000000.json')
    writeFileSync(
      stale,
      JSON.stringify({ ...base, pid: 2_000_000_000, startedAt: Date.now() })
    )
    const next = watchBegin(dir, { ...base, merge: false })
    assert.ok(next)
    // merge:false does not keep the dead merge:true promise — no live
    // watch covers it, so it stays on disk and still flags at session
    // start
    assert.equal(existsSync(stale), true)
    const listed = listWatches(dir)
    assert.equal(listed.length, 2)
    assert.ok(listed.some((l) => !l.alive && l.watch.merge))
  })
})

describe('watchHeartbeat', () => {
  test('upserts one deterministic marker per (pr, kind, pid) across sweeps', () => {
    const dir = repo()
    const first = watchHeartbeat(dir, base, 'drive')
    const second = watchHeartbeat(dir, base, 'drive')
    assert.ok(first)
    assert.equal(first, second)
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.watch.pr, 42)
    assert.equal(listed[0]!.alive, true)
  })

  test('different kinds on the same pr keep separate markers', () => {
    const dir = repo()
    assert.ok(watchHeartbeat(dir, base, 'drive'))
    assert.ok(watchHeartbeat(dir, base, 'convoy'))
    assert.equal(listWatches(dir).length, 2)
  })

  test('a dead supervisor pid lists as a stale, flaggable watch', () => {
    const dir = repo()
    const seed = watchHeartbeat(dir, base, 'drive')
    assert.ok(seed)
    // simulate the dead drive by rewriting the marker pid to a dead one
    writeFileSync(
      seed,
      JSON.stringify({ ...base, pid: 2_000_000_000, startedAt: Date.now() })
    )
    const listed = listWatches(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.alive, false)
  })
})

describe('hasLiveWatch', () => {
  test('no git dir → null (store unknown, callers fail open)', () => {
    assert.equal(hasLiveWatch(join(tmpdir(), `no-git-${process.pid}`), 42), null)
  })
  test('git repo without a watches dir → false (legitimately empty)', () => {
    assert.equal(hasLiveWatch(repo(), 42), false)
  })
  test('live marker covers; dead pid does not', () => {
    const dir = repo()
    watchHeartbeat(dir, base, 'drive')
    assert.equal(hasLiveWatch(dir, 42), true)
    assert.equal(hasLiveWatch(dir, 43), false)
  })
})

/** Drop a dead-pid marker straight into the watches dir — the state a
 *  host reboot leaves behind. */
function deadMarker(dir: string, w: Partial<PendingWatch> & { pr: number }): string {
  const wd = join(dir, '.git', 'bro', 'watches')
  mkdirSync(wd, { recursive: true })
  // canonical wait-marker name is <pr>-<pid>.json — dead pid varies so
  // several markers on one PR don't collide
  const deadPid = 2_000_000_000 + Math.floor(Math.random() * 100_000)
  const file = join(wd, `${w.pr}-${deadPid}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      link: `[#${w.pr}](https://github.com/o/r/pull/${w.pr})`,
      merge: false,
      timeoutMin: 45,
      ...w,
      pid: deadPid,
      startedAt: Date.now(),
    })
  )
  return file
}

describe('act rearm', () => {
  test('a dead marker on an open PR respawns and the marker is swept', async () => {
    const dir = repo()
    const file = deadMarker(dir, { pr: 7, merge: true })
    const spawned: Array<{
      pr: number
      merge: boolean
      cleanup: boolean
      timeoutMin: number
      workdir?: string
    }> = []
    const res = await rearmWatches({
      dir,
      isOpen: async () => true,
      respawn: (plan) => {
        spawned.push(plan)
        return 4242
      },
    })
    assert.deepEqual(res.rearmed, [{ pr: 7, pid: 4242 }])
    const { pr, merge, cleanup, timeoutMin } = spawned[0]!
    assert.deepEqual({ pr, merge, cleanup, timeoutMin }, { pr: 7, merge: true, cleanup: false, timeoutMin: 45 })
    assert.equal(existsSync(file), false)
  })

  test('a dead marker on a settled PR is swept without a respawn', async () => {
    const dir = repo()
    const file = deadMarker(dir, { pr: 8 })
    let calls = 0
    const res = await rearmWatches({
      dir,
      isOpen: async () => false,
      respawn: () => {
        calls += 1
        return 1
      },
    })
    assert.deepEqual(res.settled, [8])
    assert.equal(calls, 0)
    assert.equal(existsSync(file), false)
  })

  test('an unverifiable PR keeps its marker — no blind sweep', async () => {
    const dir = repo()
    const file = deadMarker(dir, { pr: 9 })
    const res = await rearmWatches({
      dir,
      isOpen: async () => {
        throw new Error('gh down')
      },
      respawn: () => 1,
    })
    assert.deepEqual(res.kept, [{ pr: 9, reason: 'gh down' }])
    assert.equal(existsSync(file), true)
  })

  test('two dead markers on one PR plan one resurrection — strongest wins', async () => {
    const dir = repo()
    const watchOnly = deadMarker(dir, { pr: 10, merge: false })
    const merging = deadMarker(dir, { pr: 10, merge: true })
    const spawned: Array<{ pr: number; merge: boolean }> = []
    const res = await rearmWatches({
      dir,
      isOpen: async () => true,
      respawn: (plan) => {
        spawned.push(plan)
        return 7
      },
    })
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0]!.merge, true)
    assert.equal(existsSync(watchOnly), false)
    assert.equal(existsSync(merging), false)
    assert.equal(res.rearmed.length, 1)
  })

  test("the merge marker's workdir is the plan's — it is the cleanup target", async () => {
    const dir = repo()
    const other = repo()
    deadMarker(dir, { pr: 10, merge: false, workdir: other })
    deadMarker(dir, { pr: 10, merge: true, workdir: dir })
    const plan = deadWatchPlan(dir)
    assert.equal(plan.length, 1)
    assert.equal(plan[0]!.workdir, dir)
  })

  test('a dead supervisor heartbeat is not resurrected as a bare wait', async () => {
    const dir = repo()
    // <pr>-<kind>-<pid>.json — a drive heartbeat, not an act wait marker
    const wd = join(dir, '.git', 'bro', 'watches')
    mkdirSync(wd, { recursive: true })
    const hb = join(wd, '13-drive-2000000001.json')
    writeFileSync(
      hb,
      JSON.stringify({
        pr: 13,
        link: 'x',
        pid: 2_000_000_001,
        merge: false,
        timeoutMin: 45,
        startedAt: Date.now(),
      })
    )
    assert.deepEqual(deadWatchPlan(dir), [])
    const res = await rearmWatches({ dir, isOpen: async () => true, respawn: () => 1 })
    assert.deepEqual(res, { rearmed: [], settled: [], kept: [] })
    assert.equal(existsSync(hb), true) // the drive's own restart path owns it
  })

  test('a live watcher is never in the plan — parallel work, not a corpse', async () => {
    const dir = repo()
    watchBegin(dir, base)
    assert.deepEqual(deadWatchPlan(dir), [])
    const res = await rearmWatches({ dir, isOpen: async () => true, respawn: () => 1 })
    assert.deepEqual(res, { rearmed: [], settled: [], kept: [] })
  })

  test('no respawn callback is a dry run — reported but untouched', async () => {
    const dir = repo()
    const file = deadMarker(dir, { pr: 11, merge: true })
    const res = await rearmWatches({ dir, isOpen: async () => true })
    assert.deepEqual(res.rearmed, [{ pr: 11, pid: 0 }])
    assert.equal(existsSync(file), true)
  })

  test('a failed respawn keeps the marker and names it', async () => {
    const dir = repo()
    const file = deadMarker(dir, { pr: 12 })
    const res = await rearmWatches({
      dir,
      isOpen: async () => true,
      respawn: () => undefined,
    })
    assert.deepEqual(res.kept, [{ pr: 12, reason: 'respawn failed' }])
    assert.equal(existsSync(file), true)
  })
})

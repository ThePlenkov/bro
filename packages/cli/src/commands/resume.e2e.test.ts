/** `bro fleet resume` (bro-5houx) — the post-restart pass composed over
 *  the legs each spec section names: dead watch markers rearm like
 *  `act rearm`, a recorded-but-dead daemon respawns at its cadence,
 *  dead loop/run/agent/worktree residue reports (run records reap),
 *  and --dry-run mutates nothing. */
import { after, describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { initRepo, installFakeHost, inside, runCli, writeHostState } from './testrepo.ts'
import { scrubEnv, testGit } from '@broject/core'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

const DEAD = 1 << 30

/** Repo + fake review host — the watch leg talks to host.json through
 *  the fixture connector; no gh calls. */
function fixture() {
  const { root, main } = initRepo('bro-resume-')
  installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
    })
  )
  return { root, main }
}

function broDir(main: string): string {
  return join(main, '.git', 'bro')
}

function deadWatch(main: string, pr: number): string {
  const wd = join(broDir(main), 'watches')
  mkdirSync(wd, { recursive: true })
  const file = join(wd, `${pr}-2000000000-a1b2c3d4e5f6.json`)
  writeFileSync(
    file,
    JSON.stringify({
      pr,
      link: `[#${pr}](https://example.test/o/r/pull/${pr})`,
      pid: 2_000_000_000,
      merge: true,
      timeoutMin: 5,
      startedAt: Date.now(),
    })
  )
  return file
}

/** `drive.json` — the durable want-marker `drive install` writes; the
 *  daemon leg's rearm decision reads it, never the transient
 *  `daemon.json` spawn record. */
function armedDrive(main: string, everySec = 300): string {
  const file = join(broDir(main), 'drive.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ everySec, armedAt: new Date().toISOString() })
  )
  return file
}

/** A stale `daemon.json` — a dead transient spawn record. Under the
 *  want-marker model it is residue, not rearm intent. */
function staleDaemonRecord(main: string): string {
  const file = join(broDir(main), 'daemon.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      pid: DEAD,
      everySec: 300,
      spawnedAt: new Date().toISOString(),
      cmd: 'bro daemon run --every 300',
      pidStart: 'dead-start',
    })
  )
  return file
}

function deadLoopRun(main: string, slug = 'dead-run'): string {
  const dir = join(broDir(main), 'loop')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${slug}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      beadId: 'fx-dead',
      slug,
      pid: DEAD,
      pidStart: 'dead-start',
      startedAt: new Date().toISOString(),
      worktree: main,
      log: join(dir, `${slug}.log`),
    })
  )
  return file
}

/** Kill any pids the pass resurrected and drop the fixture. */
function reaper(t: TestContext, root: string, pids: number[]): void {
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true })
  })
}

describe('fleet resume', () => {
  test('a clean repo reports nothing to resume', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      const r = runCli(['fleet', 'resume'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /nothing to resume/)
    })
  })

  test('a worker session never resumes supervisors', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      const r = runCli(['fleet', 'resume'], {
        cwd: main,
        env: { BRO_AGENT_ID: 'agent-x' },
      })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /BRO_AGENT_ID/)
    })
  })

  test('a dead watch on an open PR respawns a detached watcher', async (t) => {
    const { root, main } = fixture()
    const pids: number[] = []
    reaper(t, root, pids)
    // a pending check keeps the resurrected wait polling instead of
    // settling instantly
    writeHostState(join(main, 'host.json'), {
      prState: 'OPEN',
      checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
    })
    const marker = deadWatch(main, 7)
    const r = runCli(['fleet', 'resume', '--json'], { cwd: main })
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout) as {
      watch: { rearmed: Array<{ pr: number; pid: number }> }
    }
    assert.equal(out.watch.rearmed.length, 1)
    const pid = out.watch.rearmed[0]!.pid
    assert.ok(pid > 0)
    pids.push(pid)
    assert.equal(existsSync(marker), false)
  })

  test('an armed-but-dead supervisor respawns at the marker cadence', (t) => {
    const { root, main } = fixture()
    const pids: number[] = []
    reaper(t, root, pids)
    armedDrive(main, 4242)
    const r = runCli(['fleet', 'resume'], { cwd: main })
    assert.equal(r.code, 0, r.stderr)
    const m = /daemon — revived \(pid (\d+), every 4242s\)/.exec(r.stdout)
    assert.ok(m !== null, `stdout: ${r.stdout}`)
    pids.push(Number(m[1]))
    // the spawn record names the new pid — a second resume reads it as
    // armed intent again only if the child also dies
    const rec = JSON.parse(
      readFileSync(join(broDir(main), 'daemon.json'), 'utf8')
    ) as { pid: number; everySec: number }
    assert.equal(rec.everySec, 4242)
    assert.equal(rec.pid, pids[0])
  })

  test('a never-armed daemon stays unarmed — a stale spawn record is not intent', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      // daemon.json alone is the transient spawn record — dead without
      // a drive.json marker it is residue, never rearm intent
      staleDaemonRecord(main)
      const r = runCli(['fleet', 'resume'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.doesNotMatch(r.stdout, /daemon — revived|daemon — already/)
    })
  })

  test('dead loop residue reports and reaps; the lock holder reads dead', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      const runRec = deadLoopRun(main)
      const lock = join(broDir(main), 'loop.lock')
      writeFileSync(lock, `${DEAD}:nonce`)
      const r = runCli(['fleet', 'resume'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /supervisor dead \(was pid \d+\)/)
      assert.match(r.stdout, /1 dead run record\(s\) reaped: dead-run/)
      assert.match(r.stdout, /bro flow loop/)
      assert.equal(existsSync(runRec), false)
    })
  })

  test('--dry-run reports the plan and mutates nothing', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
      const marker = deadWatch(main, 7)
      armedDrive(main)
      const runRec = deadLoopRun(main)
      const r = runCli(['fleet', 'resume', '--dry-run'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /would respawn a watcher/)
      assert.match(r.stdout, /would revive \(every 300s\)/)
      assert.match(r.stdout, /1 dead run record\(s\): dead-run/)
      // nothing spawned, nothing swept
      assert.equal(existsSync(marker), true)
      assert.equal(existsSync(runRec), true)
      const wd = join(broDir(main), 'watches')
      assert.deepEqual(readdirSync(wd), [`7-2000000000-a1b2c3d4e5f6.json`])
    })
  })

  test('a dirty sibling worktree is listed', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      // a linked worktree carrying uncommitted work
      const sib = join(root, 'sibling')
      testGit(['-C', main, 'worktree', 'add', '-b', 'sib', sib])
      writeFileSync(join(sib, 'stranded.txt'), 'unsaved work\n')
      const r = runCli(['fleet', 'resume'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /worktrees — 1 dirty tree\(s\): sibling \(1 files\)/)
    })
  })
})

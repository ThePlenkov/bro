import { describe, test } from 'node:test'
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
  initRepo,
  installFakeHost,
  inside,
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
  w: Record<string, unknown> = {}
): string {
  const wd = join(main, '.git', 'bro', 'watches')
  mkdirSync(wd, { recursive: true })
  const file = join(wd, `${pr}-2000000000.json`)
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
    let pid = 0
    // the resurrected watcher is real — kill it so the test leaks nothing
    t.after(() => {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      rmSync(root, { recursive: true, force: true })
    })
    // a pending check keeps the gate red — the resurrected watcher
    // stays alive polling instead of merging and exiting instantly
    writeHostState(join(main, 'host.json'), {
      prState: 'OPEN',
      checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
    })
    // workdir records where the original watcher ran — --cleanup is
    // replayed only when that directory still exists (rearm could be
    // invoked from any checkout of the repo)
    const marker = deadWatch(main, 7, { merge: true, cleanup: true, workdir: main })
    const r = runCli(['act', 'rearm', '--json'], { cwd: main })
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout) as {
      rearmed: Array<{ pr: number; pid: number }>
    }
    assert.equal(out.rearmed.length, 1)
    pid = out.rearmed[0]!.pid
    assert.ok(pid > 0)
    assert.equal(existsSync(marker), false)
    // the respawned `act wait` writes its own live marker — same PR,
    // live pid, replayed mode. The child boots asynchronously, so the
    // marker lands a tick after rearm returns — poll, don't assume.
    const wd = join(main, '.git', 'bro', 'watches')
    type Marker = { pr: number; pid: number; merge: boolean; cleanup: boolean }
    let live: Marker | null = null
    const deadline = Date.now() + 10_000
    while (live === null && Date.now() < deadline) {
      for (const f of readdirSync(wd)) {
        const w = JSON.parse(readFileSync(join(wd, f), 'utf8')) as Marker
        if (w.pid === pid) live = w
      }
      if (live === null) await new Promise((res) => setTimeout(res, 50))
    }
    if (live === null) {
      assert.fail('respawned watcher never wrote its marker')
    }
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
      const out = JSON.parse(r.stdout) as { settled: number[] }
      assert.deepEqual(out.settled, [9])
      assert.equal(existsSync(marker), false)
    })
  })
})

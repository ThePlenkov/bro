import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  initRepo,
  installFakeHost,
  inside,
  readHostState,
  runCli,
  writeHostState,
} from './testrepo.ts'

/** Repo + fake review host — `act wait` polls host.json through the
 *  fixture connector; a blocked settle writes its finding into
 *  .git/bro/watches (verdict marker) and .git/bro/notify (mailbox drop). */
function fixture() {
  const { root, main } = initRepo('bro-act-wait-')
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

const THREAD = {
  id: 't1',
  resolved: false,
  outdated: false,
  comment: {
    author: 'reviewer',
    bot: false,
    path: 'work.txt',
    line: 1,
    body: 'fix this first',
    createdAt: '2026-01-01',
  },
}

const notifyDir = (main: string): string => join(main, '.git', 'bro', 'notify')
const watchesDir = (main: string): string => join(main, '.git', 'bro', 'watches')

const drops = (main: string): Array<Record<string, unknown>> => {
  const nd = notifyDir(main)
  if (!existsSync(nd)) {
    return []
  }
  return readdirSync(nd)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => JSON.parse(readFileSync(join(nd, f), 'utf8')) as Record<string, unknown>)
}

const verdicts = (main: string): Array<Record<string, unknown>> => {
  const wd = watchesDir(main)
  if (!existsSync(wd)) {
    return []
  }
  return readdirSync(wd)
    .filter((f) => f.includes('-blocked-'))
    .map((f) => JSON.parse(readFileSync(join(wd, f), 'utf8')) as Record<string, unknown>)
}

describe('act wait — a blocked settle is a finding (bro-q4iq0)', () => {
  test('BLOCKED exit also drops a keyed mailbox event and a verdict marker', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN', threads: [THREAD] })
      const r = runCli(['act', 'wait', '7', '--interval', '1', '--timeout', '1'], { cwd: main })
      assert.equal(r.code, 1, r.stderr)
      assert.match(r.stdout, /exit_gate=BLOCKED/)

      // the mailbox drop — what a mid-turn postTool or session-start
      // drain delivers
      const [ev] = drops(main)
      assert.ok(ev)
      assert.equal(ev.topic, 'act')
      assert.equal(ev.kind, 'block')
      assert.equal(ev.key, 'act-wait-7')
      assert.equal(ev.source, 'act-wait')
      assert.equal(ev.ref, 'https://example.test/o/r/pull/7')
      assert.match(String(ev.payload), /settled BLOCKED/)
      assert.match(String(ev.payload), /1 unresolved review thread/)

      // the verdict marker — the durable record session-start flags
      const [m] = verdicts(main)
      assert.ok(m)
      assert.equal(m.verdict, 'blocked')
      assert.equal(m.pr, 7)
      assert.equal(m.merge, false)
      assert.deepEqual(m.blockers, ['1 unresolved review thread(s)'])
    })
  })

  test('a second blocked wait supersedes its own pending drop — one finding', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN', threads: [THREAD] })
      const args = ['act', 'wait', '7', '--interval', '1', '--timeout', '1']
      assert.equal(runCli(args, { cwd: main }).code, 1)
      assert.equal(runCli(args, { cwd: main }).code, 1)
      const all = drops(main)
      assert.equal(all.length, 1)
      assert.equal(all[0]!.key, 'act-wait-7')
      // the re-watch supersedes the stale verdict too — its watchEnd
      // sweeps the covered marker, its own blocked settle writes the
      // fresh one: the finding is always the latest verdict
      assert.equal(verdicts(main).length, 1)
    })
  })

  test('a green settle drops the act:result event — the wait-finished moment', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
      const r = runCli(['act', 'wait', '7', '--interval', '1', '--timeout', '1'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /exit_gate=OK/)
      // "wait finished" is a human moment even when nothing went wrong —
      // notify.sinks hear it (spec: specs/bro-huy5o.8.md); same key as
      // the blocked verdict so a late green supersedes earlier BLOCKED news
      const [ev] = drops(main)
      assert.ok(ev)
      assert.equal(ev.topic, 'act')
      assert.equal(ev.kind, 'result')
      assert.equal(ev.key, 'act-wait-7')
      assert.equal(ev.source, 'act-wait')
      assert.match(String(ev.payload), /settled GREEN/)
      assert.deepEqual(verdicts(main), [])
    })
  })

  test('session-start rehydrates the verdict line and the drained drop', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN', threads: [THREAD] })
      assert.equal(
        runCli(['act', 'wait', '7', '--interval', '1', '--timeout', '1'], { cwd: main }).code,
        1
      )
      const r = runCli(['hooks', 'session-start'], {
        cwd: main,
        input: JSON.stringify({ session_id: 's1' }),
        // the user mailbox drains too — pin XDG so the test never eats
        // a real session's drops
        env: { XDG_STATE_HOME: join(root, 'xdg-state') },
      })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /settled BLOCKED/)
      assert.match(r.stdout, /1 unresolved review thread/)
      assert.match(r.stdout, /bro notify — 1 mailbox message/)
    })
  })
})

describe('act wait --detach (bro-b16er)', () => {
  /** SIGKILL the detached child at teardown — the test leaks nothing. */
  const reaper = (t: TestContext, root: string, pid: { n: number }): void => {
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

  const markerFor = (main: string, pid: number): Record<string, unknown> | null => {
    const wd = watchesDir(main)
    if (!existsSync(wd)) {
      return null
    }
    for (const f of readdirSync(wd)) {
      if (!f.endsWith('.json')) {
        continue
      }
      const w = JSON.parse(readFileSync(join(wd, f), 'utf8')) as Record<string, unknown>
      if (w.pid === pid) {
        return w
      }
    }
    return null
  }

  test('arms a watcher in its own process group — marker + log record it', async (t) => {
    const { root, main } = fixture()
    const pid = { n: 0 }
    reaper(t, root, pid)
    // a pending check keeps the detached child polling
    writeHostState(join(main, 'host.json'), {
      prState: 'OPEN',
      checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
    })
    const r = runCli(
      ['act', 'wait', '7', '--interval', '1', '--timeout', '1', '--detach'],
      { cwd: main }
    )
    assert.equal(r.code, 0, r.stderr)
    const m = /pid (\d+)/.exec(r.stdout)
    assert.ok(m !== null, r.stdout)
    pid.n = Number(m[1])
    // the child's own marker is the durable record — session-start flags
    // it dead, `act status` shows it live
    const w = markerFor(main, pid.n)
    assert.ok(w !== null, 'detached wait never wrote its marker')
    assert.equal(w.pr, 7)
    assert.equal(w.merge, false)
    assert.equal(w.workdir, main)
    // the child's output rides the per-PR log under <git-common>/bro/
    const log = join(main, '.git', 'bro', 'act-wait-7.log')
    assert.ok(existsSync(log))
    assert.match(readFileSync(log, 'utf8'), /act wait 7/)
    // the arming process is gone; the watcher keeps polling — the point
    await new Promise((res) => setTimeout(res, 1500))
    assert.doesNotThrow(() => process.kill(pid.n, 0))
  })

  test('a detached --merge lands the PR after the arming process exits', async (t) => {
    const { root, main } = fixture()
    const pid = { n: 0 }
    reaper(t, root, pid)
    writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
    const r = runCli(
      ['act', 'wait', '7', '--interval', '1', '--timeout', '1', '--merge', '--detach'],
      { cwd: main }
    )
    // the gate is already green — the child may finish the whole wait
    // inside the spawn ('settled', no watcher needed) or arm then merge
    assert.equal(r.code, 0, r.stderr)
    const m = /pid (\d+)/.exec(r.stdout)
    if (m !== null) {
      pid.n = Number(m[1])
    }
    // the parent is done — the detached child polls green and merges
    const deadline = Date.now() + 15_000
    let merges = 0
    while (Date.now() < deadline) {
      merges = Number(readHostState(join(main, 'host.json')).merges ?? 0)
      if (merges > 0) {
        break
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    assert.equal(merges, 1)
    // a kept promise sweeps its marker — nothing stale left behind
    const wd = watchesDir(main)
    const left = existsSync(wd) ? readdirSync(wd).filter((f) => f.endsWith('.json')) : []
    assert.deepEqual(left, [])
  })

  test('conflicting merge strategies refuse before the wait starts', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
      for (const extra of [[], ['--detach']]) {
        const r = runCli(
          ['act', 'wait', '7', '--merge', '--squash', '--rebase', ...extra],
          { cwd: main }
        )
        assert.equal(r.code, 2)
        assert.match(r.stderr, /conflicting merge strategies/)
      }
      assert.equal(existsSync(watchesDir(main)), false)
    })
  })

  test('--cleanup without --merge refuses before spawning', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
      const r = runCli(['act', 'wait', '7', '--cleanup', '--detach'], { cwd: main })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--cleanup requires --merge/)
      assert.equal(existsSync(watchesDir(main)), false)
    })
  })

  test('--json reports the armed pid', async (t) => {
    const { root, main } = fixture()
    const pid = { n: 0 }
    reaper(t, root, pid)
    writeHostState(join(main, 'host.json'), {
      prState: 'OPEN',
      checks: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
    })
    const r = runCli(
      ['act', 'wait', '7', '--interval', '1', '--timeout', '1', '--detach', '--json'],
      { cwd: main }
    )
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout) as { pr: number; pid: number; state: string }
    assert.equal(out.pr, 7)
    assert.equal(out.state, 'armed')
    pid.n = out.pid
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initRepo,
  installFakeHost,
  inside,
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

  test('a green settle drops nothing', () => {
    const { root, main } = fixture()
    inside(main, root, () => {
      writeHostState(join(main, 'host.json'), { prState: 'OPEN' })
      const r = runCli(['act', 'wait', '7', '--interval', '1', '--timeout', '1'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /exit_gate=OK/)
      assert.deepEqual(drops(main), [])
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

/** Merge-queue e2e (spec bro-huy5o.6) — a merge the host accepts but
 *  never lands (mergeResult: 'OPEN' models the queue hold) must park
 *  the PR on every merge path: `act merge` reports the hold and exits
 *  0 without cleanup, `act wait --merge` exits through the same
 *  landPr, and `bro drive` reads the parked PR as 'enqueued' — never
 *  'merge-unverified'. Runs the built CLI against the fake review
 *  host + fake bd like the loop e2e matrix. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  git,
  initRepo,
  inside,
  installFakeBd,
  installFakeHost,
  runCli,
  writeHostState,
  type CliResult,
} from './testrepo.ts'

interface Fixture {
  root: string
  main: string
  hostState: string
  run: (args: string[]) => CliResult
}

function fixture(): Fixture {
  const { root, main } = initRepo('bro-mq-e2e-')
  const { binDir, db } = installFakeBd(root)
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
    })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_BD_DB: db,
  }
  return {
    root,
    main,
    hostState: host.state,
    run: (args) => runCli(args, { cwd: main, env }),
  }
}

describe('merge queue hold — every merge path parks the PR (bro-huy5o.6)', () => {
  test('act merge accepts the queue hold: exit 0, no branch cleanup', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'loop/fx-a'], main)
      writeHostState(hostState, {
        prState: 'OPEN',
        headRef: 'loop/fx-a',
        mergeResult: 'OPEN', // the queue accepted; nothing landed
      })
      const r = run(['act', 'merge', '7'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /accepted but state=OPEN — a merge queue still owns it/)
      // the head branch is not deletable mid-queue — it stays
      assert.equal(git(['branch', '--list', 'loop/fx-a'], main).trim(), 'loop/fx-a')
    })
  })

  test('act wait --merge rides the same landPr — a queue hold is not a wait failure', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      writeHostState(hostState, { prState: 'OPEN', mergeResult: 'OPEN' })
      const r = run(['act', 'wait', '7', '--interval', '1', '--timeout', '1', '--merge'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /merge queue still owns it/)
    })
  })

  test('bro drive reads exit-0+OPEN as parked — enqueued, never merge-unverified', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'work/fx-a'], main)
      writeHostState(hostState, {
        prs: {
          'work/fx-a': { number: 7, state: 'OPEN', headRef: 'work/fx-a', baseRef: 'main' },
        },
        mergeResult: 'OPEN',
      })
      const r = run(['drive', '--once', '--json'])
      assert.equal(r.code, 0, r.stderr)
      const row = (JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"verdict"')) ?? '{}') ?? {}) as {
        verdict?: string
      }
      assert.equal(row.verdict, 'enqueued')
      // parked means unretired — the branch outlives the pass
      assert.equal(git(['branch', '--list', 'work/fx-a'], main).trim(), 'work/fx-a')
    })
  })

  test('bro drive still merges outright when nothing queues the merge', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'work/fx-a'], main)
      writeHostState(hostState, {
        prs: {
          'work/fx-a': { number: 7, state: 'OPEN', headRef: 'work/fx-a', baseRef: 'main' },
        },
      })
      const r = run(['drive', '--once', '--json'])
      assert.equal(r.code, 0, r.stderr)
      const row = (JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"verdict"')) ?? '{}') ?? {}) as {
        verdict?: string
      }
      assert.equal(row.verdict, 'merged')
    })
  })
})

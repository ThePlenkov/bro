/** PR ownership marking e2e (spec bro-c650l) — `bro drive` stamps what
 *  a loop's discovery can't reach: a draft is the merge=human contract
 *  → 'bro-review'; an orphaned, supervised PR → 'bro-managed'; a
 *  --no-merge pass claims nothing. `act merge` warns when neither
 *  label is present and still lands — advisory, never a blocker. Runs
 *  the built CLI against the fake host + fake bd like the loop e2e
 *  matrix. */
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
  readHostState,
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
  const { root, main } = initRepo('bro-own-e2e-')
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

interface PrRow {
  labels?: string[]
  body?: string
}

const prRow = (hostState: string, branch: string): PrRow =>
  ((readHostState(hostState).prs ?? {}) as Record<string, PrRow>)[branch] ?? {}

describe('PR ownership marking — drive + act merge (bro-c650l)', () => {
  test('drive stamps bro-review on a draft — the merge=human contract', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'work/fx-a'], main)
      writeHostState(hostState, {
        prs: {
          'work/fx-a': { number: 7, state: 'OPEN', headRef: 'work/fx-a', baseRef: 'main', isDraft: true },
        },
      })
      const r = run(['drive', '--once', '--json'])
      assert.equal(r.code, 0, r.stderr)
      const row = prRow(hostState, 'work/fx-a')
      assert.deepEqual(row.labels, ['bro-review'])
      assert.equal(
        row.body,
        '<!-- bro: {"managed":false,"mode":"drive","run":"work/fx-a"} -->'
      )
    })
  })

  test('drive stamps bro-managed on an orphaned supervised PR before merging it', () => {
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
      const row = prRow(hostState, 'work/fx-a')
      assert.deepEqual(row.labels, ['bro-managed'])
      assert.equal(
        row.body,
        '<!-- bro: {"managed":true,"mode":"drive","run":"work/fx-a"} -->'
      )
    })
  })

  test('drive --no-merge supervises without claiming the merge', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'work/fx-a'], main)
      writeHostState(hostState, {
        prs: {
          'work/fx-a': { number: 7, state: 'OPEN', headRef: 'work/fx-a', baseRef: 'main' },
        },
      })
      const r = run(['drive', '--once', '--no-merge', '--json'])
      assert.equal(r.code, 0, r.stderr)
      const row = prRow(hostState, 'work/fx-a')
      assert.deepEqual(row.labels ?? [], [])
    })
  })

  test('act merge warns on an unlabeled (human-owned) PR — and still lands', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'loop/fx-a'], main)
      writeHostState(hostState, { prOpened: true, prState: 'OPEN' })
      const r = run(['act', 'merge', '7'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /carries no bro-managed\/bro-review label — human-owned/)
      assert.match(r.stdout, /act: merged/)
    })
  })

  test('act merge stays quiet on a stamped PR', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'loop/fx-a'], main)
      writeHostState(hostState, {
        prOpened: true,
        prState: 'OPEN',
        labels: ['bro-managed'],
      })
      const r = run(['act', 'merge', '7'])
      assert.equal(r.code, 0, r.stderr)
      assert.doesNotMatch(r.stderr, /carries no bro-managed/)
      assert.match(r.stdout, /act: merged/)
    })
  })

  test('a stamping failure never fails the pass — labels are best-effort', () => {
    const { root, main, hostState, run } = fixture()
    inside(main, root, () => {
      git(['branch', 'work/fx-a'], main)
      writeHostState(hostState, {
        prs: {
          'work/fx-a': { number: 7, state: 'OPEN', headRef: 'work/fx-a', baseRef: 'main' },
        },
        // label reads throw — the pass still reports + merges
        labelsThrow: true,
      })
      const r = run(['drive', '--once', '--json'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /"verdict":"merged"/)
      // the halves are independent — the trailer still landed
      assert.match(String(prRow(hostState, 'work/fx-a').body), /"managed":true/)
    })
  })
})

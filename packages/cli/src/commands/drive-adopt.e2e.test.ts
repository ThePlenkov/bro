/** Drive merge-path TTL e2e (spec bro-ihnlv) — a green PR under a
 *  live-but-silent owner must be adopted and merged, not re-reported
 *  'green-occupied' forever. A 3h-old ownerless .work marker is inside
 *  the 24h liveness window (so it still occupies) yet outside the 2h
 *  activity TTL (so the merge path reads it as a dead owner). Fresh
 *  occupancy still holds the merge for the owner; --no-merge reports
 *  the adoption without merging. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  git,
  hostFixture,
  insideAsync,
  readHostState,
  writeHostState,
  type CliResult,
} from './testrepo.ts'

const fixture = () => {
  const f = hostFixture('bro-drive-adopt-', { loopAgent: true })
  return { ...f, run: (args: string[]) => f.run(['drive', ...args]) }
}

/** One green PR on a fleet branch. */
const green = {
  'work/fx-a': {
    number: 7,
    state: 'OPEN',
    headRef: 'work/fx-a',
    baseRef: 'main',
    mergeable: 'MERGEABLE',
  },
}

/** An ownerless .work marker naming the branch — live inside the 24h
 *  window, silent for `ageMs` of proven activity. */
const marker = (main: string, ageMs: number): void => {
  const hooks = join(main, '.git', 'bro', 'hooks')
  mkdirSync(hooks, { recursive: true })
  const f = join(hooks, 's1.work')
  writeFileSync(f, `${Date.now() - ageMs}\nwork/fx-a\n`)
  utimesSync(f, (Date.now() - ageMs) / 1000, (Date.now() - ageMs) / 1000)
}

const merges = (state: string): number =>
  ((readHostState(state).merges as number | undefined) ?? 0)

const verdict = (r: CliResult): { verdict?: string; detail?: string } =>
  (JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"verdict"')) ?? '{}') ?? {}) as {
    verdict?: string
    detail?: string
  }

describe('bro drive — green-occupied TTL (bro-ihnlv)', () => {
  test('a green PR under a silent owner is adopted and merged', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, { prs: green })
      marker(f.main, 3 * 3_600_000)
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'merged', v.detail)
      assert.match(v.detail ?? '', /adopted — session armed work/)
      assert.match(v.detail ?? '', /silent 3h/)
      assert.equal(merges(f.hostState), 1)
    })
  })

  test('a green PR under a live owner stays green-occupied', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, { prs: green })
      marker(f.main, 60_000)
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'green-occupied', v.detail)
      assert.match(v.detail ?? '', /armed work on work\/fx-a/)
      assert.equal(merges(f.hostState), 0)
    })
  })

  test('--no-merge reports the adoption instead of merging', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, { prs: green })
      marker(f.main, 3 * 3_600_000)
      const v = verdict(f.run(['--once', '--json', '--no-merge']))
      assert.equal(v.verdict, 'green', v.detail)
      assert.match(v.detail ?? '', /adopted — session armed work/)
      assert.equal(merges(f.hostState), 0)
    })
  })
})

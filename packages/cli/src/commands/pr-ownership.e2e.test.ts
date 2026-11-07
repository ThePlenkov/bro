/** PR ownership marking e2e (spec bro-c650l) — `bro drive` stamps what
 *  a loop's discovery can't reach: a draft is the merge=human contract
 *  → 'bro-review'; an orphaned, supervised PR → 'bro-managed'; a
 *  --no-merge pass claims nothing. `act merge` warns when neither
 *  label is present and still lands — advisory, never a blocker. Runs
 *  the built CLI against the fake host + fake bd like the loop e2e
 *  matrix. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  git,
  hostFixture,
  inside,
  readHostState,
  writeHostState,
  type CliResult,
  type HostFixture,
} from './testrepo.ts'

interface PrRow {
  labels?: string[]
  body?: string
}

const prRow = (hostState: string, branch: string): PrRow =>
  ((readHostState(hostState).prs ?? {}) as Record<string, PrRow>)[branch] ?? {}

/** One supervised-PR drive pass: the work/fx-a branch + its prs row
 *  scripted (`pr` patches the row, `top` patches top-level state),
 *  then `drive --once --json` — the PR's post-pass row + the run. */
function driveOnce(
  f: HostFixture,
  pr: Record<string, unknown> = {},
  extra: { args?: string[]; top?: Record<string, unknown> } = {}
): { r: CliResult; row: PrRow } {
  git(['branch', 'work/fx-a'], f.main)
  writeHostState(f.hostState, {
    prs: {
      'work/fx-a': { number: 7, state: 'OPEN', headRef: 'work/fx-a', baseRef: 'main', ...pr },
    },
    ...extra.top,
  })
  const r = f.run(['drive', '--once', ...(extra.args ?? []), '--json'])
  assert.equal(r.code, 0, r.stderr)
  return { r, row: prRow(f.hostState, 'work/fx-a') }
}

/** `act merge 7` against the flat single-PR state — loop/fx-a is the
 *  head branch, `state` patches onto the shared OPEN row. */
function actMerge(f: HostFixture, state: Record<string, unknown> = {}): CliResult {
  git(['branch', 'loop/fx-a'], f.main)
  writeHostState(f.hostState, { prOpened: true, prState: 'OPEN', ...state })
  const r = f.run(['act', 'merge', '7'])
  assert.equal(r.code, 0, r.stderr)
  return r
}

describe('PR ownership marking — drive + act merge (bro-c650l)', () => {
  test('drive stamps bro-review on a draft — the merge=human contract', () => {
    const f = hostFixture('bro-own-e2e-')
    inside(f.main, f.root, () => {
      const { row } = driveOnce(f, { isDraft: true })
      assert.deepEqual(row.labels, ['bro-review'])
      assert.equal(row.body, '<!-- bro: {"managed":false,"mode":"drive","run":"work/fx-a"} -->')
    })
  })

  test('drive stamps bro-managed on an orphaned supervised PR before merging it', () => {
    const f = hostFixture('bro-own-e2e-')
    inside(f.main, f.root, () => {
      const { row } = driveOnce(f)
      assert.deepEqual(row.labels, ['bro-managed'])
      assert.equal(row.body, '<!-- bro: {"managed":true,"mode":"drive","run":"work/fx-a"} -->')
    })
  })

  test('drive --no-merge supervises without claiming the merge', () => {
    const f = hostFixture('bro-own-e2e-')
    inside(f.main, f.root, () => {
      assert.deepEqual(driveOnce(f, {}, { args: ['--no-merge'] }).row.labels ?? [], [])
    })
  })

  test('act merge warns on an unlabeled (human-owned) PR — and still lands', () => {
    const f = hostFixture('bro-own-e2e-')
    inside(f.main, f.root, () => {
      const r = actMerge(f)
      assert.match(r.stderr, /carries no bro-managed\/bro-review label — human-owned/)
      assert.match(r.stdout, /act: merged/)
    })
  })

  test('act merge stays quiet on a stamped PR', () => {
    const f = hostFixture('bro-own-e2e-')
    inside(f.main, f.root, () => {
      const r = actMerge(f, { labels: ['bro-managed'] })
      assert.doesNotMatch(r.stderr, /carries no bro-managed/)
      assert.match(r.stdout, /act: merged/)
    })
  })

  test('a stamping failure never fails the pass — labels are best-effort', () => {
    const f = hostFixture('bro-own-e2e-')
    inside(f.main, f.root, () => {
      // label reads throw — the pass still reports + merges
      const { r, row } = driveOnce(f, {}, { top: { labelsThrow: true } })
      assert.match(r.stdout, /"verdict":"merged"/)
      // the halves are independent — the trailer still landed
      assert.match(String(row.body), /"managed":true/)
    })
  })
})

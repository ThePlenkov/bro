import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertHydratedRows,
  currentFrame,
  drillTree,
  drillUp,
  planPreventions,
  refKind,
} from './frames.ts'
import type { DrillRow } from './types.ts'

const prevention = (id: string, title: string, status = 'open'): DrillRow => ({
  id,
  title,
  status,
  labels: ['prevention'],
})

describe('refKind', () => {
  test('pull/merge-request URLs → pr', () => {
    assert.equal(refKind('https://github.com/o/r/pull/17'), 'pr')
    assert.equal(refKind('https://gitlab.com/o/r/-/merge_requests/3'), 'pr')
  })

  test('full 40-char lowercase hex → git-sha', () => {
    assert.equal(refKind('a'.repeat(40)), 'git-sha')
    assert.equal(refKind('e59d025f1ab2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), 'git-sha')
  })

  test('short shas are not git-sha → work-id', () => {
    assert.equal(refKind('abc1234'), 'work-id')
  })

  test('uppercase hex is not git-sha → work-id', () => {
    assert.equal(refKind('A'.repeat(40)), 'work-id')
  })

  test('arbitrary text → work-id', () => {
    assert.equal(refKind('transcript-2026-09-16'), 'work-id')
  })
})

describe('planPreventions', () => {
  test('no priors → everything creates', () => {
    const plan = planPreventions(['a', 'b'], [])
    assert.deepEqual(plan.create, ['a', 'b'])
    assert.equal(plan.reuse.size, 0)
  })

  test('open same-title prevention bead is reused, not recreated', () => {
    const plan = planPreventions(['a', 'b'], [prevention('bd-1', 'a')])
    assert.deepEqual(plan.create, ['b'])
    assert.equal(plan.reuse.get('a'), 'bd-1')
  })

  test('closed priors do not block re-filing', () => {
    const plan = planPreventions(['a'], [prevention('bd-1', 'a', 'closed')])
    assert.deepEqual(plan.create, ['a'])
  })

  test('non-prevention beads with the same title are ignored', () => {
    const other: DrillRow = { id: 'bd-9', title: 'a', status: 'open', labels: ['task'] }
    const plan = planPreventions(['a'], [other])
    assert.deepEqual(plan.create, ['a'])
  })

  test('duplicate items within one call collapse to a single create', () => {
    const plan = planPreventions(['a', 'a', 'b'], [])
    assert.deepEqual(plan.create, ['a', 'b'])
  })

  test('a retry after partial failure converges: created bead is reused', () => {
    // first attempt created bd-1 for 'a', then died — retry sees it in priors
    const plan = planPreventions(['a', 'b'], [prevention('bd-1', 'a')])
    assert.deepEqual(plan.create, ['b'])
    assert.equal(plan.reuse.get('a'), 'bd-1')
  })

  test('whitespace and case variants collapse to a single create', () => {
    const plan = planPreventions(['handle race', ' handle race ', 'Handle Race'], [])
    assert.deepEqual(plan.create, ['handle race'])
  })

  test('a prior matches after normalization — retry still converges', () => {
    const plan = planPreventions(['handle race'], [prevention('bd-1', '  Handle Race ')])
    assert.deepEqual(plan.create, [])
    assert.equal(plan.reuse.get('handle race'), 'bd-1')
  })

  test('created titles are trimmed; whitespace-only items are skipped', () => {
    const plan = planPreventions(['  keep me  ', '   '], [])
    assert.deepEqual(plan.create, ['keep me'])
  })
})

describe('assertHydratedRows', () => {
  test('passes hydrated rows through', () => {
    assert.doesNotThrow(() => assertHydratedRows([prevention('d1', 'a')], 'f1'))
    assert.doesNotThrow(() => assertHydratedRows([], 'f1'))
  })

  test('throws on dependency-edge shaped rows instead of degrading', () => {
    const edge = { issue_id: 'f1', depends_on_id: 'p1', type: 'discovered-from' }
    assert.throws(
      () => assertHydratedRows([edge] as never, 'f1'),
      /unexpected row shape/,
    )
  })

  test('throws on rows missing title', () => {
    assert.throws(
      () => assertHydratedRows([{ id: 'd1', status: 'open' }] as never, 'f1'),
      /unexpected row shape/,
    )
  })
})

/** A scripted `bd` on PATH — PATH lookup is the exec contract
 * (packages/core bd.ts), so no production seam is needed. `close` always
 * fails to land mid-flight; FAKE_BD_DELETE_FAIL=1 makes the compensation
 * `delete` fail too. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  show) echo '[{"id":"f1","title":"t","status":"open","labels":["drill"]}]' ;;
  children) echo '[]' ;;
  dep) echo '[]' ;;
  note) : ;;
  create) echo '{"id":"bd-new-1","title":"p1","status":"open","labels":["prevention"]}' ;;
  provenance) echo '[]' ;;
  close) echo 'close blew up' >&2; exit 1 ;;
  delete) if [ "$FAKE_BD_DELETE_FAIL" = "1" ]; then echo 'cannot delete' >&2; exit 1; fi ;;
esac
`

function withFakeBd(deleteFails: boolean, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
  writeFileSync(join(dir, 'bd'), FAKE_BD)
  chmodSync(join(dir, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevFlag = process.env.FAKE_BD_DELETE_FAIL
  process.env.PATH = `${dir}:${prevPath}`
  process.env.FAKE_BD_DELETE_FAIL = deleteFails ? '1' : '0'
  try {
    fn()
  } finally {
    process.env.PATH = prevPath
    if (prevFlag === undefined) {
      delete process.env.FAKE_BD_DELETE_FAIL
    } else {
      process.env.FAKE_BD_DELETE_FAIL = prevFlag
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const WIN32 = process.platform === 'win32'

describe('drillUp compensation', () => {
  test(
    'failed close + failed cleanup reports the orphan ids',
    { skip: WIN32 },
    () => {
      withFakeBd(true, () => {
        assert.throws(
          () => drillUp({ id: 'f1', result: 'r', prevent: ['p1'] }),
          (err: Error & { cause?: { stderr?: string } }) =>
            /cleanup incomplete: prevention bead\(s\) left behind: bd-new-1/.test(err.message) &&
            (err.cause?.stderr ?? '').includes('close blew up'),
        )
      })
    },
  )

  test(
    'failed close + successful cleanup rethrows the original error',
    { skip: WIN32 },
    () => {
      withFakeBd(false, () => {
        assert.throws(
          () => drillUp({ id: 'f1', result: 'r', prevent: ['p1'] }),
          (err: Error & { stderr?: string }) =>
            err.message.includes('bd close') &&
            !err.message.includes('cleanup incomplete') &&
            // stderr present → the raw exec error came through, not a rewrap
            (err.stderr ?? '').includes('close blew up'),
        )
      })
    },
  )
})

/** Nested drills served by a scripted bd — `dep list` answers every id in
 *  one call (the N+1 fix): f2 is f1's child, so f1 is root and f2 is the
 *  active leaf at depth 1. */
const FAKE_BD_NESTED = `#!/bin/sh
case "$1" in
  list) echo '[{"id":"f1","title":"root","status":"open","labels":["drill"],"updated_at":"2026-01-01"},{"id":"f2","title":"leaf","status":"open","labels":["drill"],"updated_at":"2026-01-02"}]' ;;
  dep) echo '[{"issue_id":"f2","depends_on_id":"f1","type":"parent-child"}]' ;;
  mol) echo '{"wisps":[]}' ;;
esac
`

describe('drillRelations via bd dep list', () => {
  test(
    'one batch call yields the parent→child tree',
    { skip: WIN32 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
      writeFileSync(join(dir, 'bd'), FAKE_BD_NESTED)
      chmodSync(join(dir, 'bd'), 0o755)
      const prevPath = process.env.PATH
      process.env.PATH = `${dir}:${prevPath}`
      try {
        assert.equal(drillTree(), '● f1 root [open]\n  ● f2 leaf [open]')
        const frame = currentFrame()
        assert.equal(frame?.id, 'f2')
        assert.equal(frame?.parentId, 'f1')
        assert.equal(frame?.depth, 1)
      } finally {
        process.env.PATH = prevPath
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('assertHydratedRows status check', () => {
  test('throws on rows with missing or non-string status', () => {
    assert.throws(
      () => assertHydratedRows([{ id: 'd1', title: 'a' }] as never, 'q1'),
      /unexpected row shape/,
    )
    assert.throws(
      () => assertHydratedRows([{ id: 'd1', title: 'a', status: 1 }] as never, 'q1'),
      /unexpected row shape/,
    )
  })
})

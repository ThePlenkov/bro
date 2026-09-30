import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { groupStats } from './stats.ts'
import type { DebtRecord, DebtStatus } from './types.ts'

function rec(
  status: DebtStatus,
  over: Partial<Pick<DebtRecord, 'author' | 'source' | 'area'>> = {}
): DebtRecord {
  return {
    thread_id: `t-${Math.random()}`,
    thread_url: '',
    status,
    priority: 'nit',
    needs: 'code_change',
    source_pr: 1,
    source_pr_url: '',
    source_pr_title: '',
    merged_at: '2026-01-01T00:00:00Z',
    merged_sha: '',
    path: '',
    line: null,
    author: 'bot-a',
    body: '',
    body_preview: '',
    fingerprint: 'f',
    area: 'packages/cli',
    harvested_at: '2026-01-01T00:00:00Z',
    harvest_run_id: 'r',
    times_seen: 1,
    fix_pr: null,
    fixed_at: null,
    notes: null,
    ...over,
  }
}

describe('groupStats', () => {
  test('counts every status per author', () => {
    const rows = groupStats(
      [
        rec('done', { author: 'bot-a' }),
        rec('done', { author: 'bot-a' }),
        rec('wontfix', { author: 'bot-a' }),
        rec('open', { author: 'bot-a' }),
        rec('claimed', { author: 'bot-b' }),
        rec('duplicate', { author: 'bot-b' }),
      ],
      'author'
    )
    const a = rows.find((r) => r.key === 'bot-a')!
    assert.equal(a.total, 4)
    assert.equal(a.open, 1)
    assert.equal(a.claimed, 0)
    assert.equal(a.done, 2)
    assert.equal(a.wontfix, 1)
    assert.equal(a.duplicate, 0)
    // 2 done of 3 decided (2 done + 1 wontfix)
    assert.equal(a.fixRate, 2 / 3)
  })

  test('fixRate is null while nothing is decided — open findings are not failures', () => {
    const rows = groupStats([rec('open'), rec('claimed')], 'author')
    assert.equal(rows[0]!.fixRate, null)
  })

  test('duplicate counts as decided-not-real', () => {
    const rows = groupStats([rec('done'), rec('duplicate')], 'author')
    assert.equal(rows[0]!.fixRate, 0.5)
  })

  test('source grouping: legacy rows without source fall back to review-threads', () => {
    const rows = groupStats(
      [
        rec('open'),
        rec('open', { source: 'dependabot' }),
        rec('done', { source: 'dependabot' }),
      ],
      'source'
    )
    const dep = rows.find((r) => r.key === 'dependabot')!
    assert.equal(dep.total, 2)
    assert.equal(dep.fixRate, 1)
    const legacy = rows.find((r) => r.key === 'review-threads')!
    assert.equal(legacy.total, 1)
  })

  test('area grouping uses the record area verbatim', () => {
    const rows = groupStats([rec('open', { area: 'site' }), rec('open')], 'area')
    assert.deepEqual(
      rows.map((r) => r.key).sort(),
      ['packages/cli', 'site']
    )
  })

  test('sorts by total desc, key asc on ties', () => {
    const rows = groupStats(
      [
        rec('open', { author: 'zeta' }),
        rec('open', { author: 'alpha' }),
        rec('open', { author: 'alpha' }),
        rec('open', { author: 'mid' }),
      ],
      'author'
    )
    assert.deepEqual(
      rows.map((r) => r.key),
      ['alpha', 'mid', 'zeta']
    )
  })

  test('malformed rows: missing group key falls back to "unknown"', () => {
    const row = rec('open')
    delete (row as Partial<DebtRecord>).author
    const rows = groupStats([row], 'author')
    assert.equal(rows[0]!.key, 'unknown')
  })

  test('malformed rows: non-string group key falls back to "unknown"', () => {
    const row = rec('open')
    ;(row as { author: unknown }).author = 42
    const rows = groupStats([row], 'author')
    assert.equal(rows[0]!.key, 'unknown')
  })

  test('malformed rows: unrecognized status counts in total, no NaN in buckets', () => {
    const row = rec('open')
    row.status = 'deferred' as DebtStatus
    const rows = groupStats([row], 'author')
    const b = rows[0]!
    assert.equal(b.total, 1)
    assert.equal(b.open + b.claimed + b.done + b.wontfix + b.duplicate, 0)
    assert.ok(!Object.values(b).some((v) => typeof v === 'number' && Number.isNaN(v)))
  })

  test('empty ledger → empty result', () => {
    assert.deepEqual(groupStats([], 'author'), [])
  })
})

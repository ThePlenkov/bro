import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrend, type ThreadBounds } from './trend.ts'
import type { DebtRecord, DebtStatus } from './types.ts'

// Fixed clock: Wednesday 2026-09-30. ISO week buckets start Mondays —
// the current bucket is 2026-09-28.
const NOW = new Date('2026-09-30T12:00:00Z')

let seq = 0
function rec(
  status: DebtStatus,
  over: Partial<Pick<DebtRecord, 'author' | 'source' | 'area' | 'harvested_at' | 'fixed_at'>> & {
    thread_id?: string
  } = {}
): DebtRecord {
  seq += 1
  return {
    thread_id: over.thread_id ?? `t-${seq}`,
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
    harvested_at: '2026-09-07T00:00:00Z',
    harvest_run_id: 'r',
    times_seen: 1,
    fix_pr: null,
    fixed_at: null,
    notes: null,
    ...over,
  }
}

function boundsOf(
  entries: Array<[string, string, string]>
): ThreadBounds {
  return new Map(entries.map(([id, first, last]) => [id, { first, last }]))
}

const OPTS = { by: null, now: NOW } as const

describe('buildTrend', () => {
  test('empty ledger → no points', () => {
    assert.deepEqual(buildTrend([], new Map(), OPTS), [])
  })

  test('weekly buckets from first seen to now — burn-down is per-bucket open', () => {
    const records = [
      rec('done', { harvested_at: '2026-09-07T00:00:00Z', fixed_at: '2026-09-16T00:00:00Z' }),
      rec('open', { harvested_at: '2026-09-15T00:00:00Z' }),
    ]
    const points = buildTrend(records, new Map(), OPTS)
    // 09-07, 09-14, 09-21, 09-28 (current)
    assert.deepEqual(
      points.map((p) => p.bucket),
      ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']
    )
    assert.deepEqual(
      points.map((p) => p.open),
      [1, 1, 1, 1]
    )
    assert.deepEqual(
      points.map((p) => `${p.opened}/${p.closed}`),
      ['1/0', '1/1', '0/0', '0/0']
    )
  })

  test('first seen comes from harvest bounds, not the latest sighting', () => {
    const r = rec('open', { harvested_at: '2026-09-29T00:00:00Z' })
    const bounds = boundsOf([[r.thread_id, '2026-09-02T00:00:00Z', '2026-09-29T00:00:00Z']])
    const points = buildTrend([r], bounds, OPTS)
    // Open edge is 08-31's bucket, so the series reaches back four weeks.
    assert.equal(points[0]!.bucket, '2026-08-31')
    assert.equal(points[0]!.open, 1)
  })

  test('claimed and open both count as open — undecided, like stats fixRate', () => {
    const points = buildTrend([rec('claimed'), rec('open')], new Map(), OPTS)
    assert.equal(points.at(-1)!.open, 2)
  })

  test('duplicate without fixed_at closes at the last harvest observation', () => {
    const r = rec('duplicate', {
      harvested_at: '2026-09-20T00:00:00Z',
      fixed_at: null,
    })
    const bounds = boundsOf([[r.thread_id, '2026-09-07T00:00:00Z', '2026-09-20T00:00:00Z']])
    const points = buildTrend([r], bounds, OPTS)
    const byBucket = new Map(points.map((p) => [p.bucket, p]))
    assert.equal(byBucket.get('2026-09-07')!.open, 1)
    // Last seen 09-20 (Sunday) — the open interval ends inside the 09-14
    // week, so that bucket reports the close and nothing stays open.
    assert.equal(byBucket.get('2026-09-14')!.closed, 1)
    assert.equal(byBucket.get('2026-09-14')!.open, 0)
    assert.equal(byBucket.get('2026-09-21')!.open, 0)
  })

  test('duplicate with a stamped fixed_at closes there', () => {
    const r = rec('duplicate', {
      harvested_at: '2026-09-07T00:00:00Z',
      fixed_at: '2026-09-22T00:00:00Z',
    })
    const points = buildTrend([r], new Map(), OPTS)
    const byBucket = new Map(points.map((p) => [p.bucket, p]))
    assert.equal(byBucket.get('2026-09-21')!.closed, 1)
    assert.equal(byBucket.get('2026-09-21')!.open, 0)
  })

  test('grouped by author — dense rows, groups ordered by record count', () => {
    const records = [
      rec('open', { author: 'zzz' }),
      rec('open', { author: 'aaa' }),
      rec('done', { author: 'aaa', fixed_at: '2026-09-29T00:00:00Z' }),
    ]
    const points = buildTrend(records, new Map(), { ...OPTS, by: 'author' })
    assert.deepEqual(points[0]!.key, 'aaa')
    assert.equal(points[0]!.bucket, '2026-09-07')
    const last = points.filter((p) => p.bucket === '2026-09-28')
    assert.deepEqual(
      last.map((p) => [p.key, p.open]),
      [
        ['aaa', 1],
        ['zzz', 1],
      ]
    )
  })

  test('daily granularity buckets by UTC date', () => {
    const r = rec('open', { harvested_at: '2026-09-28T10:00:00Z' })
    const points = buildTrend([r], new Map(), { ...OPTS, granularity: 'day' })
    assert.deepEqual(
      points.map((p) => p.bucket),
      ['2026-09-28', '2026-09-29', '2026-09-30']
    )
    assert.equal(points[0]!.opened, 1)
    assert.equal(points.at(-1)!.open, 1)
  })

  test('--since drops earlier buckets', () => {
    const points = buildTrend([rec('open')], new Map(), { ...OPTS, since: '2026-09-25' })
    // 09-25 is a Thursday → its week starts 09-21.
    assert.deepEqual(
      points.map((p) => p.bucket),
      ['2026-09-21', '2026-09-28']
    )
  })

  test('a --since past now yields an empty series', () => {
    assert.deepEqual(
      buildTrend([rec('open')], new Map(), { ...OPTS, since: '2027-01-01' }),
      []
    )
  })

  test('close stamp before the open edge clamps to a zero-length interval', () => {
    const r = rec('done', {
      harvested_at: '2026-09-15T00:00:00Z',
      fixed_at: '2026-09-01T00:00:00Z',
    })
    const points = buildTrend([r], new Map(), OPTS)
    const b = points.find((p) => p.bucket === '2026-09-14')!
    assert.equal(b.opened, 1)
    assert.equal(b.closed, 1)
    assert.equal(b.open, 0)
  })

  test('unparseable timestamps: still open, open since before the series', () => {
    const r = rec('open', { harvested_at: 'not-a-date' })
    const points = buildTrend([r], new Map(), OPTS)
    assert.equal(points.length, 1) // only the current bucket anchors
    assert.equal(points[0]!.bucket, '2026-09-28')
    assert.equal(points[0]!.open, 1)
    assert.equal(points[0]!.opened, 0)
  })
})

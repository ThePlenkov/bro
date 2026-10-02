import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listReports, renderReport, writeReport } from './report.ts'
import type { DrillReportInput } from './report.ts'
import type { DrillRow } from './types.ts'

const frame = (over: Partial<DrillRow> = {}): DrillRow => ({
  id: 'f1',
  title: 'why the cache lied',
  status: 'open',
  labels: ['drill'],
  ...over,
})

const base: DrillReportInput = {
  frame: frame(),
  chain: ['f1'],
  children: [],
  result: 'the TTL was doubled by a stray middleware',
  prevention: [],
  preventionIds: [],
  evidence: [],
  date: '2026-10-01T00:00:00.000Z',
}

describe('renderReport', () => {
  test('frontmatter carries drill/scope/chain/date/result/prevention', () => {
    const out = renderReport(base)
    assert.match(out, /^---\n/)
    assert.match(out, /\ndrill: "f1"\n/)
    assert.match(out, /\nscope: "why the cache lied"\n/)
    assert.match(out, /\nparent-chain: \["f1"\]\n/)
    assert.match(out, /\ndate: "2026-10-01T00:00:00\.000Z"\n/)
    assert.match(out, /\nresult: "the TTL was doubled by a stray middleware"\n/)
    assert.match(out, /\nprevention: \[\]\n/)
    assert.match(out, /\n# drill report — why the cache lied\n/)
  })

  test('description wins as scope when present', () => {
    const out = renderReport({
      ...base,
      frame: frame({ description: 'narrowed scope' }),
    })
    assert.match(out, /\nscope: "narrowed scope"\n/)
  })

  test('quoted scalars survive colons, newlines, quotes, and markers', () => {
    const out = renderReport({
      ...base,
      result: 'a: b\n"quoted" --- yaml',
      prevention: ['x: y'],
    })
    assert.match(out, /\nresult: "a: b\\n\\"quoted\\" --- yaml"\n/)
    assert.match(out, /\nprevention: \["x: y"\]\n/)
  })

  test('prevention items list with their bead ids; trail lists children + evidence', () => {
    const out = renderReport({
      ...base,
      prevention: ['pin the ttl', 'log on override'],
      preventionIds: ['bd-7', 'bd-8'],
      children: [frame({ id: 'f2', title: 'sub-frame' })],
      evidence: ['https://github.com/o/r/pull/17'],
    })
    assert.match(out, /## Prevention\n\n- pin the ttl \(bd-7\)\n- log on override \(bd-8\)\n/)
    assert.match(out, /- children:\n  - `f2` — sub-frame\n/)
    assert.match(out, /- evidence:\n  - https:\/\/github\.com\/o\/r\/pull\/17\n/)
  })

  test('empty sections render explicit (none) markers', () => {
    const out = renderReport(base)
    assert.match(out, /## Prevention\n\n\(none\)\n/)
    assert.match(out, /- children:\n  \(none\)\n/)
    assert.match(out, /- evidence:\n  \(none\)\n/)
  })
})

describe('writeReport + listReports', () => {
  test('writes <dir>/<id>.md creating the dir; listing reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-report-'))
    const target = join(dir, 'drills')
    try {
      const path = writeReport(target, base)
      assert.equal(path, join(target, 'f1.md'))
      assert.ok(existsSync(path))
      const rows = listReports(target)
      assert.deepEqual(rows, [
        { id: 'f1', title: 'why the cache lied', path },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing dir lists empty; non-report md files are skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-report-'))
    try {
      assert.deepEqual(listReports(join(dir, 'nope')), [])
      writeFileSync(join(dir, 'README.md'), '# not a report\n')
      writeReport(dir, { ...base, frame: frame({ id: 'f9', title: 't9' }) })
      const rows = listReports(dir)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.id, 'f9')
      assert.equal(rows[0]!.title, 't9')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a `drill:` line in the body is not a report — only frontmatter counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-report-'))
    try {
      writeFileSync(
        join(dir, 'note.md'),
        '---\ntitle: "unrelated"\n---\n\nbody text\ndrill: fake-id\n',
      )
      assert.deepEqual(listReports(dir), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write is atomic — no .tmp sibling left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-report-'))
    try {
      writeReport(dir, base)
      assert.deepEqual(readdirSync(dir), ['f1.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('written content is the rendered report (frontmatter parses back)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-report-'))
    try {
      const path = writeReport(dir, { ...base, result: 'r: with colon' })
      assert.match(readFileSync(path, 'utf8'), /result: "r: with colon"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

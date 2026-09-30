import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyDebtVerdicts,
  buildSummary,
  readDebtRecords,
  readThreadBounds,
  upsertRecords,
  writeHarvestFile,
  writeSummary,
} from './store.ts'
import type { DebtRecord } from './types.ts'

// BRO_DEBT_DIR would redirect every write in this file — tests need the
// cwd-relative path.
delete process.env.BRO_DEBT_DIR

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-debt-'))
  execFileSync('git', ['init', '-q', dir])
  // A global excludesFile covering the ledger dir would make check-ignore
  // short-circuit and the exclude assertions flaky — neutralize it.
  const emptyExcludes = join(dir, '.test-excludes')
  writeFileSync(emptyExcludes, '')
  execFileSync('git', ['-C', dir, 'config', 'core.excludesFile', emptyExcludes])
  return dir
}

const excludeFile = (repo: string): string =>
  join(repo, '.git', 'info', 'exclude')

describe('ensureDebtDirExcluded (via writeSummary)', () => {
  test('inside a git worktree → debt dir lands in .git/info/exclude', () => {
    const repo = tmpRepo()
    writeSummary(buildSummary([]), repo)
    assert.match(readFileSync(excludeFile(repo), 'utf8'), /\.agents\/review-debt\//)
  })

  test('the exclude actually ignores the ledger dir', () => {
    const repo = tmpRepo()
    writeSummary(buildSummary([]), repo)
    assert.doesNotThrow(() =>
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', '.agents/review-debt'])
    )
  })

  test('existing .gitignore coverage is respected — no exclude entry', () => {
    const repo = tmpRepo()
    writeFileSync(join(repo, '.gitignore'), '.agents/review-debt/\n')
    writeSummary(buildSummary([]), repo)
    const exclude = existsSync(excludeFile(repo))
      ? readFileSync(excludeFile(repo), 'utf8')
      : ''
    assert.doesNotMatch(exclude, /\.agents\/review-debt\//)
  })

  test('outside a git worktree → writes proceed, nothing excluded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-debt-nogit-'))
    writeSummary(buildSummary([]), dir)
    assert.ok(existsSync(join(dir, '.agents/review-debt/debt-summary.json')))
  })
})

let seq = 0
function rec(over: Partial<DebtRecord> & { thread_id: string }): DebtRecord {
  seq += 1
  return {
    thread_url: '',
    status: 'open',
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
    fingerprint: `f-${seq}`,
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

describe('readThreadBounds', () => {
  test('first/last sighting per thread across harvest files + legacy debt.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-debt-bounds-'))
    writeHarvestFile({
      pr: 1,
      runId: 'r1',
      harvestedAt: '2026-09-01T00:00:00Z',
      records: [rec({ thread_id: 'a', harvested_at: '2026-09-01T00:00:00Z' })],
      cwd: dir,
    })
    writeHarvestFile({
      pr: 1,
      runId: 'r2',
      harvestedAt: '2026-09-10T00:00:00Z',
      records: [rec({ thread_id: 'a', harvested_at: '2026-09-10T00:00:00Z' })],
      cwd: dir,
    })
    // Legacy flat ledger counts too.
    const debtDir = join(dir, '.agents', 'review-debt')
    mkdirSync(debtDir, { recursive: true })
    writeFileSync(
      join(debtDir, 'debt.jsonl'),
      `${JSON.stringify(rec({ thread_id: 'b', harvested_at: '2026-08-20T00:00:00Z' }))}\n`
    )
    const bounds = readThreadBounds(dir)
    assert.deepEqual(bounds.get('a'), {
      first: '2026-09-01T00:00:00Z',
      last: '2026-09-10T00:00:00Z',
    })
    assert.deepEqual(bounds.get('b'), {
      first: '2026-08-20T00:00:00Z',
      last: '2026-08-20T00:00:00Z',
    })
  })

  test('skips rows with missing or unparseable harvested_at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-debt-bounds-'))
    const debtDir = join(dir, '.agents', 'review-debt')
    mkdirSync(debtDir, { recursive: true })
    writeFileSync(
      join(debtDir, 'debt.jsonl'),
      [
        JSON.stringify({ thread_id: 'x', harvested_at: 'garbage' }),
        JSON.stringify({ thread_id: 'y' }),
        JSON.stringify(rec({ thread_id: 'z', harvested_at: '2026-09-01T00:00:00Z' })),
        '',
      ].join('\n')
    )
    const bounds = readThreadBounds(dir)
    assert.equal(bounds.has('x'), false)
    assert.equal(bounds.has('y'), false)
    assert.ok(bounds.has('z'))
  })
})

describe('open intervals (store side)', () => {
  test('applyDebtVerdicts stamps fixed_at on duplicate — it leaves the open pool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-debt-verdict-'))
    writeHarvestFile({
      pr: 1,
      runId: 'r',
      harvestedAt: '2026-09-01T00:00:00Z',
      records: [rec({ thread_id: 'dup' })],
      cwd: dir,
    })
    applyDebtVerdicts([{ thread_id: 'dup', status: 'duplicate' }], dir)
    const row = readDebtRecords(dir).find((r) => r.thread_id === 'dup')!
    assert.equal(row.status, 'duplicate')
    assert.ok(row.fixed_at !== null)
  })

  test('a reharvested duplicate reopens without a stale close stamp', () => {
    const prev = rec({
      thread_id: 't',
      status: 'duplicate',
      fixed_at: '2026-09-05T00:00:00Z',
      fix_pr: 7,
    })
    const fresh = rec({ thread_id: 't', harvested_at: '2026-09-20T00:00:00Z' })
    const [merged] = upsertRecords([prev], [fresh])
    assert.equal(merged!.status, 'open')
    assert.equal(merged!.fixed_at, null)
    assert.equal(merged!.fix_pr, null)
    assert.equal(merged!.times_seen, 2)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSummary, writeSummary } from './store.ts'

// BRO_DEBT_DIR would redirect every write in this file — tests need the
// cwd-relative path.
delete process.env.BRO_DEBT_DIR

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-debt-'))
  execFileSync('git', ['init', '-q', dir])
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
    execFileSync('git', ['-C', repo, 'check-ignore', '-q', '.agents/review-debt'])
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

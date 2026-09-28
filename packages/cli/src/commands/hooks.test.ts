import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyArmCommand, classifyExecCommand, isSelfToolCommand, parsePrUrl, readArmed, armDetail, otherLiveWork } from './hooks.ts'

describe('classifyExecCommand', () => {
  test('detects gh pr merge', () => {
    assert.equal(classifyExecCommand('gh pr merge 42 --squash'), 'pr-merge')
    assert.equal(classifyExecCommand('cd x && gh pr merge --auto'), 'pr-merge')
  })

  test('detects gh pr create', () => {
    assert.equal(classifyExecCommand('gh pr create --fill'), 'pr-create')
  })

  test('ignores unrelated commands', () => {
    assert.equal(classifyExecCommand('git status'), null)
    assert.equal(classifyExecCommand('gh pr view 42'), null)
    assert.equal(classifyExecCommand('echo "gh pr merge"'), null) // text, not a merge
  })
})

describe('isSelfToolCommand', () => {
  test('approves bro and bd invocations', () => {
    assert.ok(isSelfToolCommand('bro act status'))
    assert.ok(isSelfToolCommand('bd ready -n 5'))
    assert.ok(isSelfToolCommand('  bro debt prs'))
    assert.ok(isSelfToolCommand('npx -y @theplenkov/bro debt status'))
    assert.ok(isSelfToolCommand('npx @theplenkov/bro hooks stop'))
    assert.ok(isSelfToolCommand('npx -y @theplenkov/bro@0 act status'))
  })

  test('does not approve lookalikes or other tools', () => {
    assert.ok(!isSelfToolCommand('brotli -d file'))
    assert.ok(!isSelfToolCommand('bdr foo'))
    assert.ok(!isSelfToolCommand('gh pr merge 1'))
    assert.ok(!isSelfToolCommand(''))
  })

  test('rejects chained/piped/redirected commands — the second stage is unvetted', () => {
    assert.ok(!isSelfToolCommand('bro act status && rm -rf /'))
    assert.ok(!isSelfToolCommand('bro act status; rm -rf /'))
    assert.ok(!isSelfToolCommand('bd ready | sh'))
    assert.ok(!isSelfToolCommand('bro x $(evil)'))
    assert.ok(!isSelfToolCommand('bro x > /tmp/out'))
  })
})

describe('parsePrUrl', () => {
  test('extracts owner/repo/pr from a GitHub URL', () => {
    assert.deepEqual(parsePrUrl('see https://github.com/acme/widgets/pull/42 please'), {
      owner: 'acme',
      repo: 'widgets',
      pr: 42,
    })
  })

  test('returns null without a PR URL', () => {
    assert.equal(parsePrUrl('fix the thing'), null)
    assert.equal(parsePrUrl('github.com/acme/widgets/issues/9'), null)
  })
})

describe('classifyArmCommand', () => {
  test('arms act on PR-touching commands', () => {
    assert.equal(classifyArmCommand('bro act status'), 'act')
    assert.equal(classifyArmCommand('bro act merge 33 --squash'), 'act')
    assert.equal(classifyArmCommand('npx -y @theplenkov/bro act threads 33'), 'act')
    assert.equal(classifyArmCommand('gh pr create --fill'), 'act')
    assert.equal(classifyArmCommand('gh pr view 42'), 'act')
    assert.equal(classifyArmCommand('git push -u origin feat/x'), 'act')
    assert.equal(classifyArmCommand('cd x && gh pr checks'), 'act')
  })

  test('arms drill on drill/wtf commands', () => {
    assert.equal(classifyArmCommand('bro drill down "x"'), 'drill')
    assert.equal(classifyArmCommand('bro wtf "why"'), 'drill')
    assert.equal(classifyArmCommand('bro drill up --result "done"'), 'drill')
  })

  test('arms work on worktree-mutating commands', () => {
    assert.equal(classifyArmCommand('bro work enter fix-x'), 'work')
    assert.equal(classifyArmCommand('bro work leave'), 'work')
    assert.equal(classifyArmCommand('npx -y @theplenkov/bro work list'), 'work')
    assert.equal(classifyArmCommand('git worktree add ../repo--fix -b work/fix'), 'work')
    assert.equal(classifyArmCommand('git -C /path worktree remove old'), 'work')
    assert.equal(classifyArmCommand('bd worktree create feat'), 'work')
    assert.equal(classifyArmCommand('bd worktree remove feat'), 'work')
  })

  test('read-only worktree commands do not arm', () => {
    assert.equal(classifyArmCommand('git worktree list'), null)
    assert.equal(classifyArmCommand('git worktree prune'), null)
    assert.equal(classifyArmCommand('bd worktree list'), null)
  })

  test('ignores unrelated or non-command-position text', () => {
    assert.equal(classifyArmCommand('git status'), null)
    assert.equal(classifyArmCommand('bd ready'), null)
    assert.equal(classifyArmCommand('bro debt collect'), null)
    assert.equal(classifyArmCommand('echo "gh pr merge"'), null)
    assert.equal(classifyArmCommand('gh auth status'), null)
  })
})

describe('readArmed', () => {
  test('returns an empty set for a session with no marker', () => {
    assert.equal(readArmed('definitely-no-such-session-id').size, 0)
  })
})

describe('classifyArmCommand edge cases', () => {
  test('arms through global flags between binary and subcommand', () => {
    assert.equal(classifyArmCommand('git -C /path push'), 'act')
    assert.equal(classifyArmCommand('gh -R owner/repo pr view'), 'act')
    assert.equal(classifyArmCommand('gh --repo owner/repo pr checks'), 'act')
  })

  test('quoted separators do not fake a command position', () => {
    assert.equal(classifyArmCommand('echo "x; bro act status"'), null)
    assert.equal(classifyArmCommand("echo 'git push'"), null)
  })
})

describe('classifyArmCommand positions', () => {
  test('leading whitespace and newlines still count as command position', () => {
    assert.equal(classifyArmCommand('  gh pr view'), 'act')
    assert.equal(classifyArmCommand('echo hi\nbro act status'), 'act')
    assert.equal(classifyArmCommand('true && git push'), 'act')
  })

  test('escaped quotes inside arguments do not open a command position', () => {
    assert.equal(classifyArmCommand('echo "x\\"; git push"'), null)
    assert.equal(classifyArmCommand("echo 'a\\'; bro act'"), null)
  })
})

describe('armDetail', () => {
  test('names the slug from bro work enter', () => {
    assert.equal(armDetail('bro work enter bro-n5t-2', 'work'), 'bro-n5t-2')
    assert.equal(armDetail('cd x && bro work enter bro-abc', 'work'), 'bro-abc')
  })

  test('names the path from git worktree add', () => {
    assert.equal(armDetail('git worktree add ../bro--x -b work/x', 'work'), '../bro--x')
    assert.equal(armDetail('git worktree add -b work/x ../bro--x', 'work'), '../bro--x')
  })

  test('names the PR for act commands', () => {
    assert.equal(armDetail('bro act merge 89 --cleanup', 'act'), '#89')
    assert.equal(armDetail('gh pr merge 42 --squash', 'act'), '#42')
    assert.equal(armDetail('git push', 'act'), '')
  })

  test('returns empty for drill and unrecognized commands', () => {
    assert.equal(armDetail('bro drill down bro-x', 'drill'), '')
    assert.equal(armDetail('npm test', 'work'), '')
  })
})

describe('otherLiveWork', () => {
  /** Seed marker files; ageHours backdates mtime past the live window. */
  function markerDir(entries: Array<[name: string, content: string, ageHours?: number]>): string {
    const dir = mkdtempSync(join(tmpdir(), 'bro-hooks-'))
    for (const [name, content, ageHours] of entries) {
      const p = join(dir, name)
      writeFileSync(p, content)
      if (ageHours !== undefined) {
        const past = new Date(Date.now() - ageHours * 3_600_000)
        utimesSync(p, past, past)
      }
    }
    return dir
  }

  test("a second session's live work marker is detected with its detail", () => {
    const dir = markerDir([['other-session-1.work', '123\nbro-xyz']])
    const found = otherLiveWork(dir, 'self-session')
    assert.equal(found.length, 1)
    assert.equal(found[0]!.session, 'other-session-1')
    assert.equal(found[0]!.detail, 'bro-xyz')
  })

  test('a lone session sees nothing', () => {
    const dir = markerDir([
      ['self-session.work', '123\nbro-mine'],
      ['self-session.act', '123\n#1'],
    ])
    assert.equal(otherLiveWork(dir, 'self-session').length, 0)
  })

  test('stale markers and non-work aspects are ignored', () => {
    const dir = markerDir([
      ['old-session.work', '123\nbro-old', 25],
      ['other.act', '123\n#1'],
      ['other.drill', '123\n'],
      ['unrelated-file', 'x'],
    ])
    assert.equal(otherLiveWork(dir, 'self-session').length, 0)
  })
})

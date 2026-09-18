import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyArmCommand, classifyExecCommand, isSelfToolCommand, parsePrUrl, readArmed } from './hooks.ts'

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

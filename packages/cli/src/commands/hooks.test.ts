import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExecCommand, isSelfToolCommand, parsePrUrl } from './hooks.ts'

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
    assert.equal(classifyExecCommand('echo "gh pr merge"'), 'pr-merge') // text match — fine
  })
})

describe('isSelfToolCommand', () => {
  test('approves bro and bd invocations', () => {
    assert.ok(isSelfToolCommand('bro act status'))
    assert.ok(isSelfToolCommand('bd ready -n 5'))
    assert.ok(isSelfToolCommand('  bro debt prs'))
    assert.ok(isSelfToolCommand('npx -y @theplenkov/bro debt status'))
    assert.ok(isSelfToolCommand('npx @theplenkov/bro hooks stop'))
  })

  test('does not approve lookalikes or other tools', () => {
    assert.ok(!isSelfToolCommand('brotli -d file'))
    assert.ok(!isSelfToolCommand('bdr foo'))
    assert.ok(!isSelfToolCommand('gh pr merge 1'))
    assert.ok(!isSelfToolCommand(''))
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

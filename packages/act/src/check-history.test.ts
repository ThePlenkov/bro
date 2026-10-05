import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileCheckHistory } from './check-history.ts'

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'bro-checkhist-')), 'act-checks.jsonl')
}

const obs = (name: string, sha: string, bucket: string) => ({
  repo: 'o/r',
  pr: 1,
  sha,
  name,
  bucket,
})

describe('fileCheckHistory', () => {
  test('empty or absent file reads as streak 0', () => {
    const h = fileCheckHistory(tmp())
    assert.equal(h.consecutiveFailures('kilo'), 0)
    h.record(obs('kilo', 'a'.repeat(40), 'fail'))
    assert.equal(h.consecutiveFailures('kilo'), 1)
  })

  test('streak counts distinct shas, not repeated polls', () => {
    const h = fileCheckHistory(tmp())
    // same head polled repeatedly collapses to one observation
    for (let i = 0; i < 5; i += 1) {
      h.record(obs('kilo', 'a'.repeat(40), 'fail'))
    }
    assert.equal(h.consecutiveFailures('kilo'), 1)
    h.record(obs('kilo', 'b'.repeat(40), 'fail'))
    assert.equal(h.consecutiveFailures('kilo'), 2)
  })

  test('a stale same-sha observation does not end a live streak', () => {
    const h = fileCheckHistory(tmp())
    // B's head transitioned pending→fail; the older pending entry must
    // not break the trailing run — the sha's latest observation is fail
    h.record(obs('kilo', 'a'.repeat(40), 'fail'))
    h.record(obs('kilo', 'b'.repeat(40), 'pending'))
    h.record(obs('kilo', 'b'.repeat(40), 'fail'))
    assert.equal(h.consecutiveFailures('kilo'), 2)
    // …but a sha whose LATEST observation is a pass still ends it
    h.record(obs('kilo', 'c'.repeat(40), 'pass'))
    assert.equal(h.consecutiveFailures('kilo'), 0)
  })

  test('a non-fail observation breaks the streak', () => {
    const h = fileCheckHistory(tmp())
    h.record(obs('kilo', 'a'.repeat(40), 'fail'))
    h.record(obs('kilo', 'b'.repeat(40), 'fail'))
    h.record(obs('kilo', 'c'.repeat(40), 'pending'))
    assert.equal(h.consecutiveFailures('kilo'), 0)
    h.record(obs('kilo', 'd'.repeat(40), 'fail'))
    assert.equal(h.consecutiveFailures('kilo'), 1)
  })

  test('streaks are per check name and case-insensitive', () => {
    const h = fileCheckHistory(tmp())
    h.record(obs('Kilo Review', 'a'.repeat(40), 'fail'))
    h.record(obs('github-advanced-security', 'a'.repeat(40), 'fail'))
    h.record(obs('Kilo Review', 'b'.repeat(40), 'fail'))
    assert.equal(h.consecutiveFailures('kilo review'), 2)
    assert.equal(h.consecutiveFailures('github-advanced-security'), 1)
    assert.equal(h.consecutiveFailures('other'), 0)
  })

  test('streak crosses PR boundaries — reviewer health is repo-global', () => {
    const h = fileCheckHistory(tmp())
    h.record({ ...obs('kilo', 'a'.repeat(40), 'fail'), pr: 10 })
    h.record({ ...obs('kilo', 'b'.repeat(40), 'fail'), pr: 11 })
    assert.equal(h.consecutiveFailures('kilo'), 2)
  })

  test('malformed lines are skipped, not fatal', () => {
    const file = tmp()
    writeFileSync(file, '{"name":"kilo","sha":"' + 'a'.repeat(40) + '","bucket":"fail","ts":1}\n')
    writeFileSync(file, '{oops\n' + '{"name":"kilo","sha":"' + 'b'.repeat(40) + '","bucket":"fail","ts":2}\n', { flag: 'a' })
    const h = fileCheckHistory(file)
    assert.equal(h.consecutiveFailures('kilo'), 2)
  })

  test('record is a no-op on an unwritable path', () => {
    // a path inside a regular file: mkdir fails ENOTDIR — record must
    // swallow it, not throw
    const blocker = join(mkdtempSync(join(tmpdir(), 'bro-checkhist-')), 'file')
    writeFileSync(blocker, 'x')
    const h = fileCheckHistory(join(blocker, 'ledger.jsonl'))
    h.record(obs('kilo', 'a'.repeat(40), 'fail'))
    assert.equal(h.consecutiveFailures('kilo'), 0)
  })
})

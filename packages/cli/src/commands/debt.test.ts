import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { commandMutatedLedger } from './debt.ts'

describe('commandMutatedLedger', () => {
  test('mutating commands write the ledger', () => {
    for (const cmd of ['collect', 'mark', 'set', 'sync', 'next']) {
      assert.equal(commandMutatedLedger(cmd, []), true, cmd)
    }
  })

  test('read-only variants skip the post-run publish', () => {
    assert.equal(commandMutatedLedger('collect', ['--dry-run']), false)
    assert.equal(commandMutatedLedger('collect', ['--list-only']), false)
    assert.equal(commandMutatedLedger('sync', ['--dry-run']), false)
  })

  test('non-mutating commands never publish', () => {
    for (const cmd of ['status', 'list', 'prs', 'ignore', 'watch', 'help']) {
      assert.equal(commandMutatedLedger(cmd, []), false, cmd)
    }
  })

  test('unrelated flags do not suppress the publish', () => {
    assert.equal(commandMutatedLedger('collect', ['--last', '5']), true)
    assert.equal(commandMutatedLedger('next', ['--claim']), true)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLedgerOverlays,
  upsertLedgerOverlays,
  type DebtRecord,
} from '@broject/debt'
import { commandMutatedLedger, syncSonarDedupeOverlays } from './debt.ts'

/** BRO_DEBT_DIR redirects ledger writes into a throwaway dir. */
function withDebtDir(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-debt-test-'))
  const prev = process.env.BRO_DEBT_DIR
  process.env.BRO_DEBT_DIR = dir
  try {
    fn()
  } finally {
    if (prev === undefined) {
      delete process.env.BRO_DEBT_DIR
    } else {
      process.env.BRO_DEBT_DIR = prev
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('commandMutatedLedger', () => {
  test('mutating commands write the ledger', () => {
    for (const cmd of ['collect', 'mark', 'set', 'sync']) {
      assert.equal(commandMutatedLedger(cmd, []), true, cmd)
    }
  })

  test('read-only variants skip the post-run publish', () => {
    assert.equal(commandMutatedLedger('collect', ['--dry-run']), false)
    assert.equal(commandMutatedLedger('collect', ['--list-only']), false)
    assert.equal(commandMutatedLedger('sync', ['--dry-run']), false)
    assert.equal(commandMutatedLedger('next', []), false)
  })

  test('non-mutating commands never publish', () => {
    for (const cmd of ['status', 'stats', 'trend', 'prs', 'list', 'watch']) {
      assert.equal(commandMutatedLedger(cmd, []), false, cmd)
    }
  })

  test('unrelated flags do not suppress the publish', () => {
    assert.equal(commandMutatedLedger('collect', ['--last', '5']), true)
    assert.equal(commandMutatedLedger('next', ['--claim']), true)
  })
})

describe('syncSonarDedupeOverlays', () => {
  const rec = (thread_id: string, status: string = 'open'): DebtRecord =>
    ({ thread_id, status, path: '', line: null, body: '' }) as DebtRecord

  test('a re-emitted record reopens done + duplicate rows; wontfix stays', () =>
    withDebtDir(() => {
      upsertLedgerOverlays([
        {
          thread_id: 'sonarcloud:D1',
          status: 'done',
          fix_pr: null,
          fixed_at: '2026-01-01T00:00:00Z',
          notes: 'resolved upstream — no longer reported',
        },
        {
          thread_id: 'sonarcloud:DUP',
          status: 'duplicate',
          fix_pr: null,
          fixed_at: null,
          notes: 'covered by review thread T1',
        },
        {
          thread_id: 'sonarcloud:WF',
          status: 'wontfix',
          fix_pr: null,
          fixed_at: null,
          notes: 'accepted risk',
        },
      ])
      const existing = [
        rec('sonarcloud:D1', 'done'),
        rec('sonarcloud:DUP', 'duplicate'),
        rec('sonarcloud:WF', 'wontfix'),
      ]
      const records = [rec('sonarcloud:D1'), rec('sonarcloud:DUP'), rec('sonarcloud:WF')]
      syncSonarDedupeOverlays(existing, records, new Set(), new Map())
      const over = readLedgerOverlays()
      assert.equal(over.get('sonarcloud:D1')?.status, 'open')
      assert.match(over.get('sonarcloud:D1')?.notes ?? '', /still reported upstream/)
      assert.equal(over.get('sonarcloud:DUP')?.status, 'open')
      assert.equal(over.get('sonarcloud:WF')?.status, 'wontfix')
    }))

  test('a covered row transitions open + done → duplicate; wontfix stays', () =>
    withDebtDir(() => {
      const existing = [
        rec('sonarcloud:O1', 'open'),
        rec('sonarcloud:D1', 'done'),
        rec('sonarcloud:WF', 'wontfix'),
        rec('sonarcloud:DUP', 'duplicate'),
      ]
      const coveredBy = new Map(existing.map((r) => [r.thread_id, 'thread:T1'] as const))
      syncSonarDedupeOverlays(
        existing,
        [],
        new Set(existing.map((r) => r.thread_id)),
        coveredBy
      )
      const over = readLedgerOverlays()
      assert.equal(over.get('sonarcloud:O1')?.status, 'duplicate')
      assert.match(over.get('sonarcloud:O1')?.notes ?? '', /covered by review thread thread:T1/)
      // a done row still reported upstream but covered isn't fixed —
      // the thread row owns it; fix% must not count it
      assert.equal(over.get('sonarcloud:D1')?.status, 'duplicate')
      assert.equal(over.get('sonarcloud:WF'), undefined)
      assert.equal(over.get('sonarcloud:DUP'), undefined)
    }))
})

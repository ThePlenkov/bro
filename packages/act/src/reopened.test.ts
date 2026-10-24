import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewThread } from '@broject/core'
import { detectReopenedThreads } from './reopened.ts'
import type { ResolveLedger } from './resolve-log.ts'

/** A ledger stub — the detector only ever asks "was this thread
 *  resolved before?". */
function ledgerOf(resolved: string[]): ResolveLedger {
  return {
    record() {},
    wasResolved: (_repo: string, _pr: number, thread: string) => resolved.includes(thread),
  }
}

function thread(
  id: string,
  resolved: boolean,
  comments: Array<{ author: string; createdAt: string }>
): ReviewThread {
  return {
    id,
    resolved,
    outdated: false,
    comment: comments[0]
      ? {
          author: comments[0].author,
          bot: false,
          path: null,
          line: null,
          body: '',
          createdAt: comments[0].createdAt,
        }
      : null,
    comments: comments.map((c) => ({
      author: c.author,
      bot: false,
      path: null,
      line: null,
      body: '',
      createdAt: c.createdAt,
    })),
  }
}

describe('detectReopenedThreads', () => {
  it('reports a thread that was resolved before and is open again', () => {
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    const found = detectReopenedThreads(ledgerOf(['t1']), 'o/r', 7, current)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.id, 't1')
    assert.equal(found[0]!.author, 'bob')
    assert.equal(found[0]!.reopenedAt, '2026-10-02T10:00:00Z')
  })

  it('ignores a thread the ledger never saw resolved', () => {
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    assert.deepEqual(detectReopenedThreads(ledgerOf([]), 'o/r', 7, current), [])
  })

  it('ignores a thread that stays resolved', () => {
    const current = [thread('t1', true, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]

    assert.deepEqual(detectReopenedThreads(ledgerOf(['t1']), 'o/r', 7, current), [])
  })

  it('reports nothing without a ledger — fail open', () => {
    const current = [thread('t1', false, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]

    assert.deepEqual(detectReopenedThreads(null, 'o/r', 7, current), [])
    assert.deepEqual(detectReopenedThreads(undefined, 'o/r', 7, current), [])
  })

  it('ignores a thread that carries no comment at all', () => {
    const current = [thread('t1', false, [])]

    assert.deepEqual(detectReopenedThreads(ledgerOf(['t1']), 'o/r', 7, current), [])
  })

  it('falls back to the first comment when the host gives no history', () => {
    const current: ReviewThread[] = [
      {
        id: 't1',
        resolved: false,
        outdated: false,
        comment: { author: 'bob', bot: false, path: null, line: null, body: '', createdAt: '2026-10-02T10:00:00Z' },
      },
    ]

    const found = detectReopenedThreads(ledgerOf(['t1']), 'o/r', 7, current)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.author, 'bob')
  })

  it('picks the newest comment as the one that reopened the thread', () => {
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-03T10:00:00Z' },
        { author: 'carol', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    const found = detectReopenedThreads(ledgerOf(['t1']), 'o/r', 7, current)
    assert.equal(found[0]!.author, 'bob')
  })

  it('scopes the ledger to the PR — the same thread id on another PR is not a reopen', () => {
    const current = [thread('t1', false, [{ author: 'bob', createdAt: '2026-10-02T10:00:00Z' }])]

    // the ledger holds 't1' for pr 7 only — a call for pr 8 must not see it
    const scoped: ResolveLedger = {
      record() {},
      wasResolved: (_repo: string, pr: number, thread: string) => pr === 7 && thread === 't1',
    }
    assert.equal(detectReopenedThreads(scoped, 'o/r', 7, current).length, 1)
    assert.equal(detectReopenedThreads(scoped, 'o/r', 8, current).length, 0)
  })
})

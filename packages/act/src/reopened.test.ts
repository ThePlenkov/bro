import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewThread } from '@broject/core'
import { detectReopenedThreads } from './reopened.ts'

function thread(id: string, resolved: boolean, comments: Array<{ author: string; createdAt: string }>): ReviewThread {
  return {
    id,
    resolved,
    outdated: false,
    comment: comments[0]
      ? { author: comments[0].author, bot: false, path: null, line: null, body: '', createdAt: comments[0].createdAt }
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
  it('reports a thread that was resolved and is open again', () => {
    const previous = [thread('t1', true, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    const found = detectReopenedThreads(previous, current)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.id, 't1')
    assert.equal(found[0]!.author, 'bob')
    assert.equal(found[0]!.reopenedAt, '2026-10-02T10:00:00Z')
  })

  it('ignores a thread that was open before and is still open', () => {
    const previous = [thread('t1', false, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    assert.deepEqual(detectReopenedThreads(previous, current), [])
  })

  it('ignores a thread that stays resolved', () => {
    const previous = [thread('t1', true, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]
    const current = [thread('t1', true, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]

    assert.deepEqual(detectReopenedThreads(previous, current), [])
  })

  it('reports nothing without a previous observation — fail open', () => {
    const current = [thread('t1', false, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]

    assert.deepEqual(detectReopenedThreads(null, current), [])
    assert.deepEqual(detectReopenedThreads(undefined, current), [])
    assert.deepEqual(detectReopenedThreads([], current), [])
  })

  it('ignores a thread the previous observation never saw', () => {
    const previous = [thread('other', true, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    assert.deepEqual(detectReopenedThreads(previous, current), [])
  })

  it('falls back to the first comment when the host gives no history', () => {
    const previous: ReviewThread[] = [
      { id: 't1', resolved: true, outdated: false, comment: null },
    ]
    const current: ReviewThread[] = [
      {
        id: 't1',
        resolved: false,
        outdated: false,
        comment: { author: 'bob', bot: false, path: null, line: null, body: '', createdAt: '2026-10-02T10:00:00Z' },
      },
    ]

    const found = detectReopenedThreads(previous, current)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.author, 'bob')
  })

  it('picks the newest comment as the one that reopened the thread', () => {
    const previous = [thread('t1', true, [{ author: 'alice', createdAt: '2026-10-01T10:00:00Z' }])]
    const current = [
      thread('t1', false, [
        { author: 'alice', createdAt: '2026-10-01T10:00:00Z' },
        { author: 'bob', createdAt: '2026-10-03T10:00:00Z' },
        { author: 'carol', createdAt: '2026-10-02T10:00:00Z' },
      ]),
    ]

    const found = detectReopenedThreads(previous, current)
    assert.equal(found[0]!.author, 'bob')
  })
})

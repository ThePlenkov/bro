import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewComment, Verdict } from '@broject/core'
import {
  appendRow,
  commentKey,
  findVerdict,
  journalPath,
  readJournal,
  recordDisposition,
  threadSubject,
} from './journal.ts'

const withRepo = async (fn: (dir: string) => void | Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-judge-journal-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const comment: ReviewComment = {
  author: 'cubic',
  bot: true,
  path: 'src/x.ts',
  line: 42,
  body: 'deref of possibly-null',
  createdAt: '2026-01-01T00:00:00Z',
}

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  ts: '2026-01-01T00:00:00Z',
  kind: 'act-thread',
  subject: { pr: 7, threadId: 'T1', commentSha: 'abc', headSha: 'h1' },
  questions: {},
  answers: {},
  model: 'fake-1',
  latencyMs: 5,
  ...over,
})

describe('journalPath', () => {
  test('resolves under the git common dir; null outside a repo', async () => {
    await withRepo((dir) => {
      assert.equal(journalPath(dir), join(dir, '.git', 'bro', 'judge', 'verdicts.jsonl'))
    })
    const bare = mkdtempSync(join(tmpdir(), 'bro-judge-nowt-'))
    try {
      assert.equal(journalPath(bare), null)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('commentKey', () => {
  test('is stable for identical comments and moves with the content', () => {
    assert.equal(commentKey(comment), commentKey({ ...comment }))
    assert.notEqual(commentKey(comment), commentKey({ ...comment, body: 'edited' }))
    assert.notEqual(commentKey(comment), commentKey({ ...comment, line: 43 }))
  })
})

describe('append + read', () => {
  test('round-trips rows and drops a torn tail line', async () => {
    await withRepo((dir) => {
      const v = verdict()
      appendRow(dir, v)
      appendRow(dir, {
        ts: v.ts,
        kind: 'act-disposition',
        subject: { threadId: 'T1' },
        outcome: 'fixed',
      })
      appendRow(dir, v) // third row — then corrupt the tail
      appendFileSync(journalPath(dir)!, '{bad json\n')
      const rows = readJournal(dir)
      assert.equal(rows.length, 3)
      assert.deepEqual(rows[0], v)
      assert.equal(rows[1]!.kind, 'act-disposition')
    })
  })

  test('rows with a missing or non-object subject are skipped — findVerdict would throw', async () => {
    await withRepo((dir) => {
      appendRow(dir, verdict())
      appendFileSync(
        journalPath(dir)!,
        '{"kind":"x"}\n{"kind":"x","subject":"oops"}\n{"kind":"x","subject":null}\n{"kind":"x","subject":{}}\n'
      )
      const rows = readJournal(dir)
      assert.equal(rows.length, 2)
      assert.deepEqual(rows[1]!.subject, {}) // judge-decide's empty subject is legit
    })
  })
})

describe('findVerdict', () => {
  const rows = [
    verdict({ subject: { pr: 7, threadId: 'T1', commentSha: 'old', headSha: 'h0' } }),
    verdict({ subject: { pr: 7, threadId: 'T1', commentSha: 'abc', headSha: 'h1' } }),
    verdict({ subject: { pr: 7, threadId: 'T2', commentSha: 'xyz', headSha: 'h1' } }),
    verdict({
      subject: { pr: 7, threadId: 'T1', commentSha: 'abc', headSha: 'h1' },
      replay: true,
      model: 'replay-model',
    }),
  ]

  test('matches threadId + commentSha + headSha, latest non-replay wins', () => {
    const found = findVerdict(rows, { threadId: 'T1', commentSha: 'abc', headSha: 'h1' })
    assert.equal(found?.model, 'fake-1') // not the replay row
  })

  test('a moved commentSha or headSha misses — the subject earned a fresh decide()', () => {
    assert.equal(
      findVerdict(rows, { threadId: 'T1', commentSha: 'moved', headSha: 'h1' }),
      undefined
    )
    assert.equal(
      findVerdict(rows, { threadId: 'T1', commentSha: 'abc', headSha: 'h9' }),
      undefined
    )
  })

  test('unspecified fields widen the match', () => {
    const found = findVerdict(rows, { threadId: 'T2' })
    assert.equal(found?.subject.commentSha, 'xyz')
  })
})

describe('recordDisposition', () => {
  test('appends an act-disposition joined onto the verdict subject keys', async () => {
    await withRepo((dir) => {
      appendRow(
        dir,
        verdict({ subject: { pr: 7, threadId: 'T1', commentSha: 'abc', headSha: 'h1' } })
      )
      recordDisposition(dir, { pr: 7, threadId: 'T1' }, 'deferred')
      const last = readJournal(dir).at(-1)!
      assert.equal(last.kind, 'act-disposition')
      assert.equal(last.outcome, 'deferred')
      assert.equal(last.subject.threadId, 'T1')
      // commentSha recovered from the journaled verdict — the caller
      // only knew the thread id
      assert.equal(last.subject.commentSha, 'abc')
      assert.equal(last.subject.headSha, 'h1')
    })
  })

  test('records without a verdict — no join keys invented', async () => {
    await withRepo((dir) => {
      recordDisposition(dir, { threadId: 'T9' }, 'fixed')
      const last = readJournal(dir).at(-1)!
      assert.equal(last.outcome, 'fixed')
      assert.equal(last.subject.commentSha, undefined)
    })
  })
})

describe('threadSubject', () => {
  test('carries pr/threadId and the content-keyed commentSha', () => {
    const s = threadSubject(7, 'T1', comment, 'h1')
    assert.deepEqual(s, {
      pr: 7,
      threadId: 'T1',
      headSha: 'h1',
      commentSha: commentKey(comment),
    })
    assert.deepEqual(threadSubject(undefined, 'T1', null), { threadId: 'T1' })
  })
})

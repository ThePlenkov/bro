import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JudgeUnavailable } from '@broject/core'
import type {
  DecideResult,
  JudgeAnswer,
  JudgeFacade,
  ReviewComment,
  ReviewThread,
  Verdict,
} from '@broject/core'
import { readJournal } from './journal.ts'
import {
  ACT_THREAD_QUESTIONS,
  annotateThreads,
  formatAnnotation,
  threadState,
} from './shadow.ts'

const withRepo = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-judge-shadow-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const comment = (body = 'deref of possibly-null'): ReviewComment => ({
  author: 'cubic',
  bot: true,
  path: 'src/x.ts',
  line: 42,
  body,
  createdAt: '2026-01-01T00:00:00Z',
})

const thread = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  resolved: false,
  outdated: false,
  comment: comment(),
  ...over,
})

const ANSWERS: Record<string, JudgeAnswer> = {
  blocks_correctness: { type: 'noul', noul: 0.91, confidence: 0.91, decidedBy: 'jev' },
  severity: {
    type: 'score',
    score: 2.8,
    probabilities: { '1': 0.05, '2': 0.2, '3': 0.6, '4': 0.15 },
    confidence: 0.8,
    decidedBy: 'jev',
  },
  action: {
    type: 'choice',
    choice: 'resolve',
    probabilities: { resolve: 0.8, reply: 0.1, defer: 0.1 },
    confidence: 0.8,
    decidedBy: 'jev',
  },
}

function fakeJudge(result?: Partial<DecideResult>): JudgeFacade & { calls: number } {
  const box = { calls: 0 }
  return {
    get calls() {
      return box.calls
    },
    decide: async () => {
      box.calls += 1
      return {
        answers: ANSWERS,
        model: 'jev-1.13.0',
        latencyMs: 240,
        usage: { inputTokens: 900, costUsd: 0.0009 },
        lowConfidence: [],
        ...result,
      }
    },
  }
}

const failingJudge = (err: Error): JudgeFacade => ({
  decide: () => Promise.reject(err),
})

describe('ACT_THREAD_QUESTIONS', () => {
  test('is the spec’s v1 set — noul, score(4), choice(resolve|reply|defer)', () => {
    const q = ACT_THREAD_QUESTIONS
    assert.equal(q.blocks_correctness!.type, 'noul')
    assert.equal(q.severity!.type, 'score')
    assert.equal((q.severity as { criteria: unknown[] }).criteria.length, 4)
    assert.equal(q.action!.type, 'choice')
    assert.deepEqual(
      Object.keys((q.action as { criteria: object }).criteria),
      ['resolve', 'reply', 'defer']
    )
  })
})

describe('formatAnnotation', () => {
  const v: Verdict = {
    ts: '2026-01-01T00:00:00Z',
    kind: 'act-thread',
    subject: { threadId: 'T1' },
    questions: {},
    answers: ANSWERS,
    model: 'jev-1.13.0',
    latencyMs: 240,
    costUsd: 0.0009,
  }

  test('renders the spec line', () => {
    assert.equal(
      formatAnnotation(v),
      'judge: blocks_correctness 0.91 · severity 2.8/4 (should-fix) · action resolve — decided by jev-1.13.0 (240ms, $0.0009)'
    )
  })

  test('low-confidence keys tail the line; missing cost stays absent', () => {
    const low = formatAnnotation({ ...v, lowConfidence: ['severity'], costUsd: undefined })
    assert.match(low, /· low: severity$/)
    assert.doesNotMatch(low, /\$/)
  })
})

describe('threadState', () => {
  test('is the compact payload — first comment plus outdated flag', () => {
    assert.deepEqual(threadState(thread('T1')), {
      path: 'src/x.ts',
      line: 42,
      author: 'cubic',
      bot: true,
      outdated: false,
      body: 'deref of possibly-null',
    })
  })
})

describe('annotateThreads', () => {
  test('judges each unresolved thread once, journals the verdict, annotates', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const res = await annotateThreads(
        [thread('T1'), thread('T2'), thread('T3', { resolved: true })],
        { dir, pr: 7, headSha: 'h1', judge }
      )
      assert.equal(judge.calls, 2)
      assert.equal(res.decided, 2)
      assert.deepEqual([...res.annotations.keys()], ['T1', 'T2'])
      const rows = readJournal(dir)
      assert.equal(rows.length, 2)
      assert.equal(rows[0]!.kind, 'act-thread')
      assert.equal(rows[0]!.subject.commentSha?.length, 16)
      // questions ride the verdict — the journal is self-describing
      assert.deepEqual((rows[0] as Verdict).questions, ACT_THREAD_QUESTIONS)
    })
  })

  test('a repeat run re-reads the journal — zero fresh decide() calls', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const threads = [thread('T1')]
      await annotateThreads(threads, { dir, pr: 7, headSha: 'h1', judge })
      const res = await annotateThreads(threads, { dir, pr: 7, headSha: 'h1', judge })
      assert.equal(judge.calls, 1)
      assert.equal(res.decided, 0)
      assert.equal(res.annotations.size, 1)
      assert.match(res.annotations.get('T1')!, /^judge: /)
    })
  })

  test('a moved headSha re-judges — inputs moved', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const threads = [thread('T1')]
      await annotateThreads(threads, { dir, pr: 7, headSha: 'h1', judge })
      const res = await annotateThreads(threads, { dir, pr: 7, headSha: 'h2', judge })
      assert.equal(judge.calls, 2)
      assert.equal(res.decided, 1)
    })
  })

  test('budget bounds fresh decide() calls; the rest are unjudged', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const res = await annotateThreads([thread('T1'), thread('T2'), thread('T3')], {
        dir,
        pr: 7,
        judge,
        budget: 1,
      })
      assert.equal(judge.calls, 1)
      assert.equal(res.unjudged, 2)
      assert.equal(res.annotations.size, 1)
    })
  })

  test('a dead backend stops the loop fast — no per-thread timeouts', async () => {
    await withRepo(async (dir) => {
      const res = await annotateThreads([thread('T1'), thread('T2')], {
        dir,
        pr: 7,
        judge: failingJudge(new JudgeUnavailable('no key')),
      })
      assert.equal(res.unjudged, 1) // first failure breaks; T2 never attempted
      assert.equal(res.annotations.size, 0)
      assert.equal(readJournal(dir).length, 0)
    })
  })

  test('an ordinary error skips that thread only', async () => {
    await withRepo(async (dir) => {
      let n = 0
      const judge: JudgeFacade = {
        decide: async () => {
          n += 1
          if (n === 1) {
            throw new Error('max_tokens_exceeded')
          }
          return {
            answers: ANSWERS,
            model: 'jev-1.13.0',
            latencyMs: 240,
            lowConfidence: [],
          }
        },
      }
      const res = await annotateThreads([thread('T1'), thread('T2')], {
        dir,
        pr: 7,
        judge,
      })
      assert.equal(res.unjudged, 1)
      assert.equal(res.annotations.size, 1)
    })
  })
})

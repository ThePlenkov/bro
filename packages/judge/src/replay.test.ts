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
  MergedPr,
  PrTarget,
  ReviewComment,
  ReviewFacade,
  ReviewThread,
  Verdict,
} from '@broject/core'
import { appendRow, commentKey, readJournal } from './journal.ts'
import { inferOutcome, replayMergedThreads } from './replay.ts'

const withRepo = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-judge-replay-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const comment = (createdAt = '2026-01-01T00:00:00Z'): ReviewComment => ({
  author: 'cubic',
  bot: true,
  path: 'src/x.ts',
  line: 42,
  body: 'deref of possibly-null',
  createdAt,
})

const thread = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  resolved: true,
  outdated: false,
  comment: comment(),
  ...over,
})

const mergedPr = (number: number, over: Partial<MergedPr> = {}): MergedPr => ({
  number,
  mergedAt: '2026-02-01T00:00:00Z',
  updatedAt: null,
  author: 'dev',
  labels: [],
  headRef: `work/${number}`,
  headSha: `sha${number}`,
  ...over,
})

const ANSWERS: Record<string, JudgeAnswer> = {
  action: {
    type: 'choice',
    choice: 'resolve',
    probabilities: { resolve: 0.8 },
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
        latencyMs: 200,
        usage: { inputTokens: 800, costUsd: 0.0008 },
        lowConfidence: [],
        ...result,
      }
    },
  }
}

interface FakeRevSpec {
  prs?: MergedPr[]
  threads?: Map<number, ReviewThread[]>
  commits?: Map<number, string[]>
  /** when true the facade offers scanMergedPrs; when false only serial */
  bulk?: boolean
}

function fakeRev(spec: FakeRevSpec): ReviewFacade & { commitCalls: number[] } {
  const commitCalls: number[] = []
  const threads = spec.threads ?? new Map()
  const base = {
    commitCalls,
    mergedPrs: (_repo: string, q?: { ids?: number[] }) =>
      q?.ids !== undefined
        ? q.ids.map((n) => mergedPr(n))
        : (spec.prs ?? [...threads.keys()].map((n) => mergedPr(n))),
    reviewThreads: async (t: PrTarget) => threads.get(t.pr) ?? [],
    commitTimes: async (t: PrTarget) => {
      commitCalls.push(t.pr)
      return spec.commits?.get(t.pr) ?? []
    },
  }
  const rev: Record<string, unknown> = { ...base }
  if (spec.bulk !== false) {
    rev.scanMergedPrs = async (targets: PrTarget[]) => {
      const out = new Map()
      for (const t of targets) {
        out.set(t.pr, {
          info: { title: '', url: '', mergedAt: '2026-02-01T00:00:00Z', mergeSha: '' },
          threads: threads.get(t.pr) ?? [],
          labels: [],
          updatedAt: null,
        })
      }
      return out
    }
  }
  return rev as unknown as ReviewFacade & { commitCalls: number[] }
}

const disp = (
  threadId: string,
  outcome: string,
  commentSha?: string
): {
  ts: string
  kind: 'act-disposition'
  subject: { threadId: string; commentSha?: string }
  outcome: string
} => ({
  ts: '2026-01-05T00:00:00Z',
  kind: 'act-disposition',
  subject: { threadId, ...(commentSha !== undefined ? { commentSha } : {}) },
  outcome,
})

describe('inferOutcome', () => {
  const ctx = (over: Partial<Parameters<typeof inferOutcome>[1]> = {}) => ({
    dispositions: [],
    deferRefs: new Set<string>(),
    ...over,
  })

  test('a recorded disposition wins over every other signal', () => {
    const t = thread('T1', { outdated: true })
    const sha = commentKey(t.comment!)
    assert.equal(
      inferOutcome(t, ctx({ dispositions: [disp('T1', 'rejected', sha)] })),
      'rejected'
    )
    assert.equal(inferOutcome(t, ctx({ deferRefs: new Set(['T1']) })), 'deferred')
  })

  test('disposition join: SHA-less joins by threadId; a foreign SHA does not', () => {
    const t = thread('T1')
    // a SHA-less disposition is the frozen thread's outcome — pre-judge
    // history is exactly what replay reconstructs
    assert.equal(
      inferOutcome(t, ctx({ dispositions: [disp('T1', 'fixed')] })),
      'fixed'
    )
    // a disposition recorded against a DIFFERENT commentSha does not join
    assert.equal(
      inferOutcome(t, ctx({ dispositions: [disp('T1', 'fixed', 'other-sha')] })),
      undefined
    )
  })

  test('unresolved at settle → excluded', () => {
    assert.equal(inferOutcome(thread('T1', { resolved: false }), ctx()), undefined)
  })

  test('resolved + outdated anchor → fixed', () => {
    assert.equal(inferOutcome(thread('T1', { outdated: true }), ctx()), 'fixed')
  })

  test('resolved + a commit stamped after the comment → fixed', () => {
    const t = thread('T1')
    assert.equal(
      inferOutcome(t, ctx({ commitTimes: ['2026-01-02T00:00:00Z'] })),
      'fixed'
    )
  })

  test('resolved with no movement and no records → excluded', () => {
    const t = thread('T1')
    assert.equal(
      inferOutcome(t, ctx({ commitTimes: ['2025-12-31T00:00:00Z'] })),
      undefined
    )
    assert.equal(inferOutcome(t, ctx()), undefined)
  })
})

describe('replayMergedThreads', () => {
  test('judges classifiable threads, journals replay verdicts with outcomes', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const threads = new Map([
        [7, [thread('T1', { outdated: true }), thread('T2', { resolved: false })]],
      ])
      const res = await replayMergedThreads({
        dir,
        repo: 'acme/widgets',
        rev: fakeRev({ threads }),
        judge,
      })
      assert.equal(judge.calls, 1)
      assert.equal(res.judged, 1)
      assert.equal(res.excluded, 1)
      const rows = readJournal(dir)
      const v = rows[0] as Verdict
      assert.equal(v.kind, 'act-thread')
      assert.equal(v.replay, true)
      assert.equal(v.outcome, 'fixed')
      assert.equal(v.subject.pr, 7)
    })
  })

  test('re-runs are idempotent — replayed subjects count as cached', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const threads = new Map([[7, [thread('T1', { outdated: true })]]])
      const opts = { dir, repo: 'acme/widgets', rev: fakeRev({ threads }), judge }
      await replayMergedThreads(opts)
      const res = await replayMergedThreads(opts)
      assert.equal(judge.calls, 1)
      assert.equal(res.cached, 1)
      assert.equal(res.judged, 0)
    })
  })

  test('commitTimes fetch is lazy — only unresolved-by-records resolved threads pay', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const threads = new Map([
        [7, [thread('T1', { outdated: true })]], // outdated → no fetch needed
        [8, [thread('T2')]], // resolved, no signal → fetch
      ])
      const rev = fakeRev({ threads, commits: new Map([[8, ['2026-01-02T00:00:00Z']]]) })
      const res = await replayMergedThreads({
        dir,
        repo: 'acme/widgets',
        rev,
        judge,
      })
      assert.deepEqual(rev.commitCalls, [8])
      assert.equal(res.judged, 2)
    })
  })

  test('a dead backend stops the loop; attempts consumed budget', async () => {
    await withRepo(async (dir) => {
      const judge: JudgeFacade = {
        decide: () => Promise.reject(new JudgeUnavailable('no key')),
      }
      const threads = new Map([
        [7, Array.from({ length: 8 }, (_, n) => thread(`T${n}`, { outdated: true }))],
      ])
      const res = await replayMergedThreads({
        dir,
        repo: 'acme/widgets',
        rev: fakeRev({ threads }),
        judge,
      })
      assert.ok(res.failed <= 4)
      assert.equal(res.judged, 0)
      assert.equal(readJournal(dir).length, 0)
    })
  })

  test('dispositions join reconstructed subjects by threadId+commentSha', async () => {
    await withRepo(async (dir) => {
      const t = thread('T1') // resolved, not outdated, no commits
      appendRow(dir, disp('T1', 'replied', commentKey(t.comment!)))
      const judge = fakeJudge()
      const threads = new Map([[7, [t]]])
      const res = await replayMergedThreads({
        dir,
        repo: 'acme/widgets',
        rev: fakeRev({ threads }),
        judge,
      })
      assert.equal(res.judged, 1)
      const v = readJournal(dir).find((r) => r.kind !== 'act-disposition') as Verdict
      assert.equal(v.outcome, 'replied')
    })
  })

  test('--prs explicit selection goes through mergedPrs ids', async () => {
    await withRepo(async (dir) => {
      const judge = fakeJudge()
      const threads = new Map([[9, [thread('T9', { outdated: true })]]])
      const res = await replayMergedThreads({
        dir,
        repo: 'acme/widgets',
        rev: fakeRev({ threads }),
        judge,
        prs: [9],
      })
      assert.equal(res.prs, 1)
      assert.equal(res.judged, 1)
    })
  })
})

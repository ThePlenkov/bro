import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConnector } from '@broject/core'
import type { DecideResult, JudgeFacade } from '@broject/core'
import { appendRow } from '@broject/judge'
import { loadQuestions, loadState, runJudgeCommand } from './judge.ts'

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`)
  }
}

/** Capture console + intercept process.exit — usage()/error paths exit 1/2. */
async function capture(
  fn: () => Promise<unknown>
): Promise<{ code: number; out: string[]; err: string[] }> {
  const origExit = process.exit
  const origLog = console.log
  const origErr = console.error
  const out: string[] = []
  const err: string[] = []
  console.log = (...a: unknown[]) => out.push(a.join(' '))
  console.error = (...a: unknown[]) => err.push(a.join(' '))
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0)
  }) as typeof process.exit
  try {
    await fn()
    return { code: 0, out, err }
  } catch (e) {
    if (e instanceof Exit) {
      return { code: e.code, out, err }
    }
    throw e
  } finally {
    process.exit = origExit
    console.log = origLog
    console.error = origErr
  }
}

function tmpdirWith(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const FAKE_RESULT: DecideResult = {
  answers: {
    escalate: { type: 'noul', noul: 0.94, confidence: 0.94, decidedBy: 'fake-judge' },
    route: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9 },
      confidence: 0.4,
      decidedBy: 'fake-judge',
    },
  },
  model: 'fake-1',
  latencyMs: 12,
  usage: { inputTokens: 20, costUsd: 0.001 },
  lowConfidence: ['route'],
}

// a registered judge connector — decide is exercised through the real
// resolution path (facade('judge') → chain), not a stubbed command
registerConnector({
  name: 'judge-test',
  judge: () =>
    ({
      decide: async () => ({ ...FAKE_RESULT }),
    }) as JudgeFacade,
})

describe('bro judge decide', () => {
  // decide() reads config/journal from process.cwd() — run inside the
  // fixture so a shadow-mode repo config can't journal fake-1 verdicts
  // into the real dogfood journal
  const inDir = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      return await fn()
    } finally {
      process.chdir(cwd)
    }
  }

  test('decide prints typed answers + footer; low-confidence marked', async () => {
    const fx = tmpdirWith('bro-judge-')
    try {
      const state = join(fx.dir, 'state.json')
      const questions = join(fx.dir, 'questions.json')
      writeFileSync(state, JSON.stringify({ text: 'charged twice' }))
      writeFileSync(
        questions,
        JSON.stringify({
          escalate: { type: 'noul', instructions: 'escalate?' },
          route: { type: 'choice', instructions: 'where?', criteria: { billing: 'money' } },
        })
      )
      const r = await capture(() =>
        inDir(fx.dir, () =>
          runJudgeCommand([
            'decide',
            '--state',
            state,
            '--questions',
            questions,
            '--connector',
            'judge-test',
          ])
        )
      )
      assert.equal(r.code, 0)
      const text = r.out.join('\n')
      assert.match(text, /escalate: noul 0\.94 conf=0\.94 by fake-judge/)
      assert.match(text, /route: choice "billing" conf=0\.40 by fake-judge \(low confidence\)/)
      assert.match(text, /model fake-1 · 12ms · 20 in-tokens · \$0\.001/)
      assert.match(text, /low confidence: route/)
    } finally {
      fx.done()
    }
  })

  test('--json prints the DecideResult', async () => {
    const fx = tmpdirWith('bro-judge-')
    try {
      const state = join(fx.dir, 's.txt')
      const questions = join(fx.dir, 'q.json')
      writeFileSync(state, 'plain text state')
      writeFileSync(questions, JSON.stringify({ e: { type: 'noul', instructions: '?' } }))
      const r = await capture(() =>
        inDir(fx.dir, () =>
          runJudgeCommand([
            'decide',
            '--state',
            state,
            '--questions',
            questions,
            '--connector',
            'judge-test',
            '--json',
          ])
        )
      )
      assert.equal(r.code, 0)
      const parsed = JSON.parse(r.out.join('\n')) as { model: string }
      assert.equal(parsed.model, 'fake-1')
    } finally {
      fx.done()
    }
  })

  test('missing flags exit 2 with usage', async () => {
    const r = await capture(() => runJudgeCommand(['decide']))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /usage: bro judge decide/)
  })

  test('unknown subcommand exits 2', async () => {
    const r = await capture(() => runJudgeCommand(['bogus']))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /unknown judge subcommand/)
  })
})

describe('bro judge stats', () => {
  const inDir = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      return await fn()
    } finally {
      process.chdir(cwd)
    }
  }

  test('empty journal renders a zeroed report, exit 0', async () => {
    const fx = tmpdirWith('bro-judge-stats-')
    try {
      const r = await capture(() => inDir(fx.dir, () => runJudgeCommand(['stats'])))
      assert.equal(r.code, 0)
      assert.match(r.out.join('\n'), /judge stats — 0 verdicts/)
    } finally {
      fx.done()
    }
  })

  test('reads the repo journal; --json prints the stats object', async () => {
    const fx = tmpdirWith('bro-judge-stats-')
    try {
      execFileSync('git', ['init', '-q', fx.dir])
      appendRow(fx.dir, {
        ts: '2026-01-01T00:00:00Z',
        kind: 'act-thread',
        subject: { pr: 1, threadId: 'T1' },
        questions: {},
        answers: {
          action: {
            type: 'choice',
            choice: 'resolve',
            probabilities: {},
            confidence: 0.9,
            decidedBy: 'jev',
          },
        },
        model: 'jev-1.13.0',
        latencyMs: 120,
        costUsd: 0.001,
      })
      const r = await capture(() =>
        inDir(fx.dir, () => runJudgeCommand(['stats', '--json']))
      )
      assert.equal(r.code, 0)
      const parsed = JSON.parse(r.out.join('\n')) as { verdicts: number }
      assert.equal(parsed.verdicts, 1)
    } finally {
      fx.done()
    }
  })

  test('a bad --since exits 2', async () => {
    const r = await capture(() => runJudgeCommand(['stats', '--since', 'not-a-date']))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /--since must be an ISO timestamp/)
  })
})

describe('loadState / loadQuestions', () => {
  test('state parses JSON, falls back to raw string', () => {
    const fx = tmpdirWith('bro-judge-')
    try {
      const j = join(fx.dir, 'a.json')
      writeFileSync(j, '{"a":1}')
      assert.deepEqual(loadState(j), { a: 1 })
      const t = join(fx.dir, 'a.txt')
      writeFileSync(t, 'not json')
      assert.equal(loadState(t), 'not json')
    } finally {
      fx.done()
    }
  })

  test('questions validate the contract per type', () => {
    const fx = tmpdirWith('bro-judge-')
    try {
      const bad = join(fx.dir, 'bad.json')
      writeFileSync(
        bad,
        JSON.stringify({
          x: { type: 'bogus', instructions: '?' },
          y: { type: 'choice', instructions: '?', criteria: {} },
          z: { type: 'score', instructions: '?', criteria: ['one'] },
        })
      )
      const orig = console.error
      const origExit = process.exit
      const errs: string[] = []
      console.error = (...a: unknown[]) => errs.push(a.join(' '))
      process.exit = ((code?: number) => {
        throw new Exit(code ?? 0)
      }) as typeof process.exit
      try {
        assert.throws(() => loadQuestions(bad), Exit)
      } finally {
        console.error = orig
        process.exit = origExit
      }
      const text = errs.join('\n')
      assert.match(text, /"x"\.type must be one of/)
      assert.match(text, /"y"\.criteria must be a non-empty option map/)
      assert.match(text, /"z"\.criteria must be a 2–10 level array/)
    } finally {
      fx.done()
    }
  })
})

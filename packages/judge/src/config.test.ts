import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_JUDGE_CONFIG, judgeSection } from './config.ts'

describe('judgeSection', () => {
  test('undefined yields the defaults', () => {
    const cfg = judgeSection(undefined)
    assert.equal(cfg.mode, DEFAULT_JUDGE_CONFIG.mode)
    assert.equal(cfg.model, DEFAULT_JUDGE_CONFIG.model)
    assert.equal(cfg.baseUrl, DEFAULT_JUDGE_CONFIG.baseUrl)
    assert.equal(cfg.apiKeyEnv, DEFAULT_JUDGE_CONFIG.apiKeyEnv)
    assert.equal(cfg.confidence, DEFAULT_JUDGE_CONFIG.confidence)
    assert.equal(cfg.timeoutMs, DEFAULT_JUDGE_CONFIG.timeoutMs)
    assert.equal(cfg.maxDecisionsPerRun, DEFAULT_JUDGE_CONFIG.maxDecisionsPerRun)
    assert.equal(cfg.fallback, undefined)
    assert.equal(cfg.llm, undefined)
  })

  test('a bad mode falls back with a warning, not a throw', () => {
    const errs: string[] = []
    const orig = console.error
    console.error = (m: unknown) => errs.push(String(m))
    try {
      assert.equal(judgeSection({ mode: 'advisory' }).mode, 'off')
    } finally {
      console.error = orig
    }
    assert.equal(errs.length, 1)
  })

  test('an llm section needs baseUrl AND model — half is disabled', () => {
    const errs: string[] = []
    const orig = console.error
    console.error = (m: unknown) => errs.push(String(m))
    try {
      const cfg = judgeSection({ llm: { baseUrl: 'https://x' } })
      assert.equal(cfg.llm, undefined)
    } finally {
      console.error = orig
    }
    assert.ok(errs.some((l) => l.includes('judge.llm')))
  })

  test('valid fields pass through; junk falls back', () => {
    const cfg = judgeSection({
      mode: 'shadow',
      model: 'jev-1.13.0',
      confidence: 0.75,
      fallback: 'llm-judge',
      timeoutMs: 5000,
      llm: { baseUrl: 'http://localhost:8080/v1', model: 'm', apiKeyEnv: 'K' },
    })
    assert.equal(cfg.mode, 'shadow')
    assert.equal(cfg.model, 'jev-1.13.0')
    assert.equal(cfg.confidence, 0.75)
    assert.equal(cfg.fallback, 'llm-judge')
    assert.equal(cfg.timeoutMs, 5000)
    assert.equal(cfg.llm?.apiKeyEnv, 'K')
    // out-of-range confidence falls back — with a warning, never silent
    const errs: string[] = []
    const orig = console.error
    console.error = (m: unknown) => errs.push(String(m))
    try {
      assert.equal(judgeSection({ confidence: 1.5 }).confidence, 0.6)
    } finally {
      console.error = orig
    }
    assert.ok(errs.some((l) => l.includes('judge.confidence')))
  })
})

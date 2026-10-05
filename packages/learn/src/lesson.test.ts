import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  deriveConfidence,
  isLesson,
  lessonId,
  lessonProblems,
  type Lesson,
} from './lesson.ts'

const valid = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'learn-sweep-debt-after-merge',
  trigger: { on: ['post-tool'], match: { commands: ['gh pr merge'] }, budget: 1 },
  lesson: 'after gh pr merge, run bro debt collect',
  evidence: [{ kind: 'bead', ref: 'bro-abc' }],
  confidence: 'tentative',
  source: 'manual',
  createdAt: '2026-10-04T00:00:00.000Z',
  ...over,
})

describe('lessonProblems', () => {
  it('accepts a minimal valid lesson', () => {
    assert.deepEqual(lessonProblems(valid()), [])
    assert.ok(isLesson(valid()))
  })

  it('rejects non-objects and missing required fields', () => {
    assert.deepEqual(lessonProblems(null), ['not an object'])
    assert.ok(lessonProblems({}).length > 0)
    assert.ok(lessonProblems(valid({ id: 'no-prefix' })).some((p) => p.includes('learn-')))
    assert.ok(lessonProblems(valid({ lesson: '  ' })).some((p) => p.includes('lesson')))
  })

  it('requires ≥1 known hook event on the trigger', () => {
    const l = valid({ trigger: { on: [] } })
    assert.ok(lessonProblems(l).some((p) => p.includes('trigger.on')))
    const bad = valid({ trigger: { on: ['stop' as never] } })
    assert.ok(lessonProblems(bad).some((p) => p.includes('trigger.on')))
  })

  it('rejects empty evidence — a lesson must cite where it was learned', () => {
    assert.ok(lessonProblems(valid({ evidence: [] })).some((p) => p.includes('evidence')))
  })

  it('rejects a sparse evidence array — every() must not skip holes', () => {
    assert.ok(
      lessonProblems(valid({ evidence: new Array(2) })).some((p) => p.includes('evidence'))
    )
  })

  it('rejects an unknown evidence kind and a blank ref independently', () => {
    assert.ok(
      lessonProblems(valid({ evidence: [{ kind: 'hunch' as never, ref: 'x' }] })).some((p) =>
        p.includes('evidence')
      )
    )
    assert.ok(
      lessonProblems(valid({ evidence: [{ kind: 'bead', ref: ' ' }] })).some((p) =>
        p.includes('evidence')
      )
    )
  })

  it('validates match keys and budget', () => {
    const l = valid({
      trigger: { on: ['post-tool'], match: { terms: 'x' as never }, budget: 0 },
    })
    const problems = lessonProblems(l)
    assert.ok(problems.some((p) => p.includes('match.terms')))
    assert.ok(problems.some((p) => p.includes('budget')))
  })

  it('keeps unknown enums out of confidence and source', () => {
    assert.ok(
      lessonProblems(valid({ confidence: 'certain' as never })).some((p) =>
        p.includes('confidence')
      )
    )
    assert.ok(
      lessonProblems(valid({ source: 'guessed' as never })).some((p) => p.includes('source'))
    )
  })
})

describe('deriveConfidence', () => {
  it('one evidence item is tentative', () => {
    assert.equal(deriveConfidence([{ kind: 'bead', ref: 'a' }]), 'tentative')
  })

  it('≥2 independent evidences are established', () => {
    assert.equal(
      deriveConfidence([
        { kind: 'bead', ref: 'a' },
        { kind: 'pr', ref: 'https://x/1' },
      ]),
      'established'
    )
  })

  it('duplicate refs of the same kind do not count as independent', () => {
    assert.equal(
      deriveConfidence([
        { kind: 'bead', ref: 'a' },
        { kind: 'bead', ref: 'a' },
      ]),
      'tentative'
    )
  })

  it('one evidence that held under a real gate is established', () => {
    assert.equal(
      deriveConfidence([{ kind: 'pr', ref: 'https://x/1' }], { heldUnderGate: true }),
      'established'
    )
  })

  it('never assigns proven — that is earned by re-injection (v2)', () => {
    assert.notEqual(
      deriveConfidence([
        { kind: 'bead', ref: 'a' },
        { kind: 'pr', ref: 'b' },
        { kind: 'session', ref: 'c' },
      ]),
      'proven'
    )
  })
})

describe('lessonId', () => {
  it('slugs the rule text under learn-', () => {
    assert.equal(lessonId('After gh pr merge, run bro debt collect!'), 'learn-after-gh-pr-merge-run-bro-debt-collect')
  })

  it('is stable — same text, same id', () => {
    assert.equal(lessonId('repeat me'), lessonId('repeat me'))
  })

  it('falls back when nothing slug-able remains', () => {
    assert.equal(lessonId('!!!'), 'learn-lesson')
  })
})

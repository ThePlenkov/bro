/** Engine + probes — real git repos in tmp; the fired set lands in
 *  `<git-common>/bro/hooks/fired/<session>` exactly like learn's. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { gitTry, JudgeUnavailable, type Guard, type Verdict } from '@broject/core'
import type { MatchContext } from '@broject/learn'
import { runGuards, type GuardEvalOpts } from './engine.ts'

function repo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-guard-'))
  assert.equal(gitTry(['-C', dir, 'init', '-b', branch]).code, 0)
  // pin the commit identity — CI runners have no global git user
  assert.equal(gitTry(['-C', dir, 'config', 'user.email', 't@t']).code, 0)
  assert.equal(gitTry(['-C', dir, 'config', 'user.name', 't']).code, 0)
  assert.equal(gitTry(['-C', dir, 'commit', '-qm', 'init', '--allow-empty']).code, 0)
  return dir
}

const dirty = (dir: string, rel: string, content = 'x'): void => {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

const GUARD: Guard = {
  name: 'tests-with-src',
  when: {
    on: ['stop'],
    state: { diff: { changed: ['src/**'], without: ['**/*.test.*'] } },
  },
  say: 'src/ changed without a test file',
}

function opts(dir: string, over: Partial<GuardEvalOpts> = {}): GuardEvalOpts {
  return {
    dir,
    sessionId: 'ses-1',
    event: 'stop',
    mctx: async (): Promise<MatchContext> => ({ text: '', trace: [] }),
    ...over,
  }
}

describe('runGuards', () => {
  test('fires once per session — budget 1 spends through the fired set', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const first = await runGuards(opts(dir, { defs: [GUARD], record: true }))
    assert.deepEqual(first.lines, [`bro guard tests-with-src: ${GUARD.say}`])
    const second = await runGuards(opts(dir, { defs: [GUARD], record: true }))
    assert.deepEqual(second.lines, [])
    const v = second.verdicts[0]!
    assert.equal(v.fire, false)
    assert.deepEqual(v.clauses.find((c) => c.clause === 'budget'), {
      clause: 'budget',
      ok: false,
      detail: '1/1 spent',
    })
  })

  test('concurrent fires cannot double-spend — the fired set lock serializes', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    // two hook processes racing the same budget-1 guard: the check +
    // append is atomic under learn's file lock, so exactly one fires
    const [a, b] = await Promise.all([
      runGuards(opts(dir, { defs: [GUARD], record: true })),
      runGuards(opts(dir, { defs: [GUARD], record: true })),
    ])
    const fired = [a, b].filter((r) => r.lines.length === 1)
    assert.equal(fired.length, 1, `expected exactly one fire, got ${a.lines.length}+${b.lines.length}`)
    const spent = [a, b].find((r) => r.lines.length === 0)!
    assert.equal(spent.verdicts[0]!.fire, false)
  })

  test('record:false reports FIRE but never writes the fired set', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const test1 = await runGuards(opts(dir, { defs: [GUARD], record: false }))
    assert.equal(test1.verdicts[0]!.fire, true)
    assert.equal(test1.verdicts[0]!.line, `bro guard tests-with-src: ${GUARD.say}`)
    // still unfired — nothing was recorded
    const test2 = await runGuards(opts(dir, { defs: [GUARD], record: false }))
    assert.equal(test2.verdicts[0]!.fire, true)
  })

  test('diff.without suppresses when a test file is also touched', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    dirty(dir, 'src/a.test.ts')
    const run = await runGuards(opts(dir, { defs: [GUARD] }))
    const v = run.verdicts[0]!
    assert.equal(v.fire, false)
    const w = v.clauses.find((c) => c.clause === 'diff.without')!
    assert.equal(w.ok, false)
    assert.match(w.detail!, /\*?\*?\/?\*\.test\.\*/)
  })

  test('branch, exists, armed and terms compose conjunctively', async () => {
    const dir = repo('feat/x')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    const g: Guard = {
      name: 'branchy',
      when: {
        on: ['post-tool'],
        match: { terms: ['deploy'] },
        state: { branch: 'feat/*', exists: ['docs'], armed: ['act'] },
      },
      say: 'on a feat branch with docs — check the spec',
    }
    const base = opts(dir, {
      event: 'post-tool',
      defs: [g],
      armed: () => new Set(['act']),
      mctx: async () => ({ text: 'please deploy this', trace: [] }),
    })
    const run = await runGuards(base)
    assert.equal(run.verdicts[0]!.fire, true)

    const wrongBranch = await runGuards({
      ...base,
      event: 'session-start', // wrong event — on clause fails
    })
    const v = wrongBranch.verdicts[0]!
    assert.equal(v.clauses[0]!.clause, 'on')
    assert.equal(v.clauses[0]!.ok, false)
    assert.equal(v.fire, false)

    const noTerm = await runGuards({ ...base, mctx: async () => ({ text: 'hello', trace: [] }) })
    assert.equal(noTerm.verdicts[0]!.clauses.find((c) => c.clause === 'match.terms')!.ok, false)
    assert.equal(noTerm.verdicts[0]!.fire, false)

    const unarmed = await runGuards({ ...base, armed: () => new Set<string>() })
    assert.equal(unarmed.verdicts[0]!.clauses.find((c) => c.clause === 'armed')!.ok, false)
    assert.equal(unarmed.verdicts[0]!.fire, false)
  })

  test('exists stays repo-relative — ../ escapes read as missing', async () => {
    const dir = repo()
    // real file outside the repo — a verdict must never reveal it
    const escape = `${basename(dir)}.esc`
    writeFileSync(join(dir, '..', escape), 'x')
    const g: Guard = {
      name: 'esc',
      when: { on: ['stop'], state: { exists: [`../${escape}`] } },
      say: 'host file is visible',
    }
    const run = await runGuards(opts(dir, { defs: [g] }))
    const v = run.verdicts[0]!
    assert.equal(v.fire, false)
    const c = v.clauses.find((c) => c.clause === 'exists')!
    assert.equal(c.ok, false)
    assert.equal(c.detail, `missing: ../${escape}`)
  })

  test('an unknown named probe fails its clause', async () => {
    const dir = repo()
    const g: Guard = {
      name: 'drifty',
      when: { on: ['stop'], state: { probes: [{ name: 'spec-drift' }] } },
      say: 'spec went stale',
    }
    const run = await runGuards(opts(dir, { defs: [g] }))
    const v = run.verdicts[0]!
    assert.equal(v.fire, false)
    assert.deepEqual(v.clauses.find((c) => c.clause === 'probe:spec-drift'), {
      clause: 'probe:spec-drift',
      ok: false,
      detail: 'unknown probe',
    })
  })

  test('registered named probes run with their args', async () => {
    const dir = repo()
    const g: Guard = {
      name: 'p',
      when: { on: ['stop'], state: { probes: [{ name: 'has-marker', args: { k: 'x' } }] } },
      say: 'marker present',
    }
    const run = await runGuards(opts(dir, {
      defs: [g],
      probes: { 'has-marker': (args) => args?.k === 'x' },
    }))
    assert.equal(run.verdicts[0]!.fire, true)
    assert.equal(run.verdicts[0]!.clauses.find((c) => c.clause === 'probe:has-marker')!.ok, true)
  })

  test('a ProbeResult answer surfaces its detail on the clause row', async () => {
    const dir = repo()
    const g: Guard = {
      name: 'p',
      when: { on: ['stop'], state: { probes: [{ name: 'drift' }] } },
      say: 'x',
    }
    const run = await runGuards(opts(dir, {
      defs: [g],
      probes: { drift: () => ({ ok: false, detail: 'unverifiable — shallow history' }) },
    }))
    assert.deepEqual(run.verdicts[0]!.clauses.find((c) => c.clause === 'probe:drift'), {
      clause: 'probe:drift',
      ok: false,
      detail: 'unverifiable — shallow history',
    })
  })

  test('defs evaluate in parallel — a pending probe does not serialize the next def', async () => {
    const dir = repo()
    let secondRan = false
    const g = (name: string, probe: string): Guard => ({
      name,
      when: { on: ['stop'], state: { probes: [{ name: probe }] } },
      say: 'x',
    })
    const run = await runGuards(
      opts(dir, {
        defs: [g('first', 'slow'), g('second', 'fast')],
        probes: {
          // resolves only once 'fast' has been invoked — a serial phase-1
          // would exhaust the spin and answer false; passing proves the
          // defs overlap (bd/git spawns included, via async probes)
          slow: async () => {
            for (let i = 0; i < 1000 && !secondRan; i++) {
              await new Promise((r) => setImmediate(r))
            }
            return secondRan
          },
          fast: async () => {
            secondRan = true
            return true
          },
        },
      })
    )
    // declaration order survives the out-of-order completion — budget
    // accounting iterates this same order
    assert.deepEqual(run.verdicts.map((v) => v.name), ['first', 'second'])
    assert.equal(run.verdicts[0]!.clauses.find((c) => c.clause === 'probe:slow')!.ok, true)
    assert.equal(run.verdicts.every((v) => v.fire), true)
  })

  test('maxPerEvent caps emitted lines', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const mk = (n: string): Guard => ({ ...GUARD, name: n })
    const run = await runGuards(opts(dir, {
      defs: [mk('g1'), mk('g2'), mk('g3'), mk('g4')],
      cfg: { enabled: true, maxPerEvent: 2, defs: [] },
      record: true,
    }))
    assert.deepEqual(run.lines.length, 2)
    assert.equal(run.verdicts.filter((v) => v.fire).length, 2)
    const capped = run.verdicts.filter((v) => !v.fire)
    assert.ok(capped.every((v) => v.clauses.some((c) => c.clause === 'cap' && !c.ok)))
  })

  test('enabled:false emits nothing', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const run = await runGuards(opts(dir, {
      defs: [GUARD],
      cfg: { enabled: false, maxPerEvent: 3, defs: [] },
    }))
    assert.deepEqual(run.lines, [])
    assert.deepEqual(run.verdicts, [])
  })

  test('no session id → no fired set → nothing fires', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const run = await runGuards(opts(dir, { sessionId: '', defs: [GUARD], record: true }))
    assert.deepEqual(run.lines, [])
    const v = run.verdicts[0]!
    assert.equal(v.fire, false)
    assert.match(v.clauses.find((c) => c.clause === 'budget')!.detail!, /no session/)
  })

  test('judge clause: no judge wiring abstains, never vetoes', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const g: Guard = { ...GUARD, when: { ...GUARD.when, judge: { question: 'fire?' } } }
    const run = await runGuards(opts(dir, { defs: [g] }))
    const v = run.verdicts[0]!
    assert.equal(v.fire, true)
    assert.deepEqual(v.clauses.find((c) => c.clause === 'judge'), {
      clause: 'judge',
      ok: true,
      detail: 'abstained — judge off',
    })
  })

  const noulFacade = (noul: number, confidence = 0.9, lowConfidence: string[] = []) => ({
    decide: async () => ({
      answers: { fire: { type: 'noul' as const, noul, confidence, decidedBy: 'test' } },
      model: 'm',
      latencyMs: 1,
      lowConfidence,
    }),
  })

  test('judge veto suppresses a firing guard and journals kind:guard', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const g: Guard = { ...GUARD, when: { ...GUARD.when, judge: { question: 'fire?' } } }
    const journaled: Verdict[] = []
    const run = await runGuards(
      opts(dir, {
        defs: [g],
        record: true,
        judge: () => ({
          facade: noulFacade(0.2),
          confidence: 0.6,
          maxDecisions: 5,
          journal: (v) => journaled.push(v),
        }),
      })
    )
    const v = run.verdicts[0]!
    assert.equal(v.fire, false)
    assert.deepEqual(run.lines, [])
    assert.match(v.clauses.find((c) => c.clause === 'judge')!.detail!, /vetoed — noul 0\.2 < 0\.5/)
    assert.equal(journaled.length, 1)
    assert.equal(journaled[0]!.kind, 'guard')
    assert.equal(journaled[0]!.subject.threadId, 'guard:tests-with-src')
  })

  test('a throwing journal loses its row, never the verdict', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const g: Guard = { ...GUARD, when: { ...GUARD.when, judge: { question: 'fire?' } } }
    const run = await runGuards(
      opts(dir, {
        defs: [g],
        judge: () => ({
          facade: noulFacade(0.2),
          confidence: 0.6,
          maxDecisions: 5,
          journal: () => { throw new Error('ENOSPC') },
        }),
      })
    )
    const v = run.verdicts[0]!
    assert.equal(v.fire, false, 'the veto still lands')
    assert.match(v.clauses.find((c) => c.clause === 'judge')!.detail!, /vetoed — noul 0\.2 < 0\.5/)
  })

  test('judge allow fires; abstains on throw and low confidence', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const g: Guard = { ...GUARD, when: { ...GUARD.when, judge: { question: 'fire?' } } }
    const allow = await runGuards(
      opts(dir, {
        defs: [g],
        judge: () => ({ facade: noulFacade(0.9), confidence: 0.6, maxDecisions: 5 }),
      })
    )
    assert.equal(allow.verdicts[0]!.fire, true)
    assert.match(allow.verdicts[0]!.clauses.find((c) => c.clause === 'judge')!.detail!, /noul 0\.9/)

    const threw = await runGuards(
      opts(dir, {
        defs: [g],
        judge: () => ({
          facade: { decide: async () => { throw new JudgeUnavailable('down') } },
          confidence: 0.6,
          maxDecisions: 5,
        }),
      })
    )
    assert.equal(threw.verdicts[0]!.fire, true)
    assert.match(threw.verdicts[0]!.clauses.find((c) => c.clause === 'judge')!.detail!, /abstained — down/)

    const low = await runGuards(
      opts(dir, {
        defs: [g],
        judge: () => ({
          facade: noulFacade(0.1, 0.3, ['fire']),
          confidence: 0.6,
          maxDecisions: 5,
        }),
      })
    )
    // noul 0.1 would veto, but confidence 0.3 < 0.6 → abstain wins
    assert.equal(low.verdicts[0]!.fire, true)
    assert.match(low.verdicts[0]!.clauses.find((c) => c.clause === 'judge')!.detail!, /abstained — confidence/)
  })

  test('judge is only asked when deterministic clauses pass', async () => {
    const dir = repo()
    // clean tree — diff.changed misses → decide must not run
    let called = 0
    const g: Guard = { ...GUARD, when: { ...GUARD.when, judge: { question: 'fire?' } } }
    await runGuards(
      opts(dir, {
        defs: [g],
        judge: () => ({
          facade: {
            decide: async () => {
              called += 1
              throw new JudgeUnavailable('should not be called')
            },
          },
          confidence: 0.6,
          maxDecisions: 5,
        }),
      })
    )
    assert.equal(called, 0)
    // the judge row is absent entirely — the clause never evaluated
    assert.equal(
      (await runGuards(opts(dir, { defs: [g] }))).verdicts[0]!.clauses.find((c) => c.clause === 'judge'),
      undefined
    )
  })

  test('say is bounded at 2000 chars / 20 lines', async () => {
    const dir = repo()
    const g: Guard = {
      name: 'chatty',
      when: { on: ['stop'] },
      say: `${Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')}${'x'.repeat(2100)}`,
    }
    const run = await runGuards(opts(dir, { defs: [g] }))
    const line = run.lines[0]!
    assert.ok(line.length <= 'bro guard chatty: '.length + 2000 + 3)
    assert.match(line, /…$/)
  })
})

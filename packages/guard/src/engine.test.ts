/** Engine + probes — real git repos in tmp; the fired set lands in
 *  `<git-common>/bro/hooks/fired/<session>` exactly like learn's. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { gitTry, type Guard } from '@broject/core'
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

  test('judge clause abstains and marks the line (unjudged)', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const g: Guard = { ...GUARD, when: { ...GUARD.when, judge: { question: 'fire?', threshold: 0.6 } } }
    const run = await runGuards(opts(dir, { defs: [g] }))
    const v = run.verdicts[0]!
    assert.equal(v.fire, true)
    assert.equal(v.clauses.find((c) => c.clause === 'judge')!.detail, 'abstained — veto lands in bro-nkn6.4')
    assert.match(v.line!, /\(unjudged\)$/)
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

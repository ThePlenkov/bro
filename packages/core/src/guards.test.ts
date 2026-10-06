import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { collectGuards, registerConnector } from './connectors.ts'
import {
  GUARD_EVENTS,
  guardProblems,
  isGuardEvent,
  type Guard,
} from './guards.ts'

const VALID: Guard = {
  name: 'tests-with-src',
  when: { on: ['post-tool'], state: { diff: { changed: ['src/**'], without: ['**/*.test.*'] } } },
  say: 'src/ changed without a test file — write one or say why not',
}

describe('guardProblems', () => {
  test('a minimal valid guard passes', () => {
    assert.deepEqual(guardProblems({ name: 'g', when: { on: ['stop'] }, say: 'hi' }), [])
    assert.deepEqual(guardProblems(VALID), [])
  })

  test('every event name is accepted; unknown ones are not', () => {
    for (const e of GUARD_EVENTS) {
      assert.deepEqual(guardProblems({ name: 'g', when: { on: [e] }, say: 'x' }), [])
    }
    assert.ok(guardProblems({ name: 'g', when: { on: ['pre-compact'] }, say: 'x' })[0].includes('unknown event'))
    assert.ok(isGuardEvent('post-tool'))
    assert.ok(!isGuardEvent('pre-compact'))
  })

  test('rejects non-objects, bad names, empty say, missing/empty on', () => {
    for (const [v, frag] of [
      [null, 'not an object'],
      [[], 'not an object'],
      [{ when: { on: ['stop'] }, say: 'x' }, 'name'],
      [{ name: 'has space', when: { on: ['stop'] }, say: 'x' }, 'name'],
      [{ name: 'g', when: { on: ['stop'] }, say: '  ' }, 'say'],
      [{ name: 'g', say: 'x' }, 'when'],
      [{ name: 'g', when: { on: [] }, say: 'x' }, '≥1 event'],
    ] as const) {
      const problems = guardProblems(v)
      assert.ok(problems.length > 0, `expected problems for ${JSON.stringify(v)}`)
      assert.ok(problems.join('; ').includes(frag), `${frag} in ${problems.join('; ')}`)
    }
  })

  test('match keys follow the TriggerMatch shape', () => {
    assert.deepEqual(
      guardProblems({
        name: 'g',
        when: { on: ['prompt-submit'], match: { terms: ['a'], commands: ['git'], errors: true } },
        say: 'x',
      }),
      []
    )
    for (const bad of [
      { match: 'x' },
      { match: { terms: [''] } },
      { match: { tools: 'sed' } },
      { match: { errors: 'yes' } },
    ]) {
      const problems = guardProblems({ name: 'g', when: { on: ['stop'], ...bad }, say: 'x' })
      assert.ok(problems.length > 0, JSON.stringify(bad))
    }
  })

  test('state clauses are conjunctive shape-checks', () => {
    for (const bad of [
      { state: 'x' },
      { state: { diff: ['src/**'] } },
      { state: { diff: { changed: 'src/**' } } },
      { state: { branch: '' } },
      { state: { armed: 'act' } },
      { state: { exists: [42] } },
      { state: { probes: 'drift' } },
      { state: { probes: [{ args: {} }] } },
    ]) {
      const problems = guardProblems({ name: 'g', when: { on: ['stop'], ...bad }, say: 'x' })
      assert.ok(problems.length > 0, JSON.stringify(bad))
    }
    assert.deepEqual(
      guardProblems({
        name: 'g',
        when: {
          on: ['stop'],
          state: {
            diff: { changed: ['src/**'], without: ['**/*.test.*'] },
            branch: 'feat/*',
            armed: ['act'],
            exists: ['AGENTS.md'],
            probes: [{ name: 'spec-drift' }],
          },
        },
        say: 'x',
      }),
      []
    )
  })

  test('judge clause needs a question; threshold stays in [0,1]', () => {
    assert.deepEqual(
      guardProblems({ name: 'g', when: { on: ['stop'], judge: { question: 'q?', threshold: 0.7 } }, say: 'x' }),
      []
    )
    for (const bad of [
      { judge: { threshold: 0.5 } },
      { judge: { question: '' } },
      { judge: { question: 'q', threshold: 1.5 } },
      { judge: { question: 'q', threshold: -0.1 } },
    ]) {
      const problems = guardProblems({ name: 'g', when: { on: ['stop'], ...bad }, say: 'x' })
      assert.ok(problems.length > 0, JSON.stringify(bad))
    }
  })

  test('budget is an integer ≥1', () => {
    assert.deepEqual(
      guardProblems({ name: 'g', when: { on: ['stop'], budget: 3 }, say: 'x' }),
      []
    )
    for (const budget of [0, -1, 1.5, '2']) {
      assert.ok(
        guardProblems({ name: 'g', when: { on: ['stop'], budget }, say: 'x' }).length > 0,
        `budget=${JSON.stringify(budget)}`
      )
    }
  })
})

describe('collectGuards', () => {
  const ctx = { dir: '/tmp/x' }
  const mk = (name: string): Guard => ({ name, when: { on: ['stop'] }, say: `say ${name}` })

  test('config defs come first, then connectors in registry order', () => {
    registerConnector({ name: 'g-first', guards: () => [mk('conn-a')] })
    registerConnector({ name: 'g-second', guards: () => [mk('conn-b'), mk('conn-c')] })
    const rows = collectGuards(ctx, [mk('cfg-1'), mk('cfg-2')])
    const names = rows.filter((r) => r.guard).map((r) => r.guard!.name)
    assert.deepEqual(
      names.slice(0, 5),
      ['cfg-1', 'cfg-2', 'conn-a', 'conn-b', 'conn-c'],
      names.join(',')
    )
    assert.equal(rows.find((r) => r.guard?.name === 'conn-a')?.source, 'g-first')
    assert.equal(rows.find((r) => r.guard?.name === 'cfg-1')?.source, 'config')
  })

  test('duplicate names lose to the earlier declaration — config shadows connector', () => {
    registerConnector({ name: 'g-dupe', guards: () => [mk('cfg-1'), mk('conn-a')] })
    const rows = collectGuards(ctx, [mk('cfg-1')])
    const dupes = rows.filter((r) => r.name === 'cfg-1' && r.problems)
    assert.equal(dupes.length, 1)
    assert.match(dupes[0]!.problems![0]!, /duplicate/)
    assert.equal(dupes[0]!.source, 'g-dupe')
    // only one live 'cfg-1' — the config one
    assert.deepEqual(rows.filter((r) => r.guard?.name === 'cfg-1').map((r) => r.source), ['config'])
    // the earlier connector's own guard from the first test is a dupe now too
    assert.ok(rows.some((r) => r.name === 'conn-a' && r.problems))
  })

  test('a throwing connector is skipped; others still collect', () => {
    registerConnector({
      name: 'g-wedged',
      guards: () => {
        throw new Error('wedged')
      },
    })
    registerConnector({ name: 'g-ok', guards: () => [mk('ok-1')] })
    const rows = collectGuards(ctx, [])
    assert.ok(rows.some((r) => r.guard?.name === 'ok-1'))
  })

  test('malformed connector guards are annotated and skipped', () => {
    registerConnector({
      name: 'g-bad',
      guards: () => [
        { name: 'bad guard!', when: { on: ['stop'] }, say: 'x' } as Guard,
        { name: 'no-say', when: { on: ['stop'] } } as unknown as Guard,
        mk('fine-1'),
      ],
    })
    const rows = collectGuards(ctx, [])
    const bad = rows.find((r) => r.name === 'bad guard!')
    assert.ok(bad?.problems?.[0]?.includes('name'))
    assert.ok(rows.find((r) => r.name === 'no-say')?.problems?.[0]?.includes('say'))
    assert.ok(rows.some((r) => r.guard?.name === 'fine-1'))
  })

  test('connectors without guards() contribute nothing', () => {
    registerConnector({ name: 'g-none' })
    const before = collectGuards(ctx, []).filter((r) => r.source === 'g-none')
    assert.deepEqual(before, [])
  })
})

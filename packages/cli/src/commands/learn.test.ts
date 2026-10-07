/** `bro learn` e2e — the bd-kv lesson store through the built CLI.
 *  The shared fake bd plays `kv` against a JSON file (FAKE_BD_DB), so
 *  add → list → show → forget exercises the real spawn path with no
 *  live Dolt store. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initRepo,
  inside,
  installFakeBd,
  runCli,
  writeBeads,
  type CliResult,
} from './testrepo.ts'

function learnFixture(
  rows: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {}
): { root: string; main: string; db: string; run: (args: string[]) => CliResult } {
  const { root, main } = initRepo('bro-learn-e2e-')
  const { binDir, db } = installFakeBd(root, [])
  writeBeads(db, rows, extra)
  const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db }
  return { root, main, db, run: (args) => runCli(['learn', ...args], { cwd: main, env }) }
}

const ADD = [
  'add',
  '--lesson',
  'after gh pr merge run bro debt collect',
  '--on',
  'post-tool',
  '--match-commands',
  'gh pr merge',
  '--evidence',
  'bead:bro-abc',
]

describe('bro learn', () => {
  test('add → list → show → forget round-trips a lesson', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const add = f.run(ADD)
      assert.equal(add.code, 0, add.stderr)
      const id = add.stdout.trim()
      assert.match(id, /^learn-after-gh-pr-merge-run-bro-debt-colle/)

      const list = f.run(['list'])
      assert.equal(list.code, 0, list.stderr)
      assert.match(list.stdout, new RegExp(`${id}\\ttentative\\tmanual\\tpost-tool`))

      const show = f.run(['show', id])
      assert.equal(show.code, 0, show.stderr)
      const lesson = JSON.parse(show.stdout) as Record<string, unknown>
      assert.equal(lesson.id, id)
      assert.equal(lesson.source, 'manual')
      assert.deepEqual(lesson.evidence, [{ kind: 'bead', ref: 'bro-abc' }])

      const forget = f.run(['forget', id])
      assert.equal(forget.code, 0, forget.stderr)
      assert.equal(f.run(['show', id]).code, 1)
    })
  })

  test('add refuses to store without evidence — citations are load-bearing', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const r = f.run(['add', '--lesson', 'a rule', '--on', 'session-start'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--evidence is required/)
    })
  })

  test('add fills the on array from repeated and comma-joined --on', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const r = f.run([
        'add',
        '--lesson',
        'a rule that fires on several events',
        '--on',
        'session-start',
        '--on',
        'post-tool',
        '--on',
        'prompt-submit,session-start',
        '--evidence',
        'bead:bro-abc',
      ])
      assert.equal(r.code, 0, r.stderr)
      const lesson = JSON.parse(f.run(['show', r.stdout.trim()]).stdout) as {
        trigger: { on: string[] }
      }
      // every occurrence counts, order preserved, repeats collapse —
      // the Array type is reachable from add, not just from capture
      assert.deepEqual(lesson.trigger.on, [
        'session-start',
        'post-tool',
        'prompt-submit',
      ])
    })
  })

  test('add refuses a duplicate id', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(ADD).code, 0)
      const dup = f.run(ADD)
      assert.equal(dup.code, 1)
      assert.match(dup.stderr, /already exists/)
    })
  })

  test('two independent evidences store as established', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const r = f.run([
        ...ADD,
        '--evidence',
        'pr:https://example.test/o/r/pull/1',
      ])
      assert.equal(r.code, 0, r.stderr)
      const show = f.run(['show', r.stdout.trim()])
      assert.equal((JSON.parse(show.stdout) as { confidence: string }).confidence, 'established')
    })
  })

  test('list --json emits the store, filters apply', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      f.run(ADD)
      const all = JSON.parse(f.run(['list', '--json']).stdout) as unknown[]
      assert.equal(all.length, 1)
      const matching = JSON.parse(
        f.run(['list', '--json', '--source', 'manual']).stdout
      ) as unknown[]
      assert.equal(matching.length, 1)
      const filtered = JSON.parse(
        f.run(['list', '--json', '--source', 'probe']).stdout
      ) as unknown[]
      assert.equal(filtered.length, 0)
    })
  })

  const DRILL_ROW = {
    id: 'fx-d1',
    title: 'investigate bro convoy next --mol',
    status: 'closed',
    labels: ['drill'],
    description: 'look at packages/convoy/**',
    notes: '## Result\n\nconvoy next resolves the single open molecule\n\n## Prevention\n\n- pass --mol explicitly',
  }

  test('capture harvests a closed drill frame into a stored lesson', () => {
    const f = learnFixture([DRILL_ROW])
    inside(f.main, f.root, () => {
      const r = f.run(['capture', '--source', 'drill'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /captured learn-\S+\s+capture:drill\s+post-tool/)

      const list = f.run(['list', '--json'])
      const lessons = JSON.parse(list.stdout) as Array<Record<string, unknown>>
      assert.equal(lessons.length, 1)
      assert.equal(lessons[0]!.source, 'capture:drill')
    })
  })

  test('capture --dry-run (bare or =true) proposes without writing', () => {
    const f = learnFixture([DRILL_ROW])
    inside(f.main, f.root, () => {
      for (const dry of ['--dry-run', '--dry-run=true']) {
        const r = f.run(['capture', '--source', 'drill', dry])
        assert.equal(r.code, 0, r.stderr)
        assert.match(r.stdout, /would capture learn-/)
        assert.equal(f.run(['list', '--json']).stdout.trim(), '[]')
      }
    })
  })

  test('capture --source mol requires --mol', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const r = f.run(['capture', '--source', 'mol'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--mol/)
    })
  })

  test('capture rejects a repeated boolean flag — contradictory values fail closed', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const r = f.run(['capture', '--dry-run=false', '--dry-run=true'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--dry-run may be given only once/)
    })
  })

  test('probe phase 1: miss prints candidates + hint, exits 1; hit exits 0', () => {
    const f = learnFixture([
      { id: 'fx-ms9', title: 'merge slot occupancy gate', status: 'in_progress' },
    ])
    inside(f.main, f.root, () => {
      const miss = f.run(['probe', 'how does the merge slot work'])
      assert.equal(miss.code, 1)
      assert.match(miss.stdout, /probe: how does the merge slot work/)
      assert.match(miss.stdout, /bead: fx-ms9 merge slot occupancy gate/)
      assert.match(miss.stdout, /no stored lesson/)

      assert.equal(f.run(ADD).code, 0)
      const hit = f.run(['probe', 'what happens after gh pr merge'])
      assert.equal(hit.code, 0, hit.stderr)
      assert.match(hit.stdout, /learn-after-gh-pr-merge\S*\t.*post-tool/)
    })
  })

  test('probe --lesson stores a source:probe lesson indexed by question terms', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      const r = f.run([
        'probe',
        'who holds the merge slot',
        '--lesson',
        'one PR merges at a time — bd merge-slot acquire holds it',
        '--session',
        'sess-e2e',
        '--budget',
        '3',
      ])
      assert.equal(r.code, 0, r.stderr)
      const id = r.stdout.trim()
      const lesson = JSON.parse(f.run(['show', id]).stdout) as Record<string, unknown>
      assert.equal(lesson.source, 'probe')
      assert.equal(lesson.confidence, 'tentative')
      assert.deepEqual(
        (lesson.evidence as Array<{ kind: string; ref: string }>).slice(0, 2),
        [
          { kind: 'session', ref: 'sess-e2e' },
          { kind: 'text', ref: 'who holds the merge slot' },
        ]
      )
      const trigger = lesson.trigger as {
        on: string[]
        match?: { terms?: string[] }
        budget?: number
      }
      assert.deepEqual(trigger.on, ['session-start', 'prompt-submit'])
      assert.ok(trigger.match?.terms?.includes('merge'))
      // --budget alone rides the question-term trigger, never event-only
      assert.equal(trigger.budget, 3)

      // the stored answer now short-circuits a repeat probe
      const again = f.run(['probe', 'who holds the merge slot'])
      assert.equal(again.code, 0, again.stderr)
      assert.match(again.stdout, new RegExp(id))
    })
  })

  test('probe requires a question and validates trigger flags like add', () => {
    const f = learnFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['probe']).code, 2)
      const r = f.run(['probe', 'q words here', '--lesson', 'x', '--on', 'bogus'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--on must be one of/)
      const badBool = f.run([
        'probe',
        'q words here',
        '--lesson',
        'x',
        '--match-errors=bogus',
      ])
      assert.equal(badBool.code, 2)
      assert.match(badBool.stderr, /--match-errors must be true\|false/)
      // phase-2 flags without --lesson are rejected, not dropped
      const stray = f.run(['probe', 'q words here', '--on', 'post-tool'])
      assert.equal(stray.code, 2)
      assert.match(stray.stderr, /--on records an answer — it needs --lesson/)
    })
  })

  test('capture --mol distills flagged learn: lines from step results', () => {
    const f = learnFixture(
      [
        {
          id: 'fx-s1',
          title: 'Implement the thing',
          status: 'closed',
          close_reason: 'PR open\nlearn: bro act merge refuses on a red gate',
        },
      ],
      {
        mols: {
          'fx-m1': {
            root: { id: 'fx-m1', status: 'closed' },
            issues: [
              { id: 'fx-m1', status: 'closed' },
              { id: 'fx-s1', status: 'closed' },
            ],
            dependencies: [],
          },
        },
      }
    )
    inside(f.main, f.root, () => {
      const r = f.run(['capture', '--mol', 'fx-m1'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /captured learn-\S+\s+capture:mol/)
      const lessons = JSON.parse(f.run(['list', '--json']).stdout) as Array<{
        lesson: string
      }>
      assert.equal(lessons[0]!.lesson, 'bro act merge refuses on a red gate')
    })
  })
})

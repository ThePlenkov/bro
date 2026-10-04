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

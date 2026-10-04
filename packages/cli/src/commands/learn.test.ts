/** `bro learn` e2e — the bd-kv lesson store through the built CLI.
 *  The shared fake bd plays `kv` against a JSON file (FAKE_BD_DB), so
 *  add → list → show → forget exercises the real spawn path with no
 *  live Dolt store. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { initRepo, inside, installFakeBd, runCli, type CliResult } from './testrepo.ts'

function learnFixture(): { root: string; main: string; run: (args: string[]) => CliResult } {
  const { root, main } = initRepo('bro-learn-e2e-')
  const { binDir, db } = installFakeBd(root, [])
  const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db }
  return { root, main, run: (args) => runCli(['learn', ...args], { cwd: main, env }) }
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
      const filtered = JSON.parse(
        f.run(['list', '--json', '--source', 'probe']).stdout
      ) as unknown[]
      assert.equal(filtered.length, 0)
    })
  })
})

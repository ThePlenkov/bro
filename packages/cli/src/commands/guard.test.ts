/** `bro guard` e2e — config defs resolve through the built CLI: `list`
 *  TSV/JSON + fail-closed malformed defs; `test` runs the engine
 *  read-only (exit 0 FIRE / 1 SKIP / 2 usage, fired set untouched). */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { initRepo, inside, installFakeBd, runCli } from './testrepo.ts'

function guardFixture(config?: Record<string, unknown>) {
  const { root, main } = initRepo('bro-guard-e2e-', (dir) => {
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ store: 'jsonl', ...config }, null, 2)
    )
  })
  const { binDir } = installFakeBd(root, [])
  const env = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
  return { root, main, run: (args: string[]) => runCli(['guard', ...args], { cwd: main, env }) }
}

const DEF = {
  name: 'tests-with-src',
  when: { on: ['stop'], state: { diff: { changed: ['src/**'], without: ['**/*.test.*'] } } },
  say: 'src/ changed without a test file',
}

describe('bro guard list', () => {
  test('lists config defs as TSV — name, source, events, budget, state', () => {
    const f = guardFixture({ guard: { defs: [DEF] } })
    inside(f.main, f.root, () => {
      const r = f.run(['list'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /^tests-with-src\tconfig\tstop\t1\tok$/m)
    })
  })

  test('--json emits the resolved rows', () => {
    const f = guardFixture({ guard: { defs: [DEF, { ...DEF, name: 'g2', when: { on: ['post-tool'], budget: 5 } }] } })
    inside(f.main, f.root, () => {
      const r = f.run(['list', '--json'])
      assert.equal(r.code, 0, r.stderr)
      const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>
      assert.deepEqual(
        rows.filter((x) => x.source === 'config').map((x) => [x.name, x.on, x.budget, x.state]),
        [
          ['tests-with-src', 'stop', 1, 'ok'],
          ['g2', 'post-tool', 5, 'ok'],
        ]
      )
    })
  })

  test('a malformed def warns on stderr and is absent from the rows', () => {
    const f = guardFixture({
      guard: { defs: [DEF, { name: 'broken def', when: { on: ['stop'] }, say: 'x' }] },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['list'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /'broken def'.*dropped/)
      assert.doesNotMatch(r.stdout, /broken def/)
      assert.match(r.stdout, /tests-with-src/)
    })
  })

  test('no config → builtins still ship via the guard connector', () => {
    const { root, main } = initRepo('bro-guard-e2e-empty-')
    const { binDir } = installFakeBd(root, [])
    inside(main, root, () => {
      const r = runCli(['guard', 'list'], {
        cwd: main,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /^test-coverage-on-stop\tguard\tstop\t1\tok$/m)
    })
  })

  test('a config def shadows the builtin of the same name — first wins', () => {
    const shadow = { name: 'test-coverage-on-stop', when: { on: ['post-tool'] }, say: 'mine' }
    const f = guardFixture({ guard: { defs: [DEF, shadow] } })
    inside(f.main, f.root, () => {
      const r = f.run(['list', '--json'])
      assert.equal(r.code, 0, r.stderr)
      const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>
      const hits = rows.filter((x) => x.name === 'test-coverage-on-stop')
      // the live row is the config shadow; the builtin shows as skipped
      assert.deepEqual(
        hits.map((x) => [x.source, x.state === 'ok' ? x.on : 'skipped']),
        [
          ['config', 'post-tool'],
          ['guard', 'skipped'],
        ]
      )
      assert.match(r.stderr, /guard 'test-coverage-on-stop' from guard duplicates an earlier declaration/)
    })
  })

  test('usage errors exit 2', () => {
    const f = guardFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['list', 'extra']).code, 2)
      assert.equal(f.run(['bogus']).code, 2)
    })
  })
})

describe('bro guard test', () => {
  test('FIRE exits 0 with per-clause verdicts and the rendered line', () => {
    const f = guardFixture({ guard: { defs: [DEF] } })
    inside(f.main, f.root, () => {
      mkdirSync(join(f.main, 'src'), { recursive: true })
      writeFileSync(join(f.main, 'src', 'a.ts'), 'x\n')
      const r = f.run(['test', 'tests-with-src'])
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /on\tok/)
      assert.match(r.stdout, /diff\.changed\tok/)
      assert.match(r.stdout, /diff\.without\tok/)
      assert.match(r.stdout, /budget\tok\t1\/1/)
      assert.match(r.stdout, /FIRE\nbro guard tests-with-src: src\/ changed without a test file/)
    })
  })

  test('SKIP exits 1 when a clause misses', () => {
    const f = guardFixture({ guard: { defs: [DEF] } })
    inside(f.main, f.root, () => {
      // clean tree — diff.changed misses
      const r = f.run(['test', 'tests-with-src'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stdout, /diff\.changed\tmiss/)
      assert.match(r.stdout, /SKIP/)
    })
  })

  test('test never writes the fired set — FIRE twice in a row', () => {
    const f = guardFixture({ guard: { defs: [DEF] } })
    inside(f.main, f.root, () => {
      mkdirSync(join(f.main, 'src'), { recursive: true })
      writeFileSync(join(f.main, 'src', 'a.ts'), 'x\n')
      assert.equal(f.run(['test', 'tests-with-src']).code, 0)
      assert.equal(f.run(['test', 'tests-with-src']).code, 0)
    })
  })

  test('unknown name exits 1; bad --event exits 2', () => {
    const f = guardFixture({ guard: { defs: [DEF] } })
    inside(f.main, f.root, () => {
      assert.equal(f.run(['test', 'nope']).code, 1)
      assert.equal(f.run(['test', 'tests-with-src', '--event', 'bogus']).code, 2)
    })
  })

  test('spec-drift probe — a stale spec fires through the real engine', () => {
    const DRIFT = {
      name: 'drift-nudge',
      when: {
        on: ['stop'],
        state: { probes: [{ name: 'spec-drift', args: { spec: 'specs/b1.md' } }] },
      },
      say: 'spec is stale',
    }
    const f = guardFixture({ guard: { defs: [DRIFT] } })
    inside(f.main, f.root, () => {
      // pinned dates: spec@T0 < scope'd code@T1 → STALE (same fixture
      // discipline as spec.test.ts's drift suite)
      const dated = (files: Record<string, string>, date: string): void => {
        for (const [p, c] of Object.entries(files)) {
          mkdirSync(dirname(join(f.main, p)), { recursive: true })
          writeFileSync(join(f.main, p), c)
        }
        execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: f.main })
        execFileSync('git', ['commit', '-qm', 'x'], {
          cwd: f.main,
          env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        })
      }
      dated({ 'specs/b1.md': '---\nscope:\n  - "src/**"\n---\n# spec\n' }, '2026-01-01T00:00:00Z')
      dated({ 'src/a.ts': 'x\n' }, '2026-01-02T00:00:00Z')
      const r = f.run(['test', 'drift-nudge'])
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /probe:spec-drift\tok\tSTALE/)
      assert.match(r.stdout, /FIRE\nbro guard drift-nudge: spec is stale/)
    })
  })

  test('unknown probe name fails the clause — the registry stays closed', () => {
    const BOGUS = {
      name: 'bog',
      when: { on: ['stop'], state: { probes: [{ name: 'telepathy' }] } },
      say: 'x',
    }
    const f = guardFixture({ guard: { defs: [BOGUS] } })
    inside(f.main, f.root, () => {
      const r = f.run(['test', 'bog'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stdout, /probe:telepathy\tmiss\tunknown probe/)
      assert.match(r.stdout, /SKIP/)
    })
  })
})

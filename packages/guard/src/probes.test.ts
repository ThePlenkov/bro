/** Per-probe fixtures for evalState/liveState — one clause shape per
 *  state key (spec bro-nkn6.6), including the failure modes a
 *  `bro guard test` row must make diagnosable. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { gitTry } from '@broject/core'
import { evalState, liveState } from './probes.ts'

function repo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-probes-'))
  assert.equal(gitTry(['-C', dir, 'init', '-b', branch]).code, 0)
  assert.equal(gitTry(['-C', dir, 'config', 'user.email', 't@t']).code, 0)
  assert.equal(gitTry(['-C', dir, 'config', 'user.name', 't']).code, 0)
  assert.equal(gitTry(['-C', dir, 'commit', '-qm', 'init', '--allow-empty']).code, 0)
  return dir
}

const dirty = (dir: string, rel: string): void => {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, 'x')
}

const verdict = (dir: string, state: Parameters<typeof evalState>[0], armed?: Set<string>) =>
  evalState(state, dir, liveState(dir, armed !== undefined ? () => armed : undefined))

describe('state probes', () => {
  test('diff.changed hits a dirty path and reports the matching glob', async () => {
    const dir = repo()
    dirty(dir, 'src/deep/a.ts')
    const [v] = await verdict(dir, { diff: { changed: ['src/**'] } })
    assert.equal(v!.clause, 'diff.changed')
    assert.equal(v!.ok, true)
    assert.equal(v!.detail, 'src/**')
  })

  test('diff.changed misses report every declared glob', async () => {
    const dir = repo()
    dirty(dir, 'docs/a.md')
    const [v] = await verdict(dir, { diff: { changed: ['src/**', 'lib/**'] } })
    assert.equal(v!.ok, false)
    assert.equal(v!.detail, 'no diff path hits src/** | lib/**')
  })

  test('a staged rename counts both names as touched', async () => {
    const dir = repo()
    dirty(dir, 'old.ts')
    assert.equal(gitTry(['-C', dir, 'add', 'old.ts']).code, 0)
    assert.equal(gitTry(['-C', dir, 'commit', '-qm', 'add']).code, 0)
    assert.equal(gitTry(['-C', dir, 'mv', 'old.ts', 'new.ts']).code, 0)
    // the old name going away IS a change — both sides hit
    const oldHit = await verdict(dir, { diff: { changed: ['old.ts'] } })
    const newHit = await verdict(dir, { diff: { changed: ['new.ts'] } })
    assert.equal(oldHit[0]!.ok, true)
    assert.equal(newHit[0]!.ok, true)
  })

  test('git status failing fails every declared diff clause', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-probes-norepo-'))
    const vs = await verdict(dir, { diff: { changed: ['src/**'], without: ['**/*.test.*'] } })
    assert.equal(vs.length, 2)
    for (const v of vs) {
      assert.equal(v.ok, false)
      assert.equal(v.detail, 'git status unavailable')
    }
  })

  test('diff.without hit is suppression, not a miss — detail names the glob', async () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    dirty(dir, 'src/a.test.ts')
    const [v] = await verdict(dir, { diff: { without: ['**/*.test.*'] } })
    assert.equal(v!.ok, false)
    assert.match(v!.detail!, /diff touches \*\*\/\*\.test\.\*/)
  })

  test('branch hit on a matching glob; mismatch reports the actual branch', async () => {
    const dir = repo('feat/x')
    const hit = await verdict(dir, { branch: 'feat/*' })
    assert.equal(hit[0]!.ok, true)
    const miss = await verdict(dir, { branch: 'main' })
    assert.equal(miss[0]!.ok, false)
    assert.equal(miss[0]!.detail, 'feat/x')
  })

  test('detached HEAD reads as no branch', async () => {
    const dir = repo()
    const sha = gitTry(['-C', dir, 'rev-parse', 'HEAD']).out.trim()
    assert.equal(gitTry(['-C', dir, 'checkout', '-q', sha]).code, 0)
    const [v] = await verdict(dir, { branch: 'main' })
    assert.equal(v!.ok, false)
    assert.equal(v!.detail, 'no branch (detached?)')
  })

  test('armed lists the aspects still missing', async () => {
    const dir = repo()
    const vs = await verdict(dir, { armed: ['act', 'work'] }, new Set(['act']))
    assert.equal(vs[0]!.ok, false)
    assert.equal(vs[0]!.detail, 'not armed: work')
  })

  test('exists lists every missing path', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'present'), 'x')
    const vs = await verdict(dir, { exists: ['present', 'gone-a', 'gone-b'] })
    assert.equal(vs[0]!.ok, false)
    assert.equal(vs[0]!.detail, 'missing: gone-a,gone-b')
  })

  test('a throwing named probe fails its clause with the error as detail', async () => {
    const dir = repo()
    const vs = await evalState({ probes: [{ name: 'boom' }] }, dir, liveState(dir), {
      boom: () => {
        throw new Error('kaboom')
      },
    })
    assert.equal(vs[0]!.clause, 'probe:boom')
    assert.equal(vs[0]!.ok, false)
    assert.equal(vs[0]!.detail, 'threw: kaboom')
  })

  test('a rejecting async probe fails its clause the same way', async () => {
    const dir = repo()
    const vs = await evalState({ probes: [{ name: 'boom' }] }, dir, liveState(dir), {
      boom: async () => {
        throw new Error('kaboom-async')
      },
    })
    assert.equal(vs[0]!.ok, false)
    assert.equal(vs[0]!.detail, 'threw: kaboom-async')
  })

  test('named probes run in parallel — a pending probe does not serialize the next', async () => {
    const dir = repo()
    let bRan = false
    const vs = await evalState({ probes: [{ name: 'a' }, { name: 'b' }] }, dir, liveState(dir), {
      // resolves only once b has been invoked — a serial sweep would
      // exhaust the spin and answer false; passing proves the overlap
      a: async () => {
        for (let i = 0; i < 1000 && !bRan; i++) {
          await new Promise((r) => setImmediate(r))
        }
        return bRan
      },
      b: async () => {
        bRan = true
        return true
      },
    })
    // declaration order survives the out-of-order completion
    assert.deepEqual(
      vs.map((v) => [v.clause, v.ok]),
      [
        ['probe:a', true],
        ['probe:b', true],
      ]
    )
  })

  test('liveState memoizes — one git status serves repeated clause reads', () => {
    const dir = repo()
    dirty(dir, 'src/a.ts')
    const live = liveState(dir)
    // a second diffPaths() call returns the same array instance —
    // N guards share one porcelain call per event
    assert.equal(live.diffPaths(), live.diffPaths())
    assert.equal(live.branch(), live.branch())
  })
})

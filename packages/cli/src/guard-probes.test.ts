/** `spec-drift` named probe — the cli-registered end of bro-nkn6.5.
 *  Pinned author+committer dates make staleness deterministic, same as
 *  commands/spec.test.ts's drift fixtures (spec@T0 < scope@T1 → STALE;
 *  spec recommitted at T2 → fresh). */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerConnector } from '@broject/core'
import { GUARD_PROBES } from './guard-probes.ts'
import { SPEC_CONNECTORS } from './spec-connectors.ts'
import { initRepo, inside, installFakeBd } from './commands/testrepo.ts'

// the probe resolves the specs facade through the registry — unit
// tests must register what the CLI entrypoint would
for (const c of SPEC_CONNECTORS) {
  registerConnector(c)
}

const T0 = '2026-01-01T00:00:00Z'
const T1 = '2026-01-02T00:00:00Z'
const T2 = '2026-01-03T00:00:00Z'

const commit = (dir: string, subject: string, files: Record<string, string>, date: string): void => {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), content)
  }
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_INDEX_FILE: _i,
    GIT_COMMON_DIR: _c,
    ...env
  } = process.env
  execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir, env })
  execFileSync('git', ['commit', '-qm', subject], {
    cwd: dir,
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
}

const SCOPED_SPEC = '---\nscope:\n  - "src/**"\n---\n# spec\n'
const probe = GUARD_PROBES['spec-drift']!

/** initRepo + spec@T0; `fn` runs inside with the main dir. */
const withSpecRepo = (fn: (main: string) => void): void => {
  const { root, main } = initRepo('bro-probe-', (dir) => {
    commit(dir, 'spec lands', { 'specs/b1.md': SCOPED_SPEC }, T0)
  })
  inside(main, root, () => fn(main))
}

describe('spec-drift probe — args.spec (bead-free)', () => {
  test('STALE when scoped code landed after the spec', () => {
    withSpecRepo((main) => {
      commit(main, 'code moved on', { 'src/a.ts': 'x\n' }, T1)
      const r = probe({ spec: 'specs/b1.md' }, main)
      assert.equal(typeof r === 'boolean' ? r : r.ok, true)
      assert.match(typeof r === 'boolean' ? '' : (r.detail ?? ''), /^STALE/)
    })
  })

  test('fresh when the spec landed after the code', () => {
    withSpecRepo((main) => {
      commit(main, 'code moved on', { 'src/a.ts': 'x\n' }, T1)
      commit(main, 'spec catches up', { 'specs/b1.md': `${SCOPED_SPEC}more\n` }, T2)
      const r = probe({ spec: 'specs/b1.md' }, main)
      assert.equal(typeof r === 'boolean' ? r : r.ok, false)
      assert.match(typeof r === 'boolean' ? '' : (r.detail ?? ''), /^fresh/)
    })
  })

  test('usage + safety: no args / missing file / escape fail closed', () => {
    withSpecRepo((main) => {
      for (const args of [
        undefined,
        {},
        { spec: 'specs/missing.md' },
        { spec: '../outside.md' },
        { spec: 'https://example.com/x.md' },
        { spec: 'specs' }, // a dir, not a file — drift must not date it
      ]) {
        const r = probe(args, main)
        assert.equal(typeof r === 'boolean' ? r : r.ok, false, JSON.stringify(args))
      }
    })
  })
})

describe('spec-drift probe — args.id (bead-backed)', () => {
  test('STALE via the bead\u2019s spec: link; unknown bead fails closed', () => {
    const { root, main } = initRepo('bro-probe-id-', (dir) => {
      commit(dir, 'spec lands', { 'specs/b1.md': SCOPED_SPEC }, T0)
      commit(dir, 'code moved on', { 'src/a.ts': 'x\n' }, T1)
    })
    const { binDir, db } = installFakeBd(root, [
      { id: 'b1', status: 'open', title: 't', issue_type: 'task', description: 'see spec: specs/b1.md' },
    ])
    const prev = { PATH: process.env.PATH, DB: process.env.FAKE_BD_DB }
    process.env.PATH = `${binDir}:${prev.PATH ?? ''}`
    process.env.FAKE_BD_DB = db
    try {
      inside(main, root, () => {
        const r = probe({ id: 'b1' }, main)
        assert.equal(typeof r === 'boolean' ? r : r.ok, true)
        const miss = probe({ id: 'ghost' }, main)
        assert.equal(typeof miss === 'boolean' ? miss : miss.ok, false)
        // fake bd's show-miss doesn't speak the real not-found phrase —
        // the probe reports the read failure, still failing closed
        assert.match(typeof miss === 'boolean' ? '' : (miss.detail ?? ''), /ghost/)
      })
    } finally {
      process.env.PATH = prev.PATH
      if (prev.DB === undefined) delete process.env.FAKE_BD_DB
      else process.env.FAKE_BD_DB = prev.DB
    }
  })

  test('a declared spec: with no local file fails closed — no tree-pick substitution', () => {
    const { root, main } = initRepo('bro-probe-id-', (dir) => {
      // both tree specs are stale under the audit — b1's broken link
      // must still NOT inherit b1's tree spec verdict
      commit(dir, 'specs land', { 'specs/b1.md': SCOPED_SPEC, 'specs/b2.md': SCOPED_SPEC }, T0)
      commit(dir, 'code moved on', { 'src/a.ts': 'x\n' }, T1)
    })
    const { binDir, db } = installFakeBd(root, [
      { id: 'b1', status: 'open', title: 't', issue_type: 'task', description: 'see spec: specs/missing.md' },
      { id: 'b2', status: 'open', title: 't', issue_type: 'task', description: 'no link declared' },
    ])
    const prev = { PATH: process.env.PATH, DB: process.env.FAKE_BD_DB }
    process.env.PATH = `${binDir}:${prev.PATH ?? ''}`
    process.env.FAKE_BD_DB = db
    try {
      inside(main, root, () => {
        const broken = probe({ id: 'b1' }, main)
        assert.equal(typeof broken === 'boolean' ? broken : broken.ok, false)
        assert.match(typeof broken === 'boolean' ? '' : (broken.detail ?? ''), /no local spec file/)
        // undeclared beads keep the tree pick — b2's spec is STALE
        const picked = probe({ id: 'b2' }, main)
        assert.equal(typeof picked === 'boolean' ? picked : picked.ok, true)
      })
    } finally {
      process.env.PATH = prev.PATH
      if (prev.DB === undefined) delete process.env.FAKE_BD_DB
      else process.env.FAKE_BD_DB = prev.DB
    }
  })
})

describe('core-vendor probe', () => {
  const vendorProbe = GUARD_PROBES['core-vendor']!

  const withTree = (
    files: Record<string, string>,
    fn: (dir: string) => void
  ): void => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-vendor-probe-'))
    try {
      for (const [p, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true })
        writeFileSync(join(dir, p), content)
      }
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('fires on a vendor token in shipped source, with file:line detail', () => {
    withTree({ 'src/x.ts': 'const cli = "devin"\n' }, (dir) => {
      const r = vendorProbe({ path: 'src', terms: ['devin'] }, dir)
      assert.equal(typeof r === 'boolean' ? r : r.ok, true)
      assert.match(typeof r === 'boolean' ? '' : (r.detail ?? ''), /src\/x\.ts:1 devin/)
    })
  })

  test('clean source, word-boundaries, and test fixtures all miss', () => {
    withTree(
      {
        // 'devinfra' contains but is NOT 'devin'; fixtures name vendors
        // as data — the boundary lives in shipped source only
        'src/a.ts': 'const name = "devinfra"\n',
        'src/a.test.ts': 'const cmd = "devin -p"\n',
      },
      (dir) => {
        for (const args of [
          { path: 'src', terms: ['devin', 'tmux'] },
          { path: 'src' }, // no terms — unusable probe must not assert
          { path: 'src', terms: [] },
          { path: 'src', terms: [''], },
        ]) {
          const r = vendorProbe(args, dir)
          assert.equal(typeof r === 'boolean' ? r : r.ok, false, JSON.stringify(args))
        }
      }
    )
  })

  test('an unscanable path fails closed — no assertion without a scan', () => {
    withTree({}, (dir) => {
      const r = vendorProbe({ path: 'does/not/exist', terms: ['devin'] }, dir)
      assert.equal(typeof r === 'boolean' ? r : r.ok, false)
      assert.match(typeof r === 'boolean' ? '' : (r.detail ?? ''), /scan failed/)
    })
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerConnector, specStore, type SpecStore } from '@broject/core'
import { pickSpecPath, resolveScope } from './spec-drift.ts'
import { SPEC_CONNECTORS } from './spec-connectors.ts'
import { git, initRepo, inside } from './commands/testrepo.ts'

for (const c of SPEC_CONNECTORS) {
  registerConnector(c)
}

const seedSpec = (m: string, id: string, frontmatter: string): void => {
  mkdirSync(join(m, 'specs'), { recursive: true })
  writeFileSync(join(m, 'specs', `${id}.md`), `${frontmatter}# ${id}\n`)
}

describe('native scope() — the tool\u2019s explicit scope', () => {
  test('frontmatter list, scalar, and flow list all parse', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '---\nscope:\n  - src/**\n  - "docs/x.md"\n---\n')
      seedSpec(m, 'b2', '---\nscope: src/one.ts\n---\n')
      seedSpec(m, 'b3', '---\nscope: [a.ts, b.ts]\n---\n')
    })
    inside(main, root, () => {
      const spec = specStore(main)
      assert.deepEqual(spec.scope?.('b1'), ['src/**', 'docs/x.md'])
      assert.deepEqual(spec.scope?.('b2'), ['src/one.ts'])
      assert.deepEqual(spec.scope?.('b3'), ['a.ts', 'b.ts'])
    })
  })

  test('no frontmatter scope and no spec both return null', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '# plain spec — ' /* no frontmatter */)
      seedSpec(m, 'b2', '---\nscope:\n---\n')
    })
    inside(main, root, () => {
      const spec = specStore(main)
      assert.equal(spec.scope?.('b1'), null)
      assert.equal(spec.scope?.('b2'), null)
      assert.equal(spec.scope?.('b9'), null)
    })
  })
})

describe('pickSpecPath', () => {
  test('non-empty beats scaffold, dir spec beats flat', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      mkdirSync(join(m, 'specs', 'b1'), { recursive: true })
      writeFileSync(join(m, 'specs', 'b1.md'), '# flat\n')
      writeFileSync(join(m, 'specs', 'b1', 'spec.md'), '# dir spec\n')
      writeFileSync(join(m, 'specs', 'b2.md'), '  \n')
      mkdirSync(join(m, 'specs', 'b2-flat'), { recursive: true })
      writeFileSync(join(m, 'specs', 'b2-flat', 'x.md'), '# non-empty loses? no — different id\n')
    })
    inside(main, root, () => {
      const nodes = specStore(main).tree()
      assert.equal(pickSpecPath(main, nodes, 'b1'), join('specs', 'b1', 'spec.md'))
      assert.equal(pickSpecPath(main, nodes, 'b2'), join('specs', 'b2.md'))
      assert.equal(pickSpecPath(main, nodes, 'b9'), undefined)
    })
  })
})

describe('resolveScope', () => {
  test('frontmatter scope wins over bead-id commits; spec path excluded', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '---\nscope:\n  - src/**\n---\n')
      mkdirSync(join(m, 'src'))
      writeFileSync(join(m, 'src', 'a.ts'), 'x\n')
    })
    inside(main, root, () => {
      writeFileSync(join(main, 'src', 'b.ts'), 'y\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'feat: more (b1)'], main)
      assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), {
        state: 'scoped',
        via: 'frontmatter',
        pathspecs: ['src/**', ':(exclude)specs/b1.md'],
      })
    })
  })

  test('an absolute or ../ entry is unverifiable — never widened', () => {
    for (const entry of ['../outside', '/abs/path', 'a/../../b']) {
      const { root, main } = initRepo('bro-drift-', (m) => {
        seedSpec(m, 'b1', `---\nscope:\n  - ${entry}\n---\n`)
      })
      inside(main, root, () => {
        const r = resolveScope(main, 'HEAD', 'b1', specStore(main))
        assert.equal(r.state, 'unverifiable', entry)
        assert.match(r.state === 'unverifiable' ? r.reason : '', /bad scope path/)
      })
    }
  })

  test('an explicit scope matching zero committed paths is unverifiable', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '---\nscope:\n  - nope/**\n---\n')
    })
    inside(main, root, () => {
      const r = resolveScope(main, 'HEAD', 'b1', specStore(main))
      assert.deepEqual(r, { state: 'unverifiable', reason: 'scope matches nothing' })
    })
  })

  test('bead-id commits resolve the scope union — subject only, exact id', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '')
      mkdirSync(join(m, 'src'))
      writeFileSync(join(m, 'src', 'a.ts'), 'x\n')
    })
    inside(main, root, () => {
      writeFileSync(join(main, 'src', 'b.ts'), 'y\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'feat: the thing (b1) (#7)'], main)
      // b10 must not satisfy b1, and a bare "b1" without parens neither
      writeFileSync(join(main, 'src', 'c.ts'), 'z\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'feat: sibling (b10)'], main)
      writeFileSync(join(main, 'src', 'd.ts'), 'w\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'fix: mention b1 without parens'], main)
      assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), {
        state: 'scoped',
        via: 'commits',
        pathspecs: ['src/b.ts', ':(exclude)specs/b1.md'],
      })
    })
  })

  test('multiple bead commits union their touched paths', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '')
    })
    inside(main, root, () => {
      writeFileSync(join(main, 'a.ts'), 'a\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'one (b1)'], main)
      writeFileSync(join(main, 'b.ts'), 'b\n')
      writeFileSync(join(main, 'a.ts'), 'a2\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'two (b1)'], main)
      const r = resolveScope(main, 'HEAD', 'b1', specStore(main))
      if (r.state !== 'scoped') {
        assert.fail(`expected scoped, got ${JSON.stringify(r)}`)
      }
      assert.equal(r.via, 'commits')
      assert.deepEqual(new Set(r.pathspecs), new Set(['a.ts', 'b.ts', ':(exclude)specs/b1.md']))
    })
  })

  test('no frontmatter, no bead commits → no-scope', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '')
    })
    inside(main, root, () => {
      assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), { state: 'no-scope' })
    })
  })

  test('a bad ref is unverifiable, not a throw', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      seedSpec(m, 'b1', '')
    })
    inside(main, root, () => {
      const r = resolveScope(main, 'nonexistent-ref', 'b1', specStore(main))
      assert.equal(r.state, 'unverifiable')
    })
  })

  test('a connector without scope() falls through to commit-refs', () => {
    const { root, main } = initRepo('bro-drift-', (m) => {
      mkdirSync(join(m, 'specs'))
      writeFileSync(join(m, 'specs', 'b1.md'), '# b1\n')
    })
    inside(main, root, () => {
      writeFileSync(join(main, 'x.ts'), 'x\n')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'work (b1)'], main)
      const scopeless: SpecStore = {
        hasSpec: () => true,
        remedy: () => '',
        policy: () => '',
        tree: () => [{ id: 'b1', path: 'specs/b1.md' }],
      }
      assert.deepEqual(resolveScope(main, 'HEAD', 'b1', scopeless), {
        state: 'scoped',
        via: 'commits',
        pathspecs: ['x.ts', ':(exclude)specs/b1.md'],
      })
    })
  })
})

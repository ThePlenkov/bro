import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** initRepo + inside in one call — the fixture shape every case needs. */
const withRepo = (seed: (m: string) => void, fn: (main: string) => void): void => {
  const { root, main } = initRepo('bro-drift-', seed)
  inside(main, root, () => fn(main))
}

/** Stage `files` and commit with `subject` — bead-id commits carry the
 *  `(<id>)` marker in the subject. */
const commit = (main: string, subject: string, files: Record<string, string>): void => {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(main, p)), { recursive: true })
    writeFileSync(join(main, p), content)
  }
  git(['add', '-A'], main)
  git(['commit', '-qm', subject], main)
}

describe('native scope() — the tool\u2019s explicit scope', () => {
  test('frontmatter list, scalar, and flow list all parse', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '---\nscope:\n  - src/**\n  - "docs/x.md"\n---\n')
        seedSpec(m, 'b2', '---\nscope: src/one.ts\n---\n')
        seedSpec(m, 'b3', '---\nscope: [a.ts, b.ts]\n---\n')
      },
      (main) => {
        const spec = specStore(main)
        assert.deepEqual(spec.scope?.('b1'), ['src/**', 'docs/x.md'])
        assert.deepEqual(spec.scope?.('b2'), ['src/one.ts'])
        assert.deepEqual(spec.scope?.('b3'), ['a.ts', 'b.ts'])
      }
    )
  })

  test('quoted commas stay inside one entry; bare comments drop', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '---\nscope: ["a,b.ts", c.ts]\n---\n')
        seedSpec(m, 'b2', '---\nscope: src/x.ts # the main file\n---\n')
      },
      (main) => {
        const spec = specStore(main)
        assert.deepEqual(spec.scope?.('b1'), ['a,b.ts', 'c.ts'])
        assert.deepEqual(spec.scope?.('b2'), ['src/x.ts'])
      }
    )
  })

  test('no frontmatter scope and no spec both return null', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '# plain spec — ' /* no frontmatter */)
        seedSpec(m, 'b2', '---\nscope:\n---\n')
      },
      (main) => {
        const spec = specStore(main)
        assert.equal(spec.scope?.('b1'), null)
        assert.equal(spec.scope?.('b2'), null)
        assert.equal(spec.scope?.('b9'), null)
      }
    )
  })
})

describe('pickSpecPath', () => {
  test('non-empty beats scaffold, dir spec beats flat', () => {
    withRepo(
      (m) => {
        mkdirSync(join(m, 'specs', 'b1'), { recursive: true })
        writeFileSync(join(m, 'specs', 'b1.md'), '# flat\n')
        writeFileSync(join(m, 'specs', 'b1', 'spec.md'), '# dir spec\n')
        writeFileSync(join(m, 'specs', 'b2.md'), '  \n')
      },
      (main) => {
        const nodes = specStore(main).tree()
        assert.equal(pickSpecPath(main, nodes, 'b1'), join('specs', 'b1', 'spec.md'))
        assert.equal(pickSpecPath(main, nodes, 'b2'), join('specs', 'b2.md'))
        assert.equal(pickSpecPath(main, nodes, 'b9'), undefined)
      }
    )
  })

  test('duplicate same-id flat specs pick the same path scope() reads', () => {
    withRepo(
      (m) => {
        // two flat b1 specs: a root file and a child of dir spec x — the
        // kind of hand-created collision preferSpec must pick one way
        mkdirSync(join(m, 'specs', 'x'), { recursive: true })
        writeFileSync(join(m, 'specs', 'x', 'spec.md'), '# x\n')
        writeFileSync(join(m, 'specs', 'x', 'b1.md'), '---\nscope: docs/**\n---\n# nested b1\n')
        writeFileSync(join(m, 'specs', 'b1.md'), '---\nscope: src/**\n---\n# root b1\n')
        mkdirSync(join(m, 'src'))
        writeFileSync(join(m, 'src', 'a.ts'), 'x\n')
      },
      (main) => {
        const nodes = specStore(main).tree()
        const picked = pickSpecPath(main, nodes, 'b1')
        // one deterministic pick for both sides — the excluded path must
        // be the file scope() actually read
        const r = resolveScope(main, 'HEAD', 'b1', specStore(main))
        if (r.state !== 'scoped') {
          assert.fail(`expected scoped, got ${JSON.stringify(r)}`)
        }
        assert.deepEqual(r.pathspecs, ['src/**', `:(exclude,literal)${picked}`])
      }
    )
  })
})

describe('resolveScope', () => {
  test('frontmatter scope wins over bead-id commits; spec path excluded', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '---\nscope:\n  - src/**\n---\n')
        mkdirSync(join(m, 'src'))
        writeFileSync(join(m, 'src', 'a.ts'), 'x\n')
      },
      (main) => {
        commit(main, 'feat: more (b1)', { 'src/b.ts': 'y\n' })
        assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), {
          state: 'scoped',
          via: 'frontmatter',
          pathspecs: ['src/**', ':(exclude,literal)specs/b1.md'],
        })
      }
    )
  })

  test('an absolute or ../ entry is unverifiable — never widened', () => {
    for (const entry of ['../outside', '/abs/path', 'a/../../b']) {
      withRepo(
        (m) => {
          seedSpec(m, 'b1', `---\nscope:\n  - ${entry}\n---\n`)
        },
        (main) => {
          const r = resolveScope(main, 'HEAD', 'b1', specStore(main))
          assert.equal(r.state, 'unverifiable', entry)
          assert.match(r.state === 'unverifiable' ? r.reason : '', /bad scope path/)
        }
      )
    }
  })

  test('an exclusion-only scope is unverifiable — it would match the repo', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '---\nscope:\n  - ":(exclude)docs"\n---\n')
        seedSpec(m, 'b2', '---\nscope:\n  - ":^docs"\n---\n')
        mkdirSync(join(m, 'docs'))
        writeFileSync(join(m, 'docs', 'a.md'), 'x\n')
      },
      (main) => {
        for (const id of ['b1', 'b2']) {
          const r = resolveScope(main, 'HEAD', id, specStore(main))
          assert.equal(r.state, 'unverifiable', id)
          assert.match(r.state === 'unverifiable' ? r.reason : '', /exclusion-only/)
        }
      }
    )
  })

  test('an explicit scope matching zero committed paths is unverifiable', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '---\nscope:\n  - nope/**\n---\n')
      },
      (main) => {
        assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), {
          state: 'unverifiable',
          reason: 'scope matches nothing',
        })
      }
    )
  })

  test('bead-id commits resolve the scope union — subject only, exact id', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '')
        mkdirSync(join(m, 'src'))
        writeFileSync(join(m, 'src', 'a.ts'), 'x\n')
      },
      (main) => {
        commit(main, 'feat: the thing (b1) (#7)', { 'src/b.ts': 'y\n' })
        // b10 must not satisfy b1, and a bare "b1" without parens neither
        commit(main, 'feat: sibling (b10)', { 'src/c.ts': 'z\n' })
        commit(main, 'fix: mention b1 without parens', { 'src/d.ts': 'w\n' })
        assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), {
          state: 'scoped',
          via: 'commits',
          pathspecs: [':(literal)src/b.ts', ':(exclude,literal)specs/b1.md'],
        })
      }
    )
  })

  test('multiple bead commits union their touched paths — as literals', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '')
      },
      (main) => {
        commit(main, 'one (b1)', { 'a.ts': 'a\n' })
        commit(main, 'two (b1)', { 'b.ts': 'b\n', 'a.ts': 'a2\n' })
        const r = resolveScope(main, 'HEAD', 'b1', specStore(main))
        if (r.state !== 'scoped') {
          assert.fail(`expected scoped, got ${JSON.stringify(r)}`)
        }
        assert.equal(r.via, 'commits')
        assert.deepEqual(
          new Set(r.pathspecs),
          new Set([':(literal)a.ts', ':(literal)b.ts', ':(exclude,literal)specs/b1.md'])
        )
      }
    )
  })

  test('no frontmatter, no bead commits → no-scope', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '')
      },
      (main) => {
        assert.deepEqual(resolveScope(main, 'HEAD', 'b1', specStore(main)), { state: 'no-scope' })
      }
    )
  })

  test('a bad ref is unverifiable, not a throw', () => {
    withRepo(
      (m) => {
        seedSpec(m, 'b1', '')
      },
      (main) => {
        assert.equal(resolveScope(main, 'nonexistent-ref', 'b1', specStore(main)).state, 'unverifiable')
      }
    )
  })

  test('a connector without scope() falls through to commit-refs', () => {
    withRepo(
      (m) => {
        mkdirSync(join(m, 'specs'))
        writeFileSync(join(m, 'specs', 'b1.md'), '# b1\n')
      },
      (main) => {
        commit(main, 'work (b1)', { 'x.ts': 'x\n' })
        const scopeless: SpecStore = {
          hasSpec: () => true,
          remedy: () => '',
          policy: () => '',
          tree: () => [{ id: 'b1', path: 'specs/b1.md' }],
        }
        assert.deepEqual(resolveScope(main, 'HEAD', 'b1', scopeless), {
          state: 'scoped',
          via: 'commits',
          pathspecs: [':(literal)x.ts', ':(exclude,literal)specs/b1.md'],
        })
      }
    )
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sddConnector, specState } from './spec.ts'
import { hasSpecFile, SPEC_CONNECTORS } from '../spec-connectors.ts'
import { loadConfig, registerConnector, specStore } from '@broject/core'
import type { ConnectorCtx, SpecStore, TaskRow, TaskStore } from '@broject/core'

for (const c of SPEC_CONNECTORS) {
  registerConnector(c)
}

/** Native-shaped facade pinned to an explicit spec dir — the specState
 *  unit tests need to aim hasSpec at dirs config never produces. */
const nativeAt = (dir: string, specDir: string): SpecStore => ({
  hasSpec: (id) => hasSpecFile(dir, specDir, id),
  remedy: () => '',
  policy: () => '',
  tree: () => [],
})

/** Scripted bd — `list` cats $FAKE_BD_LIST_FILE (written by withRepo),
 *  `show`/`config` keep taskStore happy. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  list) cat "$FAKE_BD_LIST_FILE" ;;
  show) echo '[{"id":"b1","status":"in_progress","title":"thing"}]' ;;
  config) echo 'issue_prefix = bro' ;;
  *) : ;;
esac
`

/** Tmp git repo + fake bd on PATH + bro.config.json; fn gets the dir.
 *  Claim markers are written into .git/bro/hooks/<session>.task. */
function withRepo(
  opts: { config?: object; claims?: string[]; list?: string },
  fn: (dir: string) => void | Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-spec-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(dir, 'list.json'),
    opts.list ??
      '[{"id":"b1","status":"in_progress","title":"thing","issue_type":"task"}]'
  )
  writeFileSync(join(bin, 'bd'), FAKE_BD)
  chmodSync(join(bin, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevList = process.env.FAKE_BD_LIST_FILE
  const prevActor = process.env.BEADS_ACTOR
  const run = async (): Promise<void> => {
    execFileSync('git', ['init', '-q', dir])
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify(opts.config ?? { sdd: { mode: 'gate' } })
    )
    if (opts.claims !== undefined) {
      const hooks = join(dir, '.git', 'bro', 'hooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(
        join(hooks, 's1.task'),
        ['2026-01-01T00:00:00Z', ...opts.claims].join('\n')
      )
    }
    process.env.PATH = `${bin}:${prevPath}`
    process.env.FAKE_BD_LIST_FILE = join(dir, 'list.json')
    // pin the claim-ownership identity — git user.name is not hermetic
    process.env.BEADS_ACTOR = 'test-agent'
    await fn(dir)
  }
  return run().finally(() => {
    process.env.PATH = prevPath
    if (prevList === undefined) delete process.env.FAKE_BD_LIST_FILE
    else process.env.FAKE_BD_LIST_FILE = prevList
    if (prevActor === undefined) delete process.env.BEADS_ACTOR
    else process.env.BEADS_ACTOR = prevActor
    rmSync(dir, { recursive: true, force: true })
  })
}

const ctx = (dir: string): ConnectorCtx => ({ dir, sessionId: 's1' })

describe('specState', () => {
  const row = (over: object = {}) => ({ id: 'b1', title: 't', ...over })

  test('missing by default; file/link/exempt win', async () => {
    await withRepo({ config: {} }, (dir) => {
      assert.equal(specState(row(), nativeAt(dir, 'specs')), 'missing')
      // spec: link in the description counts
      assert.equal(
        specState(row({ description: 'design: spec: docs/x.md' }), nativeAt(dir, 'specs')),
        'link'
      )
      // chores and trivial-labeled beads are exempt
      assert.equal(specState(row({ issue_type: 'chore' }), nativeAt(dir, 'specs')), 'exempt')
      assert.equal(specState(row({ labels: ['trivial'] }), nativeAt(dir, 'specs')), 'exempt')
      // an empty scaffold does not satisfy the rule
      mkdirSync(join(dir, 'specs'))
      writeFileSync(join(dir, 'specs', 'b1.md'), '  \n')
      assert.equal(specState(row(), nativeAt(dir, 'specs')), 'missing')
      writeFileSync(join(dir, 'specs', 'b1.md'), '# spec\n')
      assert.equal(specState(row(), nativeAt(dir, 'specs')), 'spec')
      // path-traversal ids never count as having a spec file
      assert.equal(specState(row({ id: '../outside' }), nativeAt(dir, 'specs')), 'missing')
      assert.equal(specState(row({ id: 'a/../b' }), nativeAt(dir, 'specs')), 'missing')
      // an escaping sdd.dir fails open to 'missing' too
      assert.equal(specState(row(), nativeAt(dir, '../outside')), 'missing')
      assert.equal(specState(row(), nativeAt(dir, '/tmp')), 'missing')
    })
  })
})

describe('sddConnector', () => {
  const probe = (dir: string) => sddConnector.hooks!(ctx(dir))!

  test('mode off emits nothing', async () => {
    await withRepo({ config: { sdd: { mode: 'off' } }, claims: ['b1'] }, async (dir) => {
      const h = probe(dir)
      assert.deepEqual(await h.sessionStart!(ctx(dir)), [])
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })

  test('remind: policy line at session start, no claims → no nudge', async () => {
    await withRepo({ config: { sdd: { mode: 'remind' } } }, async (dir) => {
      const h = probe(dir)
      const start = await h.sessionStart!(ctx(dir))
      assert.equal(start.length, 1)
      assert.match(start[0]!, /SDD \(remind\).*spec before code/)
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })

  test('gate: own claim without spec blocks under aspect task', async () => {
    await withRepo({ claims: ['b1'] }, async (dir) => {
      const h = probe(dir)
      const gate = await h.stopGate!(ctx(dir))
      assert.equal(gate.length, 1)
      assert.equal(gate[0]!.aspect, 'task')
      assert.match(gate[0]!.block ?? '', /b1 thing/)
      assert.match((await h.promptSubmit!(ctx(dir), 'p'))[0] ?? '', /b1 thing/)
      assert.match((await h.sessionStart!(ctx(dir))).join('\n'), /spec missing: b1/)
    })
  })

  test('own claim with a spec file never blocks', async () => {
    await withRepo({ claims: ['b1'] }, async (dir) => {
      mkdirSync(join(dir, 'specs'))
      writeFileSync(join(dir, 'specs', 'b1.md'), '# spec\n')
      const h = probe(dir)
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })

  test('foreign claims never block this session', async () => {
    await withRepo({ claims: ['other-bead'] }, async (dir) => {
      const h = probe(dir)
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
    })
  })

  test('a marker claim held by another actor is foreign — never nudged', async () => {
    // `bro work enter b1` armed the marker but the claim was refused —
    // the store says other-agent holds it, so it is not ours to spec
    await withRepo(
      {
        claims: ['b1'],
        list: '[{"id":"b1","status":"in_progress","title":"held","issue_type":"task","assignee":"other-agent"}]',
      },
      async (dir) => {
        const h = probe(dir)
        assert.deepEqual(await h.stopGate!(ctx(dir)), [])
        assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
        const start = await h.sessionStart!(ctx(dir))
        assert.equal(start.filter((l) => l.includes('spec missing')).length, 0)
      }
    )
  })

  test('a marker claim whose assignee matches still counts as own', async () => {
    await withRepo(
      {
        claims: ['b1'],
        list: '[{"id":"b1","status":"in_progress","title":"thing","issue_type":"task","assignee":"test-agent"}]',
      },
      async (dir) => {
        const gate = await probe(dir).stopGate!(ctx(dir))
        assert.equal(gate.length, 1)
        assert.match(gate[0]!.block ?? '', /b1 thing/)
      }
    )
  })

  test('remind mode reports missing specs as passive, not block', async () => {
    await withRepo({ config: { sdd: { mode: 'remind' } }, claims: ['b1'] }, async (dir) => {
      const gate = await probe(dir).stopGate!(ctx(dir))
      assert.equal(gate.length, 1)
      assert.equal(gate[0]!.block, undefined)
      assert.match(gate[0]!.passive ?? '', /remind mode/)
    })
  })

  test('a dead task store fails open — policy line still emitted', async () => {
    await withRepo({ claims: ['b1'], list: 'not-json' }, async (dir) => {
      const h = probe(dir)
      assert.match((await h.sessionStart!(ctx(dir)))[0] ?? '', /SDD \(gate\)/)
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })
})

describe('sddConnector under a non-beads tasks connector', () => {
  const probe = (dir: string) => sddConnector.hooks!(ctx(dir))!
  const fakeStore = (rows: TaskRow[], actor?: () => string): TaskStore =>
    ({ list: () => rows, actor }) as unknown as TaskStore

  // a foreign backend's assignee lives in its own identity space —
  // comparing it to bdActor marked every own claim foreign and ate the
  // nudge (bro-cwgv)
  test('no actor() → a foreign assignee cannot disprove the marker', async () => {
    registerConnector({
      name: 'spec-fake-tasks',
      tasks: () =>
        fakeStore([
          {
            id: 'b1',
            status: 'in_progress',
            title: 'thing',
            issue_type: 'task',
            assignee: 'linear-user-9',
          },
        ]),
    })
    await withRepo(
      {
        claims: ['b1'],
        config: { connectors: { tasks: 'spec-fake-tasks' }, sdd: { mode: 'gate' } },
      },
      async (dir) => {
        const gate = await probe(dir).stopGate!(ctx(dir))
        assert.equal(gate.length, 1)
        assert.match(gate[0]!.block ?? '', /b1 thing/)
      }
    )
  })

  test('actor() follows the backend\u2019s own claim identity', async () => {
    registerConnector({
      name: 'spec-fake-actor',
      tasks: () =>
        fakeStore(
          [
            { id: 'b1', status: 'in_progress', title: 'mine', issue_type: 'task', assignee: 'jira-me' },
            { id: 'b2', status: 'in_progress', title: 'held', issue_type: 'task', assignee: 'jira-other' },
          ],
          () => 'jira-me'
        ),
    })
    await withRepo(
      {
        claims: ['b1', 'b2'],
        config: { connectors: { tasks: 'spec-fake-actor' }, sdd: { mode: 'gate' } },
      },
      async (dir) => {
        const gate = await probe(dir).stopGate!(ctx(dir))
        assert.equal(gate.length, 1)
        assert.match(gate[0]!.block ?? '', /b1 mine/)
        assert.doesNotMatch(gate[0]!.block ?? '', /b2/)
      }
    )
  })
})

describe('specs facade resolution', () => {
  test('bare repo resolves to native', async () => {
    await withRepo({ config: {} }, (dir) => {
      assert.match(specStore(dir).policy(), /specs\/<id>\.md/)
    })
  })

  test('.specify/ detects speckit', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, '.specify'))
      assert.match(specStore(dir).remedy('b1'), /speckit/)
    })
  })

  test('openspec/ detects openspec and counts changes/<id>', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'openspec', 'changes', 'b1'), { recursive: true })
      writeFileSync(join(dir, 'openspec', 'changes', 'b1', 'proposal.md'), '# change\n')
      const spec = specStore(dir)
      assert.match(spec.policy(), /openspec\/changes/)
      assert.equal(spec.hasSpec('b1'), true)
      assert.equal(spec.hasSpec('b2'), false)
    })
  })

  test('connectors.specs override wins over detection', async () => {
    await withRepo({ config: { connectors: { specs: 'agent' } } }, (dir) => {
      mkdirSync(join(dir, '.specify'))
      const spec = specStore(dir, loadConfig(dir).connectors)
      assert.match(spec.policy(), /write the design down first/)
      assert.equal(spec.hasSpec('b1'), false)
    })
  })
})

describe('native spec tree', () => {
  test('tree() links children via parent frontmatter', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs'))
      writeFileSync(join(dir, 'specs', 'epic.md'), '# epic\n')
      writeFileSync(join(dir, 'specs', 'child.md'), '---\nparent: epic\n---\n# child\n')
      writeFileSync(join(dir, 'specs', 'sib.md'), '# sib\n')
      const nodes = specStore(dir).tree()
      assert.deepEqual(
        nodes.map((n) => [n.id, n.parent]),
        [
          ['child', 'epic'],
          ['epic', undefined],
          ['sib', undefined],
        ]
      )
    })
  })

  test('scaffold() writes parent frontmatter and refuses overwrites', async () => {
    await withRepo({ config: {} }, (dir) => {
      const spec = specStore(dir)
      const p = spec.scaffold!('b1', { title: 'thing', parent: 'epic' })
      assert.match(readFileSync(p, 'utf8'), /^parent: epic$/m)
      assert.throws(() => spec.scaffold!('b1', {}), /already exists/)
    })
  })
})

describe('dir specs — the tree IS the filetree', () => {
  test('a dir with spec.md (or README.md) counts as the spec for its id', async () => {
    await withRepo({ config: {} }, (dir) => {
      const spec = specStore(dir)
      assert.equal(spec.hasSpec('cap'), false)
      mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
      // a bare dir is not a spec yet — index file required
      assert.equal(spec.hasSpec('cap'), false)
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '  \n')
      // an empty index does not count
      assert.equal(spec.hasSpec('cap'), false)
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      assert.equal(spec.hasSpec('cap'), true)
      mkdirSync(join(dir, 'specs', 'other'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'other', 'README.md'), '# other\n')
      assert.equal(spec.hasSpec('other'), true)
    })
  })

  test('nested entries take their enclosing dir spec as parent', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap', 'sub'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      writeFileSync(join(dir, 'specs', 'cap', 'leaf.md'), '# leaf\n')
      writeFileSync(join(dir, 'specs', 'cap', 'sub', 'spec.md'), '# sub\n')
      writeFileSync(join(dir, 'specs', 'cap', 'sub', 'deep.md'), '# deep\n')
      const nodes = specStore(dir).tree()
      assert.deepEqual(
        Object.fromEntries(nodes.map((n) => [n.id, n.parent])),
        { cap: undefined, leaf: 'cap', sub: 'cap', deep: 'sub' }
      )
    })
  })

  test('frontmatter parent wins over position', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      writeFileSync(join(dir, 'specs', 'cap', 'cross.md'), '---\nparent: other\n---\n# cross\n')
      writeFileSync(join(dir, 'specs', 'other.md'), '# other\n')
      const nodes = specStore(dir).tree()
      assert.equal(nodes.find((n) => n.id === 'cross')?.parent, 'other')
    })
  })

  test('.md inside a non-index dir is content, not a spec', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap', 'assets', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      writeFileSync(join(dir, 'specs', 'cap', 'assets', 'diagram.md'), '# diagram\n')
      writeFileSync(join(dir, 'specs', 'cap', 'assets', 'nested', 'spec.md'), '# nested\n')
      const ids = specStore(dir)
        .tree()
        .map((n) => n.id)
      assert.deepEqual(ids.sort(), ['cap', 'nested'])
      const nodes = specStore(dir).tree()
      assert.equal(nodes.find((n) => n.id === 'nested')?.parent, 'cap')
    })
  })

  test('hasSpec resolves a bead spec nested under a capability dir', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'sdd'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'sdd', 'spec.md'), '# sdd\n')
      writeFileSync(join(dir, 'specs', 'sdd', 'b1.md'), '# b1 spec\n')
      const spec = specStore(dir)
      assert.equal(spec.hasSpec('b1'), true)
      assert.equal(spec.hasSpec('b2'), false)
    })
  })

  test('frontmatter on a dir-spec index beats its positional parent', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap', 'sub'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      writeFileSync(join(dir, 'specs', 'cap', 'sub', 'spec.md'), '---\nparent: other\n---\n# sub\n')
      writeFileSync(join(dir, 'specs', 'other.md'), '# other\n')
      const nodes = specStore(dir).tree()
      assert.equal(nodes.find((n) => n.id === 'sub')?.parent, 'other')
    })
  })

  test('spec.md wins over README.md when a dir carries both', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'README.md'), '# readme\n')
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# spec\n')
      const nodes = specStore(dir).tree()
      assert.equal(nodes.find((n) => n.id === 'cap')?.path, join('specs', 'cap', 'spec.md'))
    })
  })

  test('an invalid-id dir walks through — nested specs stay attached', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap', 'bad name', 'inner'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      writeFileSync(join(dir, 'specs', 'cap', 'bad name', 'spec.md'), '# invalid id\n')
      writeFileSync(join(dir, 'specs', 'cap', 'bad name', 'inner', 'spec.md'), '# inner\n')
      const nodes = specStore(dir).tree()
      assert.equal(nodes.find((n) => n.id === 'inner')?.parent, 'cap')
      assert.equal(nodes.find((n) => n.id === 'bad name'), undefined)
    })
  })

  test('a child file reusing the dir id is skipped — no self-parent', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'foo'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'foo', 'spec.md'), '# foo\n')
      writeFileSync(join(dir, 'specs', 'foo', 'foo.md'), '# dup\n')
      writeFileSync(join(dir, 'specs', 'foo', 'leaf.md'), '# leaf\n')
      const nodes = specStore(dir).tree()
      assert.deepEqual(
        nodes.map((n) => n.id).sort(),
        ['foo', 'leaf']
      )
    })
  })

  test('a non-selected index name inside a dir spec is a child spec', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      writeFileSync(join(dir, 'specs', 'cap', 'README.md'), '# readme child\n')
      const nodes = specStore(dir).tree()
      assert.equal(nodes.find((n) => n.id === 'README')?.parent, 'cap')
    })
  })

  test('scaffold --parent into a dir spec writes positionally, no frontmatter', async () => {
    await withRepo({ config: {} }, (dir) => {
      mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
      writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), '# cap\n')
      const spec = specStore(dir)
      const p = spec.scaffold!('child', { title: 'c', parent: 'cap' })
      assert.equal(p, join(dir, 'specs', 'cap', 'child.md'))
      assert.doesNotMatch(readFileSync(p, 'utf8'), /parent:/)
      // flat-file parents still get the frontmatter edge
      writeFileSync(join(dir, 'specs', 'flat.md'), '# flat\n')
      const q = spec.scaffold!('child2', { parent: 'flat' })
      assert.match(readFileSync(q, 'utf8'), /^parent: flat$/m)
    })
  })
})

describe('bro spec init', () => {
  test('bare repo: native mode + root spec-of-specs + config', async () => {
    await withRepo({ config: {} }, async (dir) => {
      rmSync(join(dir, 'bro.config.json'))
      const cwd = process.cwd()
      process.chdir(dir)
      try {
        const { runSpecCommand } = await import('./spec.ts')
        runSpecCommand(['init'])
      } finally {
        process.chdir(cwd)
      }
      const cfg = JSON.parse(readFileSync(join(dir, 'bro.config.json'), 'utf8'))
      assert.equal(cfg.sdd.mode, 'remind')
      assert.equal(cfg.connectors?.specs, undefined)
      assert.ok(readFileSync(join(dir, 'specs', 'project.md'), 'utf8').includes('spec of specs'))
    })
  })

  test('.specify/ repo: speckit connector written to config', async () => {
    await withRepo({ config: {} }, async (dir) => {
      mkdirSync(join(dir, '.specify'))
      rmSync(join(dir, 'bro.config.json'))
      const cwd = process.cwd()
      process.chdir(dir)
      try {
        const { runSpecCommand } = await import('./spec.ts')
        runSpecCommand(['init'])
      } finally {
        process.chdir(cwd)
      }
      const cfg = JSON.parse(readFileSync(join(dir, 'bro.config.json'), 'utf8'))
      assert.equal(cfg.connectors.specs, 'speckit')
      assert.equal(cfg.sdd.mode, 'remind')
      assert.ok(!existsSync(join(dir, 'specs', 'project.md')))
    })
  })
})

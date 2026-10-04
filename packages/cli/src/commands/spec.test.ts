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
import { dirname, join } from 'node:path'
import { runSpecCommand, sddConnector, specState } from './spec.ts'
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

/** Scripted bd — `list`/`show` read $FAKE_BD_LIST_FILE (written by
 *  withRepo) with the real CLI's filtering contract: --status selects,
 *  closed rows hide unless --all or --status closed asks, `show <id>`
 *  answers [row] or exits 1 with the "Issue <id> not found" miss
 *  isBdNotFound classifies. `config` keeps taskStore happy. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  list)
    shift
    node -e '
      const rows = JSON.parse(require("fs").readFileSync(process.env.FAKE_BD_LIST_FILE, "utf8"))
      const a = process.argv.slice(1)
      const val = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1] }
      const status = val("--status")
      let r = rows
      if (status !== undefined) r = r.filter((x) => x.status === status)
      else if (!a.includes("--all")) r = r.filter((x) => x.status !== "closed")
      const n = Number(val("-n"))
      if (n > 0) r = r.slice(0, n)
      console.log(JSON.stringify(r))
    ' -- "$@"
    ;;
  show)
    node -e '
      const rows = JSON.parse(require("fs").readFileSync(process.env.FAKE_BD_LIST_FILE, "utf8"))
      const r = rows.find((x) => x.id === process.argv[1])
      if (r === undefined) { console.error("Issue " + process.argv[1] + " not found"); process.exit(1) }
      console.log(JSON.stringify([r]))
    ' -- "$2"
    ;;
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
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't'])
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

/** Write spec files under specs/, creating intermediate dirs. */
const writeSpecs = (dir: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, 'specs', rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
}

/** process.exit stubbed into a throw — usage-error paths exit 2 and an
 *  in-process command run must not take the test runner with it. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

/** Run `bro spec <argv>` with cwd in the tmp repo, capturing console and
 *  the exit verdict (process.exit code, else process.exitCode). */
const capture = async (
  dir: string,
  argv: string[]
): Promise<{ out: string[]; err: string[]; exit: number }> => {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  const origExit = process.exit
  const origCode = process.exitCode
  let exit: number | undefined
  console.log = (m?: unknown) => out.push(String(m))
  console.error = (m?: unknown) => err.push(String(m))
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as typeof process.exit
  process.exitCode = 0
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    runSpecCommand(argv)
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      throw e
    }
    exit = e.code
  } finally {
    process.chdir(cwd)
    console.log = origLog
    console.error = origErr
    process.exit = origExit
    const code = exit ?? process.exitCode ?? 0
    process.exitCode = origCode
    exit = code
  }
  return { out, err, exit }
}

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

describe('bro spec tree rendering', () => {
  /** Run `bro spec tree` over a spec fixture — returns stdout lines and
   *  the stderr lines about cyclic edges (unrelated facade warnings are
   *  filtered out). */
  const runTree = async (
    files: Record<string, string>
  ): Promise<{ out: string[]; cyclic: string[] }> => {
    let res = { out: [] as string[], cyclic: [] as string[] }
    await withRepo({ config: {}, list: '[]' }, async (dir) => {
      writeSpecs(dir, files)
      const { out, err } = await capture(dir, ['tree'])
      res = { out, cyclic: err.filter((l) => l.includes('cyclic')) }
    })
    return res
  }

  test('duplicate ids at different depths keep their own subtrees', async () => {
    // flat specs/dup.md collides with dir spec specs/cap/dup/ — the
    // leaf inside the dir spec is ITS child, not the flat one's
    const { out, cyclic } = await runTree({
      'dup.md': '# flat dup\n',
      'cap/spec.md': '# cap\n',
      'cap/dup/spec.md': '# dir dup\n',
      'cap/dup/leaf.md': '# leaf\n',
    })
    assert.deepEqual(out, [
      `cap  ${join('specs', 'cap', 'spec.md')}`,
      `  dup  ${join('specs', 'cap', 'dup', 'spec.md')}`,
      `    leaf  ${join('specs', 'cap', 'dup', 'leaf.md')}`,
      `dup  ${join('specs', 'dup.md')}`,
    ])
    assert.deepEqual(cyclic, [])
  })

  test('a self-parent edge renders at root level', async () => {
    const { out, cyclic } = await runTree({
      'a.md': '---\nparent: a\n---\n# a\n',
      'b.md': '# b\n',
    })
    assert.deepEqual(out, [
      `a  ${join('specs', 'a.md')}`,
      `b  ${join('specs', 'b.md')}`,
    ])
    assert.deepEqual(cyclic, [])
  })

  test('an unresolvable cycle warns instead of dropping the subtree', async () => {
    // a subtree hung off a cyclic node is unreachable too
    const { out, cyclic } = await runTree({
      'a.md': '---\nparent: b\n---\n# a\n',
      'b.md': '---\nparent: a\n---\n# b\n',
      'c.md': '---\nparent: a\n---\n# c\n',
      'root.md': '# root\n',
    })
    assert.deepEqual(out, [`root  ${join('specs', 'root.md')}`])
    assert.equal(cyclic.length, 1)
    assert.match(cyclic[0]!, /a, b, c/)
  })

  test('an explicit parent edge resolves path-first over an enclosing duplicate', async () => {
    // inner sits inside dir spec z/dup yet its frontmatter names the
    // duplicated id — explicit edges resolve by path order, so flat
    // specs/dup.md (sorting before specs/z/…) wins over the enclosing
    // dir spec; the positional leaf still belongs to the dir spec
    const { out, cyclic } = await runTree({
      'dup.md': '# flat dup\n',
      'z/spec.md': '# z\n',
      'z/dup/spec.md': '# dup\n',
      'z/dup/leaf.md': '# leaf\n',
      'z/dup/inner.md': '---\nparent: dup\n---\n# inner\n',
    })
    assert.deepEqual(out, [
      `dup  ${join('specs', 'dup.md')}`,
      `  inner  ${join('specs', 'z', 'dup', 'inner.md')}`,
      `z  ${join('specs', 'z', 'spec.md')}`,
      `  dup  ${join('specs', 'z', 'dup', 'spec.md')}`,
      `    leaf  ${join('specs', 'z', 'dup', 'leaf.md')}`,
    ])
    assert.deepEqual(cyclic, [])
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

describe('bro spec drift', () => {
  const T0 = '2026-01-01T00:00:00Z'
  const T1 = '2026-01-02T00:00:00Z'
  const T2 = '2026-01-03T00:00:00Z'

  /** Stage `files` and commit with `subject`, pinning author+committer
   *  dates — the staleness predicate compares committer timestamps, so
   *  the fixture controls them instead of racing the clock. */
  const commit = (
    dir: string,
    subject: string,
    files: Record<string, string>,
    date: string
  ): void => {
    for (const [p, content] of Object.entries(files)) {
      const abs = join(dir, p)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const {
      GIT_DIR: _d,
      GIT_WORK_TREE: _w,
      GIT_INDEX_FILE: _i,
      GIT_COMMON_DIR: _c,
      ...env
    } = process.env
    // stage the declared files only — `add -A` would sweep the fixture's
    // bro.config.json / bin / list.json into a (b1) commit and fabricate
    // a commit-resolved scope
    execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir, env })
    execFileSync('git', ['commit', '-qm', subject], {
      cwd: dir,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
  }

  /** capture() minus connector-collision warnings — earlier describes
   *  register fake tasks connectors process-wide, so facade resolution
   *  warns on every run; it is fixture noise, not drift output. Only
   *  the collision line is filtered — a real drift-command warning
   *  still reaches the assertions. */
  const drift = async (
    dir: string,
    argv: string[]
  ): Promise<{ out: string[]; err: string[]; exit: number }> => {
    const r = await capture(dir, argv)
    return {
      ...r,
      err: r.err.filter((l) => !/^warning: .+ all provide "tasks" — using /.test(l)),
    }
  }

  const beadRow = (id: string, over: object = {}): Record<string, unknown> => ({
    id,
    status: 'closed',
    title: `${id} title`,
    issue_type: 'task',
    ...over,
  })
  const list = (...rows: Record<string, unknown>[]): string => JSON.stringify(rows)

  const scopedSpec = (scope = 'src/**'): string =>
    `---\nscope:\n  - "${scope}"\n---\n# spec\n`

  test('STALE row: landed code newer than the spec — TSV detail + exit 1', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      commit(dir, 'spec (b1)', { 'specs/b1.md': scopedSpec() }, T0)
      commit(dir, 'code moved on', { 'src/a.ts': 'x\n' }, T1)
      const r = await drift(dir, ['drift'])
      assert.equal(r.exit, 1)
      assert.deepEqual(r.err, ['spec drift: 1 stale spec(s)'])
      assert.equal(r.out.length, 1)
      assert.match(r.out[0]!, /^b1\tSTALE\tspec@[0-9a-f]{8} \S+ · scope@[0-9a-f]{8} \S+$/)
    })
  })

  test('fresh rows: spec landed after code, or in the same commit — exit 0', async () => {
    await withRepo(
      { config: {}, list: list(beadRow('b2'), beadRow('b1')) },
      async (dir) => {
        commit(dir, 'code (b1)', { 'src/a.ts': 'x\n' }, T0)
        commit(dir, 'spec (b1)', { 'specs/b1.md': scopedSpec() }, T1)
        // b2: spec and code in one commit — the ideal landing is fresh.
        // disjoint scope: a shared path would stale b1's row too
        commit(
          dir,
          'spec+code (b2)',
          { 'specs/b2.md': scopedSpec('docs/**'), 'docs/b2.md': 'y\n' },
          T2
        )
        const r = await drift(dir, ['drift'])
        assert.equal(r.exit, 0)
        assert.deepEqual(r.err, [])
        // rows sort by id regardless of list order
        assert.deepEqual(
          r.out.map((l) => l.split('\t').slice(0, 2).join('\t')),
          ['b1\tfresh', 'b2\tfresh']
        )
      }
    )
  })

  test('no-scope reports the coverage gap without failing', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      // a plain spec — no scope: frontmatter — and no commit subjects
      // carry (b1): nothing resolves the audit scope
      commit(dir, 'spec (b1)', { 'specs/b1.md': '# plain spec\n' }, T0)
      const r = await drift(dir, ['drift'])
      assert.equal(r.exit, 0)
      assert.deepEqual(r.out, [
        'b1\tno-scope\tno frontmatter scope, no bead-id commits',
      ])
    })
  })

  test('bead-id commits resolve the scope; the next code commit staleness it', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      commit(dir, 'feat: the thing (b1) (#7)', { 'src/a.ts': 'x\n' }, T0)
      commit(dir, 'spec (b1)', { 'specs/b1.md': '# plain spec\n' }, T1)
      let r = await drift(dir, ['drift'])
      assert.match(r.out[0]!, /^b1\tfresh\t/)
      assert.equal(r.exit, 0)
      // code moves past the spec — a commit without the bead marker
      // still lands inside the resolved scope pathset
      commit(dir, 'refactor (b9)', { 'src/a.ts': 'x2\n' }, T2)
      r = await drift(dir, ['drift'])
      assert.match(r.out[0]!, /^b1\tSTALE\t/)
      assert.equal(r.exit, 1)
    })
  })

  test('explicit ids audit exactly those; an unknown id exits 2', async () => {
    await withRepo(
      { config: {}, list: list(beadRow('b1'), beadRow('b2')) },
      async (dir) => {
        commit(dir, 'code', { 'src/a.ts': 'x\n' }, T0)
        commit(
          dir,
          'specs',
          { 'specs/b1.md': scopedSpec(), 'specs/b2.md': scopedSpec() },
          T1
        )
        const r = await drift(dir, ['drift', 'b1'])
        assert.equal(r.exit, 0)
        assert.equal(r.out.length, 1)
        assert.match(r.out[0]!, /^b1\tfresh\t/)
        const miss = await drift(dir, ['drift', 'b9'])
        assert.equal(miss.exit, 2)
        assert.match(miss.err[0] ?? '', /bead\(s\) not found: b9/)
      }
    )
  })

  test('an explicit id with no local spec file is unverifiable, not dropped', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      commit(dir, 'code', { 'src/a.ts': 'x\n' }, T0)
      const r = await drift(dir, ['drift', 'b1'])
      assert.equal(r.exit, 0)
      assert.deepEqual(r.out, ['b1\tunverifiable\tno local spec file to date'])
    })
  })

  test('uncommitted spec file: no commit on the drift ref — unverifiable', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      commit(dir, 'code', { 'src/a.ts': 'x\n' }, T0)
      writeSpecs(dir, { 'b1.md': scopedSpec() })
      const r = await drift(dir, ['drift'])
      assert.equal(r.exit, 0)
      assert.match(r.out[0]!, /^b1\tunverifiable\tno spec commit on /)
    })
  })

  test('a spec: external link is unverifiable — nothing local to date', async () => {
    await withRepo(
      {
        config: {},
        list: list(beadRow('b1', { description: 'see spec: https://docs.example/x' })),
      },
      async (dir) => {
        commit(dir, 'code', { 'src/a.ts': 'x\n' }, T0)
        const r = await drift(dir, ['drift'])
        assert.equal(r.exit, 0)
        assert.deepEqual(r.out, ['b1\tunverifiable\tno local spec file to date'])
      }
    )
  })

  test('a spec: link to a repo file audits that file', async () => {
    await withRepo(
      { config: {}, list: list(beadRow('b1', { description: 'spec: docs/spec.md' })) },
      async (dir) => {
        commit(dir, 'linked spec', { 'docs/spec.md': scopedSpec() }, T0)
        commit(dir, 'code', { 'src/a.ts': 'x\n' }, T1)
        const r = await drift(dir, ['drift'])
        assert.equal(r.exit, 1)
        assert.match(r.out[0]!, /^b1\tSTALE\t/)
      }
    )
  })

  test('bad scope entries are unverifiable — never silently widened', async () => {
    await withRepo(
      { config: {}, list: list(beadRow('b1'), beadRow('b2')) },
      async (dir) => {
        commit(dir, 'specs', {
          'specs/b1.md': scopedSpec('../outside'),
          'specs/b2.md': scopedSpec('nope/**'),
        }, T0)
        const r = await drift(dir, ['drift'])
        assert.equal(r.exit, 0)
        assert.deepEqual(r.out, [
          'b1\tunverifiable\tbad scope path: ../outside',
          'b2\tunverifiable\tscope matches nothing',
        ])
      }
    )
  })

  test('shallow history is unverifiable before any timestamp comparison', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      commit(dir, 'spec+code', { 'specs/b1.md': scopedSpec(), 'src/a.ts': 'x\n' }, T0)
      // .git/shallow is what --is-shallow-repository reads — one line
      // fakes a boundary clone without a second repo
      const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
      writeFileSync(join(dir, '.git', 'shallow'), `${sha}\n`)
      const r = await drift(dir, ['drift'])
      assert.equal(r.exit, 0)
      assert.deepEqual(r.out, ['b1\tunverifiable\tshallow history'])
    })
  })

  test('unborn history is unverifiable — no drift ref resolves', async () => {
    await withRepo({ config: {}, list: list(beadRow('b1')) }, async (dir) => {
      writeSpecs(dir, { 'b1.md': scopedSpec() })
      const r = await drift(dir, ['drift'])
      assert.equal(r.exit, 0)
      assert.deepEqual(r.out, [
        'b1\tunverifiable\tunborn or empty history — no drift ref',
      ])
    })
  })

  test('default scans closed beads; --all adds open ones; exempt never audit', async () => {
    const staleSpec = { 'specs/b1.md': scopedSpec(), 'specs/b2.md': scopedSpec(), 'specs/b3.md': scopedSpec() }
    await withRepo(
      {
        config: {},
        list: list(
          beadRow('b2', { status: 'in_progress' }),
          beadRow('b1'),
          beadRow('b3', { labels: ['trivial'] })
        ),
      },
      async (dir) => {
        commit(dir, 'specs', staleSpec, T0)
        commit(dir, 'code', { 'src/a.ts': 'x\n' }, T1)
        let r = await drift(dir, ['drift'])
        assert.deepEqual(r.out.map((l) => l.split('\t')[0]), ['b1'])
        assert.equal(r.exit, 1)
        r = await drift(dir, ['drift', '--all'])
        // b3 is exempt (trivial) — never enters the audit set
        assert.deepEqual(r.out.map((l) => l.split('\t')[0]), ['b1', 'b2'])
        assert.equal(r.exit, 1)
      }
    )
  })

  test('--json emits the same rows as objects; STALE still exits 1', async () => {
    await withRepo(
      { config: {}, list: list(beadRow('b1'), beadRow('b2')) },
      async (dir) => {
        commit(
          dir,
          'specs',
          { 'specs/b1.md': scopedSpec(), 'specs/b2.md': '# plain\n' },
          T0
        )
        commit(dir, 'code', { 'src/a.ts': 'x\n' }, T1)
        const r = await drift(dir, ['drift', '--json'])
        assert.equal(r.exit, 1)
        assert.deepEqual(r.err, ['spec drift: 1 stale spec(s)'])
        const rows = JSON.parse(r.out.join('\n')) as Array<{
          id: string
          state: string
          detail: string
        }>
        assert.equal(rows.length, 2)
        assert.deepEqual(
          rows.map((x) => x.id),
          ['b1', 'b2']
        )
        assert.equal(rows[0]!.state, 'STALE')
        assert.match(rows[0]!.detail, /^spec@[0-9a-f]{8} /)
        assert.equal(rows[1]!.state, 'no-scope')
      }
    )
  })
})

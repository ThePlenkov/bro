import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { BroPlugin } from '@broject/core'
import {
  buildDump,
  parseBreaking,
  reconcileContract,
  runContractCommand,
  type ContractDoc,
  type ContractDump,
} from './contract.ts'
import { PLUGINS, GROUP_META } from '../plugins.ts'
import { tmpDir } from './testrepo.ts'

const GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['review', 'PR review loop'],
  ['work', 'worktree mechanics'],
]

function fakePlugin(p: Partial<BroPlugin> & Pick<BroPlugin, 'name'>): BroPlugin {
  return { summary: `${p.name} summary`, run: () => {}, ...p }
}

const REGISTRY: BroPlugin[] = [
  fakePlugin({
    name: 'act',
    group: 'review',
    skill: 'act',
    configKey: 'act',
    planSchema: () => ({}),
    contract: {
      subs: {
        status: {
          flags: { '--json': 'gate JSON' },
          exits: { 0: 'green', 1: 'blocked', 2: 'no PR' },
        },
      },
    },
  }),
  fakePlugin({ name: 'work', group: 'work', skill: 'work' }),
  fakePlugin({ name: 'unwind', group: 'work', aliasOf: 'drill up', argvPrefix: ['up'] }),
  fakePlugin({ name: 'drill', group: 'work' }),
  fakePlugin({ name: 'doctor' }),
  fakePlugin({ name: 'hooks', hidden: true }),
]

function doc(dump: ContractDump, removed: ContractDoc['removed'] = {}): ContractDoc {
  // deep clone — a committed doc that shares live's maps lets a test
  // mutation corrupt every later reconcile against the same fixture
  return { ...structuredClone(dump), removed }
}

describe('buildDump', () => {
  test('every registry command appears with its declared fields', () => {
    const dump = buildDump(REGISTRY, GROUPS)
    assert.equal(dump.version, 1)
    assert.deepEqual(Object.keys(dump.commands), [
      'act',
      'work',
      'unwind',
      'drill',
      'doctor',
      'hooks',
    ])
    const act = dump.commands.act!
    assert.equal(act.group, 'review')
    assert.equal(act.skill, 'act')
    assert.equal(act.plan, true)
    assert.equal(act.planVersion, 1)
    assert.equal(act.hidden, false)
    assert.equal(act.external, false)
    assert.deepEqual(act.spellings, ['act', 'review act'])
    assert.deepEqual(act.contract, {
      subs: {
        status: {
          flags: { '--json': 'gate JSON' },
          exits: { 0: 'green', 1: 'blocked', 2: 'no PR' },
        },
      },
    })
    // alias entries carry aliasOf; the target collects the reverse map
    assert.equal(dump.commands.unwind!.aliasOf, 'drill up')
    assert.deepEqual(dump.commands.unwind!.argvPrefix, ['up'])
    assert.deepEqual(dump.commands.drill!.aliases, ['unwind'])
    assert.deepEqual(dump.commands.act!.aliases, [])
    assert.equal(dump.commands.hooks!.hidden, true)
    // a group host has no `<group> <name>` spelling — `bro work work`
    // is not an invocation
    assert.deepEqual(dump.commands.work!.spellings, ['work'])
    assert.deepEqual(dump.commands.doctor!.spellings, ['doctor'])
    // groups carry the declared one-liner plus registry-ordered members
    assert.deepEqual(dump.groups.review, {
      summary: 'PR review loop',
      members: ['act'],
    })
    assert.deepEqual(dump.groups.work!.members, ['work', 'unwind', 'drill'])
    // a plan-less command advertises no planVersion
    assert.equal(dump.commands.work!.planVersion, undefined)
  })

  test('a plugin with an explicit planVersion keeps it; external is flagged', () => {
    const dump = buildDump(
      [fakePlugin({ name: 'x', planSchema: () => ({}), planVersion: 3, external: true })],
      GROUPS
    )
    assert.equal(dump.commands.x!.planVersion, 3)
    assert.equal(dump.commands.x!.external, true)
  })

  test('the live registry dumps every PLUGINS entry, hidden included', () => {
    const dump = buildDump(PLUGINS, GROUP_META)
    assert.deepEqual(Object.keys(dump.commands), PLUGINS.map((p) => p.name))
    assert.equal(dump.commands.contract!.hidden, true)
    // groups hold declared summaries — a group with no declared meta
    // still appears (empty summary) once a plugin claims it
    assert.ok(dump.groups.review!.summary!.length > 0)
    for (const p of PLUGINS) {
      const row = dump.commands[p.name]!
      if (p.group === undefined || p.group === p.name) {
        assert.deepEqual(row.spellings, [p.name], p.name)
      } else {
        assert.deepEqual(row.spellings, [p.name, `${p.group} ${p.name}`], p.name)
      }
    }
    // the seeded contract blocks survive the round trip
    assert.equal(dump.commands.act!.contract!.subs!.status!.flags!['--json'] !== undefined, true)
  })
})

describe('reconcileContract', () => {
  const live = buildDump(REGISTRY, GROUPS)

  test('identical committed is clean', () => {
    const { problems } = reconcileContract(doc(live), live, new Set())
    assert.deepEqual(problems, [])
  })

  test('an added command is stale, never breaking', () => {
    const committed = doc(live)
    delete committed.commands.doctor
    const { doc: next, problems } = reconcileContract(committed, live, new Set())
    assert.deepEqual(
      problems.map((p) => [p.kind, p.path]),
      [['stale', 'doctor (added)']]
    )
    assert.deepEqual(next, doc(live))
  })

  test('an unannounced command removal is breaking — regen cannot paper it', () => {
    const live2 = buildDump(
      REGISTRY.filter((p) => p.name !== 'doctor'),
      GROUPS
    )
    const { problems } = reconcileContract(doc(live), live2, new Set())
    const breaking = problems.filter((p) => p.kind === 'breaking')
    assert.deepEqual(breaking.map((p) => p.path), ['doctor'])
  })

  test('an announced removal tombstones — then the regenerated file is clean', () => {
    const live2 = buildDump(
      REGISTRY.filter((p) => p.name !== 'doctor'),
      GROUPS
    )
    const committed = doc(live)
    const { doc: next, problems } = reconcileContract(committed, live2, new Set(['doctor']))
    assert.deepEqual(next.removed.doctor, committed.commands.doctor)
    // the command is gone from commands, kept only in the ledger
    assert.equal(next.commands.doctor, undefined)
    // announced ≠ free pass — the file is stale until the regen writes
    // the tombstone in; only `breaking` is suppressed by the bullet
    assert.deepEqual(
      problems.map((p) => [p.kind, p.path]),
      [['stale', 'removed']]
    )
    // after regen the gate is green — and only while the bullet stays
    assert.deepEqual(reconcileContract(next, live2, new Set(['doctor'])).problems, [])
    assert.ok(
      reconcileContract(next, live2, new Set()).problems.some(
        (p) => p.kind === 'ledger' && p.path === 'removed.doctor'
      )
    )
  })

  test('announcing a command covers removals under it', () => {
    const live2 = structuredClone(live)
    delete live2.commands.act!.contract!.subs!.status!.flags!['--json']
    const { doc: next, problems } = reconcileContract(doc(live), live2, new Set(['act']))
    // no breaking — the flag's removal is announced; the file itself is
    // stale until the tombstone write lands
    assert.deepEqual(
      problems.map((p) => [p.kind, p.path]),
      [['stale', 'act'], ['stale', 'removed']]
    )
    assert.deepEqual(next.removed['act.subs.status.flags.--json'], 'gate JSON')
  })

  test('a vanished flags map reports each leaf — a leaf bullet covers it', () => {
    const live2 = structuredClone(live)
    delete live2.commands.act!.contract!.subs!.status!.flags
    // announce the leaf, not the map — the removal is reported at the
    // leaf's canonical path so the bullet covers it
    const { doc: next, problems } = reconcileContract(
      doc(live),
      live2,
      new Set(['act.subs.status.flags.--json'])
    )
    assert.equal(problems.some((p) => p.kind === 'breaking'), false)
    assert.deepEqual(next.removed['act.subs.status.flags.--json'], 'gate JSON')
    // …and announcing the map itself still covers every leaf under it
    const covered = reconcileContract(doc(live), live2, new Set(['act.subs.status.flags']))
    assert.equal(covered.problems.some((p) => p.kind === 'breaking'), false)
  })

  test('an unannounced flag removal is breaking at its dotted path', () => {
    const live2 = structuredClone(live)
    delete live2.commands.act!.contract!.subs!.status!.flags!['--json']
    const { problems } = reconcileContract(doc(live), live2, new Set())
    const breaking = problems.filter((p) => p.kind === 'breaking')
    assert.deepEqual(breaking.map((p) => p.path), ['act.subs.status.flags.--json'])
  })

  test('a rename reads as remove+add — the old name is breaking, the new stale', () => {
    const reg2 = REGISTRY.map((p) =>
      p.name === 'doctor' ? fakePlugin({ name: 'diagnose' }) : p
    )
    const live2 = buildDump(reg2, GROUPS)
    const { problems } = reconcileContract(doc(live), live2, new Set())
    const byKind = (k: string) => problems.filter((p) => p.kind === k).map((p) => p.path)
    assert.deepEqual(byKind('breaking'), ['doctor'])
    assert.deepEqual(byKind('stale'), ['diagnose (added)'])
  })

  test('a group change is breaking — the invocation spelling moved', () => {
    const reg2 = REGISTRY.map((p) =>
      p.name === 'act' ? { ...p, group: 'work' } : p
    )
    const live2 = buildDump(reg2, GROUPS)
    const { problems } = reconcileContract(doc(live), live2, new Set())
    const breaking = problems.filter((p) => p.kind === 'breaking')
    assert.deepEqual(breaking.map((p) => p.path), ['act.group'])
  })

  test('a flag meaning edit is stale, not breaking — the flag still exists', () => {
    const live2 = structuredClone(live)
    live2.commands.act!.contract!.subs!.status!.flags!['--json'] = 'reworded'
    const { problems } = reconcileContract(doc(live), live2, new Set())
    assert.deepEqual(
      problems.map((p) => [p.kind, p.path]),
      [['stale', 'act']]
    )
  })

  test('every tombstone must keep its BREAKING.md bullet', () => {
    const committed = doc(live, { ghost: { name: 'ghost' } })
    const { problems } = reconcileContract(committed, live, new Set())
    const ledger = problems.filter((p) => p.kind === 'ledger')
    assert.deepEqual(ledger.map((p) => p.path), ['removed.ghost'])
  })

  test('a tombstone announced stays announced — ledger coverage survives regen', () => {
    const committed = doc(live, { ghost: { name: 'ghost' } })
    const { doc: next, problems } = reconcileContract(committed, live, new Set(['ghost']))
    assert.deepEqual(problems, [])
    assert.deepEqual(next.removed.ghost, { name: 'ghost' })
  })

  test('a whole contract block removal is one breaking path, not per-leaf', () => {
    const live2 = structuredClone(live)
    delete live2.commands.act!.contract
    const { problems } = reconcileContract(doc(live), live2, new Set())
    const breaking = problems.filter((p) => p.kind === 'breaking')
    assert.deepEqual(breaking.map((p) => p.path), ['act.contract'])
  })

  test('a removed group is breaking — a group nothing claims or declares', () => {
    const live2 = buildDump(REGISTRY, GROUPS)
    const committed = doc(live2)
    // a group neither groupMeta nor any plugin claims — the only shape
    // that can truly vanish (declared groups keep their members: [] row)
    committed.groups.extra = { summary: 'an external group', members: ['x'] }
    const { problems } = reconcileContract(committed, live2, new Set())
    const breaking = problems.filter((p) => p.kind === 'breaking')
    assert.deepEqual(breaking.map((p) => p.path), ['groups.extra'])
  })

  test('an argvPrefix change is breaking — same spelling, different verb', () => {
    const reg2 = REGISTRY.map((p) =>
      p.name === 'unwind' ? { ...p, argvPrefix: ['down'] } : p
    )
    const live2 = buildDump(reg2, GROUPS)
    const { problems } = reconcileContract(doc(live), live2, new Set())
    const breaking = problems.filter((p) => p.kind === 'breaking')
    assert.deepEqual(breaking.map((p) => p.path), ['unwind.argvPrefix'])
  })

  test('a malformed committed row degrades to stale, never a crash', () => {
    const committed = doc(live)
    ;(committed.commands as Record<string, unknown>).act = 'garbage'
    ;(committed.commands as Record<string, unknown>).hooks = { contract: 'not-an-object' }
    const { problems } = reconcileContract(committed, live, new Set())
    assert.equal(problems.some((p) => p.kind === 'breaking'), false)
    assert.ok(problems.some((p) => p.kind === 'stale' && p.path === 'act'))
    assert.ok(problems.some((p) => p.kind === 'stale' && p.path === 'hooks'))
  })
})

describe('parseBreaking', () => {
  test('collects bullet tokens, strips a trailing colon, ignores prose', () => {
    const md = [
      '# CLI breaking changes',
      '',
      'Some paragraph mentioning act.status — not a bullet.',
      '- act — renamed to review-gate',
      '- wtf.aliasOf:',
      '  - nested.bullet also counts',
    ].join('\n')
    assert.deepEqual([...parseBreaking(md)].sort(), [
      'act',
      'nested.bullet',
      'wtf.aliasOf',
    ])
  })
})

describe('runContractCommand', () => {
  function captured(fn: () => void): string {
    const orig = console.log
    const lines: string[] = []
    console.log = (...a: unknown[]) => lines.push(a.join(' '))
    try {
      fn()
    } finally {
      console.log = orig
    }
    return lines.join('\n')
  }

  test('dump --json emits the parseable registry doc', () => {
    const out = captured(() => runContractCommand(['dump', '--json'], REGISTRY, GROUPS))
    const dump = JSON.parse(out) as ContractDump
    // the JSON IS the dump — every field, not just the command keys
    assert.deepEqual(dump, JSON.parse(JSON.stringify(buildDump(REGISTRY, GROUPS))))
  })

  test('a __proto__-named plugin still lands as an own enumerable key', () => {
    const dump = buildDump(
      [...REGISTRY, fakePlugin({ name: '__proto__', group: '__proto__' })],
      GROUPS
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(dump.commands, '__proto__'),
      true
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(dump.groups, '__proto__'),
      true
    )
    // and it survives the JSON round trip the snapshot takes
    const back = JSON.parse(JSON.stringify(dump)) as ContractDump
    assert.equal(back.commands['__proto__']!.name, '__proto__')
  })

  test('check reads --contract/--dump/--breaking overrides from files', () => {
    const dir = tmpDir('bro-contract-')
    const live = buildDump(REGISTRY, GROUPS)
    // a tombstone that must be announced — if --breaking were ignored the
    // ledger problem would exit 1; if --dump were ignored the live
    // registry (a different one is passed below) would exit 1 too
    const committed = doc(live, { ghost: { name: 'ghost' } })
    const contractFile = join(dir, 'cli.json')
    const breakingFile = join(dir, 'BREAKING.md')
    const dumpFile = join(dir, 'dump.json')
    writeFileSync(contractFile, JSON.stringify(committed, null, 2))
    writeFileSync(breakingFile, '# ledger\n- ghost — removed in the fixture\n')
    writeFileSync(dumpFile, JSON.stringify(live, null, 2))
    const out = captured(() =>
      runContractCommand(
        ['check', '--contract', contractFile, '--dump', dumpFile, '--breaking', breakingFile],
        // a deliberately different registry — only --dump can make this fresh
        [fakePlugin({ name: 'unrelated' })],
        GROUPS
      )
    )
    assert.match(out, /fresh/)
  })

  test('gen regenerates the committed file — byte-idempotent', () => {
    const dir = tmpDir('bro-contract-')
    const contractFile = join(dir, 'nested', 'cli.json')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    const breakingFile = join(dir, 'BREAKING.md')
    writeFileSync(breakingFile, '# ledger\n')
    captured(() =>
      runContractCommand(
        ['gen', '--contract', contractFile, '--breaking', breakingFile],
        REGISTRY,
        GROUPS
      )
    )
    const first = readFileSync(contractFile, 'utf8')
    const doc1 = JSON.parse(first) as ContractDoc
    assert.deepEqual(Object.keys(doc1.commands), REGISTRY.map((p) => p.name))
    assert.deepEqual(doc1.removed, {})
    // atomic write — the tmp file is renamed away, never left behind
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['cli.json'])
    captured(() =>
      runContractCommand(
        ['gen', '--contract', contractFile, '--breaking', breakingFile],
        REGISTRY,
        GROUPS
      )
    )
    assert.equal(readFileSync(contractFile, 'utf8'), first)
    // and check is green on what gen wrote
    const out = captured(() =>
      runContractCommand(
        ['check', '--contract', contractFile, '--breaking', breakingFile],
        REGISTRY,
        GROUPS
      )
    )
    assert.match(out, /fresh/)
  })
})

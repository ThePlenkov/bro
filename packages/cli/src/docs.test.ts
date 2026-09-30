import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { docVerbs, verbMethod } from '@broject/core'
import type { DocAdapter, DocType } from '@broject/core'
import {
  docArgs,
  docTypes,
  filterDocTypes,
  registerDocType,
  reservedWords,
  runDocVerb,
} from './docs.ts'
import { storeDoc } from './doctypes/store.ts'
import { taskDoc } from './doctypes/task.ts'

describe('docArgs', () => {
  test('--key=value and boolean --key; --global sets scope', () => {
    const { positional, flags, scope } = docArgs([
      'tasks',
      'bro-x',
      '--status=open',
      '--ready',
      '--global',
    ])
    assert.deepEqual(positional, ['tasks', 'bro-x'])
    assert.deepEqual(flags, { status: 'open', ready: 'true' })
    assert.equal(scope, 'global')
  })

  test('-- ends flag parsing — the tail is raw positional', () => {
    const { positional, flags } = docArgs(['--global', '--', 'ready', '--json'])
    assert.deepEqual(positional, ['ready', '--json'])
    assert.deepEqual(flags, {})
  })
})

describe('docVerbs', () => {
  const adapter: DocAdapter = {
    list: () => [],
    get: () => null,
    close: () => undefined,
    _internal: 42,
  }

  test('methods are the registry — standard aliases + custom verbs', () => {
    assert.deepEqual(docVerbs(adapter), ['close', 'get', 'list', 'show'])
  })

  test('verbMethod maps CLI spellings to methods', () => {
    assert.equal(verbMethod(adapter, 'show'), adapter.get)
    assert.equal(verbMethod(adapter, 'list'), adapter.list)
    assert.equal(verbMethod(adapter, 'close'), adapter.close)
    assert.equal(verbMethod(adapter, 'bogus'), undefined)
  })
})

describe('runDocVerb', () => {
  const calls: string[] = []
  registerDocType({
    name: 'fake',
    aliases: ['fakes'],
    idPrefix: 'fx-',
    render: (d: { id: string }) => `rendered:${d.id}`,
    adapter: () => ({
      list: (flags: Record<string, string>) => {
        calls.push(`list:${JSON.stringify(flags)}`)
        return [{ id: 'f1' }]
      },
      get: (ref: string) => {
        calls.push(`get:${ref}`)
        return { id: ref ?? 'none' }
      },
    }),
  } satisfies DocType<{ id: string }>)

  async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
    const orig = console.log
    const out: string[] = []
    console.log = (...a: unknown[]) => out.push(a.join(' '))
    try {
      await fn()
      return out
    } finally {
      console.log = orig
    }
  }

  test('unknown verbs pass through (return false)', async () => {
    assert.equal(await runDocVerb('definitely-not-a-verb', []), false)
  })

  test('`bro fake list --x=1` reaches the adapter with flags', async () => {
    const printed = await captureLog(async () => {
      assert.equal(await runDocVerb('fake', ['list', '--x=1']), true)
    })
    assert.ok(calls.includes('list:{"x":"1"}'))
    assert.deepEqual(printed, ['rendered:f1'])
  })

  test('`bro fake` bare noun defaults to list', async () => {
    await captureLog(async () => {
      assert.equal(await runDocVerb('fake', []), true)
    })
    assert.ok(calls.includes('list:{}'))
  })

  test('`bro fake show id-7` — noun namespaces the verb', async () => {
    await captureLog(async () => {
      assert.equal(await runDocVerb('fake', ['show', 'id-7']), true)
    })
    assert.ok(calls.includes('get:id-7'))
  })

  test('verb-first ref inference still binds a non-default type', async () => {
    // fake idPrefix 'fx-' — `bro show fx-9` resolves the type by prefix
    await captureLog(async () => {
      assert.equal(await runDocVerb('show', ['fx-9']), true)
    })
    assert.ok(calls.includes('get:fx-9'))
  })

  test('builtin doc types registered: task + store', () => {
    const names = docTypes().map((t) => t.name)
    assert.ok(names.includes('task'))
    assert.ok(names.includes('store'))
    assert.ok(names.includes('fake'))
  })
})

describe('doc type collisions', () => {
  function warnings(fn: () => unknown): string[] {
    const orig = console.error
    const out: string[] = []
    console.error = (...a: unknown[]) => out.push(a.join(' '))
    try {
      fn()
      return out
    } finally {
      console.error = orig
    }
  }

  const prefixed: DocType = { name: 'fx', idPrefix: 'bro-x-', adapter: () => ({}) }
  const cases: [string, DocType, DocType[]][] = [
    ['duplicate noun', { name: 'task', adapter: () => ({}) }, []],
    ['alias collision', { name: 'other', aliases: ['stores'], adapter: () => ({}) }, []],
    ['noun spelled like a verb', { name: 'list', adapter: () => ({}) }, []],
    ['overlapping idPrefix', { name: 'bx', idPrefix: 'bro-x-a-', adapter: () => ({}) }, [prefixed]],
  ]

  for (const [label, type, extra] of cases) {
    test(`${label} — dropped with a warning, not dispatched`, () => {
      const w = warnings(() => {
        const kept = filterDocTypes([taskDoc, storeDoc, ...extra, type])
        assert.ok(!kept.includes(type))
      })
      assert.ok(w.some((l) => l.includes('skipped')))
    })
  }

  test('prototype-chain names are not reserved — `constructor` noun is kept', () => {
    const proto: DocType = { name: 'constructor', adapter: () => ({}) }
    let kept: DocType[] = []
    const w = warnings(() => {
      kept = filterDocTypes([taskDoc, storeDoc, proto])
    })
    assert.ok(kept.includes(proto))
    assert.ok(w.every((l) => !l.includes('constructor')))
  })

  test('reservedWords covers verbs, nouns, and plugin names', () => {
    const w = reservedWords()
    for (const word of ['list', 'show', 'close', 'exec', 'init', 'task', 'store', 'tasks']) {
      assert.ok(w.has(word), `reservedWords missing "${word}"`)
    }
    // a free word stays free
    assert.ok(!w.has('totally-free-name'))
  })

  test('docTypes memoizes the filtered list — one warning per process', () => {
    registerDocType({ name: 'dup', aliases: ['task'], adapter: () => ({}) })
    const w = warnings(() => {
      docTypes()
      docTypes()
      docTypes()
    })
    assert.equal(w.filter((l) => l.includes('skipped')).length, 1)
  })

  test('mutating a registered type re-filters — stale nouns never dispatch', () => {
    const t: DocType = { name: 'mut', adapter: () => ({}) }
    registerDocType(t)
    assert.ok(docTypes().includes(t))
    t.aliases = ['task']
    const w = warnings(() => {
      assert.ok(!docTypes().includes(t))
    })
    assert.ok(w.some((l) => l.includes('skipped')))
    delete t.aliases
    assert.ok(docTypes().includes(t))
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { docVerbs, verbMethod } from '@bro/core'
import type { DocAdapter, DocType } from '@bro/core'
import { docArgs, docTypes, registerDocType, runDocVerb } from './docs.ts'

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

  test('`bro list fakes --x=1` reaches the adapter with flags', async () => {
    const printed = await captureLog(async () => {
      assert.equal(await runDocVerb('list', ['fakes', '--x=1']), true)
    })
    assert.ok(calls.includes('list:{"x":"1"}'))
    assert.deepEqual(printed, ['rendered:f1'])
  })

  test('`bro show fake id-7` resolves the noun then the ref', async () => {
    await captureLog(async () => {
      assert.equal(await runDocVerb('show', ['fake', 'id-7']), true)
    })
    assert.ok(calls.includes('get:id-7'))
  })

  test('builtin doc types registered: task + store', () => {
    const names = docTypes().map((t) => t.name)
    assert.ok(names.includes('task'))
    assert.ok(names.includes('store'))
    assert.ok(names.includes('fake'))
  })
})

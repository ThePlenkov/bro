import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deprecatedFlag, flag, flagAll, positionals } from './args.ts'

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`)
  }
}

/** Intercept process.exit — the arg helpers exit(2) on bad input. */
function exits(fn: () => unknown): { code: number; err: string[] } {
  const origExit = process.exit
  const origErr = console.error
  const err: string[] = []
  console.error = (...a: unknown[]) => err.push(a.join(' '))
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0)
  }) as typeof process.exit
  try {
    fn()
    return { code: -1, err }
  } catch (e) {
    return { code: e instanceof Exit ? e.code : -1, err }
  } finally {
    process.exit = origExit
    console.error = origErr
  }
}

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

describe('deprecatedFlag', () => {
  test('warns once on a present boolean flag', () => {
    const w = warnings(() => deprecatedFlag(['--old', 'x'], '--old', 'use --new'))
    assert.deepEqual(w, ["warning: flag --old is deprecated — use --new"])
  })

  test('matches the --flag=value spelling', () => {
    const w = warnings(() => deprecatedFlag(['--old=v'], '--old'))
    assert.deepEqual(w, ['warning: flag --old is deprecated'])
  })

  test('silent when the flag is absent', () => {
    const w = warnings(() => deprecatedFlag(['--new', 'x'], '--old', 'use --new'))
    assert.deepEqual(w, [])
  })

  test('does not match a longer flag sharing the prefix', () => {
    const w = warnings(() => deprecatedFlag(['--oldish'], '--old'))
    assert.deepEqual(w, [])
  })
})

describe('flag', () => {
  test('returns the value', () => {
    assert.equal(flag(['--x', 'v'], '--x'), 'v')
  })

  test('rejects a repeat — scalar flags are not repeatable', () => {
    const r = exits(() => flag(['--label', 'a', '--label', 'b'], '--label'))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /may be given only once/)
  })

  test('rejects a missing value', () => {
    const r = exits(() => flag(['--label'], '--label'))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /requires a value/)
  })

  test('--name=value spelling returns the value', () => {
    assert.equal(flag(['--label=debt,ui'], '--label'), 'debt,ui')
  })

  test('--name= empty value fails closed', () => {
    const r = exits(() => flag(['--label='], '--label'))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /requires a value/)
  })

  test('bare + = spellings count as a repeat', () => {
    const r = exits(() => flag(['--label', 'a', '--label=b'], '--label'))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /may be given only once/)
  })
})

describe('flagAll', () => {
  test('collects repeated values', () => {
    assert.deepEqual(flagAll(['--on', 'a', '--on', 'b'], '--on'), ['a', 'b'])
  })

  test('collects --name=value spellings', () => {
    assert.deepEqual(flagAll(['--on=a', '--on=b'], '--on'), ['a', 'b'])
  })

  test('mixes bare and = spellings', () => {
    assert.deepEqual(flagAll(['--on', 'a', '--on=b'], '--on'), ['a', 'b'])
  })

  test('--name= empty value fails closed', () => {
    const r = exits(() => flagAll(['--on='], '--on'))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /requires a value/)
  })

  test('does not match a longer flag sharing the prefix', () => {
    assert.deepEqual(flagAll(['--only=x'], '--on'), [])
  })

  test('stops at `--` — trailing text is never a flag', () => {
    assert.deepEqual(flagAll(['--on', 'a', '--', '--on', 'b'], '--on'), ['a'])
    assert.equal(flag(['--to', 'x', '--', '--to', 'y'], '--to'), 'x')
  })
})

describe('positionals', () => {
  test('drops known value flags with their values', () => {
    assert.deepEqual(positionals(['a', '--to', 'x', 'b'], new Set(['--to'])), ['a', 'b'])
    assert.deepEqual(positionals(['a', '--to=x', 'b'], new Set(['--to'])), ['a', 'b'])
  })

  test('`--` ends flag parsing — the rest is verbatim text', () => {
    assert.deepEqual(
      positionals(['deploy', '--', '--help', 'now'], new Set(['--to'])),
      ['deploy', '--help', 'now']
    )
  })

  test('strict: an unknown option is a usage error, not a dropped word', () => {
    const r = exits(() => positionals(['msg', '--knd', 'ask'], new Set(['--kind']), { strict: true }))
    assert.equal(r.code, 2)
    assert.match(r.err.join('\n'), /unknown option --knd/)
  })

  test('non-strict keeps the legacy silent drop for other commands', () => {
    assert.deepEqual(positionals(['msg', '--future-flag', 'x'], new Set(['--kind'])), ['msg', 'x'])
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deprecatedFlag } from './args.ts'

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

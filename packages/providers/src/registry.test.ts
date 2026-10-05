import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderEntry } from '@broject/core'
import { providerClient } from './registry.ts'

describe('providerClient', () => {
  test('a systemone entry binds the typed call surface', () => {
    const entry: ProviderEntry = {
      type: 'systemone',
      apiKeyEnv: 'K',
      model: 'jev-1.13.0',
    }
    const client = providerClient('typesafe', entry)
    assert.equal(typeof client.call, 'function')
    assert.equal(client.chat, undefined)
  })

  test('an openai-compat entry binds the raw chat surface', () => {
    const entry: ProviderEntry = {
      type: 'openai-compat',
      baseUrl: 'https://orca.example/v1',
      model: 'qwen3-coder',
    }
    const client = providerClient('orca', entry)
    assert.equal(typeof client.chat, 'function')
    assert.equal(client.call, undefined)
  })

  test('a kind with no binding yet throws — naming provider + kind', () => {
    for (const entry of [
      { type: 'acp', command: 'kilo --acp' },
      { type: 'cli', command: 'devin -p' },
    ] as const) {
      assert.throws(
        () => providerClient('kilo', entry),
        (e: unknown) =>
          e instanceof Error &&
          /providers\.kilo/.test(e.message) &&
          new RegExp(`'${entry.type}'`).test(e.message) &&
          /no client binding yet/.test(e.message)
      )
    }
  })
})

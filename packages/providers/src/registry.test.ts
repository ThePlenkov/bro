import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderEntry } from '@broject/core'
import { providerClient } from './registry.ts'

describe('providerClient', () => {
  test('an api entry binds a surface by its resolved model wire', () => {
    const entry: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://orca.example',
      apiKeyEnv: 'K',
      models: {
        'typesafe/jev-1.13': 'systemone',
        'acme/cheap-chat': 'openai-compat',
      },
    }
    const typed = providerClient('orca', entry, { model: 'typesafe/jev-1.13' })
    assert.equal(typeof typed.call, 'function')
    assert.equal(typed.chat, undefined)
    const prose = providerClient('orca', entry, { model: 'acme/cheap-chat' })
    assert.equal(typeof prose.chat, 'function')
    assert.equal(prose.call, undefined)
    // a single-model entry needs no explicit model
    const solo = providerClient('solo', {
      type: 'api',
      baseUrl: 'https://x',
      models: { 'typesafe/jev-1.13': 'systemone' },
    })
    assert.equal(typeof solo.call, 'function')
  })

  test('an api entry refuses an undeclared model — the allowlist is the point', () => {
    const entry: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://orca.example',
      models: { 'typesafe/jev-1.13': 'systemone' },
    }
    assert.throws(
      () => providerClient('orca', entry, { model: 'kilo/typesafe/jev-router' }),
      (e: unknown) =>
        e instanceof Error &&
        /not served/.test(e.message) &&
        /typesafe\/jev-1\.13/.test(e.message)
    )
  })

  test('an acp entry binds a surface by its resolved model', () => {
    const typed = providerClient('kilo', {
      type: 'acp',
      command: 'kilo --acp',
      model: 'typesafe/jev-1.13',
    })
    assert.equal(typeof typed.call, 'function')
    const prose = providerClient('kilo', { type: 'acp', command: 'kilo --acp' })
    assert.equal(typeof prose.chat, 'function')
  })

  test('a cli entry binds the prose chat surface', () => {
    const client = providerClient('local', { type: 'cli', command: 'devin -p' })
    assert.equal(typeof client.chat, 'function')
    assert.equal(client.call, undefined)
  })

  test('a kind with no binding throws — naming provider + kind', () => {
    const entry = { type: 'vllm' } as unknown as ProviderEntry
    assert.throws(
      () => providerClient('kilo', entry),
      (e: unknown) =>
        e instanceof Error &&
        /providers\.kilo/.test(e.message) &&
        /'vllm'/.test(e.message) &&
        /no client binding/.test(e.message)
    )
  })
})

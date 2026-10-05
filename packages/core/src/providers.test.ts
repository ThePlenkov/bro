import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import {
  getProvider,
  isEnvName,
  parseProviderEntry,
  PROVIDER_KINDS,
  PROVIDER_REGISTRY,
  ProviderSurfaceError,
  requireProviderSurface,
  UnknownProviderError,
  type ProviderEntry,
} from './providers.ts'

function load(raw?: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-providers-'))
  if (raw !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(raw))
  }
  return loadConfig(dir)
}

describe('isEnvName', () => {
  test('SCREAMING_SNAKE names pass', () => {
    for (const v of ['TYPESAFE_API_KEY', 'ORCA_API_KEY', 'X', '_PRIVATE']) {
      assert.equal(isEnvName(v), true, v)
    }
  })

  test('pasted key values and lowercase fail', () => {
    for (const v of ['sk-live-123', 'ts_live_x', 'apiKey', '', '1ABC', 'MY KEY']) {
      assert.equal(isEnvName(v), false, v)
    }
  })
})

describe('providers section', () => {
  test('absent section → empty registry', () => {
    assert.deepEqual(load().providers, {})
    assert.deepEqual(load({}).providers, {})
  })

  test('non-object section → empty registry', () => {
    assert.deepEqual(load({ providers: 'nope' }).providers, {})
    assert.deepEqual(load({ providers: [] }).providers, {})
  })

  test('valid entry of each kind parses', () => {
    const cfg = load({
      providers: {
        typesafe: { type: 'systemone', apiKeyEnv: 'TYPESAFE_API_KEY', model: 'jev-1.13.0' },
        orca: {
          type: 'openai-compat',
          baseUrl: 'https://orca.example/v1',
          apiKeyEnv: 'ORCA_API_KEY',
          model: 'qwen3-coder',
        },
        'kilo-cli': { type: 'acp', command: 'kilo --acp', model: 'typesafe/jev-1.13' },
        local: { type: 'cli', command: 'devin -p', model: 'devin-1' },
      },
    })
    assert.deepEqual(cfg.providers.typesafe, {
      type: 'systemone',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      model: 'jev-1.13.0',
    })
    assert.equal(cfg.providers.orca.type, 'openai-compat')
    assert.equal(cfg.providers['kilo-cli'].type, 'acp')
    assert.equal(cfg.providers.local.type, 'cli')
  })

  test('unknown type drops the entry, keeps the rest', () => {
    const cfg = load({
      providers: {
        bad: { type: 'vllm', model: 'x' },
        ok: { type: 'cli', command: 'devin -p' },
      },
    })
    assert.equal(cfg.providers.bad, undefined)
    assert.equal(cfg.providers.ok.type, 'cli')
  })

  test('missing required field drops the entry', () => {
    const cfg = load({
      providers: {
        nokey: { type: 'systemone', model: 'jev-1.13.0' },
        nomodel: { type: 'openai-compat', baseUrl: 'https://x/v1' },
        nocmd: { type: 'acp', model: 'x' },
      },
    })
    assert.deepEqual(cfg.providers, {})
  })

  test('apiKeyEnv holding a key value (not SCREAMING_SNAKE) drops the entry', () => {
    const cfg = load({
      providers: {
        leaked: { type: 'systemone', apiKeyEnv: 'ts_live_abc123', model: 'jev' },
        ok: { type: 'openai-compat', baseUrl: 'https://x/v1', apiKeyEnv: 'ORCA_API_KEY', model: 'm' },
      },
    })
    assert.equal(cfg.providers.leaked, undefined)
    assert.equal(cfg.providers.ok.type, 'openai-compat')
  })

  test('optional field with wrong type drops the field, keeps the entry', () => {
    const cfg = load({ providers: { local: { type: 'cli', command: 'devin -p', model: 42 } } })
    assert.deepEqual(cfg.providers.local, { type: 'cli', command: 'devin -p' })
  })

  test('unknown extra keys are stripped from the entry', () => {
    const cfg = load({
      providers: { local: { type: 'cli', command: 'devin -p', futureField: 'x' } },
    })
    assert.deepEqual(cfg.providers.local, { type: 'cli', command: 'devin -p' })
  })

  test('non-object and empty-name entries are dropped', () => {
    const cfg = load({ providers: { '': { type: 'cli', command: 'x' }, arr: [1], s: 'x' } })
    assert.deepEqual(cfg.providers, {})
  })
})

describe('PROVIDER_REGISTRY capability matrix', () => {
  test('kind set is the closed spec union', () => {
    assert.deepEqual(PROVIDER_KINDS, ['systemone', 'openai-compat', 'acp', 'cli'])
  })

  test('matrix matches spec: systemone typed-call only, openai-compat prose-call only, acp auto+both, cli prose+spawn', () => {
    assert.deepEqual(PROVIDER_REGISTRY.systemone, {
      call: 'typed',
      spawn: false,
      required: ['apiKeyEnv', 'model'],
      optional: ['baseUrl'],
    })
    assert.equal(PROVIDER_REGISTRY['openai-compat'].call, 'prose')
    assert.equal(PROVIDER_REGISTRY['openai-compat'].spawn, false)
    assert.equal(PROVIDER_REGISTRY.acp.call, 'auto')
    assert.equal(PROVIDER_REGISTRY.acp.spawn, true)
    assert.equal(PROVIDER_REGISTRY.cli.call, 'prose')
    assert.equal(PROVIDER_REGISTRY.cli.spawn, true)
  })
})

describe('provider lookup + surfaces', () => {
  const providers: Record<string, ProviderEntry> = {
    typesafe: { type: 'systemone', apiKeyEnv: 'TYPESAFE_API_KEY', model: 'jev' },
    'kilo-cli': { type: 'acp', command: 'kilo --acp' },
    local: { type: 'cli', command: 'devin -p' },
  }

  test('unknown name throws naming the missing key', () => {
    assert.throws(() => getProvider(providers, 'nope'), UnknownProviderError)
    assert.throws(() => getProvider(providers, 'nope'), /providers\.nope is not configured/)
  })

  test('asking a non-spawn kind to spawn throws naming kind + surface', () => {
    assert.throws(
      () => requireProviderSurface(providers, 'typesafe', 'spawn'),
      (e: unknown) =>
        e instanceof ProviderSurfaceError &&
        /providers\.typesafe \(type 'systemone'\) has no spawn surface/.test(e.message)
    )
  })

  test('spawnable kinds pass the spawn assertion; all kinds pass call', () => {
    assert.equal(requireProviderSurface(providers, 'kilo-cli', 'spawn').type, 'acp')
    assert.equal(requireProviderSurface(providers, 'local', 'spawn').type, 'cli')
    for (const name of Object.keys(providers)) {
      assert.equal(requireProviderSurface(providers, name, 'call').type, providers[name].type)
    }
  })
})

describe('parseProviderEntry', () => {
  test('trims fields and keeps optional ones when valid', () => {
    const e = parseProviderEntry('p', {
      type: 'acp',
      command: '  kilo --acp ',
      profile: 'work',
      apiKeyEnv: 'KILO_KEY',
    })
    assert.deepEqual(e, { type: 'acp', command: 'kilo --acp', profile: 'work', apiKeyEnv: 'KILO_KEY' })
  })

  test('returns null on non-object and bad type', () => {
    assert.equal(parseProviderEntry('p', 'cli'), null)
    assert.equal(parseProviderEntry('p', { type: 'wat' }), null)
    assert.equal(parseProviderEntry('p', {}), null)
  })
})

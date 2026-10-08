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
  providerCallGrade,
  PROVIDER_KINDS,
  PROVIDER_REGISTRY,
  ProviderSurfaceError,
  requireProviderSurface,
  resolveApiModel,
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
        orca: {
          type: 'api',
          baseUrl: 'https://api.orcarouter.ai',
          apiKeyCommand: 'secret-tool lookup service orca',
          model: 'typesafe/jev-1.13',
          models: {
            'typesafe/jev-1.13': 'systemone',
            'acme/cheap-chat': 'openai-compat',
          },
        },
        'kilo-cli': { type: 'acp', command: 'kilo --acp', model: 'typesafe/jev-1.13' },
        local: { type: 'cli', command: 'devin -p', model: 'devin-1' },
      },
    })
    assert.deepEqual(cfg.providers.orca, {
      type: 'api',
      baseUrl: 'https://api.orcarouter.ai',
      apiKeyCommand: 'secret-tool lookup service orca',
      model: 'typesafe/jev-1.13',
      models: {
        'typesafe/jev-1.13': 'systemone',
        'acme/cheap-chat': 'openai-compat',
      },
    })
    assert.equal(cfg.providers['kilo-cli'].type, 'acp')
    assert.equal(cfg.providers.local.type, 'cli')
  })

  test('api models map: bare wire, {wire} object, and null all resolve — null infers by family', () => {
    const cfg = load({
      providers: {
        orca: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'ORCA_API_KEY',
          models: {
            'typesafe/jev-1.13': 'systemone',
            'acme/chat': { wire: 'openai-compat' },
            'auto/inferred-jev': null,
            'typesafe/jev-2.0': null,
            'other/plain': null,
            // {} and {wire:null} are the object spellings of "no pin"
            'auto/empty-obj': {},
            'typesafe/jev-3.1': { wire: null },
          },
        },
      },
    })
    const m = cfg.providers.orca.type === 'api' ? cfg.providers.orca.models : {}
    assert.equal(m['typesafe/jev-1.13'], 'systemone')
    assert.equal(m['acme/chat'], 'openai-compat')
    // inference: typesafe/jev-* → systemone; the version anchor means
    // jev-router is NOT family → openai-compat (prose), never typed
    assert.equal(m['auto/inferred-jev'], 'openai-compat')
    assert.equal(m['typesafe/jev-2.0'], 'systemone')
    assert.equal(m['other/plain'], 'openai-compat')
    assert.equal(m['auto/empty-obj'], 'openai-compat')
    assert.equal(m['typesafe/jev-3.1'], 'systemone')
  })

  test('api models map: a value that is not a wire string, {wire}, or null is an error — never an inference', () => {
    const cfg = load({
      providers: {
        flag: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'X',
          models: { 'a/b': false },
        },
        num: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'X',
          models: { 'a/b': 42 },
        },
        list: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'X',
          models: { 'a/b': ['systemone'] },
        },
        // a foreign-keyed object ({wrie} is a typo, not a pin) is the
        // same malformed shape — it must not silently infer a wire
        typo: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'X',
          models: { 'a/b': { wrie: 'systemone' } },
        },
      },
    })
    assert.deepEqual(cfg.providers, {})
  })

  test("a model literally named 'err' stays a valid id — the parse failure shape is tagged, not key-probed", () => {
    const cfg = load({
      providers: {
        host: {
          type: 'api',
          baseUrl: 'https://x',
          models: { err: 'openai-compat' },
        },
      },
    })
    const m = cfg.providers.host!.type === 'api' ? cfg.providers.host!.models : {}
    assert.equal(m.err, 'openai-compat')
  })

  test('api entry: missing/empty models, bad wire, or a default model outside the allowlist drop the entry', () => {
    const cfg = load({
      providers: {
        nomodels: { type: 'api', baseUrl: 'https://x' },
        empty: { type: 'api', baseUrl: 'https://x', models: {} },
        badwire: { type: 'api', baseUrl: 'https://x', models: { m: 'graphql' } },
        baddefault: {
          type: 'api',
          baseUrl: 'https://x',
          model: 'ghost',
          models: { m: 'systemone' },
        },
      },
    })
    assert.deepEqual(cfg.providers, {})
  })

  test('a systemone-wire model with no key source drops the entry — Bearer is the wire contract', () => {
    const cfg = load({
      providers: {
        nokey: {
          type: 'api',
          baseUrl: 'https://x',
          models: { 'typesafe/jev-1.13': 'systemone' },
        },
        // inference lands on the same wire — a null mapping is no
        // escape from the credential requirement
        inferred: {
          type: 'api',
          baseUrl: 'https://x',
          models: { 'typesafe/jev-1.13': null },
        },
        keyed: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'X',
          models: { 'typesafe/jev-1.13': 'systemone' },
        },
        // the prose wire tolerates no key — openai-compat serves
        // anonymous hosts, so an all-prose map needs no key source
        prose: {
          type: 'api',
          baseUrl: 'https://x',
          models: { 'acme/chat': 'openai-compat' },
        },
      },
    })
    assert.equal(cfg.providers.nokey, undefined)
    assert.equal(cfg.providers.inferred, undefined)
    assert.equal(cfg.providers.keyed.type, 'api')
    assert.equal(cfg.providers.prose.type, 'api')
  })

  test('a __proto__ model id lands as an own key — never pollutes the prototype', () => {
    const cfg = load({
      providers: {
        host: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'X',
          // JSON.parse produces a real own '__proto__' key — an object
          // literal would run the setter instead
          models: JSON.parse('{"__proto__":"systemone","m":null}'),
        },
      },
    })
    const models = cfg.providers.host!.type === 'api' ? cfg.providers.host!.models : {}
    assert.equal(Object.hasOwn(models, '__proto__'), true)
    assert.equal(models['__proto__'], 'systemone')
    // an inherited member is still not a declared model — allowlist
    // checks pin to own keys (hasOwn), never to prototype lookups
    const badDefault = load({
      providers: {
        host: {
          type: 'api',
          baseUrl: 'https://x',
          model: 'constructor',
          models: { m: 'systemone' },
        },
      },
    })
    assert.equal(badDefault.providers.host, undefined)
  })

  test('retired kinds name the migration — the error IS the note', () => {
    const cfg = load({
      providers: {
        old: { type: 'systemone', apiKeyEnv: 'K', model: 'jev' },
        ok: { type: 'cli', command: 'devin -p' },
      },
    })
    assert.equal(cfg.providers.old, undefined)
    assert.equal(cfg.providers.ok.type, 'cli')
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
        nobase: { type: 'api', models: { 'jev-1.13.0': 'systemone' } },
        nocmd: { type: 'acp', model: 'x' },
      },
    })
    assert.deepEqual(cfg.providers, {})
  })

  test('apiKeyEnv holding a key value (not SCREAMING_SNAKE) drops the entry', () => {
    const cfg = load({
      providers: {
        leaked: {
          type: 'api',
          baseUrl: 'https://x',
          apiKeyEnv: 'ts_live_abc123',
          models: { jev: 'systemone' },
        },
        ok: {
          type: 'api',
          baseUrl: 'https://x/v1',
          apiKeyEnv: 'ORCA_API_KEY',
          models: { m: 'openai-compat' },
        },
      },
    })
    assert.equal(cfg.providers.leaked, undefined)
    assert.equal(cfg.providers.ok.type, 'api')
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
    assert.deepEqual(PROVIDER_KINDS, ['api', 'acp', 'cli'])
  })

  test('matrix matches spec: api is auto-call (wire picks the surface), acp auto+spawn, cli prose+spawn', () => {
    assert.deepEqual(PROVIDER_REGISTRY.api, {
      call: 'auto',
      spawn: false,
      required: ['baseUrl'],
      optional: ['model', 'apiKeyEnv', 'apiKeyCommand'],
    })
    assert.equal(PROVIDER_REGISTRY.acp.call, 'auto')
    assert.equal(PROVIDER_REGISTRY.acp.spawn, true)
    assert.equal(PROVIDER_REGISTRY.cli.call, 'prose')
    assert.equal(PROVIDER_REGISTRY.cli.spawn, true)
  })
})

describe('provider lookup + surfaces', () => {
  const providers: Record<string, ProviderEntry> = {
    orca: {
      type: 'api',
      baseUrl: 'https://x',
      apiKeyEnv: 'ORCA_KEY',
      models: { 'typesafe/jev-1.13': 'systemone' },
    },
    'kilo-cli': { type: 'acp', command: 'kilo --acp' },
    local: { type: 'cli', command: 'devin -p' },
  }

  test('unknown name throws naming the missing key', () => {
    assert.throws(() => getProvider(providers, 'nope'), UnknownProviderError)
    assert.throws(() => getProvider(providers, 'nope'), /providers\.nope is not configured/)
    // inherited members are not configured entries — 'constructor'
    // must throw, not return Function.prototype.constructor
    assert.throws(() => getProvider(providers, 'constructor'), UnknownProviderError)
  })

  test('asking a non-spawn kind to spawn throws naming kind + surface', () => {
    assert.throws(
      () => requireProviderSurface(providers, 'orca', 'spawn'),
      (e: unknown) =>
        e instanceof ProviderSurfaceError &&
        /providers\.orca \(type 'api'\) has no spawn surface/.test(e.message)
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
      autoApprove: true,
    })
    assert.deepEqual(e, {
      type: 'acp',
      command: 'kilo --acp',
      profile: 'work',
      apiKeyEnv: 'KILO_KEY',
      autoApprove: true,
    })
  })

  test('a non-boolean autoApprove drops the field, keeps the entry', () => {
    const e = parseProviderEntry('p', {
      type: 'acp',
      command: 'kilo --acp',
      autoApprove: 'yes',
    })
    assert.deepEqual(e, { type: 'acp', command: 'kilo --acp' })
  })

  test('autoApprove on a kind without the knob is stripped like any unknown key', () => {
    const e = parseProviderEntry('p', { type: 'cli', command: 'devin -p', autoApprove: true })
    assert.deepEqual(e, { type: 'cli', command: 'devin -p' })
  })

  test('returns null on non-object and bad type', () => {
    assert.equal(parseProviderEntry('p', 'cli'), null)
    assert.equal(parseProviderEntry('p', { type: 'wat' }), null)
    assert.equal(parseProviderEntry('p', {}), null)
  })

  test('an apiKeyCommand smuggling a key value drops the entry', () => {
    for (const cmd of [
      'echo sk-abc123',
      'printf ts_live_abc123',
      'printf ts_test_abc123',
      'curl -H "Bearer x" https://x',
    ]) {
      const e = parseProviderEntry('p', {
        type: 'api',
        baseUrl: 'https://x',
        apiKeyCommand: cmd,
        models: { jev: 'systemone' },
      })
      assert.equal(e, null, cmd)
    }
    const ok = parseProviderEntry('p', {
      type: 'api',
      baseUrl: 'https://x',
      apiKeyCommand: 'pass show bro/typesafe',
      models: { jev: 'systemone' },
    })
    assert.equal(ok?.type, 'api')
  })

  test('resolveApiModel: requested wins, default pin is the fallback, single-model needs neither', () => {
    const entry: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://x',
      model: 'typesafe/jev-1.13',
      models: { 'typesafe/jev-1.13': 'systemone', 'acme/x': 'openai-compat' },
    }
    assert.deepEqual(resolveApiModel(entry, 'acme/x'), {
      model: 'acme/x',
      wire: 'openai-compat',
    })
    assert.deepEqual(resolveApiModel(entry, undefined), {
      model: 'typesafe/jev-1.13',
      wire: 'systemone',
    })
    const solo: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://x',
      models: { 'typesafe/jev-1.13': 'systemone' },
    }
    assert.deepEqual(resolveApiModel(solo, undefined), {
      model: 'typesafe/jev-1.13',
      wire: 'systemone',
    })
    assert.throws(
      () => resolveApiModel(entry, 'kilo/typesafe/jev-router'),
      /not served.*declared: typesafe\/jev-1\.13, acme\/x/
    )
    assert.throws(() => resolveApiModel({ ...entry, model: undefined }, undefined), /name one/)
  })
})

describe('providerCallGrade — the RESOLVED grade (spec bro-1x7p M7)', () => {
  test('an api entry grades on the resolved model wire', () => {
    const typed: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://x',
      models: { 'typesafe/jev-1.13': 'systemone' },
    }
    assert.equal(providerCallGrade(typed), 'typed')
    const prose: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://x',
      models: { 'acme/x': 'openai-compat' },
    }
    assert.equal(providerCallGrade(prose), 'prose')
  })

  test('an acp entry grades on its model pin — jev-family typed, else prose', () => {
    assert.equal(
      providerCallGrade({ type: 'acp', command: 'x', model: 'kilo/orcarouter/typesafe/jev-1.13' }),
      'typed'
    )
    assert.equal(providerCallGrade({ type: 'acp', command: 'x', model: 'claude-4' }), 'prose')
    // 'jev-router' is a router PRODUCT, not a jev model — isSystemoneFamily's
    // version anchor keeps it prose
    assert.equal(providerCallGrade({ type: 'acp', command: 'x', model: 'jev-router' }), 'prose')
    assert.equal(providerCallGrade({ type: 'acp', command: 'x' }), 'prose')
  })

  test('a cli entry is always prose — an undeclared api model propagates the config error', () => {
    assert.equal(providerCallGrade({ type: 'cli', command: 'x' }), 'prose')
    const ambiguous: ProviderEntry = {
      type: 'api',
      baseUrl: 'https://x',
      models: { 'a/m': 'systemone', 'b/m': 'openai-compat' },
    }
    assert.throws(() => providerCallGrade(ambiguous), /name one/)
  })
})

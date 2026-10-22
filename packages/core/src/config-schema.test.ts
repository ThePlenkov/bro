import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from './testtmp.ts'
import type { ConfigSection, JsonSchema } from './config.ts'
import {
  configDiagnostics,
  configPolicyErrors,
  CONFIG_SCHEMA_URL,
  configSchemaDocument,
  jsonSchemasFor,
  validateSchemaValue,
} from './config-schema.ts'
import { scrubEnv, testGit } from './testkit.ts'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

// the global layer reads $XDG_CONFIG_HOME/bro — pin it to an empty tmp
// for the whole file so a dev machine's real user config can't leak in
const XDG = tmpDir('bro-schema-xdg-')
const prevXdg = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = XDG
process.on('exit', () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
})

function dirWith(layer: 'bro.config.json' | 'bro.config.local.json', raw: unknown): string {
  const dir = tmpDir('bro-schema-')
  writeFileSync(join(dir, layer), JSON.stringify(raw))
  return dir
}

describe('validateSchemaValue', () => {
  const check = (v: unknown, s: Parameters<typeof validateSchemaValue>[1]) =>
    validateSchemaValue(v, s, 'k')

  test('clean values report nothing', () => {
    assert.deepEqual(check(3, { type: 'integer', minimum: 0 }), [])
    assert.deepEqual(check('a', { type: 'string', minLength: 1 }), [])
    assert.deepEqual(check('off', { enum: ['off', 'gate'] }), [])
  })

  test('a wrong type reports one error and stops — no cascade noise', () => {
    const e = check('1', { type: 'integer' })
    assert.equal(e.length, 1)
    assert.equal(e[0].path, 'k')
    assert.match(e[0].message, /must be integer/)
  })

  test('enum violations name the allowed set and the offender', () => {
    const e = check('gtae', { enum: ['off', 'remind', 'gate'] })
    assert.equal(e.length, 1)
    assert.match(e[0].message, /"off"|"gate"/)
    assert.match(e[0].message, /"gtae"/)
  })

  test('closed objects name unknown keys; nested paths dot through', () => {
    const e = check(
      { mode: 'gate', typo: 1 },
      { type: 'object', properties: { mode: { enum: ['gate'] } }, additionalProperties: false }
    )
    assert.deepEqual(e.map((x) => x.message), ['unknown key "typo"'])
    const nested = check(
      { outer: { inner: 'x' } },
      {
        type: 'object',
        properties: { outer: { type: 'object', properties: { inner: { type: 'integer' } } } },
      }
    )
    assert.equal(nested[0].path, 'k.outer.inner')
  })

  test('anyOf passes on one clean branch, reports the discriminant branch on failure', () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: 'object', properties: { type: { const: 'api' }, n: { type: 'integer' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'cli' }, s: { type: 'string' } }, required: ['type'] },
      ],
    }
    assert.deepEqual(check({ type: 'cli', s: 'x' }, schema), [])
    const e = check({ type: 'cli', n: 5, s: 3 }, schema)
    // the cli branch's violations surface, not the api branch's
    assert.ok(e.some((x) => x.path === 'k.s'))
    assert.ok(!e.some((x) => x.path === 'k.n'))
  })

  test('bounds, patterns, list plumbing', () => {
    assert.ok(check(0.5, { type: 'number', minimum: 1 }).length > 0)
    assert.ok(check(1.5, { type: 'integer' }).length > 0)
    assert.ok(check('nope', { type: 'string', pattern: '^mesh://' }).length > 0)
    assert.ok(check(['a', 2], { type: 'array', items: { type: 'string' } })[0].path === 'k[1]')
    assert.ok(check('x'.repeat(5), { type: 'string', maxLength: 3 }).length > 0)
  })
})

describe('configDiagnostics', () => {
  test('the audit examples — string fleet cap, bad sdd mode, dropped connector pin', () => {
    const dir = dirWith('bro.config.json', {
      fleet: { maxConcurrent: '1' },
      sdd: { mode: 'gtae' },
      connectors: { tasks: 42 },
    })
    const diags = configDiagnostics(dir)
    const byPath = new Map(diags.map((d) => [d.path, d]))
    assert.match(byPath.get('fleet.maxConcurrent')?.message ?? '', /integer/)
    assert.match(byPath.get('sdd.mode')?.message ?? '', /"off"|"gate"/)
    assert.match(byPath.get('connectors.tasks')?.message ?? '', /string/)
    for (const d of diags) {
      assert.equal(d.layer, 'project')
      assert.ok(d.file.endsWith('bro.config.json'))
    }
  })

  test('a clean config produces no diagnostics', () => {
    const dir = dirWith('bro.config.json', {
      sdd: { mode: 'gate' },
      act: { ignoreChecks: ['kilo', { name: 'x', consecutiveFailures: 2 }] },
      fleet: { maxConcurrent: 3, routing: { default: { chain: [{ provider: 'devin' }] } } },
    })
    assert.deepEqual(configDiagnostics(dir), [])
  })

  test('diagnostics carry layer + file provenance per hit', () => {
    const dir = tmpDir('bro-schema-')
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ sdd: { mode: 'gtae' } }))
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify({ fleet: { maxConcurrent: -1 } }))
    const diags = configDiagnostics(dir)
    const local = diags.find((d) => d.key === 'fleet')
    const project = diags.find((d) => d.key === 'sdd')
    assert.equal(local?.layer, 'local')
    assert.ok(local?.file.endsWith('bro.config.local.json'))
    assert.equal(project?.layer, 'project')
  })

  test('a linked worktree sees the main checkout — including its local layer', () => {
    // real git: --git-common-dir can't be faked (same fixture as
    // loadConfig's worktree tests)
    const main = realpathSync(tmpDir('bro-schema-main-'))
    testGit(['init', '-q', main])
    testGit(['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const wt = tmpDir('bro-schema-wt-')
    testGit(['-C', main, 'worktree', 'add', '-qf', '--detach', wt])
    writeFileSync(join(main, 'bro.config.local.json'), JSON.stringify({ loop: { stallMin: 'soon' } }))
    const diags = configDiagnostics(wt, { loop: loopSectionStub })
    const hit = diags.find((d) => d.path === 'loop.stallMin')
    assert.equal(hit?.layer, 'local')
    assert.equal(hit?.file, join(main, 'bro.config.local.json'))
  })

  test('plugin sections validate through the same merged registry', () => {
    const dir = dirWith('bro.config.json', { custom: { level: 'high' } })
    const section: ConfigSection<unknown> = Object.assign((raw: unknown) => raw, {
      jsonSchema: { type: 'object', properties: { level: { type: 'integer' } }, additionalProperties: false },
    })
    const diags = configDiagnostics(dir, { custom: section })
    assert.equal(diags[0]?.path, 'custom.level')
  })

  test('unknown keys are skipped — external plugin configKeys are uncheckable', () => {
    const dir = dirWith('bro.config.json', { notARealKey: { anything: true } })
    assert.deepEqual(configDiagnostics(dir), [])
  })
})

describe('configPolicyErrors', () => {
  test('policy sections gate, operator sections do not', () => {
    const dir = dirWith('bro.config.json', {
      sdd: { mode: 'gtae' }, // policy
      providers: { x: { type: 'bogus' } }, // operator
      fleet: { maxConcurrent: '1' }, // operator
      personality: 'unknown', // operator top-level scalar
    })
    const diags = configDiagnostics(dir)
    assert.ok(diags.length >= 4)
    const policy = configPolicyErrors(dir)
    assert.deepEqual(policy.map((d) => d.key), ['sdd'])
  })

  test('policy violations in a local file also gate', () => {
    const dir = dirWith('bro.config.local.json', { act: { maxRounds: 'many' } })
    assert.deepEqual(configPolicyErrors(dir).map((d) => d.path), ['act.maxRounds'])
  })
})

describe('configSchemaDocument', () => {
  test('carries every CORE_SECTIONS key plus the registry merge', () => {
    const doc = configSchemaDocument()
    // beads/stack/agents are plugin-registered (plugins.ts declares them
    // as configKey + configSchema) — the emitted doc merges them in via
    // pluginConfigSections; bare core owns only these
    for (const key of [
      'debt', 'sync', 'sweep', 'act', 'connectors', 'providers', 'sdd', 'fleet',
      'query', 'mesh', 'mcp', 'mirror', 'notify', 'serve',
    ]) {
      assert.ok(key in (doc.properties as object), `missing ${key}`)
    }
    // top-level scalars + the self-reference key
    for (const key of ['$schema', 'stores', 'store', 'personality', 'plugins', 'pack']) {
      assert.ok(key in (doc.properties as object), `missing ${key}`)
    }
    assert.equal(doc.$schema, 'http://json-schema.org/draft-07/schema#')
    assert.equal(doc.$id, CONFIG_SCHEMA_URL)
    assert.equal(doc.additionalProperties, true)
  })

  test('plugin sections merge; a core key is not clobbered', () => {
    const mine: ConfigSection<unknown> = Object.assign((r: unknown) => r, {
      jsonSchema: { type: 'object', title: 'mine' },
    })
    const fakeAct: ConfigSection<unknown> = Object.assign((r: unknown) => r, {
      jsonSchema: { type: 'object', title: 'fake act' },
    })
    const doc = configSchemaDocument({ mine, act: fakeAct })
    const props = doc.properties as Record<string, { title?: string }>
    assert.equal(props.mine?.title, 'mine')
    assert.notEqual(props.act?.title, 'fake act')
  })
})

describe('jsonSchemasFor', () => {
  test('sections without a declared schema are skipped, not broken', () => {
    const bare = ((r: unknown) => r) as ConfigSection<unknown>
    const schemas = jsonSchemasFor({ bare })
    assert.ok(!('bare' in schemas))
    assert.ok('sdd' in schemas) // core registry always present
  })
})

/** Minimal plugin-style section for diagnostics tests — mirrors a real
 *  registered section without importing a plugin package. */
const loopSectionStub: ConfigSection<unknown> = Object.assign(
  (raw: unknown) => raw,
  {
    jsonSchema: {
      type: 'object',
      properties: { stallMin: { type: 'number', minimum: 1 } },
      additionalProperties: false,
    },
  }
)

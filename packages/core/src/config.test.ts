import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DEFAULT_CONFIG, defineConfig, loadConfig } from './config.ts'

function load(raw?: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
  if (raw !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(raw))
  }
  return loadConfig(dir)
}

describe('loadConfig stores', () => {
  test('no config file → beads on by default', () => {
    assert.deepEqual(load().stores, ['jsonl', 'beads'])
  })

  test('config without a stores key → beads on by default', () => {
    assert.deepEqual(load({ personality: 'mentor' }).stores, ['jsonl', 'beads'])
  })

  test('explicit stores: ["jsonl"] is the opt-out', () => {
    assert.deepEqual(load({ stores: ['jsonl'] }).stores, ['jsonl'])
  })

  test('explicit stores keeps jsonl first, dedupes', () => {
    assert.deepEqual(load({ stores: ['beads', 'jsonl', 'beads'] }).stores, [
      'jsonl',
      'beads',
    ])
  })

  test('unknown backend names are dropped, not fatal', () => {
    assert.deepEqual(load({ stores: ['beed'] }).stores, ['jsonl'])
  })

  test('legacy store: "jsonl" stays jsonl-only', () => {
    assert.deepEqual(load({ store: 'jsonl' }).stores, ['jsonl'])
  })

  test('legacy store: "beads"/"both" → jsonl + beads', () => {
    assert.deepEqual(load({ store: 'beads' }).stores, ['jsonl', 'beads'])
    assert.deepEqual(load({ store: 'both' }).stores, ['jsonl', 'beads'])
  })

  test('mistyped legacy store value falls back to jsonl-only', () => {
    assert.deepEqual(load({ store: 'beed' }).stores, ['jsonl'])
  })

  test('non-array stores field falls back to jsonl-only', () => {
    assert.deepEqual(load({ stores: 'bead' }).stores, ['jsonl'])
  })

  test('malformed config file falls back to jsonl-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    writeFileSync(join(dir, 'bro.config.json'), '{oops')
    assert.deepEqual(loadConfig(dir).stores, ['jsonl'])
  })

  test('stores array beats legacy store field', () => {
    assert.deepEqual(load({ store: 'beads', stores: ['jsonl'] }).stores, ['jsonl'])
  })

  test('DEFAULT_CONFIG itself is jsonl + beads', () => {
    assert.deepEqual(DEFAULT_CONFIG.stores, ['jsonl', 'beads'])
  })
})

describe('loadConfig root shape', () => {
  test('non-object JSON roots fall back to jsonl-only', () => {
    for (const root of ['str', [1, 2], 42, null, true]) {
      assert.deepEqual(load(root).stores, ['jsonl'], `root ${JSON.stringify(root)}`)
    }
  })

  test('empty object is a valid config', () => {
    assert.deepEqual(load({}), DEFAULT_CONFIG)
  })

  test('nested debt config merges over defaults', () => {
    assert.equal(load({ debt: { dir: 'debt-out' } }).debt.dir, 'debt-out')
    assert.equal(load({ debt: { dir: 'debt-out' } }).personality, 'terse')
  })

  test('non-string sync fields fall back to defaults', () => {
    const cfg = load({ sync: { remote: null, ref: 'refs/bro/custom' } })
    assert.equal(cfg.sync.remote, 'origin')
    assert.equal(cfg.sync.ref, 'refs/bro/custom')
  })

  test('non-object sync section falls back to defaults', () => {
    assert.deepEqual(load({ sync: 'x' }).sync, DEFAULT_CONFIG.sync)
  })

  test('act.ignoreChecks keeps only strings', () => {
    const cfg = load({ act: { ignoreChecks: ['kilo', 42, 'flaky-bot', '', '  '] } })
    assert.deepEqual(cfg.act.ignoreChecks, ['kilo', 'flaky-bot'])
  })

  test('non-object act section falls back to defaults', () => {
    assert.deepEqual(load({ act: 'x' }).act, DEFAULT_CONFIG.act)
  })
})

function loadTs(
  source: string,
  json?: unknown,
  pkg: unknown = { type: 'module' }
): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
  writeFileSync(join(dir, 'bro.config.ts'), source)
  if (json !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(json))
  }
  // a dir with no package.json resolves .ts as CommonJS on Node ≤24 —
  // `export default` then fails to transform. Tests model real repos,
  // so the module type is always explicit (default ESM, the canonical form)
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  return loadConfig(dir)
}

describe('loadConfig bro.config.ts', () => {
  test('export default object loads', () => {
    const cfg = loadTs('export default { personality: "mentor" }')
    assert.equal(cfg.personality, 'mentor')
    assert.deepEqual(cfg.stores, ['jsonl', 'beads'])
  })

  test('module.exports object loads in a CJS repo', () => {
    const cfg = loadTs(
      'module.exports = { debt: { dir: "d" } }',
      undefined,
      { type: 'commonjs' }
    )
    assert.equal(cfg.debt.dir, 'd')
  })

  test('module.exports in an ESM repo applies or falls back cleanly', () => {
    // plain Node throws "module is not defined" → jsonl-only; tsx's CJS
    // interop applies it — either way the result must be a whole config,
    // never a half-loaded one
    const cfg = loadTs(
      'module.exports = { personality: "sarcastic" }',
      undefined,
      { type: 'module' }
    )
    assert.ok(['sarcastic', 'terse'].includes(cfg.personality))
  })

  test('.ts with import statements loads', () => {
    // require() can't take ESM syntax on every runtime — the subprocess
    // import() fallback must carry configs with real imports
    const cfg = loadTs(
      'import { join } from "node:path"\nexport default { personality: join("men", "tor") }'
    )
    assert.equal(cfg.personality, join('men', 'tor'))
  })

  test('.ts wins over .json when both exist', () => {
    const cfg = loadTs('export default { personality: "sarcastic" }', {
      personality: 'mentor',
    })
    assert.equal(cfg.personality, 'sarcastic')
  })

  test('non-Error throw falls back cleanly', () => {
    const cfg = loadTs('throw null')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('broken .ts falls back to jsonl-only, never to .json', () => {
    const cfg = loadTs('export default {{{', { stores: ['jsonl', 'beads'] })
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('non-object .ts export falls back to jsonl-only', () => {
    const cfg = loadTs('export default 42')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('export default null does not leak the module namespace', () => {
    const cfg = loadTs('export default null')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('relative cwd resolves bro.config.ts too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-rel-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(dir, 'bro.config.ts'), 'export default { personality: "sarcastic" }')
    const rel = relative(process.cwd(), dir)
    assert.equal(loadConfig(rel).personality, 'sarcastic')
  })

  test('defineConfig is a pass-through', () => {
    assert.deepEqual(defineConfig({ personality: 'mentor', extra: 1 }), {
      personality: 'mentor',
      extra: 1,
    })
  })
})

describe('loadConfig plugin sections', () => {
  function loadWith(
    raw: unknown,
    sections: Parameters<typeof loadConfig>[1]
  ): ReturnType<typeof loadConfig> {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(raw))
    return loadConfig(dir, sections)
  }

  test('registered schema normalizes its section', () => {
    const cfg = loadWith(
      { myplug: { opt: 'x', junk: true } },
      { myplug: (r) => ({ opt: (r as { opt?: string }).opt ?? 'default' }) }
    )
    assert.equal((cfg.myplug as { opt: string }).opt, 'x')
  })

  test('missing section still gets schema defaults', () => {
    const cfg = loadWith({}, { myplug: () => ({ opt: 'default' }) })
    assert.equal((cfg.myplug as { opt: string }).opt, 'default')
  })

  test('throwing schema warns and falls back to schema(undefined)', () => {
    const cfg = loadWith(
      { myplug: { bad: true } },
      {
        myplug: (r) => {
          if (r !== undefined) throw new Error('bad section')
          return { opt: 'default' }
        },
      }
    )
    assert.equal((cfg.myplug as { opt: string }).opt, 'default')
  })
})

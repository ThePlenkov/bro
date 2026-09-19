import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})

function loadTs(source: string, json?: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
  writeFileSync(join(dir, 'bro.config.ts'), source)
  if (json !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(json))
  }
  return loadConfig(dir)
}

describe('loadConfig bro.config.ts', () => {
  test('export default object loads', () => {
    const cfg = loadTs('export default { personality: "mentor" }')
    assert.equal(cfg.personality, 'mentor')
    assert.deepEqual(cfg.stores, ['jsonl', 'beads'])
  })

  test('module.exports object loads', () => {
    const cfg = loadTs('module.exports = { debt: { dir: "d" } }')
    assert.equal(cfg.debt.dir, 'd')
  })

  test('.ts wins over .json when both exist', () => {
    const cfg = loadTs('export default { personality: "sarcastic" }', {
      personality: 'mentor',
    })
    assert.equal(cfg.personality, 'sarcastic')
  })

  test('broken .ts falls back to jsonl-only, never to .json', () => {
    const cfg = loadTs('export default {{{', { stores: ['jsonl', 'beads'] })
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('non-object .ts export falls back to jsonl-only', () => {
    const cfg = loadTs('export default 42')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('defineConfig is a pass-through', () => {
    assert.deepEqual(defineConfig({ personality: 'mentor', extra: 1 }), {
      personality: 'mentor',
      extra: 1,
    })
  })
})

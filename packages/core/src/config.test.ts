import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, loadConfig } from './config.ts'

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

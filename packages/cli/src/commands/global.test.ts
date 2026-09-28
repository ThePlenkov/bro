import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsSection, DEFAULT_GLOBAL_BEADS_DIR } from '@bro/core'
import { resolveGlobalDir } from './global.ts'

const DEFAULT_GLOBAL_DIR = DEFAULT_GLOBAL_BEADS_DIR

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  try {
    return fn()
  } finally {
    if (prev === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = prev
    }
  }
}

function configDir(beads: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-global-cfg-'))
  writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ beads }))
  return dir
}

describe('beadsSection', () => {
  test('defaults to the XDG store dir', () => {
    withEnv('BRO_GLOBAL_BEADS', undefined, () => {
      assert.deepEqual(beadsSection(undefined), { global: DEFAULT_GLOBAL_DIR })
      assert.deepEqual(beadsSection({}), { global: DEFAULT_GLOBAL_DIR })
    })
  })

  test('config value wins over the default; env wins over config', () => {
    withEnv('BRO_GLOBAL_BEADS', undefined, () => {
      assert.equal(beadsSection({ global: '/srv/beads' }).global, '/srv/beads')
    })
    withEnv('BRO_GLOBAL_BEADS', '/tmp/env-beads', () => {
      assert.equal(beadsSection({ global: '/srv/beads' }).global, '/tmp/env-beads')
    })
  })

  test('~/ expands against the home dir', () => {
    withEnv('BRO_GLOBAL_BEADS', undefined, () => {
      assert.equal(beadsSection({ global: '~/beads' }).global, join(homedir(), 'beads'))
    })
  })

  test('non-string and blank values fall back to the default', () => {
    withEnv('BRO_GLOBAL_BEADS', undefined, () => {
      assert.equal(beadsSection({ global: 42 }).global, DEFAULT_GLOBAL_DIR)
      assert.equal(beadsSection({ global: '   ' }).global, DEFAULT_GLOBAL_DIR)
      assert.equal(beadsSection('beads').global, DEFAULT_GLOBAL_DIR)
    })
    withEnv('BRO_GLOBAL_BEADS', '  ', () => {
      assert.equal(beadsSection(undefined).global, DEFAULT_GLOBAL_DIR)
    })
  })
})

describe('resolveGlobalDir', () => {
  test('reads beads.global from bro.config.json', () => {
    const dir = configDir({ global: '/tmp/store-from-config' })
    try {
      withEnv('BRO_GLOBAL_BEADS', undefined, () => {
        assert.equal(resolveGlobalDir(dir), '/tmp/store-from-config')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('env overrides the config file', () => {
    const dir = configDir({ global: '/tmp/store-from-config' })
    try {
      withEnv('BRO_GLOBAL_BEADS', '/tmp/store-from-env', () => {
        assert.equal(resolveGlobalDir(dir), '/tmp/store-from-env')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a relative beads.global anchors at cwd, not the process dir', () => {
    const dir = configDir({ global: 'rel-store' })
    try {
      withEnv('BRO_GLOBAL_BEADS', undefined, () => {
        assert.equal(resolveGlobalDir(dir), join(dir, 'rel-store'))
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no config file and no env → the default store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-global-empty-'))
    try {
      withEnv('BRO_GLOBAL_BEADS', undefined, () => {
        assert.equal(resolveGlobalDir(dir), DEFAULT_GLOBAL_DIR)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

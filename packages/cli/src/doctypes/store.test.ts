import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsSection, DEFAULT_GLOBAL_BEADS_DIR } from '@broject/core'
import { initStore, requireGlobalStore, resolveGlobalDir } from './store.ts'
import { taskDoc } from './task.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'bro-store-cfg-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'bro-store-empty-'))
    try {
      withEnv('BRO_GLOBAL_BEADS', undefined, () => {
        assert.equal(resolveGlobalDir(dir), DEFAULT_GLOBAL_DIR)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Intercept process.exit — the store guards are loud exits, and a
 *  regression that drops them would silently read an empty queue. */
function captureExit(fn: () => unknown): { code: number | undefined; err: string } {
  const origExit = process.exit
  const origErr = console.error
  const lines: string[] = []
  let code: number | undefined
  process.exit = ((c?: number) => {
    code = c
    throw new Error('__exit__')
  }) as typeof process.exit
  console.error = (...a: unknown[]) => {
    lines.push(a.join(' '))
  }
  try {
    fn()
  } catch (err) {
    if ((err as Error).message !== '__exit__') {
      throw err
    }
  } finally {
    process.exit = origExit
    console.error = origErr
  }
  return { code, err: lines.join('\n') }
}

describe('requireGlobalStore', () => {
  test('exits 2 with an init hint when the store was never created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-store-noval-'))
    const store = join(dir, 'no-store')
    try {
      withEnv('BRO_GLOBAL_BEADS', store, () => {
        const r = captureExit(() => requireGlobalStore(dir))
        assert.equal(r.code, 2)
        assert.match(r.err, /bro store init --global/)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns the dir when .beads exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-store-ok-'))
    const store = join(dir, 'store')
    mkdirSync(join(store, '.beads'), { recursive: true })
    try {
      withEnv('BRO_GLOBAL_BEADS', store, () => {
        assert.equal(requireGlobalStore(dir), store)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bd missing (ENOENT)', () => {
  // an empty PATH dir makes spawnSync fail with ENOENT deterministically —
  // no fake bd binary, no reliance on the host's install state
  function withoutPath<T>(fn: () => T): T {
    const empty = mkdtempSync(join(tmpdir(), 'bro-nopath-'))
    try {
      return withEnv('PATH', empty, fn)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  }

  test('store init reports "bd not found", not "bd init failed" — and strands no dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-store-init-'))
    const store = join(dir, 'store')
    try {
      withEnv('BRO_GLOBAL_BEADS', store, () => {
        const r = captureExit(() => withoutPath(() => initStore('global', {}, dir)))
        assert.equal(r.code, 1)
        assert.match(r.err, /bd not found/)
      })
      assert.equal(existsSync(store), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('task exec passthrough reports "bd not found" instead of a silent exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-store-exec-'))
    try {
      const exec = taskDoc.adapter({ root: dir, scope: 'project' }).exec as
        | ((ref: unknown, flags: object, args: string[]) => unknown)
        | undefined
      const r = captureExit(() => withoutPath(() => exec?.(undefined, {}, ['list'])))
      assert.equal(r.code, 1)
      assert.match(r.err, /bd not found/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

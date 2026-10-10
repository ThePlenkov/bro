import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BdCompatError,
  checkBeads,
  isBdCompatError,
  isBdNotFound,
  probeBdCompat,
} from './bd.ts'

const WIN32 = process.platform === 'win32'

/** Scripted bd — env knobs drive each failure mode. With no knob set it
 *  answers a healthy store: version, array-shaped reads, schema 1. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version)
    [ "$FAKE_BD_VERSION_FAIL" = "1" ] && { echo 'Error: exec format error' >&2; exit 1; }
    echo 'bd version 1.3.0 (fake)' ;;
  list|ready)
    [ "$FAKE_BD_NO_STORE" = "1" ] && { echo 'Error: no beads database found' >&2; exit 1; }
    [ "$FAKE_BD_FLAG_DRIFT" = "1" ] && { echo 'Error: unknown flag: --json' >&2; exit 1; }
    [ "$1" = "ready" ] && [ "$FAKE_BD_READY_FAIL" = "1" ] && { echo 'Error: database is locked' >&2; exit 1; }
    [ "$FAKE_BD_SHAPE_DRIFT" = "1" ] && { echo '{"issues":[]}'; exit 0; }
    [ "$FAKE_BD_ROW_DRIFT" = "1" ] && { echo '[{"name":"x"}]'; exit 0; }
    echo '[]' ;;
  info)
    [ "$FAKE_BD_INFO_MISSING" = "1" ] && { echo 'Error: unknown command "info" for "bd"' >&2; exit 1; }
    echo "{\\"schema_version\\":\${FAKE_BD_SCHEMA:-1}}" ;;
  *) exit 1 ;;
esac
`

function withFakeBd(env: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-bd-compat-'))
  writeFileSync(join(dir, 'bd'), FAKE_BD)
  chmodSync(join(dir, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  process.env.PATH = `${dir}:${prevPath}`
  Object.assign(process.env, env)
  try {
    fn()
  } finally {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** PATH with no bd at all — only the real git must stay reachable. */
function withoutBd(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-bd-absent-'))
  const prevPath = process.env.PATH
  process.env.PATH = dir
  try {
    fn()
  } finally {
    process.env.PATH = prevPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('probeBdCompat', { skip: WIN32 }, () => {
  test('healthy bd — ok, version parsed, store reachable', () => {
    withFakeBd({}, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, true)
      assert.equal(c.missing, false)
      assert.equal(c.version, '1.3.0')
      assert.equal(c.store, 'reachable')
      assert.deepEqual(c.problems, [])
    })
  })

  test('no bd on PATH — missing, not drift', () => {
    withoutBd(() => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.equal(c.missing, true)
    })
  })

  test('missing bd under the timeout supervisor still classifies as missing', () => {
    // PATH carries only a symlink to the real GNU timeout — bd absent.
    // The supervisor reports "failed to run command 'bd': No such file
    // or directory"; bdTry must normalize that to ENOENT so consumers
    // classify the setup gap exactly like a bare spawn.
    const timeoutPath = ['/usr/bin/timeout', '/bin/timeout', '/usr/local/bin/timeout'].find(
      existsSync
    )
    if (timeoutPath === undefined) {
      return // no GNU timeout on this host — bare spawn already yields ENOENT
    }
    const dir = mkdtempSync(join(tmpdir(), 'bro-bd-supervised-miss-'))
    symlinkSync(timeoutPath, join(dir, 'timeout'))
    const prevPath = process.env.PATH
    process.env.PATH = dir
    try {
      const c = probeBdCompat()
      assert.equal(c.missing, true)
      assert.equal(c.broken, false)
    } finally {
      process.env.PATH = prevPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('non-array --json payload is drift', () => {
    withFakeBd({ FAKE_BD_SHAPE_DRIFT: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.ok(c.problems.some((p) => /expected an array/.test(p)))
    })
  })

  test('rows without a string id are drift', () => {
    withFakeBd({ FAKE_BD_ROW_DRIFT: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.ok(c.problems.some((p) => /string `id`/.test(p)))
    })
  })

  test('rejected --json flag is drift', () => {
    withFakeBd({ FAKE_BD_FLAG_DRIFT: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.ok(c.problems.some((p) => /unknown flag/.test(p)))
    })
  })

  test('a newer store schema_version is drift', () => {
    withFakeBd({ FAKE_BD_SCHEMA: '2' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.ok(c.problems.some((p) => /schema_version 2/.test(p)))
    })
  })

  test('missing bd info subcommand is drift', () => {
    withFakeBd({ FAKE_BD_INFO_MISSING: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.ok(c.problems.some((p) => /`bd info`/.test(p)))
    })
  })

  test('no store — ok but inconclusive, not drift', () => {
    withFakeBd({ FAKE_BD_NO_STORE: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, true)
      assert.equal(c.store, 'absent')
    })
  })

  test('a bd that cannot answer --version is broken, not drift', () => {
    withFakeBd({ FAKE_BD_VERSION_FAIL: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, false)
      assert.equal(c.broken, true)
      assert.equal(c.missing, false)
    })
  })

  test('a transient read failure is a store error, not drift', () => {
    withFakeBd({ FAKE_BD_READY_FAIL: '1' }, () => {
      const c = probeBdCompat()
      assert.equal(c.ok, true)
      assert.equal(c.store, 'error')
      assert.match(c.storeErr ?? '', /database is locked/)
      assert.deepEqual(c.problems, [])
    })
  })
})

describe('isBdNotFound', () => {
  test('malformed thrown values are non-matches, never a throw', () => {
    assert.equal(isBdNotFound(null), false)
    assert.equal(isBdNotFound(undefined), false)
    assert.equal(isBdNotFound('Issue b1 not found'), true)
    assert.equal(isBdNotFound(new Error('Issue b1 not found')), true)
    assert.equal(
      isBdNotFound(
        Object.assign(new Error('exit 1'), {
          stdout: '{"error":"no issues found matching the provided IDs"}',
        })
      ),
      true
    )
    assert.equal(isBdNotFound(new Error('database is locked')), false)
  })
})

describe('isBdCompatError', { skip: WIN32 }, () => {
  test('classifies drift vs operational failures', () => {
    assert.equal(isBdCompatError(new BdCompatError('x')), true)
    assert.equal(isBdCompatError(new Error('Error: unknown flag: --json')), true)
    assert.equal(isBdCompatError(new Error('bd returned malformed JSON — x')), true)
    assert.equal(isBdCompatError(new Error('Error: no beads database found')), false)
    assert.equal(isBdCompatError(new Error('socket hang up')), false)
  })
})

describe('checkBeads', { skip: WIN32 }, () => {
  test('drift throws a named compat error', () => {
    withFakeBd({ FAKE_BD_SHAPE_DRIFT: '1' }, () => {
      assert.throws(() => checkBeads(), (err: unknown) => {
        assert.ok(err instanceof BdCompatError)
        assert.match(err.message, /drifted off the contract/)
        return true
      })
    })
  })

  test('missing bd throws the install hint', () => {
    withoutBd(() => {
      assert.throws(() => checkBeads(), /bd not found/)
    })
  })

  test('absent store keeps the bd-init guidance', () => {
    withFakeBd({ FAKE_BD_NO_STORE: '1' }, () => {
      assert.throws(() => checkBeads(), /bd list failed.*bd init/s)
    })
  })

  test('broken bd fails as operational, not compat', () => {
    withFakeBd({ FAKE_BD_VERSION_FAIL: '1' }, () => {
      assert.throws(
        () => checkBeads(),
        (err: unknown) => {
          assert.ok(!(err instanceof BdCompatError))
          assert.match((err as Error).message, /bd unusable/)
          return true
        }
      )
    })
  })

  test('transient read failure is operational, not compat', () => {
    withFakeBd({ FAKE_BD_READY_FAIL: '1' }, () => {
      assert.throws(
        () => checkBeads(),
        (err: unknown) => {
          assert.ok(!(err instanceof BdCompatError))
          assert.match((err as Error).message, /store probe failed.*database is locked/s)
          return true
        }
      )
    })
  })
})

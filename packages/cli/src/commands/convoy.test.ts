import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyConvoyPlan } from './convoy.ts'
import type { ConvoyPlan } from '@bro/convoy'

/** A scripted `bd` on PATH — PATH lookup is the exec contract
 *  (packages/core bd.ts). `mol pour ok` emits a root id; `mol pour boom`
 *  fails mid-plan. `mol show` emits a root + one step; `delete` records
 *  into FAKE_BD_LOG, and fails when FAKE_BD_DELETE_FAIL=1. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd 0.0' ;;
  list) echo '[]' ;;
  config)
    case "$2" in
      get) echo 'agent,human' ;;
      set) : ;;
    esac ;;
  mol)
    case "$2" in
      pour)
        if [ "$3" = 'boom' ]; then echo 'boom not found' >&2; exit 1; fi
        echo 'Root issue: m-1' ;;
      show)
        echo '{"root":{"id":"m-1","title":"t","status":"open"},' \\
          '"issues":[{"id":"m-1","title":"t","status":"open"},' \\
          '{"id":"s-1","title":"step","status":"open"}],' \\
          '"dependencies":[]}' ;;
    esac ;;
  delete)
    if [ "$FAKE_BD_DELETE_FAIL" = '1' ]; then echo 'cannot delete' >&2; exit 1; fi
    echo "$@" >> "$FAKE_BD_LOG" ;;
esac
`

const PARTIAL: ConvoyPlan = {
  molecules: [{ formula: 'ok' }, { formula: 'boom' }],
}

function withFakeBd(deleteFails: boolean, fn: (log: () => string) => void): () => void {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
    writeFileSync(join(dir, 'bd'), FAKE_BD)
    chmodSync(join(dir, 'bd'), 0o755)
    const log = join(dir, 'deletes.log')
    const prev = {
      PATH: process.env.PATH,
      FAKE_BD_LOG: process.env.FAKE_BD_LOG,
      FAKE_BD_DELETE_FAIL: process.env.FAKE_BD_DELETE_FAIL,
    }
    process.env.PATH = `${dir}:${prev.PATH}`
    process.env.FAKE_BD_LOG = log
    process.env.FAKE_BD_DELETE_FAIL = deleteFails ? '1' : '0'
    try {
      fn(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''))
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const WIN32 = process.platform === 'win32'

describe('applyConvoyPlan compensation', () => {
  it(
    'a failed later pour deletes the molecules this run already poured',
    { skip: WIN32 },
    withFakeBd(false, log => {
      assert.throws(
        () => applyConvoyPlan(PARTIAL),
        (err: Error) => /bd mol pour boom/.test(err.message) && !/cleanup incomplete/.test(err.message)
      )
      // step first, then root — bd refuses a root with open children
      assert.match(log(), /delete s-1 --force/)
      assert.match(log(), /delete m-1 --force/)
      assert.ok(log().indexOf('delete s-1') < log().indexOf('delete m-1'))
    })
  )

  it(
    'a failed cleanup reports the orphan ids on top of the pour error',
    { skip: WIN32 },
    withFakeBd(true, () => {
      assert.throws(
        () => applyConvoyPlan(PARTIAL),
        (err: Error) => /cleanup incomplete: molecule\(s\) left behind: m-1/.test(err.message)
      )
    })
  )
})

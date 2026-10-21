import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  devinAccountUsage,
  devinStorePath,
  emitDevinUsage,
} from './devin-usage.ts'

describe('the devin store path', () => {
  test('is the sibling of the session-locks dir the plane derives', () => {
    const p = devinStorePath({ HOME: '/home/x', XDG_DATA_HOME: '' })
    assert.equal(p, '/home/x/.local/share/devin/cli/sessions.db')
  })

  test('honours XDG_DATA_HOME', () => {
    const p = devinStorePath({ XDG_DATA_HOME: '/data', HOME: '/home/x' })
    assert.equal(p, '/data/devin/cli/sessions.db')
  })
})

describe('the account usage', () => {
  test('a missing store is no numbers, never a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-devin-usage-'))
    try {
      const usage = await devinAccountUsage(Date.now() - 1000, {
        XDG_DATA_HOME: dir,
        HOME: dir,
      })
      assert.deepEqual(usage, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the usage emitter', () => {
  test('never throws — telemetry must not stall the pass', async () => {
    // a bag with a broken plane config: the emitter swallows it
    await emitDevinUsage({ lockDir: '/nonexistent/bro/devin' })
  })
})

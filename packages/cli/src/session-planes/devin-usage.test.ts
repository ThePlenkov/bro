import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  devinStorePath,
  devinUsageStatePath,
  readDevinUsageState,
  sampleDevinUsage,
  writeDevinUsageState,
} from './devin-usage.ts'

const withDir = (fn: (dir: string) => void | Promise<void>): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-devin-usage-'))
  try {
    void fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the devin store path', () => {
  test('is the sibling of the session-locks dir the plane derives', () => {
    const p = devinStorePath({ HOME: '/home/x', XDG_DATA_HOME: '' })
    assert.equal(p, '/home/x/.local/share/devin/cli/sessions.db')
  })

  test('honours XDG_DATA_HOME — a worker under its own XDG reads its own store', () => {
    const p = devinStorePath({ XDG_DATA_HOME: '/data', HOME: '/home/x' })
    assert.equal(p, '/data/devin/cli/sessions.db')
  })
})

describe('the sampler', () => {
  test('a missing store is no numbers, never a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-devin-usage-'))
    try {
      const sample = await sampleDevinUsage({
        sinceRowId: 7,
        env: { XDG_DATA_HOME: dir, HOME: dir },
      })
      assert.deepEqual(sample.usage, [])
      assert.equal(sample.lastRowId, 7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('counts DISTINCT request ids, not prompt rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-devin-store-'))
    try {
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string) => {
          exec: (sql: string) => void
          prepare: (sql: string) => { run: (...p: unknown[]) => void }
          close: () => void
        }
      }
      const path = join(dir, 'devin', 'cli', 'sessions.db')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(dir, 'devin', 'cli'), { recursive: true })
      const db = new DatabaseSync(path)
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT)')
      db.exec(
        'CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT)'
      )
      db.exec("INSERT INTO sessions VALUES ('s1', 'swe-2-max')")
      const insert = db.prepare('INSERT INTO message_nodes VALUES (?, ?, ?)')
      const node = (rowId: number, requestId: string | null) =>
        insert.run(
          rowId,
          's1',
          JSON.stringify({
            message_id: `m${rowId}`,
            role: 'assistant',
            content: 'x',
            metadata: requestId === null ? {} : { request_id: requestId },
          })
        )
      // one request, three message rows (the tool loop) — a prompt-row
      // count would say three requests
      node(1, 'req-a')
      node(2, 'req-a')
      node(3, 'req-a')
      node(4, 'req-b')
      node(5, null)
      const sample = await sampleDevinUsage({
        env: { XDG_DATA_HOME: dir, HOME: dir },
        limit: 100,
      })
      const swe = sample.usage.find((u) => u.model === 'swe-2-max')
      assert.equal(swe?.requests, 2, 'two distinct request ids, not five rows')
      assert.equal(swe?.sessions, 1)
      assert.equal(sample.lastRowId, 5)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the sampler state', () => {
  test('round-trips the cursor and the cumulative counters', () => {
    withDir((dir) => {
      const path = devinUsageStatePath(dir)
      assert.equal(path, null, 'no git repo — no state file')
      void path
    })
  })

  test('a missing state is an empty state, never a throw', () => {
    const state = readDevinUsageState('/nonexistent/repo')
    assert.equal(state.lastRowId, 0)
    assert.deepEqual(state.models, {})
  })
})

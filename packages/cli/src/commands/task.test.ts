import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { initRepo, installFakeBd, insideAsync, readBeads } from './testrepo.ts'
import { runTaskCommand } from './task.ts'

/** In-process run against the fake bd — PATH carries the shim,
 *  FAKE_BD_DB the store, both restored in finally (agents.test.ts
 *  pattern). Only no-exit paths run in-process; usage/exit paths are
 *  e2e territory (testrepo notes why). Returns captured stdout. */
async function withFakeStore(fn: (ctx: { lines: string[] }) => Promise<void>): Promise<void> {
  const { root, main } = initRepo('task-')
  await insideAsync(main, root, async () => {
    const { binDir, db } = installFakeBd(main, [])
    const prev = { PATH: process.env.PATH, FAKE_BD_DB: process.env.FAKE_BD_DB }
    const prevLog = console.log
    const lines: string[] = []
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
    process.env.FAKE_BD_DB = db
    console.log = (...a: unknown[]) => lines.push(a.join(' '))
    try {
      await fn({ lines })
    } finally {
      console.log = prevLog
      process.env.PATH = prev.PATH
      if (prev.FAKE_BD_DB === undefined) delete process.env.FAKE_BD_DB
      else process.env.FAKE_BD_DB = prev.FAKE_BD_DB
    }
  })
}

describe('bro task', () => {
  test('new → desc → show round-trips the spec: link', () =>
    withFakeStore(async ({ lines }) => {
      await runTaskCommand(['new', 'add a hello.txt greeting file'])
      const id = lines.pop()?.trim()
      assert.match(id ?? '', /-/)

      await runTaskCommand(['desc', id!, 'spec: specs/x.md'])
      await runTaskCommand(['show', id!])
      const out = lines.join('\n')
      assert.match(out, /add a hello\.txt greeting file/)
      assert.match(out, /spec: specs\/x\.md/)
    }))

  test('list, claim, close cover the lifecycle', () =>
    withFakeStore(async ({ lines }) => {
      await runTaskCommand(['new', 'one'])
      const id = lines.pop()!.trim()
      await runTaskCommand(['claim', id])
      await runTaskCommand(['list'])
      assert.match(lines.join('\n'), new RegExp(`${id}.*in_progress`))
      await runTaskCommand(['close', id, 'done'])
      // `list` hides closed rows like bd does — read the store row
      const row = readBeads(process.env.FAKE_BD_DB!).find((r) => r['id'] === id)
      assert.equal(row?.['status'], 'closed')
    }))

  test('note appends to the row', () =>
    withFakeStore(async ({ lines }) => {
      await runTaskCommand(['new', 'noted'])
      const id = lines.pop()!.trim()
      await runTaskCommand(['note', id, 'first note'])
      const row = readBeads(process.env.FAKE_BD_DB!).find((r) => r['id'] === id)
      assert.match(String(row?.['notes'] ?? ''), /first note/)
    }))
})

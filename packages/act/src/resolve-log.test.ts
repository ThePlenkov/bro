import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileResolveLog } from './resolve-log.ts'

describe('resolve ledger', () => {
  it('records a resolve and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resolve-log-'))
    try {
      const file = join(dir, 'act-resolves.jsonl')
      const log = fileResolveLog(file)

      assert.equal(log.wasResolved('o/r', 7, 't1'), false)
      log.record({ repo: 'o/r', pr: 7, thread: 't1' })
      assert.equal(log.wasResolved('o/r', 7, 't1'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scopes the record to the repo and PR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resolve-log-'))
    try {
      const file = join(dir, 'act-resolves.jsonl')
      const log = fileResolveLog(file)

      log.record({ repo: 'o/r', pr: 7, thread: 't1' })
      assert.equal(log.wasResolved('o/r', 7, 't1'), true)
      assert.equal(log.wasResolved('o/r', 8, 't1'), false)
      assert.equal(log.wasResolved('other/r', 7, 't1'), false)
      assert.equal(log.wasResolved('o/r', 7, 't2'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not append a second line for the same thread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resolve-log-'))
    try {
      const file = join(dir, 'act-resolves.jsonl')
      const log = fileResolveLog(file)

      log.record({ repo: 'o/r', pr: 7, thread: 't1' })
      log.record({ repo: 'o/r', pr: 7, thread: 't1' })
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      assert.equal(lines.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a missing file as no history — fail open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resolve-log-'))
    try {
      const log = fileResolveLog(join(dir, 'nope.jsonl'))
      assert.equal(log.wasResolved('o/r', 7, 't1'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a torn line instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resolve-log-'))
    try {
      const file = join(dir, 'act-resolves.jsonl')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        file,
        '{"ts":1,"repo":"o/r","pr":7,"thread":"t1"}\n{"ts":2,"repo":"o/r","pr":\n',
        'utf8'
      )
      const log = fileResolveLog(file)
      assert.equal(log.wasResolved('o/r', 7, 't1'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failed write is a no-op, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resolve-log-'))
    try {
      // the parent path is a file, so the append cannot create the ledger
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x', 'utf8')
      const log = fileResolveLog(join(blocker, 'act-resolves.jsonl'))
      log.record({ repo: 'o/r', pr: 7, thread: 't1' })
      assert.equal(log.wasResolved('o/r', 7, 't1'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

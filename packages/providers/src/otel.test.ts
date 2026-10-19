import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { otelEvent, otelJournal } from './otel.ts'

describe('otel journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-otel-'))
  afterEach(() => {
    otelJournal(undefined)
    for (const f of ['turns.jsonl']) {
      try {
        rmSync(join(dir, f))
      } catch {}
    }
  })

  it('appends one JSONL row per emitted event', () => {
    const path = join(dir, 'turns.jsonl')
    otelJournal(path)
    otelEvent('conductor.turn', { backend: 'devin', model: 'swe-2-max', session_reused: true })
    otelEvent('conductor.error', { status: 429 })
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.event, 'conductor.turn')
    assert.equal(rows[0]!.model, 'swe-2-max')
    assert.equal(rows[0]!.session_reused, true)
    assert.equal(rows[1]!.event, 'conductor.error')
    assert.match(String(rows[0]!.ts), /^\d{4}-/)
  })

  it('stays silent with no journal pinned', () => {
    otelJournal(undefined)
    otelEvent('conductor.turn', { backend: 'x' })
    assert.throws(() => readFileSync(join(dir, 'turns.jsonl'), 'utf8'))
  })
})

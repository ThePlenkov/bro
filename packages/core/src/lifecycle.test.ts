import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { gitTry } from './git.ts'
import {
  emitLifecycle,
  lifecyclePath,
  readLifecycle,
} from './lifecycle.ts'

/** The journal lives under the git common dir — a bare tmpdir gets a
 *  `git init`, and the env knobs the emitter reads (agent badge,
 *  actor, session chain) are pinned per test so the resolved fields
 *  are the assertion, not the ambient shell's. */
const ENV_KEYS = [
  'BRO_AGENT_ID',
  'BRO_SESSION_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
  'BEADS_ACTOR',
  'BD_ACTOR',
] as const

function withRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-lifecycle-'))
  gitTry(['-C', dir, 'init'])
  const saved = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
  try {
    fn(dir)
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved.get(k)
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('lifecycle journal', () => {
  test('lifecyclePath resolves <git-common>/bro/events.jsonl', () => {
    withRepo((dir) => {
      const p = lifecyclePath(dir)
      assert.ok(p !== null)
      assert.ok(p!.endsWith(join('.git', 'bro', 'events.jsonl')))
    })
  })

  test('emit appends one stamped row; read returns file order', () => {
    withRepo((dir) => {
      emitLifecycle(dir, { kind: 'claim', bead: 'bro-x1', from: 'open', to: 'in_progress' })
      emitLifecycle(dir, { kind: 'merge', bead: 'bro-x1', pr: 7, to: 'merged' })
      const rows = readLifecycle(dir)
      assert.equal(rows.length, 2)
      assert.equal(rows[0]!.kind, 'claim')
      assert.equal(rows[0]!.bead, 'bro-x1')
      assert.equal(rows[0]!.from, 'open')
      assert.equal(rows[0]!.to, 'in_progress')
      assert.equal(rows[1]!.kind, 'merge')
      assert.equal(rows[1]!.pr, 7)
      // stamped fields exist and seqs are line positions
      assert.ok(typeof rows[0]!.ts === 'string' && rows[0]!.ts.includes('T'))
      assert.ok(typeof rows[0]!.actor === 'string')
      assert.ok(typeof rows[0]!.session === 'string')
      assert.equal(rows[0]!.seq, 1)
      assert.equal(rows[1]!.seq, 2)
    })
  })

  test('BRO_AGENT_ID wins actor; BRO_SESSION_ID wins session', () => {
    withRepo((dir) => {
      process.env['BRO_AGENT_ID'] = 'agent-99'
      process.env['BRO_SESSION_ID'] = 'agent-99'
      emitLifecycle(dir, { kind: 'spawn', to: 'spawned' })
      const [row] = readLifecycle(dir)
      assert.equal(row!.actor, 'agent-99')
      assert.equal(row!.session, 'agent-99')
    })
  })

  test('explicit ts (epoch ms and ISO) is honored over the emitter clock', () => {
    withRepo((dir) => {
      emitLifecycle(dir, { kind: 'agent-exit', ts: 1_700_000_000_000 })
      emitLifecycle(dir, { kind: 'agent-exit', ts: '2001-02-03T04:05:06.000Z' })
      const rows = readLifecycle(dir)
      assert.equal(rows[0]!.ts, new Date(1_700_000_000_000).toISOString())
      assert.equal(rows[1]!.ts, '2001-02-03T04:05:06.000Z')
    })
  })

  test('read filters kind/bead/pr/since and newest-first limit', () => {
    withRepo((dir) => {
      emitLifecycle(dir, { kind: 'claim', bead: 'a', ts: '2026-01-01T00:00:01Z' })
      emitLifecycle(dir, { kind: 'gate', bead: 'a', pr: 3, ts: '2026-01-01T00:00:02Z' })
      emitLifecycle(dir, { kind: 'merge', bead: 'b', pr: 3, ts: '2026-01-01T00:00:03Z' })
      assert.equal(readLifecycle(dir, { kind: 'gate' }).length, 1)
      assert.equal(readLifecycle(dir, { bead: 'b' })[0]!.kind, 'merge')
      assert.equal(readLifecycle(dir, { pr: 3 }).length, 2)
      assert.equal(readLifecycle(dir, { since: '2026-01-01T00:00:01Z' }).length, 2)
      const last = readLifecycle(dir, { limit: 1 })
      assert.equal(last.length, 1)
      assert.equal(last[0]!.kind, 'merge')
    })
  })

  test('torn and malformed lines are skipped, not fatal', () => {
    withRepo((dir) => {
      const file = lifecyclePath(dir)!
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(
        file,
        '{"ts":"2026-01-01T00:00:00Z","kind":"claim","actor":"x","session":"s"}\n' +
          '{"ts":"2026-01-01T00:00:01Z","kind":"ga\n' + // torn tail
          'not json at all\n' +
          '{"ts":"2026-01-01T00:00:02Z","kind":"merge","actor":"x","session":"s"}\n'
      )
      const rows = readLifecycle(dir)
      assert.equal(rows.length, 2)
      assert.equal(rows[0]!.kind, 'claim')
      assert.equal(rows[1]!.kind, 'merge')
    })
  })

  test('future kinds round-trip — read kind stays an open string', () => {
    withRepo((dir) => {
      const file = lifecyclePath(dir)!
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(
        file,
        '{"ts":"2026-01-01T00:00:00Z","kind":"quantum-leap","actor":"x","session":"s"}\n'
      )
      const [row] = readLifecycle(dir)
      assert.equal(row!.kind, 'quantum-leap')
    })
  })

  test('fail-open — emit outside a repo and read of a missing file are no-ops', () => {
    const bare = mkdtempSync(join(tmpdir(), 'bro-lifecycle-norepo-'))
    try {
      assert.equal(lifecyclePath(bare), null)
      emitLifecycle(bare, { kind: 'claim' }) // must not throw
      assert.deepEqual(readLifecycle(bare), [])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('detail rides through verbatim; optional fields stay absent', () => {
    withRepo((dir) => {
      emitLifecycle(dir, {
        kind: 'gate',
        pr: 5,
        to: 'blocked',
        detail: { via: 'act', blockers: ['2 open thread(s)'], round: 2 },
      })
      const raw = readFileSync(lifecyclePath(dir)!, 'utf8')
      const row = JSON.parse(raw.trim())
      assert.deepEqual(row.detail, { via: 'act', blockers: ['2 open thread(s)'], round: 2 })
      assert.equal(row.bead, undefined)
      assert.equal(row.from, undefined)
    })
  })

  test('oversized journal self-caps to whole newest lines', () => {
    withRepo((dir) => {
      const file = lifecyclePath(dir)!
      mkdirSync(join(file, '..'), { recursive: true })
      // > 4 MiB of valid rows — the cap is per whole line, so the pad
      // rows are themselves well-formed
      const pad = `${JSON.stringify({
        ts: '2026-01-01T00:00:00Z',
        kind: 'gate',
        actor: 'x',
        session: 's',
        detail: { pad: 'x'.repeat(900) },
      })}\n`
      writeFileSync(file, pad.repeat(5_000)) // ~5_000 * ~1 KiB ≈ 5 MiB
      emitLifecycle(dir, { kind: 'merge', to: 'merged' })
      const rows = readLifecycle(dir)
      assert.equal(rows.at(-1)!.kind, 'merge')
      // every surviving line parses — the cap never leaves a torn head
      assert.ok(rows.length < 5_001)
      assert.ok(rows.length > 0)
    })
  })
})

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runNextCommand } from './next.ts'

/** A scripted `bd` on PATH — PATH lookup is the exec contract. `ready`
 *  emits a fixed queue; `update` records claims into FAKE_BD_LOG. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd 0.0' ;;
  ready) cat <<'JSON'
[
  {"id":"b-gate","title":"HUMAN GATE — pick one","status":"open","priority":1,"issue_type":"task","created_at":"2026-01-01T00:00:00Z"},
  {"id":"b-epic","title":"big epic","status":"open","priority":1,"issue_type":"epic","created_at":"2026-01-01T00:00:00Z"},
  {"id":"b-mol","title":"mol step","status":"open","priority":1,"issue_type":"task","parent":"m-1","created_at":"2026-01-01T00:00:00Z"},
  {"id":"b-newer","title":"newer task","status":"open","priority":2,"issue_type":"task","created_at":"2026-01-03T00:00:00Z"},
  {"id":"b-older","title":"older task","status":"open","priority":2,"issue_type":"task","created_at":"2026-01-02T00:00:00Z"}
]
JSON
    ;;
  update) echo "$@" >> "$FAKE_BD_LOG" ;;
esac
`

interface Captured {
  lines: string[]
  claims: string
}

function withFakeBd(fn: (c: Captured) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
    writeFileSync(join(dir, 'bd'), FAKE_BD)
    chmodSync(join(dir, 'bd'), 0o755)
    const log = join(dir, 'claims.log')
    const prevPath = process.env.PATH
    const prevLog = process.env.FAKE_BD_LOG
    process.env.PATH = `${dir}:${prevPath}`
    process.env.FAKE_BD_LOG = log
    const lines: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      await fn({
        lines,
        get claims() {
          return existsSync(log) ? readFileSync(log, 'utf8') : ''
        },
      })
    } finally {
      console.log = orig
      process.env.PATH = prevPath
      if (prevLog === undefined) delete process.env.FAKE_BD_LOG
      else process.env.FAKE_BD_LOG = prevLog
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe('bro next', () => {
  it(
    'claims the oldest top-priority task, skipping gates/epics/mol steps',
    withFakeBd(async c => {
      await runNextCommand([])
      assert.match(c.lines[0], /→ b-older.*\(claimed\)/)
      assert.match(c.claims, /b-older --claim/)
      assert.match(c.lines.join('\n'), /gate: b-gate/)
      assert.match(c.lines.join('\n'), /epic: b-epic/)
      assert.doesNotMatch(c.lines.join('\n'), /b-mol.*claimed/)
    })
  )

  it(
    '--list shows the queue without claiming',
    withFakeBd(async c => {
      await runNextCommand(['--list'])
      assert.match(c.lines[0], /→ b-older/)
      assert.doesNotMatch(c.lines[0], /claimed/)
      assert.equal(c.claims, '')
    })
  )

  it(
    '--json emits state + bead + skips',
    withFakeBd(async c => {
      await runNextCommand(['--list', '--json'])
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.state, 'task')
      assert.equal(r.bead.id, 'b-older')
      assert.equal(r.gates[0].id, 'b-gate')
      assert.equal(r.epics[0].id, 'b-epic')
      assert.equal(r.queue, 2)
    })
  )
})

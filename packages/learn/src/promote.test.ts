import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Lesson } from './lesson.ts'
import { promoteLesson } from './promote.ts'
import { getLesson, putLesson } from './store.ts'

/** Scripted `bd` on PATH — the union the promote path touches:
 *  `kv` serves the lesson store, `create`/`close` serve the rule-edit
 *  bead. FAKE_BD_KV_FAIL=1 makes every `kv set` exit 1 — the
 *  compensation path's trigger. Seed file: {kv: {}, rows: []}. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.FAKE_BD_DB
const fail = (m) => { console.error('fake bd: ' + m); process.exit(1) }
const load = () => {
  try {
    const d = JSON.parse(fs.readFileSync(DB, 'utf8'))
    return { kv: {}, rows: [], ...d }
  } catch { return { kv: {}, rows: [] } }
}
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
const args = process.argv.slice(2).filter((a) => a !== '--json')
if (args[0] !== 'kv' && args[0] !== 'create' && args[0] !== 'close') {
  fail('unhandled: ' + args.join(' '))
}
const db = load()
const row = (id) => db.rows.find((r) => r.id === id)
if (args[0] === 'kv') {
  const sub = args[1]
  if (sub === 'set') {
    if (process.env.FAKE_BD_KV_FAIL === '1') fail('kv set refused')
    db.kv[args[2]] = args[3]; save(db)
  } else if (sub === 'get') {
    if (db.kv[args[2]] === undefined) { console.error(args[2] + ' (not set)'); process.exit(1) }
    console.log(db.kv[args[2]])
  } else if (sub === 'clear') { delete db.kv[args[2]]; save(db) }
  else if (sub === 'list') process.stdout.write(JSON.stringify(db.kv))
  else fail('kv ' + sub)
} else if (args[0] === 'create') {
  // create --title T -d D -l L [--l L2] — collect repeatable -l/--labels
  const val = (names) => {
    for (let i = 1; i < args.length - 1; i++) {
      if (names.includes(args[i])) return args[i + 1]
    }
    return undefined
  }
  const title = val(['--title', '-t']) ?? ''
  const labels = []
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i] === '-l' || args[i] === '--labels') labels.push(args[i + 1])
  }
  const r = {
    id: 'fx-' + db.rows.length,
    title,
    description: val(['-d', '--description']) ?? '',
    status: 'open',
    labels,
    created_at: new Date().toISOString(),
  }
  db.rows.push(r); save(db)
  process.stdout.write(JSON.stringify(r) + '\\n')
} else if (args[0] === 'close') {
  const r = row(args[1])
  if (!r) fail('not found: ' + args[1])
  r.status = 'closed'
  r.close_reason = args.includes('--reason') ? args[args.indexOf('--reason') + 1] : ''
  save(db)
}
`

const WIN32 = process.platform === 'win32'

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  trigger: {
    on: ['post-tool'],
    match: { commands: ['gh pr merge'] },
    budget: 2,
  },
  lesson: `after gh pr merge run bro debt collect`,
  evidence: [
    { kind: 'bead', ref: 'bro-abc' },
    { kind: 'pr', ref: 'https://github.com/x/y/pull/1' },
  ],
  confidence: 'established',
  source: 'capture:retro',
  createdAt: '2026-10-04T00:00:00.000Z',
  ...over,
})

interface Fixture {
  /** non-git cwd — bd calls land here, the store lock stays off (no
   *  git common dir to hang it on) */
  cwd: string
  db: string
}

function withFakeBd(fn: (f: Fixture) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-learn-promote-'))
  const prev: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    FAKE_BD_DB: process.env.FAKE_BD_DB,
    FAKE_BD_KV_FAIL: process.env.FAKE_BD_KV_FAIL,
  }
  writeFileSync(join(dir, 'bd'), FAKE_BD)
  chmodSync(join(dir, 'bd'), 0o755)
  process.env.PATH = `${dir}:${prev.PATH}`
  process.env.FAKE_BD_DB = join(dir, 'store.json')
  try {
    fn({ cwd: dir, db: process.env.FAKE_BD_DB })
  } finally {
    for (const k of ['PATH', 'FAKE_BD_DB', 'FAKE_BD_KV_FAIL']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const readDb = (dbPath: string): { kv: Record<string, string>; rows: Array<Record<string, unknown>> } =>
  JSON.parse(readFileSync(dbPath, 'utf8'))

describe('promote', { skip: WIN32 }, () => {
  it('opens a rule-edit bead carrying rule+trigger+evidence and marks the lesson', () => {
    withFakeBd(({ cwd, db }) => {
      const l = lesson('learn-promote-me')
      putLesson(l, cwd)
      const r = promoteLesson('learn-promote-me', cwd)
      assert.equal(r.alreadyPromoted, false)
      assert.match(r.beadId, /^fx-/)

      const store = readDb(db)
      const bead = store.rows.find(x => x.id === r.beadId) as Record<string, unknown>
      assert.equal(bead.status, 'open')
      assert.deepEqual(bead.labels, ['learn'])
      assert.match(String(bead.title), /learn promote learn-promote-me/)
      const desc = String(bead.description)
      assert.match(desc, /after gh pr merge run bro debt collect/)
      assert.match(desc, /on: post-tool/)
      assert.match(desc, /commands: gh pr merge/)
      assert.match(desc, /bead: bro-abc/)
      assert.match(desc, /pr: https:\/\/github\.com\/x\/y\/pull\/1/)
      assert.match(desc, /lesson: learn-promote-me/)

      const stored = getLesson('learn-promote-me', cwd)
      assert.equal(stored?.promotedTo, r.beadId)
      assert.ok(stored?.updatedAt !== undefined)
    })
  })

  it('is idempotent — a second promote returns the same bead, files nothing', () => {
    withFakeBd(({ cwd, db }) => {
      putLesson(lesson('learn-once'), cwd)
      const first = promoteLesson('learn-once', cwd)
      const second = promoteLesson('learn-once', cwd)
      assert.equal(second.alreadyPromoted, true)
      assert.equal(second.beadId, first.beadId)
      assert.equal(readDb(db).rows.length, 1)
    })
  })

  it('throws on a missing lesson', () => {
    withFakeBd(({ cwd }) => {
      assert.throws(() => promoteLesson('learn-nope', cwd), /no lesson learn-nope/)
    })
  })

  it('closes the orphan bead when the lesson mark fails — retry stays clean', () => {
    withFakeBd(({ cwd, db }) => {
      putLesson(lesson('learn-comp'), cwd)
      // only the promote's mark write fails — the seed already landed
      process.env.FAKE_BD_KV_FAIL = '1'
      assert.throws(() => promoteLesson('learn-comp', cwd), /kv set refused/)
      const store = readDb(db)
      assert.equal(store.rows.length, 1)
      assert.equal(store.rows[0]!.status, 'closed')
      // the lesson was never marked — a retry files a fresh bead
      assert.equal(getLesson('learn-comp', cwd)?.promotedTo, undefined)
    })
  })
})

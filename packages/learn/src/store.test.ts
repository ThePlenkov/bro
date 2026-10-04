import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { deleteLesson, getLesson, lessonIds, listLessons, putLesson } from './store.ts'
import type { Lesson } from './lesson.ts'

/** Scripted `bd` on PATH — the exec contract is PATH lookup
 *  (packages/core bd.ts). `kv` mutates a JSON map in $FAKE_BD_DB;
 *  `kv get` on a miss exits 1 with "(not set)" like real bd. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.FAKE_BD_DB
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return {} } }
const save = (m) => fs.writeFileSync(DB, JSON.stringify(m))
const args = process.argv.slice(2).filter((a) => a !== '--json')
if (args[0] !== 'kv') { console.error('fake bd: unhandled ' + args.join(' ')); process.exit(1) }
const map = load()
switch (args[1]) {
  case 'set': map[args[2]] = args[3]; save(map); break
  case 'get':
    if (map[args[2]] === undefined) { console.error(args[2] + ' (not set)'); process.exit(1) }
    console.log(map[args[2]])
    break
  case 'clear': delete map[args[2]]; save(map); break
  case 'list': process.stdout.write(JSON.stringify(map)); break
}
`

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  trigger: { on: ['session-start'] },
  lesson: `rule for ${id}`,
  evidence: [{ kind: 'text', ref: 'test' }],
  confidence: 'tentative',
  source: 'manual',
  createdAt: '2026-10-04T00:00:00.000Z',
  ...over,
})

const WIN32 = process.platform === 'win32'

function withFakeBd(fn: (db: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-learn-fake-bd-'))
  const prev = { PATH: process.env.PATH, FAKE_BD_DB: process.env.FAKE_BD_DB }
  writeFileSync(join(dir, 'bd'), FAKE_BD)
  chmodSync(join(dir, 'bd'), 0o755)
  process.env.PATH = `${dir}:${prev.PATH}`
  process.env.FAKE_BD_DB = join(dir, 'kv.json')
  try {
    fn(process.env.FAKE_BD_DB)
  } finally {
    process.env.PATH = prev.PATH
    if (prev.FAKE_BD_DB === undefined) delete process.env.FAKE_BD_DB
    else process.env.FAKE_BD_DB = prev.FAKE_BD_DB
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Reach under the API and write raw kv entries — corrupt rows arrive
 *  from a newer bro, not through putLesson. */
function seedKv(db: string, entries: Record<string, string>): void {
  let map: Record<string, string> = {}
  try {
    map = JSON.parse(readFileSync(db, 'utf8')) as Record<string, string>
  } catch {
    // no store yet — seeding creates it, same as the fake's load()
  }
  writeFileSync(db, JSON.stringify({ ...map, ...entries }))
}

describe('store', { skip: WIN32 }, () => {
  it('put → get round-trips a lesson', () => {
    withFakeBd(() => {
      const l = lesson('learn-round-trip')
      putLesson(l)
      assert.deepEqual(getLesson('learn-round-trip'), l)
    })
  })

  it('get returns null on a miss', () => {
    withFakeBd(() => {
      assert.equal(getLesson('learn-absent'), null)
    })
  })

  it('list enumerates learn/ keys', () => {
    withFakeBd((db) => {
      putLesson(lesson('learn-one'))
      putLesson(lesson('learn-two'))
      seedKv(db, { 'other/unrelated': '{"x":1}' })
      const { lessons, skipped } = listLessons()
      assert.deepEqual(lessons.map((l) => l.id).sort(), ['learn-one', 'learn-two'])
      assert.deepEqual(skipped, [])
    })
  })

  it('list fails open — schema violations land in skipped, never thrown', () => {
    withFakeBd((db) => {
      putLesson(lesson('learn-good'))
      seedKv(db, {
        'learn/broken': '{"id":"learn-broken","lesson":123}',
        'learn/not-json': 'not json at all',
      })
      const { lessons, skipped } = listLessons()
      assert.deepEqual(lessons.map((l) => l.id), ['learn-good'])
      assert.deepEqual(skipped.map((s) => s.key).sort(), ['learn/broken', 'learn/not-json'])
    })
  })

  it('list skips a key whose id does not match the lesson inside', () => {
    withFakeBd((db) => {
      seedKv(db, {
        'learn/learn-real': JSON.stringify(lesson('learn-different')),
      })
      const { lessons, skipped } = listLessons()
      assert.equal(lessons.length, 0)
      assert.equal(skipped.length, 1)
      assert.match(skipped[0]!.problems[0]!, /does not match key/)
    })
  })

  it('put refuses an invalid lesson — the write path fails closed', () => {
    withFakeBd(() => {
      assert.throws(
        () => putLesson(lesson('learn-x', { evidence: [] })),
        /refusing to store invalid lesson/
      )
    })
  })

  it('get on a corrupt entry throws — show must distinguish miss from broken', () => {
    withFakeBd((db) => {
      seedKv(db, { 'learn/learn-broken': '{not json' })
      assert.throws(() => getLesson('learn-broken'), /fails schema|malformed/)
    })
  })

  it('delete removes the entry', () => {
    withFakeBd(() => {
      putLesson(lesson('learn-gone'))
      deleteLesson('learn-gone')
      assert.equal(getLesson('learn-gone'), null)
    })
  })

  it('lessonIds covers skipped entries too — a corrupt key still squats its id', () => {
    withFakeBd((db) => {
      putLesson(lesson('learn-visible'))
      seedKv(db, { 'learn/learn-squatter': '{broken' })
      assert.deepEqual([...lessonIds()].sort(), ['learn-squatter', 'learn-visible'])
    })
  })
})

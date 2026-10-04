/**
 * learn probe — store-first query, gap log, phase-2 record. Exercised
 * against a real git repo (hooks/trace/fired dirs) and a scripted `bd`
 * for the lesson store — the same fixture shape as connector.test.ts.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  probeQuestion,
  probeTerms,
  probeTrigger,
  rankLessons,
  recordProbeAnswer,
  resolveSessionId,
} from './probe.ts'
import { getLesson } from './store.ts'
import type { Lesson } from './lesson.ts'

const WIN32 = process.platform === 'win32'

const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.FAKE_BD_DB
const fail = (m) => { console.error('fake bd: ' + m); process.exit(1) }
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { rows: [], kv: {} } } }
const save = (m) => fs.writeFileSync(DB, JSON.stringify(m))
const args = process.argv.slice(2).filter((a) => a !== '--json')
const pos = args.filter((a) => !a.startsWith('-'))
const flagVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const db = load()
switch (pos[0]) {
  case 'kv': {
    db.kv = db.kv || {}
    const sub = pos[1]
    if (sub === 'set') { db.kv[pos[2]] = pos[3]; save(db); break }
    if (sub === 'get') {
      if (db.kv[pos[2]] === undefined) { console.error(pos[2] + ' (not set)'); process.exit(1) }
      console.log(db.kv[pos[2]]); break
    }
    if (sub === 'clear') { delete db.kv[pos[2]]; save(db); break }
    if (sub === 'list') { process.stdout.write(JSON.stringify(db.kv)); break }
    fail('kv ' + sub)
  }
  case 'list': {
    let rows = db.rows || []
    const st = flagVal('--status')
    if (st) rows = rows.filter((r) => r.status === st)
    console.log(JSON.stringify(rows)); break
  }
  case 'config': console.log('(not set)'); break
  default: fail('unhandled ' + args.join(' '))
}
`

interface Fixture {
  dir: string
  hooks: string
  db: string
}

function lesson(id: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id,
    trigger: { on: ['prompt-submit'], match: { terms: ['merge'] } },
    lesson: `rule for ${id}`,
    evidence: [{ kind: 'text', ref: 'test' }],
    confidence: 'tentative',
    source: 'manual',
    createdAt: '2026-10-04T00:00:00.000Z',
    ...over,
  }
}

function fixture(opts: {
  lessons?: Lesson[]
  rows?: Array<Record<string, unknown>>
} = {}): Fixture & { restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'bro-learn-probe-'))
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'bd'), FAKE_BD)
  chmodSync(join(binDir, 'bd'), 0o755)
  const db = join(root, 'beads.json')
  writeFileSync(
    db,
    JSON.stringify({
      rows: opts.rows ?? [],
      kv: Object.fromEntries(
        (opts.lessons ?? []).map((l) => [`learn/${l.id}`, JSON.stringify(l)])
      ),
    })
  )
  const prev = {
    PATH: process.env.PATH,
    FAKE_BD_DB: process.env.FAKE_BD_DB,
  }
  process.env.PATH = `${binDir}:${prev.PATH}`
  process.env.FAKE_BD_DB = db
  const hooks = join(dir, '.git', 'bro', 'hooks')
  return {
    dir,
    hooks,
    db,
    restore() {
      process.env.PATH = prev.PATH
      if (prev.FAKE_BD_DB === undefined) delete process.env.FAKE_BD_DB
      else process.env.FAKE_BD_DB = prev.FAKE_BD_DB
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('probeTerms', { skip: WIN32 }, () => {
  it('keeps significant words, drops stopwords and shorts', () => {
    assert.deepEqual(probeTerms('why does this merge fail?'), ['merge', 'fail'])
    assert.deepEqual(probeTerms('the of a an'), [])
  })
})

describe('rankLessons', { skip: WIN32 }, () => {
  it('ranks by distinct term coverage, confidence breaks ties', () => {
    const lessons = [
      lesson('learn-a', { lesson: 'merge then sweep debt' }),
      lesson('learn-b', {
        lesson: 'merge is yours',
        confidence: 'established',
      }),
      lesson('learn-c', {
        lesson: 'unrelated rule',
        trigger: { on: ['post-tool'], match: { terms: ['unrelated'] } },
      }),
    ]
    const hits = rankLessons('how does merge work', lessons)
    assert.deepEqual(
      hits.map((h) => h.lesson.id),
      ['learn-b', 'learn-a']
    )
    assert.equal(hits[0]!.score, 1)
    assert.equal(hits[1]!.score, 1)
  })

  it('sees terms inside match values, not just the rule text', () => {
    const lessons = [
      lesson('learn-cmd', {
        lesson: 'sweep after landing',
        trigger: { on: ['post-tool'], match: { commands: ['gh pr merge'] } },
      }),
    ]
    const hits = rankLessons('what runs after gh pr merge', lessons)
    assert.equal(hits.length, 1)
    assert.ok(hits[0]!.score >= 1)
  })

  it('empty-term questions rank nothing', () => {
    assert.deepEqual(rankLessons('the a an', [lesson('learn-x')]), [])
  })
})

describe('resolveSessionId', { skip: WIN32 }, () => {
  it('explicit flag wins, then newest live marker, then cli', () => {
    const fx = fixture()
    try {
      assert.equal(resolveSessionId(fx.dir, 'flag-sid'), 'flag-sid')
      // no markers → cli
      assert.equal(resolveSessionId(fx.dir), 'cli')
      mkdirSync(fx.hooks, { recursive: true })
      writeFileSync(join(fx.hooks, 'live-one.task'), `${Date.now()}\nfx-1\n`)
      assert.equal(resolveSessionId(fx.dir), 'live-one')
      // a stale marker (ownerless + aged past the live window) does not win
      const stale = join(fx.hooks, 'old.task')
      writeFileSync(stale, `1\nfx-9\n`)
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      utimesSync(stale, old, old)
      assert.equal(resolveSessionId(fx.dir), 'live-one')
    } finally {
      fx.restore()
    }
  })
})

describe('probeQuestion', { skip: WIN32 }, () => {
  it('a hit short-circuits — ranked lessons, no gap logged', () => {
    const fx = fixture({ lessons: [lesson('learn-merge-rule')] })
    try {
      const res = probeQuestion('how does merge work', { dir: fx.dir })
      assert.equal(res.hits.length, 1)
      assert.equal(res.hits[0]!.lesson.id, 'learn-merge-rule')
      assert.equal(res.gapLogged, false)
      assert.equal(existsSync(join(fx.hooks, 'fired')), false)
    } finally {
      fx.restore()
    }
  })

  it('a miss logs an open gap to the fired set, once per session+question', () => {
    const fx = fixture()
    try {
      const res = probeQuestion('how does the merge slot work', {
        dir: fx.dir,
        sessionId: 's1',
      })
      assert.equal(res.hits.length, 0)
      assert.equal(res.gapLogged, true)
      assert.equal(res.sessionId, 's1')
      const fired = readFileSync(join(fx.hooks, 'fired', 's1'), 'utf8')
      assert.match(fired, /^gap:how does the merge slot work$/m)
      // re-probing the same question does not double-log
      assert.equal(
        probeQuestion('how does the merge slot work', { dir: fx.dir, sessionId: 's1' })
          .gapLogged,
        false
      )
      assert.equal(
        readFileSync(join(fx.hooks, 'fired', 's1'), 'utf8').split('\n').filter(Boolean)
          .length,
        1
      )
    } finally {
      fx.restore()
    }
  })

  it('a miss gathers trace lines and live beads carrying a term', () => {
    const fx = fixture({
      rows: [{ id: 'fx-7', title: 'merge slot occupancy', status: 'in_progress' }],
    })
    try {
      mkdirSync(join(fx.hooks, 'trace'), { recursive: true })
      writeFileSync(
        join(fx.hooks, 'trace', 's1.jsonl'),
        [
          JSON.stringify({ ts: 1, tool: 'exec', command: 'bd merge-slot check', ok: true }),
          JSON.stringify({ ts: 2, tool: 'exec', command: 'echo unrelated', ok: true }),
        ].join('\n') + '\n'
      )
      const res = probeQuestion('who holds the merge slot', {
        dir: fx.dir,
        sessionId: 's1',
      })
      assert.equal(res.hits.length, 0)
      assert.ok(res.candidates.some((c) => c === 'trace: bd merge-slot check'))
      assert.ok(res.candidates.some((c) => c.includes('fx-7')))
    } finally {
      fx.restore()
    }
  })

  it('corrupt entries surface in skipped, not a crash', () => {
    const fx = fixture({ lessons: [lesson('learn-ok')] })
    try {
      const db = JSON.parse(readFileSync(fx.db, 'utf8')) as { kv: Record<string, string> }
      db.kv['learn/broken'] = '{nope'
      writeFileSync(fx.db, JSON.stringify(db))
      const res = probeQuestion('merge', { dir: fx.dir })
      assert.equal(res.skipped.length, 1)
      assert.equal(res.skipped[0]!.key, 'learn/broken')
    } finally {
      fx.restore()
    }
  })
})

describe('recordProbeAnswer', { skip: WIN32 }, () => {
  it('stores a source:probe lesson citing the session and the question', () => {
    const fx = fixture()
    try {
      const trigger = probeTrigger('how does the merge slot work')!
      const res = recordProbeAnswer({
        question: 'how does the merge slot work',
        lesson: 'one PR merges at a time — bd merge-slot acquire holds it',
        trigger,
        dir: fx.dir,
        sessionId: 'sess-1',
      })
      assert.equal(res.merged, false)
      const stored = getLesson(res.lesson.id, fx.dir)!
      assert.equal(stored.source, 'probe')
      // session+question cite one investigation — tentative, not established
      assert.equal(stored.confidence, 'tentative')
      assert.deepEqual(stored.evidence.slice(0, 2), [
        { kind: 'session', ref: 'sess-1' },
        { kind: 'text', ref: 'how does the merge slot work' },
      ])
      // 'work' is a stopword — the index is content terms only
      assert.deepEqual(stored.trigger.match?.terms, ['merge', 'slot'])
    } finally {
      fx.restore()
    }
  })

  it('re-probing the same answer folds evidence instead of duplicating', () => {
    const fx = fixture()
    try {
      const trigger = { on: ['prompt-submit' as const], match: { terms: ['merge'] } }
      const first = recordProbeAnswer({
        question: 'q1',
        lesson: 'one PR merges at a time',
        trigger,
        dir: fx.dir,
        sessionId: 'sess-1',
      })
      const second = recordProbeAnswer({
        question: 'q2',
        lesson: 'one PR merges at a time',
        trigger: { on: ['session-start' as const], match: { terms: ['slot'] } },
        dir: fx.dir,
        sessionId: 'sess-2',
      })
      assert.equal(second.merged, true)
      assert.equal(second.lesson.id, first.lesson.id)
      const stored = getLesson(first.lesson.id, fx.dir)!
      assert.equal(stored.evidence.length, 4)
      // two independent evidences → established
      assert.equal(stored.confidence, 'established')
      // mergeTrigger unions the probe's index into the existing rule —
      // a repeat of the second question's context still finds it
      assert.deepEqual(stored.trigger.on.sort(), ['prompt-submit', 'session-start'].sort())
      assert.deepEqual(stored.trigger.match?.terms, ['merge', 'slot'])
    } finally {
      fx.restore()
    }
  })

  it('an empty answer refuses to store', () => {
    const fx = fixture()
    try {
      assert.throws(
        () =>
          recordProbeAnswer({
            question: 'q',
            lesson: '   ',
            trigger: { on: ['prompt-submit'] },
            dir: fx.dir,
          }),
        /non-empty/
      )
    } finally {
      fx.restore()
    }
  })
})

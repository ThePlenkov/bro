/**
 * learnConnector probes — exercised against a real (empty) git repo for
 * the hooks/trace/fired dirs and a scripted `bd` for the lesson store
 * and task rows. The store's kv surface and the connector's matching
 * are the contract; the fake's job is to fail loudly on anything else.
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
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { learnConnector } from './connector.ts'
import type { Lesson } from './lesson.ts'

const WIN32 = process.platform === 'win32'

/** Scripted `bd` — kv mutates the `kv` map in $FAKE_BD_DB, `list`/`show`
 *  answer the `rows` array, `config get` reports unset. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.FAKE_BD_DB
const fail = (m) => { console.error('fake bd: ' + m); process.exit(1) }
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { rows: [], kv: {} } } }
const save = (m) => fs.writeFileSync(DB, JSON.stringify(m))
const args = process.argv.slice(2).filter((a) => a !== '--json')
const LOG = process.env.FAKE_BD_LOG
if (LOG) fs.appendFileSync(LOG, args.join(' ') + '\\n')
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
    const ty = flagVal('--type')
    if (ty) rows = rows.filter((r) => r.issue_type === ty)
    console.log(JSON.stringify(rows)); break
  }
  case 'show': {
    const r = (db.rows || []).find((r) => r.id === pos[1])
    console.log(JSON.stringify(r ? [r] : [])); break
  }
  case 'config': console.log('(not set)'); break
  default: fail('unhandled ' + args.join(' '))
}
`

interface Fixture {
  /** repo root (the ctx.dir probes run against) */
  dir: string
  /** <git-common>/bro/hooks */
  hooks: string
  /** fake-bd json file — {rows, kv} */
  db: string
}

function lesson(id: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id,
    trigger: { on: ['post-tool'] },
    lesson: `rule for ${id}`,
    evidence: [{ kind: 'text', ref: 'test' }],
    confidence: 'tentative',
    source: 'manual',
    createdAt: '2026-10-04T00:00:00.000Z',
    ...over,
  }
}

/** git-init a repo, install the fake bd on PATH, return the handles.
 *  Call restore() in a finally — it also restores PATH/FAKE_BD_DB. */
function fixture(opts: {
  lessons?: Lesson[]
  rows?: Array<Record<string, unknown>>
  config?: Record<string, unknown>
} = {}): Fixture & { restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'bro-learn-conn-'))
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  if (opts.config !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(opts.config))
  }
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
    BEADS_DIR: process.env.BEADS_DIR,
  }
  process.env.PATH = `${binDir}:${prev.PATH}`
  process.env.FAKE_BD_DB = db
  // a session-pinned BEADS_DIR (agent env) would resolve the real store
  // instead of the fixture's — the snapshot stamp must key on fx.dir
  delete process.env.BEADS_DIR
  const hooks = join(dir, '.git', 'bro', 'hooks')
  return {
    dir,
    hooks,
    db,
    restore() {
      process.env.PATH = prev.PATH
      if (prev.FAKE_BD_DB === undefined) delete process.env.FAKE_BD_DB
      else process.env.FAKE_BD_DB = prev.FAKE_BD_DB
      if (prev.BEADS_DIR === undefined) delete process.env.BEADS_DIR
      else process.env.BEADS_DIR = prev.BEADS_DIR
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** One journaled post-tool line — the shape emitPostTool writes. */
function trace(fx: Fixture, sessionId: string, entries: object[]): void {
  const dir = join(fx.hooks, 'trace')
  mkdirSync(dir, { recursive: true })
  appendLines(join(dir, `${sessionId}.jsonl`), entries)
}

function appendLines(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const hooks = () => learnConnector.hooks!({ dir: '' })
const probe = {
  sessionStart: (dir: string, sid: string) =>
    hooks().sessionStart!({ dir, sessionId: sid }),
  promptSubmit: (dir: string, sid: string, prompt: string) =>
    hooks().promptSubmit!({ dir, sessionId: sid }, prompt),
  postTool: (dir: string, sid: string) =>
    hooks().postTool!({ dir, sessionId: sid }),
}

describe('learnConnector', { skip: WIN32 }, () => {
  it('postTool fires a lesson whose command prefix is in the trace, once', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-sweep-debt', {
          trigger: { on: ['post-tool'], match: { commands: ['gh pr merge'] } },
          lesson: 'after gh pr merge, run bro debt collect',
        }),
      ],
    })
    try {
      trace(fx, 's1', [
        { ts: 1, tool: 'exec', command: 'gh pr merge 42 --squash', ok: true },
      ])
      const lines = await probe.postTool(fx.dir, 's1')
      assert.deepEqual(lines, [
        'bro learn learn-sweep-debt: after gh pr merge, run bro debt collect',
      ])
      // budget 1 spent — a second probe (or restart) does not re-fire
      assert.deepEqual(await probe.postTool(fx.dir, 's1'), [])
      assert.equal(
        readFileSync(join(fx.hooks, 'fired', 's1'), 'utf8').trim(),
        'learn-sweep-debt'
      )
    } finally {
      fx.restore()
    }
  })

  it('postTool matches repo-relative path globs against absolute trace paths', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-spec-first', {
          trigger: { on: ['post-tool'], match: { paths: ['specs/**'] } },
          lesson: 'spec edits need the spec gate',
        }),
      ],
    })
    try {
      trace(fx, 's1', [
        { ts: 1, tool: 'edit', paths: [join(fx.dir, 'specs', 'x.md')], ok: true },
      ])
      const lines = await probe.postTool(fx.dir, 's1')
      assert.equal(lines.length, 1)
      assert.match(lines[0]!, /learn-spec-first/)
    } finally {
      fx.restore()
    }
  })

  it('postTool errors trigger fires on a failed landing only', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-check-fail', {
          trigger: { on: ['post-tool'], match: { errors: true } },
          lesson: 'a tool failed — check the error before continuing',
        }),
      ],
    })
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'true', ok: true }])
      assert.deepEqual(await probe.postTool(fx.dir, 's1'), [])
      trace(fx, 's1', [
        { ts: 1, tool: 'exec', command: 'true', ok: true },
        { ts: 2, tool: 'exec', command: 'npm test', ok: false },
      ])
      assert.equal((await probe.postTool(fx.dir, 's1')).length, 1)
    } finally {
      fx.restore()
    }
  })

  it('promptSubmit matches terms against the raw prompt', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-merge-rules', {
          trigger: { on: ['prompt-submit'], match: { terms: ['merge'] } },
          lesson: 'merge is yours — fix the gate until it merges',
        }),
        lesson('learn-other-event', {
          trigger: { on: ['post-tool'] },
          lesson: 'not for prompts',
        }),
      ],
    })
    try {
      const lines = await probe.promptSubmit(fx.dir, 's1', 'now merge the PR')
      assert.deepEqual(lines, [
        'bro learn learn-merge-rules: merge is yours — fix the gate until it merges',
      ])
    } finally {
      fx.restore()
    }
  })

  it('sessionStart matches terms against session context and the previous trace', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-repo-rule', {
          trigger: { on: ['session-start'], match: { terms: ['branch:main'] } },
          lesson: 'on main — watch the push target',
        }),
        lesson('learn-prev-trace', {
          trigger: {
            on: ['session-start'],
            match: { commands: ['bro act wait'] },
          },
          lesson: 'previous session was watching a PR gate',
        }),
      ],
    })
    try {
      // another session's journal — resumable context for this session
      trace(fx, 'previous-session', [
        { ts: 1, tool: 'exec', command: 'bro act wait --merge', ok: true },
      ])
      const lines = (await probe.sessionStart(fx.dir, 's1')) as string[]
      assert.ok(lines.some((l) => l.includes('learn-repo-rule')))
      assert.ok(lines.some((l) => l.includes('learn-prev-trace')))
    } finally {
      fx.restore()
    }
  })

  it('sessionStart relativizes the previous session’s trace paths', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-spec-first', {
          trigger: { on: ['session-start'], match: { paths: ['specs/**'] } },
          lesson: 'spec edits need the spec gate',
        }),
      ],
    })
    try {
      // journaled paths are absolute — a repo-relative glob must still hit
      trace(fx, 'prev', [
        { ts: 1, tool: 'edit', paths: [join(fx.dir, 'specs', 'x.md')], ok: true },
      ])
      const lines = (await probe.sessionStart(fx.dir, 's1')) as string[]
      assert.ok(lines.some((l) => l.includes('learn-spec-first')))
    } finally {
      fx.restore()
    }
  })

  it('sessionStart skips a live session’s trace — concurrent work is not resume context', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-resume', {
          trigger: { on: ['session-start'], match: { commands: ['bro act wait'] } },
          lesson: 'previous session was watching a PR gate',
        }),
        lesson('learn-live-leak', {
          trigger: { on: ['session-start'], match: { commands: ['secret-cmd'] } },
          lesson: 'live peer context leaked',
        }),
      ],
    })
    try {
      trace(fx, 'live-peer', [
        { ts: 9, tool: 'exec', command: 'secret-cmd', ok: true },
      ])
      trace(fx, 'dead-peer', [
        { ts: 8, tool: 'exec', command: 'bro act wait', ok: true },
      ])
      // an ownerless marker reads live inside the day window; aging the
      // dead peer's out of it leaves its trace eligible
      mkdirSync(fx.hooks, { recursive: true })
      writeFileSync(join(fx.hooks, 'live-peer.work'), `${Date.now()}\nfx-9\n`)
      writeFileSync(join(fx.hooks, 'dead-peer.work'), `${Date.now()}\nfx-1\n`)
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      utimesSync(join(fx.hooks, 'dead-peer.work'), old, old)
      const lines = (await probe.sessionStart(fx.dir, 's1')) as string[]
      assert.ok(lines.some((l) => l.includes('learn-resume')))
      assert.ok(!lines.some((l) => l.includes('learn-live-leak')))
    } finally {
      fx.restore()
    }
  })

  it('sessionStart finds mol steps via the parent relationship, not the id shape', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-mol', {
          trigger: { on: ['session-start'], match: { terms: ['mol-step:fx-9'] } },
          lesson: 'mid-molecule — resume the convoy',
        }),
        lesson('learn-not-mol', {
          trigger: { on: ['session-start'], match: { terms: ['mol-step:fx-10'] } },
          lesson: 'a plain child is not a mol step',
        }),
      ],
      rows: [
        { id: 'mol-1', title: 'the molecule', status: 'open', issue_type: 'molecule' },
        { id: 'fx-9', title: 'step nine', status: 'in_progress', parent: 'mol-1' },
        { id: 'fx-10', title: 'plain child', status: 'in_progress', parent: 'fx-1' },
        { id: 'fx-1', title: 'a feature', status: 'open', issue_type: 'task' },
      ],
    })
    try {
      const lines = (await probe.sessionStart(fx.dir, 's1')) as string[]
      assert.ok(lines.some((l) => l.includes('learn-mol')))
      assert.ok(!lines.some((l) => l.includes('learn-not-mol')))
    } finally {
      fx.restore()
    }
  })

  it('postTool caches the lesson list — a store write invalidates the snapshot', async () => {
    const fx = fixture({
      lessons: [lesson('learn-x', { trigger: { on: ['post-tool'] } })],
    })
    const prevLog = process.env.FAKE_BD_LOG
    const log = join(fx.dir, 'bd.log')
    process.env.FAKE_BD_LOG = log
    // a recognizable embeddeddolt layout makes the store cacheable —
    // the noms manifest is the write barometer the snapshot keys on
    const manifest = join(fx.dir, '.beads', 'embeddeddolt', 'x', '.dolt', 'noms', 'manifest')
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(manifest, 'm1')
    const kvLists = (): number =>
      readFileSync(log, 'utf8').split('\n').filter((l) => l === 'kv list').length
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'x', ok: true }])
      assert.equal((await probe.postTool(fx.dir, 's1')).length, 1)
      // second probe hits the snapshot — no second `bd kv list` spawn
      await probe.postTool(fx.dir, 's1')
      assert.equal(kvLists(), 1)
      // a store write bumps the manifest — the next probe reads live
      const later = new Date(Date.now() + 60_000)
      utimesSync(manifest, later, later)
      await probe.postTool(fx.dir, 's1')
      assert.equal(kvLists(), 2)
    } finally {
      if (prevLog === undefined) delete process.env.FAKE_BD_LOG
      else process.env.FAKE_BD_LOG = prevLog
      fx.restore()
    }
  })

  it('a stale fired lock is stolen — the probe still emits', async () => {
    const fx = fixture({
      lessons: [lesson('learn-x', { trigger: { on: ['post-tool'] } })],
    })
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'x', ok: true }])
      // a crashed holder's lock — the dead pid makes it stealable
      mkdirSync(join(fx.hooks, 'fired'), { recursive: true })
      writeFileSync(join(fx.hooks, 'fired', 's1.lock'), '2000000000:dead')
      assert.equal((await probe.postTool(fx.dir, 's1')).length, 1)
    } finally {
      fx.restore()
    }
  })

  it('sessionStart sees this session’s claimed beads via the task marker', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-bead-rule', {
          trigger: { on: ['session-start'], match: { terms: ['urgent-bead'] } },
          lesson: 'the claimed bead wants care',
        }),
      ],
      rows: [
        { id: 'fx-1', title: 'urgent-bead refactor', status: 'in_progress', labels: ['x'] },
      ],
    })
    try {
      // the .task marker is what a `bd … --claim` arming records
      mkdirSync(fx.hooks, { recursive: true })
      writeFileSync(join(fx.hooks, 's1.task'), `${Date.now()}\nfx-1\n`)
      const lines = (await probe.sessionStart(fx.dir, 's1')) as string[]
      assert.ok(lines.some((l) => l.includes('learn-bead-rule')))
    } finally {
      fx.restore()
    }
  })

  it('budget >1 allows repeat fires, then stops', async () => {
    const fx = fixture({
      lessons: [
        lesson('learn-twice', {
          trigger: { on: ['post-tool'], budget: 2 },
        }),
      ],
    })
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'x', ok: true }])
      assert.equal((await probe.postTool(fx.dir, 's1')).length, 1)
      assert.equal((await probe.postTool(fx.dir, 's1')).length, 1)
      assert.deepEqual(await probe.postTool(fx.dir, 's1'), [])
      assert.equal(
        readFileSync(join(fx.hooks, 'fired', 's1'), 'utf8').trim().split('\n').length,
        2
      )
    } finally {
      fx.restore()
    }
  })

  it('learn.enabled=false silences every probe', async () => {
    const fx = fixture({
      config: { learn: { enabled: false } },
      lessons: [lesson('learn-off', { trigger: { on: ['post-tool'] } })],
    })
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'x', ok: true }])
      assert.deepEqual(await probe.postTool(fx.dir, 's1'), [])
      assert.equal(existsSync(join(fx.hooks, 'fired', 's1')), false)
    } finally {
      fx.restore()
    }
  })

  it('learn.sources filters which lesson sources may inject', async () => {
    const fx = fixture({
      config: { learn: { sources: ['probe'] } },
      lessons: [
        lesson('learn-manual', { source: 'manual', trigger: { on: ['post-tool'] } }),
        lesson('learn-probe', { source: 'probe', trigger: { on: ['post-tool'] } }),
      ],
    })
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'x', ok: true }])
      const lines = await probe.postTool(fx.dir, 's1')
      assert.deepEqual(lines, ['bro learn learn-probe: rule for learn-probe'])
    } finally {
      fx.restore()
    }
  })

  it('learn.maxInject caps lines per probe', async () => {
    const fx = fixture({
      config: { learn: { maxInject: 1 } },
      lessons: [
        lesson('learn-a', { trigger: { on: ['post-tool'] } }),
        lesson('learn-b', { trigger: { on: ['post-tool'] } }),
      ],
    })
    try {
      trace(fx, 's1', [{ ts: 1, tool: 'exec', command: 'x', ok: true }])
      const lines = await probe.postTool(fx.dir, 's1')
      assert.equal(lines.length, 1)
      // the capped lesson still fires — the cap is per-probe, not permanent
      assert.equal((await probe.postTool(fx.dir, 's1')).length, 1)
    } finally {
      fx.restore()
    }
  })

  it('no session id and no git dir both emit nothing', async () => {
    const fx = fixture({ lessons: [lesson('learn-x')] })
    try {
      assert.deepEqual(await probe.postTool(fx.dir, ''), [])
      assert.deepEqual(await probe.postTool(join(fx.dir, 'no-such'), 's1'), [])
    } finally {
      fx.restore()
    }
  })
})

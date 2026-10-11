import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { captureLessons, planCapture, type CaptureCandidate } from './capture.ts'
import { getLesson, lessonIds } from './store.ts'
import type { Lesson } from './lesson.ts'

/** Scripted `bd` on PATH — wider than store.test.ts's kv-only fake:
 *  `list`/`show`/`dep list` serve seeded issue rows, `mol show` serves
 *  db.mols[id], `kv` mutates db.kv. Seed file shape:
 *  {rows: TaskRow[], kv: {}, deps: [{issue_id,depends_on_id,type}]} */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.FAKE_BD_DB
const fail = (m) => { console.error('fake bd: ' + m); process.exit(1) }
const load = () => {
  try {
    const d = JSON.parse(fs.readFileSync(DB, 'utf8'))
    return { rows: [], kv: {}, deps: [], mols: {}, ...d }
  } catch { return { rows: [], kv: {}, deps: [], mols: {} } }
}
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
const args = process.argv.slice(2)
const flags = {}
const pos = []
for (let i = 0; i < args.length; i++) {
  const t = args[i]
  if (t === '--json') continue
  if (t.startsWith('--')) {
    const k = t.slice(2)
    if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) flags[k] = args[++i]
    else flags[k] = true
  } else if (/^-\\w$/.test(t) && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
    const k = t.slice(1)
    flags[k] = flags[k] === undefined ? args[++i] : [].concat(flags[k], args[++i])
  } else pos.push(t)
}
const db = load()
const row = (id) => db.rows.find((r) => r.id === id)
const jsonOut = (v) => process.stdout.write(JSON.stringify(v) + '\\n')
// FAKE_BD_LOG records every invocation (one argv per line) so tests can
// assert the bd call budget instead of re-measuring wall time
if (process.env.FAKE_BD_LOG) {
  fs.appendFileSync(process.env.FAKE_BD_LOG, args.join(' ') + '\\n')
}
switch (pos[0]) {
  case 'list': {
    let rows = db.rows
    if (!flags.all) rows = rows.filter((r) => r.status !== 'closed' && r.status !== 'done')
    const labs = [].concat(flags.l || [])
    for (const l of labs) rows = rows.filter((r) => (r.labels || []).includes(l))
    if (flags.n !== undefined && Number(flags.n) > 0) rows = rows.slice(0, Number(flags.n))
    jsonOut(rows)
    break
  }
  case 'show': {
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    jsonOut([r])
    break
  }
  case 'dep': {
    if (pos[1] !== 'list') fail('dep ' + pos[1])
    const ids = pos.slice(2)
    const type = flags.t
    const out = []
    for (const e of db.deps) {
      if (type && e.type !== type) continue
      // direction 'down' — the queried id is the dependent; its
      // neighbors are what it depends on (real bd's reading)
      if (!ids.includes(e.issue_id)) continue
      if (ids.length === 1) {
        // single-id dep list hydrates neighbor rows
        const r = row(e.depends_on_id)
        if (r) out.push({ ...r, dependency_type: e.type })
      } else {
        // multi-id dep list returns flat edge records
        out.push({ issue_id: e.issue_id, depends_on_id: e.depends_on_id, type: e.type })
      }
    }
    jsonOut(out)
    break
  }
  case 'mol': {
    if (pos[1] !== 'show') fail('mol ' + pos[1])
    const m = db.mols[pos[2]]
    if (!m) fail('no molecule ' + pos[2])
    jsonOut(m)
    break
  }
  case 'kv': {
    const sub = pos[1]
    if (sub === 'set') { db.kv[pos[2]] = pos[3]; save(db) }
    else if (sub === 'get') {
      if (db.kv[pos[2]] === undefined) { console.error(pos[2] + ' (not set)'); process.exit(1) }
      console.log(db.kv[pos[2]])
    }
    else if (sub === 'clear') { delete db.kv[pos[2]]; save(db) }
    else if (sub === 'list') jsonOut(db.kv)
    else fail('kv ' + sub)
    break
  }
  case 'config':
    if (pos[1] === 'get' && pos[2] === 'issue_prefix') console.log('issue_prefix = fx')
    else fail('config ' + pos.slice(1).join(' '))
    break
  default:
    fail('unhandled: ' + args.join(' '))
}
`

const WIN32 = process.platform === 'win32'

interface Seed {
  rows?: Array<Record<string, unknown>>
  kv?: Record<string, string>
  deps?: Array<Record<string, unknown>>
  mols?: Record<string, unknown>
}

function withFakeBd(seed: Seed, fn: (db: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-learn-capture-'))
  const prev = {
    PATH: process.env.PATH,
    FAKE_BD_DB: process.env.FAKE_BD_DB,
    FAKE_BD_LOG: process.env.FAKE_BD_LOG,
  }
  writeFileSync(join(dir, 'bd'), FAKE_BD)
  chmodSync(join(dir, 'bd'), 0o755)
  process.env.PATH = `${dir}:${prev.PATH}`
  process.env.FAKE_BD_DB = join(dir, 'beads.json')
  process.env.FAKE_BD_LOG = join(dir, 'bd.log')
  writeFileSync(process.env.FAKE_BD_DB, JSON.stringify(seed))
  writeFileSync(process.env.FAKE_BD_LOG, '')
  try {
    fn(process.env.FAKE_BD_DB)
  } finally {
    process.env.PATH = prev.PATH
    if (prev.FAKE_BD_DB === undefined) delete process.env.FAKE_BD_DB
    else process.env.FAKE_BD_DB = prev.FAKE_BD_DB
    if (prev.FAKE_BD_LOG === undefined) delete process.env.FAKE_BD_LOG
    else process.env.FAKE_BD_LOG = prev.FAKE_BD_LOG
    rmSync(dir, { recursive: true, force: true })
  }
}

/** bd argv lines the fake recorded this fixture — the call budget. */
const callLog = (db: string): string[] =>
  readFileSync(join(dirname(db), 'bd.log'), 'utf8').trim().split('\n').filter(Boolean)

const readKv = (db: string): Record<string, string> =>
  JSON.parse(readFileSync(db, 'utf8')).kv ?? {}

const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  labels: [],
  ...over,
})

const DRILL_MEMO = '## Result\n\nconvoy next resolves the single open molecule\n\n## Prevention\n\n- pass --mol explicitly'

const beadEv = (...refs: string[]): { kind: 'bead'; ref: string }[] =>
  refs.map((ref) => ({ kind: 'bead', ref }))

/** plan.write holds exactly one lesson — return it for field asserts. */
const singleWrite = (plan: ReturnType<typeof captureLessons>['plan']): Lesson => {
  assert.equal(plan.write.length, 1)
  return plan.write[0]!.lesson
}

describe('capture', { skip: WIN32 }, () => {
  it('drill: a closed frame memo becomes a post-tool lesson', () => {
    withFakeBd(
      {
        rows: [
          row('fx-d1', {
            status: 'closed',
            labels: ['drill'],
            title: 'investigate bro convoy next --mol',
            description: 'look at packages/convoy/**',
            notes: DRILL_MEMO,
          }),
        ],
      },
      (db) => {
        const { plan } = captureLessons({ sources: ['drill'] })
        assert.equal(plan.write.length, 1)
        const l = plan.write[0]!.lesson
        assert.match(l.id, /^learn-convoy-next-resolves/)
        assert.equal(
          l.lesson,
          'convoy next resolves the single open molecule — prevent: pass --mol explicitly'
        )
        assert.deepEqual(l.trigger.on, ['post-tool'])
        assert.ok(l.trigger.match?.paths?.includes('packages/convoy/**'))
        assert.ok(l.trigger.match?.commands?.includes('bro convoy next'))
        assert.deepEqual(l.evidence, [{ kind: 'bead', ref: 'fx-d1' }])
        assert.equal(l.source, 'capture:drill')
        assert.equal(l.confidence, 'tentative')
        // and it landed in the kv store
        assert.ok(readKv(db)[`learn/${l.id}`])
      }
    )
  })

  it('drill: bare dotfiles are trigger paths — .env and .gitignore count', () => {
    withFakeBd(
      {
        rows: [
          row('fx-d2', {
            status: 'closed',
            labels: ['drill'],
            title: 'investigate env loading',
            description: 'edits land in .env and .gitignore only',
            notes: DRILL_MEMO,
          }),
        ],
      },
      () => {
        const { plan } = captureLessons({ sources: ['drill'] })
        const l = plan.write[0]!.lesson
        assert.ok(l.trigger.match?.paths?.includes('.env'))
        assert.ok(l.trigger.match?.paths?.includes('.gitignore'))
      }
    )
  })

  it('drill: a sink-routed closed prevention bead auto-captures as established', () => {
    withFakeBd(
      {
        rows: [
          row('fx-p1', {
            status: 'closed',
            labels: ['prevention', 'sink:agentic-documents'],
            title: 'prevention: docs-only PRs — cap inline fix rounds',
            description: 'update AGENTS.md\nsink: agentic-documents',
          }),
          row('fx-r1', { status: 'closed', labels: ['retro'], title: 'retro: rounds' }),
        ],
        deps: [{ issue_id: 'fx-p1', depends_on_id: 'fx-r1', type: 'discovered-from' }],
      },
      () => {
        const l = singleWrite(captureLessons({ sources: ['drill'] }).plan)
        assert.equal(l.lesson, 'docs-only PRs — cap inline fix rounds')
        assert.deepEqual(l.evidence, beadEv('fx-p1', 'fx-r1'))
        assert.equal(l.confidence, 'established')
      }
    )
  })

  it('drill: prevention beads without a sink route are not auto-captured', () => {
    withFakeBd(
      {
        rows: [
          row('fx-p2', {
            status: 'closed',
            labels: ['prevention'],
            title: 'unrouted prevention',
          }),
        ],
      },
      () => {
        const { plan } = captureLessons({ sources: ['drill'] })
        assert.equal(plan.write.length, 0)
        assert.equal(plan.merge.length, 0)
      }
    )
  })

  it('retro: ## Why is the lesson, the originating wtf is evidence', () => {
    withFakeBd(
      {
        rows: [
          row('fx-r1', {
            status: 'closed',
            labels: ['retro'],
            title: 'retro: blocked the conversation on a synchronous wait',
            description:
              '## What\n\nBlocked the conversation on a synchronous 5-min get_output wait.\n\n## Why\n\nChose a blocking wait instead of polling logs between turns.\n\nscope: agent',
          }),
          row('fx-w1', { status: 'closed', labels: ['wtf'], title: 'wtf: blocked' }),
        ],
        deps: [{ issue_id: 'fx-r1', depends_on_id: 'fx-w1', type: 'discovered-from' }],
      },
      () => {
        const l = singleWrite(captureLessons({ sources: ['retro'] }).plan)
        assert.equal(l.lesson, 'Chose a blocking wait instead of polling logs between turns.')
        assert.deepEqual(l.evidence, beadEv('fx-r1', 'fx-w1'))
        assert.equal(l.source, 'capture:retro')
        assert.equal(l.confidence, 'established')
      }
    )
  })

  it('act: a fingerprint recurring across PRs becomes one lesson', () => {
    withFakeBd(
      {
        rows: [
          row('fx-x1', {
            status: 'closed',
            labels: ['debt'],
            title: 'packages/cli: use Array.from for sparse evidence',
            description: 'body\npr: https://example.test/o/r/pull/5',
            metadata: { fingerprint: 'abc', source_pr: 5, times_seen: 1, path: 'packages/cli/src/learn.ts' },
          }),
          row('fx-x2', {
            status: 'closed',
            labels: ['debt'],
            title: 'packages/cli: use Array.from for sparse evidence',
            description: 'body\npr: https://example.test/o/r/pull/9',
            metadata: { fingerprint: 'abc', source_pr: 9, times_seen: 1, path: 'packages/cli/src/learn.ts' },
          }),
          row('fx-x3', {
            status: 'closed',
            labels: ['debt'],
            title: 'root: one-off nit',
            metadata: { fingerprint: 'zzz', source_pr: 7, times_seen: 1 },
          }),
        ],
      },
      () => {
        const { plan } = captureLessons({ sources: ['act'] })
        assert.equal(plan.write.length, 1)
        const l = plan.write[0]!.lesson
        assert.equal(l.lesson, 'use Array.from for sparse evidence')
        assert.ok(l.trigger.match?.paths?.includes('packages/cli/src/learn.ts'))
        assert.ok(
          l.evidence.some((e) => e.ref === 'fx-x1') &&
            l.evidence.some((e) => e.ref === 'fx-x2') &&
            l.evidence.some((e) => e.kind === 'pr')
        )
        assert.equal(l.confidence, 'established')
        assert.ok(plan.skipped.some((s) => s.origin === 'fx-x3'))
      }
    )
  })

  it('mol: flagged learn: lines in step results distill; unflagged do not', () => {
    withFakeBd(
      {
        // bd mol show's issue rows carry title + close_reason — no
        // per-step show follows the harvest
        mols: {
          'fx-m1': {
            root: { id: 'fx-m1', status: 'closed' },
            issues: [
              { id: 'fx-m1', status: 'closed' },
              {
                id: 'fx-s1',
                status: 'closed',
                title: 'Implement the thing',
                close_reason: 'PR open [#7](https://x/7)\nlearn: bro act merge refuses on a red gate',
              },
              { id: 'fx-s2', status: 'closed', title: 'Verify', close_reason: 'gate green' },
              // a closed step with no close_reason can't be audited —
              // it's logged, not skipped silently
              { id: 'fx-s3', status: 'closed', title: 'Cleanup' },
            ],
            dependencies: [],
          },
        },
      },
      () => {
        const { plan } = captureLessons({ mol: 'fx-m1' })
        assert.equal(plan.write.length, 1)
        const l = plan.write[0]!.lesson
        assert.equal(l.lesson, 'bro act merge refuses on a red gate')
        assert.deepEqual(l.evidence, [
          { kind: 'bead', ref: 'fx-s1' },
          { kind: 'bead', ref: 'fx-m1' },
        ])
        assert.equal(l.source, 'capture:mol')
        assert.ok(
          plan.skipped.some(
            (s) => s.origin === 'fx-s3' && s.reason === 'closed step has no close_reason'
          )
        )
      }
    )
  })

  it('mol: refuses to harvest an open molecule', () => {
    withFakeBd(
      { mols: { 'fx-m2': { root: { id: 'fx-m2', status: 'open' }, issues: [], dependencies: [] } } },
      () => {
        assert.throws(() => captureLessons({ mol: 'fx-m2' }), /is open/)
      }
    )
  })

  it('dedup: a repeat capture merges evidence instead of writing a second lesson', () => {
    const seed: Seed = {
      rows: [
        row('fx-d1', {
          status: 'closed',
          labels: ['drill'],
          title: 'investigate bro convoy next --mol',
          notes: DRILL_MEMO,
        }),
      ],
    }
    withFakeBd(seed, () => {
      const first = captureLessons({ sources: ['drill'] })
      const id = first.plan.write[0]!.lesson.id
      // second pass: the same memo plus a corroborating prevention dep
      const db = process.env.FAKE_BD_DB!
      const stored = JSON.parse(readFileSync(db, 'utf8'))
      stored.rows.push(
        row('fx-p1', {
          status: 'closed',
          labels: ['prevention', 'sink:backlog'],
          title: 'prevention: convoy next resolves the single open molecule — prevent: pass --mol explicitly',
        })
      )
      stored.deps.push({ issue_id: 'fx-p1', depends_on_id: 'fx-d1', type: 'discovered-from' })
      writeFileSync(db, JSON.stringify(stored))

      const second = captureLessons({ sources: ['drill'] })
      // the frame now harvests with extra evidence → merge, not a new write
      assert.equal(second.plan.write.length, 0)
      assert.equal(second.plan.merge.length, 1)
      assert.ok(second.plan.merge[0]!.added.some((e) => e.ref === 'fx-p1'))
      assert.equal(getLesson(id)!.confidence, 'established')
      assert.equal([...lessonIds()].filter((i) => i === id).length, 1)
    })
  })

  it('dryRun renders the plan without writing the store', () => {
    withFakeBd(
      {
        rows: [
          row('fx-d1', {
            status: 'closed',
            labels: ['drill'],
            title: 'investigate bro convoy next --mol',
            notes: DRILL_MEMO,
          }),
        ],
      },
      (db) => {
        const { plan, dryRun } = captureLessons({ sources: ['drill'], dryRun: true })
        assert.equal(dryRun, true)
        assert.equal(plan.write.length, 1)
        assert.deepEqual(readKv(db), {})
      }
    )
  })

  it('harvest is O(1) bd calls — no per-row show/dep storm (bro-rcs07)', () => {
    const rows: Array<Record<string, unknown>> = []
    const deps: Array<Record<string, unknown>> = []
    for (let i = 0; i < 30; i++) {
      rows.push(
        row(`fx-d${i}`, {
          status: 'closed',
          labels: ['drill'],
          title: `investigate bro convoy next ${i}`,
          description: 'look at packages/convoy/**',
          notes: DRILL_MEMO,
        }),
        row(`fx-p${i}`, {
          status: 'closed',
          labels: ['prevention', 'sink:docs'],
          title: `prevention: rule ${i}`,
          description: 'update packages/convoy/**',
        }),
        row(`fx-r${i}`, {
          status: 'closed',
          labels: ['retro'],
          title: `retro: chose wrong ${i}`,
          description: '## Why\n\nchose wrong\n\nscope: agent',
        }),
        row(`fx-w${i}`, { status: 'closed', labels: ['wtf'], title: `wtf ${i}` })
      )
      deps.push(
        { issue_id: `fx-p${i}`, depends_on_id: `fx-r${i}`, type: 'discovered-from' },
        { issue_id: `fx-r${i}`, depends_on_id: `fx-w${i}`, type: 'discovered-from' }
      )
    }
    withFakeBd({ rows, deps }, (db) => {
      // dry-run: the reported repro — reads must not scale with row count
      const { plan } = captureLessons({ dryRun: true })
      assert.ok(plan.write.length > 0)
      const calls = callLog(db)
      // the old path cost one show per closed drill frame plus one
      // dep list per evidence row — 60+ serial shell-outs on this seed
      assert.equal(calls.filter((c) => c.startsWith('show ')).length, 0)
      const depLists = calls.filter((c) => c.startsWith('dep list '))
      assert.ok(depLists.length <= 3, `dep list calls: ${depLists.length}`)
      // label pools + dep batches + kv list — bounded, not per-row
      assert.ok(calls.length <= 10, `total bd calls: ${calls.length}`)
    })
  })

  it('skips artifacts with no extractable trigger scope', () => {
    withFakeBd(
      {
        rows: [
          row('fx-d9', {
            status: 'closed',
            labels: ['drill'],
            title: 'xy',
            notes: '## Result\n\nok',
          }),
        ],
      },
      () => {
        const { plan } = captureLessons({ sources: ['drill'] })
        assert.equal(plan.write.length, 0)
        assert.ok(plan.skipped.some((s) => s.origin === 'fx-d9' && /no trigger scope/.test(s.reason)))
      }
    )
  })

  it('planCapture: a corrupt key squatting an id skips instead of merging blind', () => {
    const c: CaptureCandidate = {
      lesson: 'some rule',
      trigger: { on: ['post-tool'], match: { commands: ['x'] } },
      evidence: [{ kind: 'bead', ref: 'fx-1' }],
      source: 'capture:drill',
      origin: 'fx-1',
    }
    const id = 'learn-some-rule'
    withFakeBd({ kv: { 'learn/learn-some-rule': '{broken json' } }, () => {
      const plan = planCapture([c])
      assert.equal(plan.write.length, 0)
      assert.equal(plan.merge.length, 0)
      assert.ok(plan.skipped.some((s) => /fails schema/.test(s.reason)))
    })
  })

  it('planCapture: two candidates with the same text fold into one write', () => {
    const mk = (origin: string): CaptureCandidate => ({
      lesson: 'same rule',
      trigger: { on: ['post-tool'], match: { commands: ['x'] } },
      evidence: [{ kind: 'bead', ref: origin }],
      source: 'capture:drill',
      origin,
    })
    withFakeBd({}, () => {
      const plan = planCapture([mk('fx-1'), mk('fx-2')])
      assert.equal(plan.write.length, 1)
      assert.equal(plan.merge.length, 0)
      assert.equal(plan.write[0]!.lesson.evidence.length, 2)
      assert.equal(plan.write[0]!.lesson.confidence, 'established')
    })
  })

  it('never downgrades confidence on merge', () => {
    const existing: Lesson = {
      id: 'learn-some-rule',
      trigger: { on: ['session-start'] },
      lesson: 'some rule',
      evidence: [
        { kind: 'bead', ref: 'fx-a' },
        { kind: 'bead', ref: 'fx-b' },
      ],
      confidence: 'established',
      source: 'capture:retro',
      createdAt: '2026-10-01T00:00:00.000Z',
    }
    withFakeBd(
      { kv: { 'learn/learn-some-rule': JSON.stringify(existing) } },
      () => {
        const c: CaptureCandidate = {
          lesson: 'some rule',
          trigger: { on: ['post-tool'], match: { commands: ['x'] } },
          evidence: [{ kind: 'bead', ref: 'fx-c' }],
          source: 'capture:drill',
          origin: 'fx-c',
        }
        const plan = planCapture([c])
        assert.equal(plan.merge.length, 1)
        const l = plan.merge[0]!.lesson
        assert.equal(l.confidence, 'established')
        assert.equal(l.evidence.length, 3)
        assert.equal(l.trigger.on[0], 'session-start') // original trigger kept
        assert.equal(l.promotedTo, undefined)
      }
    )
  })
})

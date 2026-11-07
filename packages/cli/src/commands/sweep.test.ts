/** `bro sweep` e2e — the gated disposal pipeline against the fake bd
 *  store: status counts, distill materialization (auto-mark + molecule
 *  pour), and run's gate → archive → data-ref → prune → flatten. The
 *  archive lands on refs/bro/data, never in the branch — the test repo
 *  gitignores `.agents/` exactly like a real synced repo. */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FAKE_BEAD,
  git,
  initRepo,
  inside,
  installFakeBd,
  readBeads,
  runCli,
  writeBeads,
} from './testrepo.ts'

const DAY = 86_400_000
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()

const closed = (id: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({
  ...FAKE_BEAD,
  id,
  title: `closed ${id}`,
  status: 'closed',
  close_reason: 'done',
  closed_at: iso(daysAgo),
  ...extra,
})

function fixture(
  rows: Array<Record<string, unknown>>,
  opts: {
    config?: Record<string, unknown>
    kv?: Record<string, string>
    prov?: Record<string, unknown[]>
    provFail?: string[]
  } = {}
) {
  const { root, main } = initRepo('bro-sweep-e2e-', (dir) => {
    writeFileSync(join(dir, '.gitignore'), '.agents/\n')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ store: 'jsonl', ...(opts.config ?? {}) })
    )
  })
  const { binDir, db } = installFakeBd(root, [])
  writeBeads(db, rows, {
    kv: opts.kv ?? {},
    prov: opts.prov ?? {},
    provFail: opts.provFail ?? [],
  })
  const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db }
  return {
    root,
    main,
    db,
    run: (args: string[]) => runCli(['sweep', ...args], { cwd: main, env }),
  }
}

const labels = (db: string, id: string): string[] => {
  const row = readBeads(db).find((r) => r.id === id)
  return Array.isArray(row?.labels) ? (row.labels as string[]) : []
}

const lesson = (ref: string) =>
  JSON.stringify({
    id: 'learn-t1',
    trigger: { on: ['post-tool'] },
    lesson: 'harvest me',
    evidence: [{ kind: 'bead', ref }],
    confidence: 'tentative',
    source: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
  })

describe('bro sweep status', () => {
  test('reports closed/harvested/undated/old counts and the gate set', () => {
    const f = fixture([
      closed('fx-old-unharv', 60),
      closed('fx-old-harv', 60, { labels: ['sweep:distilled'] }),
      closed('fx-recent', 5),
      { ...FAKE_BEAD, id: 'fx-nodate', status: 'closed' },
      { ...FAKE_BEAD, id: 'fx-open' },
      closed('fx-eph', 90, { ephemeral: true }),
    ])
    inside(f.main, f.root, () => {
      const r = f.run(['status'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /closed: 4 {2}/)
      assert.match(r.stdout, /harvested: 1 {2}/)
      assert.match(r.stdout, /unharvested: 3 {2}/)
      assert.match(r.stdout, /undated: 1/)
      assert.match(r.stdout, /older-than 30d: 2 \(1 unharvested\)/)
      assert.match(r.stdout, /would-burn now: 0/)
      assert.match(r.stdout, /undated \(gate-blocking\): fx-nodate/)
      assert.match(r.stdout, /unharvested\tfx-old-unharv/)
      // ephemeral rows are outside the closed set entirely
      assert.doesNotMatch(r.stdout, /fx-eph|fx-open/)
    })
  })

  test('all-harvested old set → would-burn counts them', () => {
    const f = fixture([closed('fx-old', 60, { labels: ['sweep:distilled'] })])
    inside(f.main, f.root, () => {
      const r = f.run(['status'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /would-burn now: 1/)
      assert.doesNotMatch(r.stdout, /undated \(gate-blocking\)/)
    })
  })

  test('empty store → zeros, no gate rows', () => {
    const f = fixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['status'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /closed: 0/)
      assert.match(r.stdout, /would-burn now: 0/)
    })
  })
})

describe('bro sweep distill', () => {
  test('--dry-run lists auto-mark and steps without mutating', () => {
    const f = fixture([closed('fx-cited', 60), closed('fx-plain', 60)], {
      kv: { 'learn/learn-t1': lesson('fx-cited') },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['distill', '--dry-run'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /1 auto-mark, 1 step/)
      assert.match(r.stdout, /auto-mark\tfx-cited/)
      assert.match(r.stdout, /step\tfx-plain/)
      assert.deepEqual(labels(f.db, 'fx-cited'), [])
      assert.ok(!readBeads(f.db).some((b) => String(b.id).startsWith('fx-mol-')))
    })
  })

  test('marks learn-cited beads, pours the rest as one molecule', () => {
    const f = fixture([closed('fx-cited', 60), closed('fx-plain', 60)], {
      kv: { 'learn/learn-t1': lesson('fx-cited') },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['distill'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /marked\tfx-cited/)
      assert.match(r.stdout, /molecule fx-mol-\d+ poured — 1 step\(s\), 1 auto-marked/)
      assert.ok(labels(f.db, 'fx-cited').includes('sweep:distilled'))
      assert.ok(!labels(f.db, 'fx-plain').includes('sweep:distilled'))
      assert.ok(readBeads(f.db).some((b) => String(b.id).startsWith('fx-mol-')))
    })
  })

  test('nothing unharvested → no-op', () => {
    const f = fixture([closed('fx-done', 60, { labels: ['sweep:distilled'] })])
    inside(f.main, f.root, () => {
      const r = f.run(['distill'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /nothing unharvested/)
    })
  })
})

describe('bro sweep run', () => {
  test('--dry-run prints every stage and mutates nothing', () => {
    const f = fixture([closed('fx-old-unharv', 60)])
    inside(f.main, f.root, () => {
      const r = f.run(['run', '--dry-run'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /gate:\s+REFUSE — 1/)
      assert.match(r.stdout, /archive: bd export/)
      assert.match(r.stdout, /prune:.*1 bead/)
      assert.match(r.stdout, /flatten: bd flatten/)
      assert.equal(existsSync(join(f.main, '.agents')), false)
      assert.equal(readBeads(f.db).length, 1)
    })
  })

  test('gate refuses while old unharvested beads exist — the refusal is the feature', () => {
    const f = fixture([closed('fx-old-unharv', 60)])
    inside(f.main, f.root, () => {
      const r = f.run(['run'])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /1 unharvested\/undated bead.*older than 30d/)
      assert.match(r.stderr, /fx-old-unharv/)
      assert.equal(readBeads(f.db).length, 1)
      assert.equal(existsSync(join(f.main, '.agents')), false)
    })
  })

  test('undated closed beads block the gate — cannot prove safe', () => {
    const f = fixture([{ ...FAKE_BEAD, id: 'fx-nodate', status: 'closed' }])
    inside(f.main, f.root, () => {
      const r = f.run(['run'])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /fx-nodate/)
      assert.equal(readBeads(f.db).length, 1)
    })
  })

  test('harvested old beads pass the gate; young unharvested survive', () => {
    const f = fixture([
      closed('fx-old', 60, { labels: ['sweep:distilled'] }),
      closed('fx-recent', 5),
    ])
    inside(f.main, f.root, () => {
      const r = f.run(['run'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /archive: \.agents\/sweep\/\S+\.jsonl/)
      assert.match(r.stdout, /prune:/)
      assert.match(r.stdout, /flatten:/)
      const rows = readBeads(f.db)
      assert.equal(rows.find((b) => b.id === 'fx-old'), undefined)
      assert.ok(rows.find((b) => b.id === 'fx-recent'))
      // the archive lives on the data ref, not the branch
      const archives = readdirSync(join(f.main, '.agents', 'sweep')).filter((n) =>
        n.endsWith('.jsonl')
      )
      assert.ok(archives.length >= 2, 'issues + provenance dumps')
      // git() throws on non-zero — the file reaching the data ref is
      // the archive-really-synced assertion
      git(['cat-file', '-e', `refs/bro/data:.agents/sweep/${archives[0]}`], f.main)
      assert.equal(git(['status', '--porcelain'], f.main).trim(), '')
    })
  })

  test('a failed provenance dump preserves the archive but refuses prune', () => {
    const f = fixture([closed('fx-old', 60, { labels: ['sweep:distilled'] })], {
      provFail: ['fx-old'],
    })
    inside(f.main, f.root, () => {
      const r = f.run(['run'])
      assert.equal(r.code, 1, r.stderr)
      assert.match(r.stderr, /provenance dump failed.*fx-old/)
      // the bead survives — an incomplete archive never reaches prune
      assert.ok(readBeads(f.db).some((b) => b.id === 'fx-old'))
      // and the archive, failure marker included, still reached the ref
      const prov = readdirSync(join(f.main, '.agents', 'sweep')).find((n) =>
        n.endsWith('.provenance.jsonl')
      )
      assert.ok(prov)
      assert.match(
        git(['show', `refs/bro/data:.agents/sweep/${prov}`], f.main),
        /provenance dump failed/
      )
    })
  })

  test('--force overrides the gate and prunes', () => {
    const f = fixture([closed('fx-old-unharv', 60)])
    inside(f.main, f.root, () => {
      const r = f.run(['run', '--force'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /prune:/)
      assert.equal(readBeads(f.db).length, 0)
    })
  })

  test('--no-flatten suppresses the flatten stage', () => {
    const f = fixture([closed('fx-old', 60, { labels: ['sweep:distilled'] })])
    inside(f.main, f.root, () => {
      const r = f.run(['run', '--no-flatten'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /flatten: skipped/)
    })
  })

  test('sweep.dir outside the synced set refuses before archiving or pruning', () => {
    for (const dir of ['docs/sweep', '.agents/../docs/sweep']) {
      const f = fixture([closed('fx-old', 60, { labels: ['sweep:distilled'] })], {
        config: { sweep: { dir } },
      })
      inside(f.main, f.root, () => {
        const r = f.run(['run'])
        assert.equal(r.code, 1, `dir=${dir}: ${r.stderr}`)
        assert.match(r.stderr, /outside the synced set/)
        assert.equal(existsSync(join(f.main, 'docs')), false)
        assert.equal(readBeads(f.db).length, 1)
      })
    }
  })

  test('nothing old enough → done without touching the archive', () => {
    const f = fixture([closed('fx-recent', 5)])
    inside(f.main, f.root, () => {
      const r = f.run(['run'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /nothing older than 30d/)
      assert.equal(existsSync(join(f.main, '.agents')), false)
    })
  })
})

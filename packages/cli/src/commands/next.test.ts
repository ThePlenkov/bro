import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyNextPlan, projectPrefix, runNextCommand } from './next.ts'
import { parseNextPlan } from './next-plan.ts'

/** A scripted `bd` on PATH — PATH lookup is the exec contract. `ready`
 *  emits FAKE_BD_READY and logs its argv into FAKE_BD_LOG; `update`
 *  records claims into FAKE_BD_LOG, and fails for ids in
 *  FAKE_BD_CLAIM_FAIL (simulates a raced-away bead). `config get
 *  issue_prefix` echoes FAKE_BD_PREFIX, "(not set)" when unset. `show`
 *  reports issue_type=epic for ids matching FAKE_BD_EPIC_PARENTS. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd 0.0' ;;
  ready) echo "$@" >> "$FAKE_BD_READY_LOG"; cat "$FAKE_BD_READY" ;;
  config)
    if [ -n "$FAKE_BD_CONFIG_FAIL" ]; then exit 1; fi
    case "$3" in
      issue_prefix) echo "\${FAKE_BD_PREFIX:-issue_prefix (not set)}" ;;
      *) echo "$3 (not set)" ;;
    esac ;;
  show)
    status=open
    if [ -n "$FAKE_BD_CLAIM_FAIL" ]; then
      case "$2" in *$FAKE_BD_CLAIM_FAIL*) status=in_progress ;; esac
    fi
    type=task
    if [ -n "$FAKE_BD_EPIC_PARENTS" ]; then
      case "$2" in *$FAKE_BD_EPIC_PARENTS*) type=epic ;; esac
    fi
    echo '[{"status":"'$status'","issue_type":"'$type'"}]' ;;
  update)
    if [ -n "$FAKE_BD_CLAIM_FAIL" ]; then
      case "$2" in *$FAKE_BD_CLAIM_FAIL*) exit 1 ;; esac
    fi
    if [ -n "$FAKE_BD_UPDATE_FAIL" ]; then
      case "$2" in *$FAKE_BD_UPDATE_FAIL*) echo 'db locked' >&2; exit 1 ;; esac
    fi
    echo "$@" >> "$FAKE_BD_LOG" ;;
esac
`

const MIXED = [
  { id: 'b-gate', title: 'HUMAN GATE — pick one', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' },
  { id: 'b-epic', title: 'big epic', status: 'open', priority: 1, issue_type: 'epic', created_at: '2026-01-01T00:00:00Z' },
  { id: 'b-mol', title: 'mol step', status: 'open', priority: 1, issue_type: 'task', parent: 'm-1', created_at: '2026-01-01T00:00:00Z' },
  { id: 'b-newer', title: 'newer task', status: 'open', priority: 2, issue_type: 'task', created_at: '2026-01-03T00:00:00Z' },
  { id: 'b-older', title: 'older task', status: 'open', priority: 2, issue_type: 'task', created_at: '2026-01-02T00:00:00Z' },
]

const GATED = [MIXED[0], MIXED[1], MIXED[2]]

interface Captured {
  lines: string[]
  claims: string
  /** argv of every `bd ready` invocation — one line per call */
  readyArgs: string
}

function withFakeBd(
  ready: unknown[],
  fn: (c: Captured) => Promise<void>,
  claimFail = '',
  updateFail = '',
  prefix = '',
  epicParents = ''
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
    writeFileSync(join(dir, 'bd'), FAKE_BD)
    chmodSync(join(dir, 'bd'), 0o755)
    writeFileSync(join(dir, 'ready.json'), JSON.stringify(ready))
    const log = join(dir, 'claims.log')
    const prev = {
      PATH: process.env.PATH,
      FAKE_BD_READY: process.env.FAKE_BD_READY,
      FAKE_BD_LOG: process.env.FAKE_BD_LOG,
      FAKE_BD_CLAIM_FAIL: process.env.FAKE_BD_CLAIM_FAIL,
      FAKE_BD_UPDATE_FAIL: process.env.FAKE_BD_UPDATE_FAIL,
      FAKE_BD_PREFIX: process.env.FAKE_BD_PREFIX,
      FAKE_BD_READY_LOG: process.env.FAKE_BD_READY_LOG,
      FAKE_BD_CONFIG_FAIL: process.env.FAKE_BD_CONFIG_FAIL,
      FAKE_BD_EPIC_PARENTS: process.env.FAKE_BD_EPIC_PARENTS,
    }
    process.env.PATH = `${dir}:${prev.PATH}`
    process.env.FAKE_BD_READY = join(dir, 'ready.json')
    process.env.FAKE_BD_LOG = log
    process.env.FAKE_BD_READY_LOG = join(dir, 'ready.log')
    process.env.FAKE_BD_CLAIM_FAIL = claimFail
    process.env.FAKE_BD_UPDATE_FAIL = updateFail
    if (prefix === '') delete process.env.FAKE_BD_PREFIX
    else process.env.FAKE_BD_PREFIX = prefix
    if (epicParents === '') delete process.env.FAKE_BD_EPIC_PARENTS
    else process.env.FAKE_BD_EPIC_PARENTS = epicParents
    const lines: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      await fn({
        lines,
        get claims() {
          return existsSync(log) ? readFileSync(log, 'utf8') : ''
        },
        get readyArgs() {
          const rl = join(dir, 'ready.log')
          return existsSync(rl) ? readFileSync(rl, 'utf8') : ''
        },
      })
    } finally {
      console.log = orig
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe('bro next', () => {
  it(
    'claims the oldest top-priority task, skipping gates/epics/mol steps',
    withFakeBd(MIXED, async c => {
      await runNextCommand([])
      assert.match(c.lines[0], /→ b-older.*\(claimed\)/)
      assert.match(c.claims, /b-older --claim/)
      assert.match(c.lines.join('\n'), /gate: b-gate/)
      assert.match(c.lines.join('\n'), /epic: b-epic/)
      assert.match(c.lines.join('\n'), /convoy: 1 molecule step/)
      assert.doesNotMatch(c.lines.join('\n'), /b-mol.*claimed/)
    })
  )

  it(
    '--list shows the queue without claiming',
    withFakeBd(MIXED, async c => {
      await runNextCommand(['--list'])
      assert.match(c.lines[0], /→ b-older/)
      assert.doesNotMatch(c.lines[0], /claimed/)
      assert.equal(c.claims, '')
    })
  )

  it(
    '--json emits state + bead + skips',
    withFakeBd(MIXED, async c => {
      await runNextCommand(['--list', '--json'])
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.state, 'task')
      assert.equal(r.bead.id, 'b-older')
      assert.equal(r.gates[0].id, 'b-gate')
      assert.equal(r.epics[0].id, 'b-epic')
      assert.equal(r.moleculeSteps, 1)
      assert.equal(r.queue, 2)
    })
  )

  it(
    'a raced-away claim falls through to the next candidate',
    withFakeBd(
      MIXED,
      async c => {
        await runNextCommand([])
        assert.match(c.lines[0], /→ b-newer.*\(claimed\)/)
        assert.match(c.claims, /b-newer --claim/)
      },
      'b-older'
    )
  )

  it(
    'a claim failure that is not a race surfaces instead of skipping',
    withFakeBd(
      MIXED,
      async () => {
        // claim fails but the bead is still open — an outage, not a
        // race; it must surface, not silently drain the queue
        await assert.rejects(runNextCommand([]))
      },
      '',
      'b-older'
    )
  )

  it(
    'reports gated when only gates/epics/mol steps remain',
    withFakeBd(GATED, async c => {
      await runNextCommand(['--json'])
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.state, 'gated')
      assert.equal(r.bead, undefined)
      assert.equal(r.queue, 0)
    })
  )

  it(
    'reports idle on an empty backlog',
    withFakeBd([], async c => {
      await runNextCommand(['--json'])
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.state, 'idle')
    })
  )

  it(
    'excludes coordination primitives bd-side via --exclude-label',
    withFakeBd(MIXED, async c => {
      await runNextCommand(['--list'])
      // the label filter must reach bd itself — a shared queue's
      // semaphores are filtered before classification ever sees them
      assert.match(c.readyArgs, /^ready --exclude-label gt:slot --json$/m)
    })
  )

  it(
    'scopes the queue to issue_prefix — foreign beads are reported, never claimed',
    withFakeBd(
      [
        { id: 'other-x', title: 'foreign task', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' },
        { id: 'other-merge-slot', title: 'foreign merge slot', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' },
        ...MIXED,
      ],
      async c => {
        await runNextCommand(['--json'])
        const r = JSON.parse(c.lines.join('\n'))
        // the foreign beads outrank b-older by priority — yet only the
        // project bead may be picked
        assert.equal(r.bead.id, 'b-older')
        assert.equal(r.foreign, 2)
        assert.match(c.claims, /b-older --claim/)
        assert.doesNotMatch(c.claims, /other-/)
      },
      '',
      '',
      'b'
    )
  )

  it(
    'a foreign-only queue is gated, not idle',
    withFakeBd(
      [{ id: 'other-x', title: 'foreign task', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' }],
      async c => {
        await runNextCommand(['--json'])
        const r = JSON.parse(c.lines.join('\n'))
        assert.equal(r.state, 'gated')
        assert.equal(r.foreign, 1)
      },
      '',
      '',
      'b'
    )
  )

  it(
    'epic children are claimable; only non-epic parents stay molecule steps',
    withFakeBd(
      [
        { id: 'b-echild', title: 'epic child', parent: 'b-epic-x', status: 'open', priority: 2, issue_type: 'task', created_at: '2026-01-02T00:00:00Z' },
        { id: 'b-mol2', title: 'real mol step', parent: 'm-9', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' },
      ],
      async c => {
        await runNextCommand(['--json'])
        const r = JSON.parse(c.lines.join('\n'))
        // b-mol2 outranks b-echild by priority but its parent is not an
        // epic — the epic child wins, the mol step stays convoy-owned
        assert.equal(r.bead.id, 'b-echild')
        assert.equal(r.moleculeSteps, 1)
        assert.match(c.claims, /b-echild --claim/)
        assert.doesNotMatch(c.claims, /b-mol2/)
      },
      '',
      '',
      '',
      'b-epic-x'
    )
  )

  it(
    'falls back to unscoped when issue_prefix is not set',
    withFakeBd(
      [{ id: 'other-x', title: 'foreign task', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' }],
      async c => {
        await runNextCommand(['--json'])
        const r = JSON.parse(c.lines.join('\n'))
        assert.equal(r.bead.id, 'other-x') // no prefix → fail open
      }
    )
  )

  it(
    'a failed prefix lookup fails closed — unscoped claiming must stop',
    withFakeBd(MIXED, async () => {
      process.env.FAKE_BD_CONFIG_FAIL = '1'
      assert.throws(() => projectPrefix(), /refusing to schedule/)
    })
  )
})

describe('bro next plans', () => {
  const plan = (over: Partial<Parameters<typeof applyNextPlan>[0]> = {}) => ({
    limit: 1,
    order: 'priority' as const,
    claim: true,
    gates: 'forbid' as const,
    scope: 'project' as const,
    json: true,
    filters: {},
    ...over,
  })

  const RICH = [
    ...MIXED,
    { id: 'b-low', title: 'low task', status: 'open', priority: 4, issue_type: 'task', created_at: '2026-01-04T00:00:00Z' },
    { id: 'b-bug', title: 'a bug', status: 'open', priority: 1, issue_type: 'bug', created_at: '2026-01-05T00:00:00Z' },
  ]

  it(
    'limit > 1 claims that many beads, in order',
    withFakeBd(RICH, async c => {
      applyNextPlan(plan({ limit: 3 }))
      const r = JSON.parse(c.lines.join('\n'))
      assert.deepEqual(r.beads.map((b: { id: string }) => b.id), ['b-bug', 'b-older', 'b-newer'])
      assert.match(c.claims, /b-bug --claim/)
      assert.match(c.claims, /b-newer --claim/)
    })
  )

  it(
    'claim = false selects without claiming',
    withFakeBd(RICH, async c => {
      applyNextPlan(plan({ claim: false, limit: 2 }))
      const r = JSON.parse(c.lines.join('\n'))
      assert.deepEqual(r.beads.map((b: { id: string }) => b.id), ['b-bug', 'b-older'])
      assert.equal(c.claims, '')
    })
  )

  it(
    'filters narrow the queue: types, max_priority, match',
    withFakeBd(RICH, async c => {
      applyNextPlan(plan({ filters: { types: ['bug'] } }))
      let r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.bead.id, 'b-bug')

      c.lines.length = 0
      applyNextPlan(plan({ filters: { maxPriority: 2 } }))
      r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.bead.id, 'b-bug')
      assert.equal(r.queue, 3) // b-low (P4) is filtered out

      c.lines.length = 0
      applyNextPlan(plan({ filters: { match: /task/ } }))
      r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.bead.id, 'b-older') // b-bug's title doesn't match
    })
  )

  it(
    'order changes the pick',
    withFakeBd(RICH, async c => {
      applyNextPlan(plan({ order: 'newest', claim: false }))
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.bead.id, 'b-bug') // newest claimable by created_at
    })
  )

  it(
    'gates = "allow" puts HUMAN GATE beads in the queue',
    withFakeBd(GATED, async c => {
      applyNextPlan(plan({ gates: 'allow' }))
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.state, 'task')
      assert.equal(r.bead.id, 'b-gate')
      assert.equal(r.gates.length, 0) // the claimed gate isn't double-reported
      assert.match(c.claims, /b-gate --claim/)
    })
  )

  it(
    'filters that exclude everything report gated, not idle',
    withFakeBd(RICH, async c => {
      applyNextPlan(plan({ filters: { types: ['feature'] } }))
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.state, 'gated') // not idle — claimable beads remain
      assert.equal(r.filtered, 4)
      assert.equal(r.queue, 0)
    })
  )

  it(
    'a failed claim that is not a race surfaces the error',
    withFakeBd(
      MIXED,
      async () => {
        // update fails on b-older but show still reports it open —
        // a bd outage, not a claim race: the error must propagate
        assert.throws(() => applyNextPlan(plan()))
      },
      '',
      'b-older'
    )
  )

  it(
    'a raced-away claim still fills the batch from the rest of the queue',
    withFakeBd(
      MIXED,
      async c => {
        applyNextPlan(plan({ limit: 2 }))
        const r = JSON.parse(c.lines.join('\n'))
        assert.deepEqual(r.beads.map((b: { id: string }) => b.id), ['b-newer'])
        assert.equal(r.queue, 2)
      },
      'b-older'
    )
  )

  it(
    'the schema routes through parseNextPlan — a parsed doc executes',
    withFakeBd(RICH, async c => {
      const p = parseNextPlan({ kind: 'next', limit: 1, json: true, filters: { types: ['bug'] } })
      applyNextPlan(p)
      const r = JSON.parse(c.lines.join('\n'))
      assert.equal(r.bead.id, 'b-bug')
    })
  )

  it(
    'scope = "all" opts out of the issue_prefix restriction',
    withFakeBd(
      [{ id: 'other-x', title: 'foreign task', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' }],
      async c => {
        const p = parseNextPlan({ kind: 'next', scope: 'all', json: true })
        applyNextPlan(p)
        const r = JSON.parse(c.lines.join('\n'))
        assert.equal(r.bead.id, 'other-x')
        assert.equal(r.foreign, 0)
      },
      '',
      '',
      'b'
    )
  )

  it(
    'scope rejects unknown values',
    () => {
      assert.throws(() => parseNextPlan({ kind: 'next', scope: 'universe' }), /scope.*project\|all/)
    }
  )
})

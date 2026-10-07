import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FleetRow } from './fleet.ts'
import { initRepo, inside } from './testrepo.ts'
import {
  attentionOf,
  emitMailbox,
  renderSnapshot,
  snapshotKey,
  watchArgs,
  type WatchMol,
  type WatchPrGate,
  type WatchSnapshot,
} from './watch.ts'

const mol = (over: Partial<WatchMol> = {}): WatchMol => ({
  mol: 'm-1',
  state: 'step',
  ready: [],
  gates: [],
  inProgress: [],
  blocked: [],
  ...over,
})

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  mol: 'm-1',
  step: 's-1',
  title: 'do the thing',
  kind: 'agent',
  state: 'in_progress',
  agent: 'running (pid 1)',
  ...over,
})

const prGate = (over: Partial<WatchPrGate> = {}): WatchPrGate => ({
  pr: 12,
  link: '[#12](https://github.com/o/r/pull/12)',
  ok: true,
  blockers: [],
  ...over,
})

describe('watchArgs', () => {
  test('defaults: one snapshot, no notify', () => {
    assert.deepEqual(watchArgs([]), { json: false, notify: false })
    assert.deepEqual(watchArgs(['--once']), { json: false, notify: false })
  })

  test('flags parse', () => {
    assert.deepEqual(watchArgs(['--json', '--notify', '--every', '30']), {
      json: true,
      notify: true,
      everySec: 30,
    })
    assert.equal(watchArgs(['--every=15']).everySec, 15)
  })

  test('a bad --every fails closed', () => {
    for (const v of ['abc', '0', '-5', 'NaN']) {
      assert.throws(() => watchArgs(['--every', v]), /--every/)
    }
  })

  test('a sub-floor --every fails closed — a busy loop is not a poll', () => {
    assert.throws(() => watchArgs(['--every', '0.01']), /--every/)
    assert.equal(watchArgs(['--every', '0.1']).everySec, 0.1)
  })

  test('--for bounds the loop; alone or below --every it fails closed', () => {
    assert.deepEqual(watchArgs(['--every', '30', '--for', '300']), {
      json: false,
      notify: false,
      everySec: 30,
      forSec: 300,
    })
    assert.throws(() => watchArgs(['--for', '60']), /--for/)
    assert.throws(() => watchArgs(['--every', '30', '--for', '10']), /--for/)
    assert.throws(() => watchArgs(['--every', '30', '--for', 'abc']), /--for/)
  })

  test('an --every beyond the timer range fails closed', () => {
    // over 2^31-1 ms setTimeout clamps to ~1ms — a busy tick, not a cadence
    assert.throws(() => watchArgs(['--every', '3000000000']), /--every/)
    assert.equal(watchArgs(['--every', '2147483']).everySec, 2147483)
  })
})

describe('attentionOf', () => {
  test('empty inputs are a quiet fleet', () => {
    assert.deepEqual(attentionOf([], [], []), [])
  })

  test('a ready human gate is attention, titled', () => {
    const m = mol({
      state: 'gate',
      gates: ['s-9'],
      ready: [{ id: 's-9', title: 'Approve the merge', kind: 'human' }],
    })
    assert.deepEqual(attentionOf([m], [], []), [
      'gate ready — m-1: s-9 (Approve the merge)',
    ])
  })

  test('a lost agent on a claimed step is the respawn surface', () => {
    const r = row({ agent: 'lost — respawn?' })
    assert.deepEqual(attentionOf([], [r], []), [
      'agent lost — s-1 (do the thing) — respawn?',
    ])
  })

  test('a blocked exit gate surfaces its blockers', () => {
    const g = prGate({ ok: false, blockers: ['2 unresolved review thread(s)'] })
    assert.deepEqual(attentionOf([], [], [g]), [
      'PR [#12](https://github.com/o/r/pull/12) blocked — 2 unresolved review thread(s)',
    ])
  })

  test('a mol whose load threw is attention, not a silent drop', () => {
    const m = mol({ state: 'error — bd gone' })
    assert.deepEqual(attentionOf([m], [], []), [
      'mol m-1 unreadable — error — bd gone',
    ])
  })

  test('a failed probe is reported, not read as blocked', () => {
    const g = prGate({ ok: undefined, blockers: undefined, error: 'gh timed out' })
    assert.deepEqual(attentionOf([], [], [g]), [
      'PR [#12](https://github.com/o/r/pull/12) gate probe failed — gh timed out',
    ])
  })

  test('provider walls are attention — the spec `walled — <cause>` line', () => {
    const walls = [
      { provider: 'kilo-free', cause: 'rate_limited' as const, until: '2026-10-08T00:00:00Z' },
      { provider: 'devin', cause: 'quota' as const },
    ]
    assert.deepEqual(attentionOf([], [], [], walls), [
      'provider kilo-free walled — rate_limited til 2026-10-08T00:00:00Z',
      'provider devin walled — quota',
    ])
  })

  test('ok gates and live agents are not attention', () => {
    assert.deepEqual(attentionOf([mol()], [row()], [prGate()]), [])
  })
})

const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({
  ts: '2026-10-02T00:00:00.000Z',
  attention: [],
  mols: [],
  gates: { available: true, prs: [] },
  fleet: { rows: [], degraded: [], conflicts: [] },
  ...over,
})

describe('snapshotKey', () => {
  test('the timestamp is not part of the dedup key', () => {
    const a = snap({ ts: '2026-10-02T00:00:00.000Z' })
    const b = snap({ ts: '2026-10-02T01:00:00.000Z' })
    assert.equal(snapshotKey(a), snapshotKey(b))
  })

  test('a transition changes the key', () => {
    const a = snap()
    const b = snap({ attention: ['gate ready — m-1: s-9'] })
    assert.notEqual(snapshotKey(a), snapshotKey(b))
  })
})

describe('renderSnapshot', () => {
  test('a quiet snapshot reads quiet, with every section present', () => {
    const text = renderSnapshot(snap())
    assert.match(text, /bro watch — 2026-10-02T00:00:00\.000Z/)
    assert.match(text, /attention\n  \(quiet\)/)
    assert.match(text, /mols\n  no open molecules/)
    assert.match(text, /gates\n  no PRs in the fleet/)
    assert.match(text, /fleet\n  no open molecules — nothing in the fleet/)
  })

  test('an unavailable gates section says so with the reason', () => {
    const text = renderSnapshot(
      snap({ gates: { available: false, reason: 'no review host', prs: [] } })
    )
    assert.match(text, /gates\n  unavailable — no review host/)
  })

  test('a failed mols plane renders unavailable, never a false quiet', () => {
    const text = renderSnapshot(snap({ molsError: 'bd timed out' }))
    assert.match(text, /mols\n  unavailable — bd timed out/)
  })

  test('failed PR lookups warn in the fleet section', () => {
    const text = renderSnapshot(
      snap({ fleet: { rows: [], degraded: [], conflicts: [], prErrors: ['work/x: boom'] } })
    )
    assert.match(text, /warning: PR lookup failed — work\/x: boom/)
  })

  test('a failed wall derivation warns — rows survive, the section does not report unavailable', () => {
    const text = renderSnapshot(
      snap({ fleet: { rows: [row()], degraded: [], conflicts: [], wallsError: 'registry JSON corrupt' } })
    )
    assert.match(text, /warning: provider walls unreadable — registry JSON corrupt/)
    assert.match(text, /s-1\s+in_progress\s+running \(pid 1\)/)
    assert.doesNotMatch(text, /fleet\n  unavailable/)
  })

  test('attention and sections render their contents', () => {
    const text = renderSnapshot(
      snap({
        attention: ['gate ready — m-1: s-9 (Approve)'],
        mols: [
          mol({
            gates: ['s-9'],
            ready: [{ id: 's-9', title: 'Approve', kind: 'human' }],
            blocked: ['s-2'],
          }),
        ],
        gates: { available: true, prs: [prGate({ ok: false, blockers: ['x'] })] },
        fleet: { rows: [row()], degraded: ['native: down'], conflicts: [] },
      })
    )
    assert.match(text, /gate ready — m-1: s-9 \(Approve\)/)
    assert.match(text, /m-1\s+step\s+s-9\s+s-9/)
    assert.match(text, /\[#12\]\(https:\/\/github\.com\/o\/r\/pull\/12\)\s+blocked — x/)
    assert.match(text, /s-1\s+in_progress\s+running \(pid 1\)/)
    assert.match(text, /warning: backend degraded — native: down/)
  })
})

describe('emitMailbox', () => {
  test('drops one atomic watch-* file into <common>/bro/notify', () => {
    const { root, main } = initRepo('bro-watch-')
    inside(main, root, () => {
      assert.equal(emitMailbox(main, 'snapshot text'), true)
      const notify = join(main, '.git', 'bro', 'notify')
      const files = readdirSync(notify)
      assert.equal(files.length, 1)
      assert.match(files[0]!, /^watch-\d+-[a-z0-9]+\.txt$/)
      assert.equal(readFileSync(join(notify, files[0]!), 'utf8'), 'snapshot text')
      // tmp+rename leaves no half-written residue
      assert.ok(!files.some((f) => f.includes('.tmp')))
    })
  })

  test('outside a repo it reports no mailbox instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-watch-nowt-'))
    try {
      assert.equal(emitMailbox(dir, 'x'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

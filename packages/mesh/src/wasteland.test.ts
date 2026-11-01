/** wasteland transport (specs/cross-repo/bro-kim1e) — the pure halves:
 *  `pN` ↔ 0–4 priority, board row → mesh records projection, rig-handle
 *  mapping. `wl`-shelling reads fail open — the missing-binary case is
 *  the testable one on machines without wl. The live e2e against a
 *  `wl --remote-base` file provider is opt-in (BRO_MESH_WL_E2E). */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import {
  boardPriority,
  browseWanted,
  handleToRig,
  projectWanted,
  termPriority,
  type WantedRow,
} from './wasteland.ts'

describe('priority mapping', () => {
  test('pN ↔ 0–4, same scale both directions', () => {
    for (let p = 0; p <= 4; p++) {
      assert.equal(termPriority(p), `p${p}`)
      assert.equal(boardPriority(`p${p}`), p)
    }
    assert.equal(boardPriority(termPriority(3)), 3)
  })

  test('out-of-band input degrades, never invents a priority', () => {
    for (const term of [undefined, '', 'p5', 'high', 'P2']) {
      assert.equal(boardPriority(term), undefined, JSON.stringify(term))
    }
    assert.equal(termPriority(undefined), undefined)
    assert.equal(termPriority(9), 'p4') // clamped into the board's scale
    assert.equal(termPriority(-1), 'p0')
  })
})

describe('handleToRig', () => {
  test('org/name maps straight to the mesh uri; a bare handle lives in the commons namespace', () => {
    assert.equal(handleToRig('acme/rig'), 'mesh://acme/rig')
    assert.equal(handleToRig('ACME/Rig'), 'mesh://acme/rig')
    assert.equal(handleToRig('rigger'), 'mesh://wasteland/rigger')
    for (const bad of [undefined, '', 'not a handle!', 'a/b/c']) {
      assert.equal(handleToRig(bad), null, JSON.stringify(bad))
    }
  })
})

describe('projectWanted', () => {
  const row = (over: Partial<WantedRow> = {}): WantedRow => ({
    id: 'w-deadbeef',
    title: 'port the thing',
    description: 'details',
    priority: 2,
    posted_by: 'acme/poster',
    status: 'open',
    ...over,
  })

  test('an open row projects one request addressed to the reader', () => {
    const p = projectWanted({ row: row(), selfRig: 'mesh://acme/mine' })
    assert.deepEqual(p.errors, [])
    assert.equal(p.envelopes.length, 1)
    const req = p.envelopes[0]!
    assert.equal(req.kind, 'request')
    assert.equal(req.id, 'w-deadbeef')
    assert.equal(req.thread, 'w-deadbeef') // board id IS the thread id
    assert.equal(req.from, 'mesh://acme/poster')
    assert.equal(req.to, 'mesh://acme/mine')
    assert.equal(req.terms.priority, 'p2')
    assert.equal(req.body, 'details')
  })

  test('without selfRig an open row is addressed back to the poster', () => {
    const p = projectWanted({ row: row() })
    assert.equal(p.envelopes[0]?.to, 'mesh://acme/poster')
  })

  test('a claimed row adds the claim record addressed to the poster', () => {
    const p = projectWanted({ row: row({ status: 'claimed', claimed_by: 'acme/worker' }), selfRig: 'mesh://acme/mine' })
    assert.deepEqual(
      p.envelopes.map((e) => e.kind),
      ['request', 'claim'],
    )
    const claim = p.envelopes[1]!
    assert.equal(claim.id, 'w-deadbeef#claim')
    assert.equal(claim.from, 'mesh://acme/worker')
    assert.equal(claim.to, 'mesh://acme/poster')
    // past open, the request addresses back to the poster
    assert.equal(p.envelopes[0]?.to, 'mesh://acme/poster')
  })

  test('a completion with evidence projects result; a verdict projects accept/reject', () => {
    const done = projectWanted({
      row: row({
        status: 'done',
        claimed_by: 'acme/worker',
        completions: [{ evidence: 'https://github.com/acme/rig/pull/7' }],
      }),
    })
    assert.deepEqual(
      done.envelopes.map((e) => e.kind),
      ['request', 'claim', 'result'],
    )
    assert.deepEqual(done.envelopes[2]?.evidence, [
      { kind: 'url', ref: 'https://github.com/acme/rig/pull/7' },
    ])

    for (const [state, kind] of [
      ['accepted', 'accept'],
      ['rejected', 'reject'],
    ] as const) {
      const p = projectWanted({
        row: row({
          status: 'done',
          claimed_by: 'acme/worker',
          completions: [{ evidence: 'https://x', state }],
        }),
      })
      assert.equal(p.envelopes.at(-1)?.kind, kind)
      assert.equal(p.envelopes.at(-1)?.id, `w-deadbeef#${kind}`)
      assert.equal(p.envelopes.at(-1)?.from, 'mesh://acme/poster')
      assert.equal(p.envelopes.at(-1)?.to, 'mesh://acme/worker')
    }

    // board marks it completed without a stored verdict → accept
    const closed = projectWanted({ row: row({ status: 'completed', claimed_by: 'acme/worker' }) })
    assert.equal(closed.envelopes.at(-1)?.kind, 'accept')
  })

  test('board-local vocabulary is carried, never projected into terms', () => {
    const p = projectWanted({ row: row({ project: 'x', type: 'bug', effort_level: 's', tags: ['a'] }) })
    assert.equal(p.envelopes[0]?.kind, 'request')
    assert.deepEqual(p.envelopes[0]?.refs, [])
  })

  test('an unprojectable poster is an error line, not an invented rig', () => {
    const p = projectWanted({ row: row({ posted_by: 'not a handle!' }) })
    assert.equal(p.envelopes.length, 0)
    assert.match(p.errors[0] ?? '', /posted_by.*not a rig handle/)
  })

  test('an unprojectable claimer keeps the request, flags the claim', () => {
    const p = projectWanted({ row: row({ status: 'claimed', claimed_by: 'not a handle!' }) })
    assert.deepEqual(
      p.envelopes.map((e) => e.kind),
      ['request'],
    )
    assert.match(p.errors[0] ?? '', /claimed_by.*not a rig handle/)
  })
})

describe('wl fail-open', () => {
  test('a missing wl binary is an error line naming it, never a crash', (t) => {
    if (spawnSync('wl', ['--version']).status === 0) {
      t.skip('wl is installed — the absent-binary path is not testable here')
      return
    }
    const r = browseWanted('wl://org/board')
    assert.match(r.error ?? '', /wl/)
  })
})

// ---- gated e2e (specs/cross-repo/bro-kim1e Plan, last item) ----
// Opt-in: BRO_MESH_WL_E2E=<remote-base> names a local `wl` file
// provider the commons may live at. Skipped without wl or the var.

const WL_E2E = process.env.BRO_MESH_WL_E2E

describe('wasteland e2e (gated)', () => {
  test('post → claim → done against a local file provider', async (t) => {
    if (WL_E2E === undefined || WL_E2E === '') {
      t.skip('set BRO_MESH_WL_E2E=<remote-base> to run')
      return
    }
    if (spawnSync('wl', ['--version']).status !== 0) {
      t.skip('wl not installed')
      return
    }
    const { postWanted, claimWanted, completeWanted, wantedStatus } = await import('./wasteland.ts')
    const posted = postWanted({ remote: WL_E2E, title: `mesh e2e ${Date.now()}`, body: 'scratch', priority: 2 })
    assert.ok(posted.id, posted.error)
    assert.match(posted.id!, /^w-/)
    assert.equal(claimWanted({ remote: WL_E2E, id: posted.id! }).error, undefined)
    assert.equal(
      completeWanted({ remote: WL_E2E, id: posted.id!, evidence: [{ kind: 'url', ref: 'https://example.com/e2e' }] }).error,
      undefined,
    )
    const row = wantedStatus({ remote: WL_E2E, id: posted.id! })
    assert.ok(row.row, row.error)
    assert.notEqual(row.row!.status, 'open')
  })
})

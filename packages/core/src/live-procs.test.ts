/** live-procs — the orphan classifier and sweep. An orphaned bd holds
 *  the embedded noms LOCK past every caller's timeout (bro-8845g);
 *  the sweep must catch exactly those: right comm, reparented to
 *  init/systemd, cwd inside the repo, older than the age floor. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { pickOrphanProcs, sweepOrphanProcs, type ProcRow } from './live-procs.ts'

const NOW = Date.parse('2026-10-10T07:00:00Z')
const OLD = NOW - 120_000 // well past the 60s age floor
const YOUNG = NOW - 5_000 // a live, in-flight call

function row(partial: Partial<ProcRow>): ProcRow {
  return {
    pid: 1000,
    comm: 'bd',
    ppid: 1,
    parentComm: 'init',
    cwd: '/repo/sub',
    startMs: OLD,
    ...partial,
  }
}

describe('pickOrphanProcs', () => {
  test('a reparented, repo-cwd, old bd is picked', () => {
    assert.deepEqual(pickOrphanProcs([row({ pid: 7 })], 'bd', '/repo', NOW), [7])
  })

  test('a live parent (non-init comm) is not an orphan', () => {
    assert.deepEqual(
      pickOrphanProcs([row({ pid: 7, ppid: 42, parentComm: 'node' })], 'bd', '/repo', NOW),
      []
    )
  })

  test('ppid 1 and systemd both count as reparented', () => {
    const rows = [
      row({ pid: 1, ppid: 1, parentComm: null }),
      row({ pid: 2, ppid: 55, parentComm: 'systemd' }),
      row({ pid: 3, ppid: 789, parentComm: 'init' }), // WSL /init subreaper
    ]
    assert.deepEqual(pickOrphanProcs(rows, 'bd', '/repo', NOW), [1, 2, 3])
  })

  test('cwd outside the repo is left alone', () => {
    const rows = [
      row({ pid: 1, cwd: '/other/dir' }),
      row({ pid: 2, cwd: '/repo-sibling/x' }), // prefix-attack guard
      row({ pid: 3, cwd: '/repo' }), // root itself counts
    ]
    assert.deepEqual(pickOrphanProcs(rows, 'bd', '/repo', NOW), [3])
  })

  test('young procs are in-flight calls, not debris', () => {
    assert.deepEqual(
      pickOrphanProcs([row({ pid: 7, startMs: YOUNG })], 'bd', '/repo', NOW),
      []
    )
  })

  test('other comms are ignored', () => {
    assert.deepEqual(
      pickOrphanProcs([row({ pid: 7, comm: 'dolt' })], 'bd', '/repo', NOW),
      []
    )
  })

  test('unreadable cwd (raced exit) is skipped', () => {
    assert.deepEqual(
      pickOrphanProcs([row({ pid: 7, cwd: null })], 'bd', '/repo', NOW),
      []
    )
  })
})

describe('sweepOrphanProcs', () => {
  test('kills the matched pids through the injected signal', () => {
    const killed: number[] = []
    const rows = [row({ pid: 7 }), row({ pid: 8, ppid: 42, parentComm: 'node' })]
    const r = sweepOrphanProcs('bd', '/repo', {
      rows,
      now: NOW,
      kill: (pid) => killed.push(pid),
    })
    assert.deepEqual(killed, [7])
    assert.equal(r.scanned, 2)
    assert.deepEqual(r.killed, [{ pid: 7, cwd: '/repo/sub' }])
    assert.deepEqual(r.failed, [])
  })

  test('a resisting kill lands in failed, not thrown', () => {
    const r = sweepOrphanProcs('bd', '/repo', {
      rows: [row({ pid: 7 })],
      now: NOW,
      kill: () => {
        throw new Error('EPERM')
      },
    })
    assert.deepEqual(r.killed, [])
    assert.deepEqual(r.failed, [7])
  })
})

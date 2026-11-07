import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo, inside } from './testrepo.ts'
import {
  heartbeatAge,
  heartbeatFile,
  heartbeatLine,
  readHeartbeat,
  writeHeartbeat,
} from './watch-heartbeat.ts'

const snap = {
  ts: '2026-10-10T13:00:00.000Z',
  attention: [],
  mols: [],
  gates: { available: true, prs: [] },
  fleet: { rows: [], degraded: [], conflicts: [] },
  loop: { stallMin: 45, runs: [] },
}

describe('heartbeatFile', () => {
  test('resolves <git-common>/bro/heartbeat.json inside a repo', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      assert.equal(heartbeatFile(main), join(main, '.git', 'bro', 'heartbeat.json'))
    })
  })

  test('null outside a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-hb-nowt-'))
    try {
      assert.equal(heartbeatFile(dir), null)
      assert.equal(readHeartbeat(dir), null)
      assert.equal(heartbeatLine(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('writeHeartbeat + readHeartbeat', () => {
  test('one atomic file round-trips the snapshot', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      assert.equal(writeHeartbeat(main, snap), true)
      const bro = join(main, '.git', 'bro')
      assert.deepEqual(readdirSync(bro), ['heartbeat.json'])
      assert.equal(JSON.parse(readFileSync(join(bro, 'heartbeat.json'), 'utf8')).ts, snap.ts)
      const h = readHeartbeat(main, Date.parse('2026-10-10T13:05:00.000Z'))
      assert.deepEqual(h, { ts: snap.ts, ageMs: 300_000, attention: 0 })
    })
  })

  test('the attention count comes from the snapshot list', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      writeHeartbeat(main, { ...snap, attention: ['a', 'b'] })
      assert.equal(readHeartbeat(main)?.attention, 2)
    })
  })

  test('overwrite keeps the latest tick', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      writeHeartbeat(main, snap)
      writeHeartbeat(main, { ...snap, ts: '2026-10-10T14:00:00.000Z' })
      assert.equal(readHeartbeat(main)?.ts, '2026-10-10T14:00:00.000Z')
    })
  })

  test('outside a repo the write reports false instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-hb-nowt-'))
    try {
      assert.equal(writeHeartbeat(dir, snap), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('torn or half-shaped files read as null — never an error', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      const file = join(main, '.git', 'bro', 'heartbeat.json')
      mkdirSync(join(main, '.git', 'bro'), { recursive: true })
      writeFileSync(file, '{torn')
      assert.equal(readHeartbeat(main), null)
      writeFileSync(file, JSON.stringify({ attention: [] }))
      assert.equal(readHeartbeat(main), null)
      writeFileSync(file, JSON.stringify({ ts: snap.ts }))
      assert.equal(readHeartbeat(main), null)
      writeFileSync(file, JSON.stringify({ ts: snap.ts, attention: 3 }))
      assert.equal(readHeartbeat(main), null)
    })
  })
})

describe('heartbeatAge', () => {
  test('smallest honest unit', () => {
    assert.equal(heartbeatAge(30_000), '30s')
    assert.equal(heartbeatAge(89_000), '89s')
    assert.equal(heartbeatAge(90_000), '1m')
    assert.equal(heartbeatAge(4 * 60_000), '4m')
    assert.equal(heartbeatAge(9 * 3_600_000), '9h')
    assert.equal(heartbeatAge(2 * 86_400_000), '2d')
  })
})

describe('heartbeatLine', () => {
  test('quiet and attention forms', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      const fresh = { ...snap, ts: new Date().toISOString() }
      writeHeartbeat(main, fresh)
      assert.match(heartbeatLine(main) ?? '', /^last tick \d+s ago — quiet$/)
      writeHeartbeat(main, { ...fresh, attention: ['gate ready — m-1: s-9'] })
      assert.match(heartbeatLine(main) ?? '', /^last tick \d+s ago — 1 attention$/)
    })
  })

  test('a stale heartbeat reports its own age — the signal, no verdict', () => {
    const { root, main } = initRepo('bro-hb-')
    inside(main, root, () => {
      const stale = { ...snap, ts: new Date(Date.now() - 9 * 3_600_000).toISOString() }
      writeHeartbeat(main, stale)
      assert.match(heartbeatLine(main) ?? '', /^last tick 9h ago — quiet$/)
    })
  })
})

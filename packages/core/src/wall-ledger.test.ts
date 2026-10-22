import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import {
  clearLedgerWalls,
  readLedgerWalls,
  recordWall,
  wallLedgerPath,
  type WallObservation,
} from './wall-ledger.ts'

const base = Date.parse('2026-01-01T00:00:00.000Z')

function tempLedger(): { dir: string; path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-walls-'))
  return { dir, path: join(dir, 'bro', 'walls.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

function observation(
  account: string,
  cause: WallObservation['cause'] = 'rate_limited',
  observedAt = new Date(base).toISOString(),
  extra: Partial<WallObservation> = {}
): WallObservation {
  return {
    account,
    cause,
    observedAt,
    provider: 'provider',
    rig: 'org/repo',
    step: 'bro-step',
    ...extra,
  }
}

describe('host wall ledger', () => {
  test('records and reads a wall with its computed expiry', () => {
    const t = tempLedger()
    try {
      recordWall(observation('acct'), { path: t.path, now: base })
      assert.deepEqual(readLedgerWalls(base + 60_000, undefined, { path: t.path }), [
        {
          account: 'acct',
          cause: 'rate_limited',
          until: new Date(base + 15 * 60_000).toISOString(),
          observedAt: new Date(base).toISOString(),
          provider: 'provider',
          rig: 'org/repo',
          step: 'bro-step',
        },
      ])
    } finally {
      t.done()
    }
  })

  test('rate resetAt overrides TTL; rate TTL expires without resetAt', () => {
    const t = tempLedger()
    try {
      recordWall(observation('reset', 'rate_limited', new Date(base).toISOString(), {
        resetAt: new Date(base + 30_000).toISOString(),
      }), { path: t.path, now: base })
      recordWall(observation('ttl'), { path: t.path, now: base })
      assert.equal(readLedgerWalls(base + 29_999, undefined, { path: t.path }).length, 2)
      assert.equal(readLedgerWalls(base + 30_000, undefined, { path: t.path }).length, 1)
      assert.equal(readLedgerWalls(base + 15 * 60_000, undefined, { path: t.path }).length, 0)
    } finally {
      t.done()
    }
  })

  test('quota TTL defaults to six hours and a live quota is not overwritten by rate', () => {
    const t = tempLedger()
    try {
      recordWall(observation('quota', 'quota'), { path: t.path, now: base })
      recordWall(observation('quota', 'rate_limited', new Date(base + 60_000).toISOString()), {
        path: t.path,
        now: base + 60_000,
      })
      const row = readLedgerWalls(base + 60_000, undefined, { path: t.path })[0]
      assert.equal(row?.cause, 'quota')
      assert.equal(row?.until, new Date(base + 6 * 60 * 60_000).toISOString())
    } finally {
      t.done()
    }
  })

  test('a newer rate observation supersedes an older rate observation', () => {
    const t = tempLedger()
    try {
      recordWall(observation('acct', 'rate_limited', new Date(base).toISOString(), {
        provider: 'old',
      }), { path: t.path, now: base })
      recordWall(observation('acct', 'rate_limited', new Date(base + 60_000).toISOString(), {
        provider: 'new',
      }), { path: t.path, now: base + 60_000 })
      assert.equal(readLedgerWalls(base + 60_000, undefined, { path: t.path })[0]?.provider, 'new')
    } finally {
      t.done()
    }
  })

  test('prunes expired rows on write and clears one or all accounts', () => {
    const t = tempLedger()
    try {
      recordWall(observation('expired'), { path: t.path, now: base })
      recordWall(observation('live', 'quota', new Date(base + 16 * 60_000).toISOString()), {
        path: t.path,
        now: base + 16 * 60_000,
      })
      assert.deepEqual(readLedgerWalls(base + 16 * 60_000, undefined, { path: t.path }).map((w) => w.account), ['live'])
      assert.equal(clearLedgerWalls('live', { path: t.path, now: base + 16 * 60_000 }), 1)
      recordWall(observation('a', 'quota'), { path: t.path, now: base })
      recordWall(observation('b', 'quota'), { path: t.path, now: base })
      assert.equal(clearLedgerWalls('all', { path: t.path, now: base }), 2)
      assert.deepEqual(readLedgerWalls(base, undefined, { path: t.path }), [])
    } finally {
      t.done()
    }
  })

  test('resolves XDG override and treats an empty XDG state home as unset', () => {
    assert.equal(wallLedgerPath('/state'), '/state/bro/walls.json')
    assert.equal(wallLedgerPath(''), join(homedir(), '.local', 'state', 'bro', 'walls.json'))
  })

  test('creates the ledger directory as 0700 and ledger file as 0600', () => {
    const t = tempLedger()
    try {
      recordWall(observation('acct'), { path: t.path, now: base })
      assert.equal(statSync(dirname(t.path)).mode & 0o777, 0o700)
      assert.equal(statSync(t.path).mode & 0o777, 0o600)
    } finally {
      t.done()
    }
  })

  test('corrupt data reads empty and the next record repairs it', () => {
    const t = tempLedger()
    try {
      mkdirSyncForPath(t.path)
      writeFileSync(t.path, '{')
      assert.deepEqual(readLedgerWalls(base, undefined, { path: t.path }), [])
      recordWall(observation('repaired'), { path: t.path, now: base })
      assert.equal(JSON.parse(readFileSync(t.path, 'utf8')).version, 1)
      assert.equal(readLedgerWalls(base, undefined, { path: t.path })[0]?.account, 'repaired')
    } finally {
      t.done()
    }
  })

  test('concurrent child processes preserve distinct account writes', async () => {
    const t = tempLedger()
    try {
      const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'wall-ledger.ts')).href
      const script =
        `import { recordWall } from ${JSON.stringify(moduleUrl)}; ` +
        `recordWall(JSON.parse(process.env.WALL_OBS), { path: process.env.WALL_PATH, now: ${base} });`
      const run = (account: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
            env: {
              ...process.env,
              WALL_PATH: t.path,
              WALL_OBS: JSON.stringify(observation(account, 'quota')),
            },
            stdio: 'ignore',
          })
          child.once('error', reject)
          child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
        })
      await Promise.all([run('one'), run('two')])
      assert.deepEqual(readLedgerWalls(base, undefined, { path: t.path }).map((w) => w.account), ['one', 'two'])
    } finally {
      t.done()
    }
  })
})

function mkdirSyncForPath(path: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
}

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileBackedJanitorDeps,
  janitorBroDir,
  janitorDidWork,
  janitorLine,
  runJanitor,
} from './janitor.ts'
import { procStat } from './proc.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const withBro = (fn: (bro: string) => void): void => {
  const bro = mkdtempSync(join(tmpdir(), 'bro-janitor-'))
  try {
    fn(bro)
  } finally {
    rmSync(bro, { recursive: true, force: true })
  }
}

const mkdir = (bro: string, ...parts: string[]): string => {
  const d = join(bro, ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

const touch = (path: string, body: string, mtimeAgoMs = 0): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  if (mtimeAgoMs > 0) {
    const t = new Date(Date.now() - mtimeAgoMs)
    utimesSync(path, t, t)
  }
}

/** A marker stamp line: `<millis> [pid start]` — dead-owner markers use
 *  a pid that cannot be alive, live ones this process's real identity. */
const deadStamp = (): string => `${Date.now() - 2 * DAY} 99999999 1`
const liveStamp = (): string =>
  `${Date.now()} ${process.pid} ${procStat(process.pid)?.start ?? ''}`

const deps = (bro: string) => fileBackedJanitorDeps(bro)

const writeRegistry = (bro: string, reg: object): void =>
  writeFileSync(join(bro, 'agents.json'), JSON.stringify(reg))

describe('janitor — dead sessions', () => {
  test('a session with all-dead markers and no live worktree loses markers, hinted, fired, cursor', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(hooks, 'dead-sess.work'), `${deadStamp()}\nbro-x\n`, 2 * DAY)
      touch(join(hooks, 'dead-sess.act'), deadStamp(), 2 * DAY)
      touch(join(hooks, 'hinted', 'dead-sess.act'), '1', 2 * DAY)
      touch(join(hooks, 'fired', 'dead-sess'), 'lesson-a\n', 2 * DAY)
      touch(join(bro, 'notify', '.seen-dead-sess'), 'drop-a\n', 2 * DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.deepEqual(r.sessions, ['dead-sess'])
      assert.equal(r.reaped.markers, 2)
      assert.equal(r.reaped.hinted, 1)
      assert.equal(r.reaped.fired, 1)
      assert.equal(r.reaped.cursors, 1)
      assert.equal(existsSync(join(hooks, 'dead-sess.work')), false)
      assert.equal(existsSync(join(hooks, 'hinted', 'dead-sess.act')), false)
      assert.equal(existsSync(join(hooks, 'fired', 'dead-sess')), false)
      assert.equal(existsSync(join(bro, 'notify', '.seen-dead-sess')), false)
    })
  })

  test('a session with a live marker keeps everything', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(hooks, 'live-sess.work'), `${liveStamp()}\nbro-x\n`)
      touch(join(hooks, 'live-sess.act'), `${liveStamp()}\n#1\n`)
      touch(join(bro, 'notify', '.seen-live-sess'), 'drop-a\n')
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(janitorDidWork(r), false)
      assert.equal(existsSync(join(hooks, 'live-sess.work')), true)
      assert.equal(existsSync(join(bro, 'notify', '.seen-live-sess')), true)
    })
  })

  test('a dead session whose .work detail names a surviving path keeps its state', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(hooks, 'dead-sess.work'), `${deadStamp()}\n${bro}\n`, 2 * DAY)
      touch(join(bro, 'notify', '.seen-dead-sess'), 'drop-a\n', 2 * DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(hooks, 'dead-sess.work')), true)
      assert.equal(existsSync(join(bro, 'notify', '.seen-dead-sess')), true)
      assert.equal(r.sessions.includes('dead-sess'), false)
    })
  })

  test('a dead-owned marker reaps even when its mtime is fresh', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      touch(join(hooks, 'dead-sess.task'), deadStamp()) // fresh mtime, dead owner
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(hooks, 'dead-sess.task')), false)
      assert.deepEqual(r.sessions, ['dead-sess'])
    })
  })

  test('an ownerless marker inside the marker TTL keeps the session — reaping uses the armed-state bar, not the 24h detection one', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      // 2 days old, ownerless — dead for parallel detection, still
      // registry-present for readArmed: the sweep must not eat armed
      // state early
      touch(join(hooks, 'idle-sess.work'), `${Date.now() - 2 * DAY}\nbro-x\n`, 2 * DAY)
      touch(join(bro, 'notify', '.seen-idle-sess'), 'drop-a\n', 2 * DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(hooks, 'idle-sess.work')), true)
      assert.equal(existsSync(join(bro, 'notify', '.seen-idle-sess')), true)
      assert.equal(r.sessions.includes('idle-sess'), false)
    })
  })

  test('an ownerless marker inside the freshness window keeps the session', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      // ownerless marker — a human shell or a pre-tag build — live by mtime
      touch(join(hooks, 'human-sess.work'), `${Date.now() - HOUR}\nbro-x\n`, HOUR)
      touch(join(bro, 'notify', '.seen-human-sess'), 'drop-a\n', 2 * DAY)
      mkdir(bro, 'notify')
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(hooks, 'human-sess.work')), true)
      assert.equal(existsSync(join(bro, 'notify', '.seen-human-sess')), true)
      assert.equal(r.sessions.includes('human-sess'), false)
    })
  })

  test('a dead session keeps its trace journal — the postmortem record is not coordination state', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      touch(join(hooks, 'dead-sess.work'), `${deadStamp()}\nbro-x\n`, 2 * DAY)
      touch(join(hooks, 'trace', 'dead-sess.jsonl'), '{"ts":1}\n', 2 * DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.deepEqual(r.sessions, ['dead-sess'])
      assert.equal(existsSync(join(hooks, 'trace', 'dead-sess.jsonl')), true)
      assert.equal(r.reaped.trace, 0)
    })
  })

  test('markers past the TTL reap even inside a live session', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      touch(join(hooks, 'old-sess.work'), `${liveStamp()}\nbro-x\n`)
      // a stale marker of the same session — dead owner AND ancient
      touch(join(hooks, 'old-sess.act'), `${Date.now() - 8 * DAY}\n`, 8 * DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(hooks, 'old-sess.act')), false)
      assert.equal(existsSync(join(hooks, 'old-sess.work')), true)
      assert.equal(r.sessions.includes('old-sess'), false)
    })
  })
})

describe('janitor — cursors', () => {
  test('a markerless idle cursor reaps — drain idleness is the owner check', () => {
    withBro((bro) => {
      mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(bro, 'notify', '.seen-ghost'), 'drop-a\n', 2 * DAY)
      touch(join(bro, 'notify', '.seen-fresh'), 'drop-a\n', HOUR)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(bro, 'notify', '.seen-ghost')), false)
      assert.equal(existsSync(join(bro, 'notify', '.seen-fresh')), true)
      assert.equal(r.reaped.cursors, 1)
    })
  })

  test('a cursor for a session with live markers stays', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(hooks, 'live-sess.work'), `${liveStamp()}\nbro-x\n`)
      touch(join(bro, 'notify', '.seen-live-sess'), 'drop-a\n', 2 * DAY) // idle cursor, live session
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(bro, 'notify', '.seen-live-sess')), true)
      assert.equal(r.reaped.cursors, 0)
    })
  })

  test('expired drops reap without waiting for a drain', () => {
    withBro((bro) => {
      const notify = mkdir(bro, 'notify')
      touch(join(notify, 'watch-1-abc.txt'), 'stale', 2 * HOUR)
      touch(join(notify, 'watch-2-def.txt'), 'fresh', 10 * 60_000)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(notify, 'watch-1-abc.txt')), false)
      assert.equal(existsSync(join(notify, 'watch-2-def.txt')), true)
      assert.equal(r.reaped.drops, 1)
    })
  })
})

describe('janitor — agent homes', () => {
  test('registry-entry-gone-but-files-remain: orphan agent files unlink', () => {
    withBro((bro) => {
      const agents = mkdir(bro, 'agents')
      writeRegistry(bro, {
        'step-live': { agentId: 'native-live', backend: 'native', spawnedAt: new Date().toISOString() },
      })
      touch(join(agents, 'native-orphan.log'), 'orphan\n', DAY)
      touch(join(agents, 'native-orphan.exit'), '1', DAY)
      touch(join(agents, 'native-live.log'), 'live\n', DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(agents, 'native-orphan.log')), false)
      assert.equal(existsSync(join(agents, 'native-orphan.exit')), false)
      assert.equal(existsSync(join(agents, 'native-live.log')), true)
      assert.equal(r.reaped.agentFiles, 2)
    })
  })

  test('a recorded death past retention removes the entry and its home', () => {
    withBro((bro) => {
      const agents = mkdir(bro, 'agents')
      writeRegistry(bro, {
        'step-dead': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date(Date.now() - 9 * DAY).toISOString(),
          exitStatus: 1,
        },
        'step-live': { agentId: 'native-live', backend: 'native', spawnedAt: new Date().toISOString() },
      })
      touch(join(agents, 'native-dead.exit'), '1', 8 * DAY)
      touch(join(agents, 'native-dead.log'), 'log\n', 8 * DAY)
      touch(join(agents, 'native-dead.prompt.md'), 'prompt\n', 8 * DAY)
      const r = janitorBroDir(bro, deps(bro))
      assert.deepEqual(r.agentEntries, ['step-dead'])
      assert.equal(existsSync(join(agents, 'native-dead.exit')), false)
      assert.equal(existsSync(join(agents, 'native-dead.log')), false)
      assert.equal(existsSync(join(agents, 'native-dead.prompt.md')), false)
      const reg = JSON.parse(readFileSync(join(bro, 'agents.json'), 'utf8')) as Record<string, unknown>
      assert.equal('step-dead' in reg, false)
      assert.equal('step-live' in reg, true)
    })
  })

  test('a recorded death inside retention keeps the entry and its home', () => {
    withBro((bro) => {
      const agents = mkdir(bro, 'agents')
      writeRegistry(bro, {
        'step-dead': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date(Date.now() - DAY).toISOString(),
          exitStatus: 0,
        },
      })
      touch(join(agents, 'native-dead.exit'), '0', HOUR)
      touch(join(agents, 'native-dead.log'), 'log\n', HOUR)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(r.agentEntries.length, 0)
      assert.equal(existsSync(join(agents, 'native-dead.exit')), true)
      assert.equal(existsSync(join(agents, 'native-dead.log')), true)
      assert.equal('step-dead' in (JSON.parse(readFileSync(join(bro, 'agents.json'), 'utf8')) as object), true)
    })
  })

  test('a live entry is never reaped — unrecorded death is the connector probe, not the janitor', () => {
    withBro((bro) => {
      mkdir(bro, 'agents')
      writeRegistry(bro, {
        'step-live': {
          agentId: 'native-live',
          backend: 'native',
          spawnedAt: new Date(Date.now() - 30 * DAY).toISOString(),
        },
      })
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(r.agentEntries.length, 0)
      assert.equal('step-live' in (JSON.parse(readFileSync(join(bro, 'agents.json'), 'utf8')) as object), true)
    })
  })
})

describe('janitor — locks', () => {
  test('a lock whose token names a dead pid reaps — lock older than the agent it guards', () => {
    withBro((bro) => {
      // a path nothing acquires — agents.json.lock would already be
      // stolen by acquireFileLock's own dead-holder steal in the sweeps
      touch(join(bro, 'stale.json.lock'), '99999999:deadbeef', DAY)
      // a live holder inside the abandoned bound — an actual hold,
      // not residue; the filelock's own steal rule keeps it
      touch(join(bro, 'other.json.lock'), `${process.pid}:livebeef`)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(bro, 'stale.json.lock')), false)
      assert.equal(existsSync(join(bro, 'other.json.lock')), true)
      assert.equal(r.reaped.locks, 1)
    })
  })

  test('a live holder past the abandoned bound reaps — the same verdict a contender\'s steal reaches', () => {
    withBro((bro) => {
      // alive pid, but a hold older than LOCK_ABANDONED_MS (15m) is
      // rob-by-rule — a contender would steal it on its next acquire
      touch(join(bro, 'abandoned.json.lock'), `${process.pid}:livebeef`, 20 * 60_000)
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(bro, 'abandoned.json.lock')), false)
      assert.equal(r.reaped.locks, 1)
    })
  })

  test('a lock that cannot be acquired skips the serialized passes — fail-closed, never unlocked', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(hooks, 'dead-sess.work'), `${deadStamp()}\nbro-x\n`, 2 * DAY)
      touch(join(bro, 'notify', '.seen-idle-sess'), 'drop-a\n', 2 * DAY)
      const broken = { ...deps(bro), registryLock: () => { throw new Error('held') } }
      const r = janitorBroDir(bro, broken)
      // the session sweep and its idle-cursor verdict both skip — a
      // sweep without the occupancy lock proves nothing about liveness
      assert.equal(existsSync(join(hooks, 'dead-sess.work')), true)
      assert.equal(existsSync(join(bro, 'notify', '.seen-idle-sess')), true)
      assert.equal(r.sessions.length, 0)
      assert.equal(r.reaped.cursors, 0)
    })
  })

  test('captured and staged lock leftovers reap past the debris floor', () => {
    withBro((bro) => {
      touch(join(bro, 'x.lock.cap-1-ab12'), '1:x', 2 * 60_000)
      touch(join(bro, 'agents.json.123.ab12.tmp'), 'tok', 2 * 60_000)
      touch(join(bro, 'agents.json.456.cd34.tmp'), 'tok', 10_000) // in-flight — kept
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(existsSync(join(bro, 'x.lock.cap-1-ab12')), false)
      assert.equal(existsSync(join(bro, 'agents.json.123.ab12.tmp')), false)
      assert.equal(existsSync(join(bro, 'agents.json.456.cd34.tmp')), true)
      assert.equal(r.reaped.debris, 2)
    })
  })
})

describe('janitor — size caps', () => {
  test('an oversized trace journal keeps its newest whole-line tail', () => {
    withBro((bro) => {
      const trace = mkdir(bro, 'hooks', 'trace')
      const line = `{"ts":1,"tool":"x","pad":"${'y'.repeat(100)}"}\n`
      const big = join(trace, 'fat-sess.jsonl')
      writeFileSync(big, line.repeat(12000)) // ~1.4 MiB
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(r.truncated.length, 1)
      const after = readFileSync(big, 'utf8')
      assert.ok(after.length <= 600 * 1024)
      const first = after.split('\n')[0]!
      assert.ok(first.startsWith('{"ts"'), 'tail starts on a line boundary')
      assert.ok(after.endsWith('}\n'), 'newest line survives')
    })
  })

  test('a live agent .log caps; an orphan .log reaps instead', () => {
    withBro((bro) => {
      const agents = mkdir(bro, 'agents')
      writeRegistry(bro, {
        'step-live': { agentId: 'native-live', backend: 'native', spawnedAt: new Date().toISOString() },
      })
      const big = 'x'.repeat(200) + '\n'
      const liveLog = join(agents, 'native-live.log')
      const orphanLog = join(agents, 'native-orphan.log')
      writeFileSync(liveLog, big.repeat(6000))
      writeFileSync(orphanLog, big.repeat(6000))
      const r = janitorBroDir(bro, deps(bro))
      assert.ok(statSync(liveLog).size <= 600 * 1024)
      assert.equal(existsSync(liveLog), true)
      assert.equal(existsSync(orphanLog), false)
      assert.equal(r.truncated.length, 1)
    })
  })

  test('a file under the cap is untouched', () => {
    withBro((bro) => {
      const trace = mkdir(bro, 'hooks', 'trace')
      touch(join(trace, 'small.jsonl'), '{"ts":1}\n')
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(r.truncated.length, 0)
      assert.equal(readFileSync(join(trace, 'small.jsonl'), 'utf8'), '{"ts":1}\n')
    })
  })
})

describe('janitor — report + modes', () => {
  test('dryRun counts but never unlinks', () => {
    withBro((bro) => {
      const hooks = mkdir(bro, 'hooks')
      mkdir(bro, 'notify')
      touch(join(hooks, 'dead-sess.work'), `${deadStamp()}\nbro-x\n`, 2 * DAY)
      touch(join(bro, 'notify', '.seen-dead-sess'), 'drop-a\n', 2 * DAY)
      const r = janitorBroDir(bro, deps(bro), { dryRun: true })
      assert.equal(r.dryRun, true)
      assert.equal(janitorDidWork(r), true)
      assert.ok(janitorLine(r).startsWith('janitor: would reap'))
      assert.equal(existsSync(join(hooks, 'dead-sess.work')), true)
      assert.equal(existsSync(join(bro, 'notify', '.seen-dead-sess')), true)
    })
  })

  test('a clean state dir reports no work and an empty line', () => {
    withBro((bro) => {
      const r = janitorBroDir(bro, deps(bro))
      assert.equal(janitorDidWork(r), false)
      assert.equal(janitorLine(r), '')
    })
  })

  test('runJanitor returns null outside a git worktree', () => {
    const bare = mkdtempSync(join(tmpdir(), 'bro-janitor-bare-'))
    try {
      assert.equal(runJanitor(bare), null)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

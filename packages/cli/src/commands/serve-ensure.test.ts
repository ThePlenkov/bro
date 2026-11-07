import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { git, initRepo, insideAsync } from './testrepo.ts'
import {
  ensureServe,
  SERVE_TOKEN_ENV,
  serveSessionToken,
  watchdogVerdict,
  writeServeState,
} from './serve.ts'

const PORT = 44928

describe('bro serve ensure', () => {
  test('live listener on this repo prints its token — no spawn', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        writeServeState(main, {
          pid: process.pid,
          url: `http://127.0.0.1:${PORT}`,
          dir: realpathSync(main),
          startedAt: new Date().toISOString(),
          token: 'tok-live',
        })
        let spawned = false
        const token = await ensureServe(main, PORT, {
          probe: async () => ({ ok: true, dir: realpathSync(main), pid: process.pid }),
          spawnServer: () => {
            spawned = true
          },
        })
        assert.equal(token, 'tok-live')
        assert.equal(spawned, false)
      })
    })())

  test('a healthy listener bound to a foreign repo refuses', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        await assert.rejects(
          () =>
            ensureServe(main, PORT, {
              probe: async () => ({ ok: true, dir: '/other/repo' }),
            }),
          /already serves \/other\/repo/
        )
      })
    })())

  test('dead port spawns once, then prints the new token', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        let spawns = 0
        let probes = 0
        const token = await ensureServe(main, PORT, {
          probe: async () => {
            probes += 1
            if (probes < 2) return undefined
            return { ok: true, dir: realpathSync(main), pid: process.pid }
          },
          spawnServer: () => {
            spawns += 1
            // the real spawn writes serve.json asynchronously — the
            // stub lands it between spawn and the next probe
            writeServeState(main, {
              pid: process.pid,
              url: `http://127.0.0.1:${PORT}`,
              dir: realpathSync(main),
              startedAt: new Date().toISOString(),
              token: 'tok-new',
            })
          },
          pollMs: 1,
        })
        assert.equal(spawns, 1)
        assert.equal(token, 'tok-new')
      })
    })())

  test('a port that never comes up reports the log path', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        await assert.rejects(
          () =>
            ensureServe(main, PORT, {
              probe: async () => undefined,
              spawnServer: () => {},
              timeoutMs: 5,
              pollMs: 1,
            }),
          /never came up.*serve\.log/
        )
      })
    })())

  test('a listener claiming our dir with a foreign pid is refused', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        writeServeState(main, {
          pid: process.pid,
          url: `http://127.0.0.1:${PORT}`,
          dir: realpathSync(main),
          startedAt: new Date().toISOString(),
          token: 'tok-live',
        })
        await assert.rejects(
          () =>
            ensureServe(main, PORT, {
              probe: async () => ({
                ok: true,
                dir: realpathSync(main),
                pid: process.pid + 9_999,
              }),
            }),
          /not the recorded serve/
        )
      })
    })())

  test('a linked worktree accepts the serve anchored to the main root', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        const linked = join(root, 'linked')
        git(['worktree', 'add', '-q', linked, '-b', 'work/x'], main)
        // the serve anchors dir to the MAIN checkout; serve.json lives
        // in the common dir both worktrees share
        writeServeState(linked, {
          pid: process.pid,
          url: `http://127.0.0.1:${PORT}`,
          dir: realpathSync(main),
          startedAt: new Date().toISOString(),
          token: 'tok-live',
        })
        let spawned = false
        const token = await ensureServe(linked, PORT, {
          probe: async () => ({ ok: true, dir: realpathSync(main), pid: process.pid }),
          spawnServer: () => {
            spawned = true
          },
        })
        assert.equal(token, 'tok-live')
        assert.equal(spawned, false)
      })
    })())

  test('a serve anchored to a deleted path is stopped, then respawned', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        const gone = join(root, 'deleted-worktree')
        const stalePid = process.pid + 10_001
        const newPid = stalePid + 1
        writeServeState(main, {
          pid: stalePid,
          url: `http://127.0.0.1:${PORT}`,
          dir: gone,
          startedAt: new Date().toISOString(),
          token: 'tok-old',
        })
        const stopped: number[] = []
        let spawns = 0
        let probes = 0
        const token = await ensureServe(main, PORT, {
          probe: async () => {
            probes += 1
            // first: the stale generation still answers on its dead dir;
            // after the respawn the new serve reports the main root
            if (probes === 1) return { ok: true, dir: gone, pid: stalePid }
            return { ok: true, dir: realpathSync(main), pid: newPid }
          },
          stopServe: async (pid) => {
            stopped.push(pid)
          },
          spawnServer: () => {
            spawns += 1
            writeServeState(main, {
              pid: newPid,
              url: `http://127.0.0.1:${PORT}`,
              dir: realpathSync(main),
              startedAt: new Date().toISOString(),
              token: 'tok-new',
            })
          },
          pollMs: 1,
        })
        assert.equal(token, 'tok-new')
        assert.equal(spawns, 1)
        assert.deepEqual(stopped, [stalePid])
      })
    })())

  test('a pid-matching serve on a live other dir is ours but off-anchor — healed', () =>
    (async () => {
      const { root, main } = initRepo('ensure-')
      await insideAsync(main, root, async () => {
        // pre-fix residue: the recorded dir is a linked worktree that
        // still exists — functional, but parked on a doomed anchor; the
        // hand-out heals it onto the main root now
        const newPid = process.pid + 10_002
        writeServeState(main, {
          pid: process.pid,
          url: `http://127.0.0.1:${PORT}`,
          dir: root,
          startedAt: new Date().toISOString(),
          token: 'tok-old',
        })
        const stopped: number[] = []
        let probes = 0
        const token = await ensureServe(main, PORT, {
          probe: async () => {
            probes += 1
            if (probes === 1) return { ok: true, dir: root, pid: process.pid }
            return { ok: true, dir: realpathSync(main), pid: newPid }
          },
          stopServe: async (pid) => {
            stopped.push(pid)
          },
          spawnServer: () => {
            writeServeState(main, {
              pid: newPid,
              url: `http://127.0.0.1:${PORT}`,
              dir: realpathSync(main),
              startedAt: new Date().toISOString(),
              token: 'tok-new',
            })
          },
          pollMs: 1,
        })
        assert.equal(token, 'tok-new')
        assert.deepEqual(stopped, [process.pid])
      })
    })())

  test('outside a repo there is no anchor — loud, not empty', () =>
    (async () => {
      await assert.rejects(
        () =>
          ensureServe('/tmp', PORT, {
            probe: () => Promise.reject(new Error('probe must not run without an anchor')),
          }),
        /not inside a git repository/
      )
    })())
})

describe('watchdogVerdict', () => {
  const record = {
    pid: 7,
    url: 'http://127.0.0.1:1',
    dir: '/repo',
    startedAt: 't',
    token: 't',
  }

  test('a retracted record or a superseding pid retires the leg', () => {
    assert.equal(watchdogVerdict(undefined, 7), 'retire')
    assert.equal(watchdogVerdict({ ...record, pid: 9 }, 7), 'retire')
  })

  test('a live recorded pid keeps watching; a dead one respawns', () => {
    assert.equal(watchdogVerdict(record, 7, () => true), 'alive')
    assert.equal(watchdogVerdict(record, 7, () => false), 'respawn')
  })
})

describe('serveSessionToken', () => {
  test('a watchdog respawn adopts the inherited token; a fresh serve mints one', () => {
    // the crash-recovery contract: the watchdog hands the dead
    // generation's token through the child env so clients holding it
    // never see a 401 window (the apiKeyHelper re-ensures only on
    // auth refresh)
    assert.equal(serveSessionToken({ [SERVE_TOKEN_ENV]: 'tok-inherited' }), 'tok-inherited')
    assert.equal(serveSessionToken({ [SERVE_TOKEN_ENV]: '' }).length, 64)
    const fresh = serveSessionToken({})
    assert.match(fresh, /^[0-9a-f]{64}$/)
    assert.notEqual(fresh, serveSessionToken({}))
  })
})

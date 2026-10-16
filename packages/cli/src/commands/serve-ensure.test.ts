import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { initRepo, insideAsync } from './testrepo.ts'
import { ensureServe, writeServeState } from './serve.ts'

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

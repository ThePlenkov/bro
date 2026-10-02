/** `bro serve` e2e — the real built CLI as a long-running child: the
 *  loopback bind, the discovery file, and clean SIGTERM shutdown are
 *  process-lifecycle behavior, so they only exist at spawn distance.
 *  No chdir — the child takes `cwd`; the parent only cleans up. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLI_DIST,
  e2eEnv,
  initRepo,
  installFakeBd,
} from './testrepo.ts'

/** Spawn `bro serve` and resolve once stdout reports the bound URL. */
function startServe(
  cwd: string,
  env: Record<string, string>
): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, 'serve', '--port', '0'], {
      cwd,
      env: e2eEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    // every reject path kills the child — an orphaned `bro serve`
    // outlives the fixture its caller is about to rmSync
    function fail(e: Error): void {
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(e)
    }
    const timer = setTimeout(
      () => fail(new Error(`serve never reported a URL — stdout: ${out} stderr: ${err}`)),
      15_000
    )
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      const m = /bro serve — (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ child, url: m[1]! })
      }
    })
    child.stderr!.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    child.once('exit', (code) => {
      fail(new Error(`serve exited ${code} before binding — ${err}`))
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve did not exit on SIGTERM')), 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

describe('bro serve e2e', () => {
  test('binds loopback, serves the facade planes, publishes + retracts serve.json', async () => {
    const { root, main } = initRepo('bro-serve-e2e-')
    const { binDir, db } = installFakeBd(root, [])
    try {
      const { child, url } = await startServe(main, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_BD_DB: db,
      })
      try {
        const health = await fetch(`${url}/api/v1/health`)
        assert.equal(health.status, 200)
        const h = (await health.json()) as { ok: boolean; pid: number; dir: string }
        assert.equal(h.ok, true)
        assert.equal(h.pid, child.pid)

        const agents = await fetch(`${url}/api/v1/agents`)
        const plane = (await agents.json()) as { backends: { name: string }[] }
        assert.ok(plane.backends.some((b) => b.name === 'native'))

        // the snapshot composes even with an empty store — planes degrade
        // inside the payload, they don't take the host down
        const snap = await fetch(`${url}/api/v1/snapshot`)
        assert.equal(snap.status, 200)
        assert.ok('mols' in ((await snap.json()) as object))

        const miss = await fetch(`${url}/api/v1/agents/native-nope`)
        assert.equal(miss.status, 404)

        const bad = await fetch(`${url}/api/v1/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        assert.equal(bad.status, 400)

        // a non-JSON write is refused — the loopback CSRF guard
        const forged = await fetch(`${url}/api/v1/agents`, {
          method: 'POST',
          body: '{"molStep":"fx-1"}',
        })
        assert.equal(forged.status, 415)

        // discovery file lives in the common dir while the server runs
        const stateFile = join(main, '.git', 'bro', 'serve.json')
        assert.equal(existsSync(stateFile), true)
        const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
          pid: number
          url: string
        }
        assert.equal(state.pid, child.pid)
        assert.equal(state.url, url)

        await stop(child)
        // shutdown retracts the discovery file — a stale URL must not
        // outlive the server it points at
        assert.equal(existsSync(stateFile), false)
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a second serve refuses while the first is alive', async () => {
    const { root, main } = initRepo('bro-serve-e2e-')
    const { binDir, db } = installFakeBd(root, [])
    try {
      const env = {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_BD_DB: db,
      }
      const { child } = await startServe(main, env)
      try {
        const second = spawn(process.execPath, [CLI_DIST, 'serve'], {
          cwd: main,
          env: e2eEnv(env),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
          let err = ''
          // bounded wait — if the refuse logic regresses and the second
          // serve binds instead of exiting, kill it and fail the test
          // rather than hanging the suite
          const timer = setTimeout(() => {
            second.kill('SIGKILL')
            resolve({ code: null, err: `${err} — timed out waiting for exit` })
          }, 15_000)
          second.stderr!.on('data', (d: Buffer) => {
            err += d.toString('utf8')
          })
          second.once('exit', (code) => {
            clearTimeout(timer)
            resolve({ code, err })
          })
        })
        assert.equal(result.code, 1)
        assert.match(result.err, /already serving/)
      } finally {
        await stop(child).catch(() => child.kill('SIGKILL'))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

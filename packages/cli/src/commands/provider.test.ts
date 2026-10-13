import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createProviderHandler,
  DEFAULT_PROVIDER_PORT,
  liveProviderState,
  providerStatePath,
  resolveProviderEndpoint,
} from './provider.ts'
import { writeServeState, writeStateFile, type ServeState } from './serve.ts'
import { initRepo, inside, tmpDir } from './testrepo.ts'

const LIVE = process.pid
const DEAD = 1 << 30

const state = (pid: number, url: string, dir = '/x', token = 'tok'): ServeState => ({
  pid,
  url,
  dir,
  startedAt: 't',
  token,
})

/** A private XDG state dir per test — providerStatePath reads the env
 *  at call time, so setting it here scopes every lookup. */
function tmpStateDir(t: TestContext): string {
  const d = tmpDir('bro-provider-state-')
  const prev = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = d
  t.after(() => {
    if (prev === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = prev
    }
  })
  return d
}

describe('provider state — the host-level discovery file', () => {
  test('providerStatePath honors XDG_STATE_HOME, falls back to ~/.local/state', (t) => {
    const d = tmpStateDir(t)
    assert.equal(providerStatePath(), join(d, 'bro', 'provider.json'))
    const prev = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    try {
      assert.match(providerStatePath(), /\.local\/state\/bro\/provider\.json$/)
    } finally {
      process.env.XDG_STATE_HOME = prev
    }
  })

  test('liveProviderState — written 0600, live-pid gated', (t) => {
    tmpStateDir(t)
    assert.equal(liveProviderState(), undefined)
    writeStateFile(providerStatePath(), state(LIVE, 'http://127.0.0.1:4545'))
    assert.equal(statSync(providerStatePath()).mode & 0o077, 0)
    assert.equal(liveProviderState()?.token, 'tok')
    // a dead recorded pid is a stale file, not a live listener
    writeStateFile(providerStatePath(), state(DEAD, 'http://127.0.0.1:4545'))
    assert.equal(liveProviderState(), undefined)
  })
})

describe('resolveProviderEndpoint — the cwd-aware pick', () => {
  test('host listener is the fallback; repo provider serve wins inside its repo', (t) => {
    tmpStateDir(t)
    writeStateFile(providerStatePath(), state(LIVE, 'http://127.0.0.1:4545', '/x', 'host-tok'))
    const { root, main } = initRepo('bro-prov-resolve-')
    inside(main, root, () => {
      // host only
      assert.deepEqual(resolveProviderEndpoint(main, {}), {
        url: 'http://127.0.0.1:4545',
        token: 'host-tok',
        source: 'host',
      })
      // a facade-only repo serve must not shadow the host listener
      writeServeState(main, state(LIVE, 'http://127.0.0.1:9000', main, 'facade-tok'))
      assert.equal(resolveProviderEndpoint(main, {})?.source, 'host')
      // the provider-wired repo serve is the specific context — it wins
      writeServeState(main, {
        ...state(LIVE, 'http://127.0.0.1:9000', main, 'repo-tok'),
        provider: true,
      })
      assert.deepEqual(resolveProviderEndpoint(main, {}), {
        url: 'http://127.0.0.1:9000',
        token: 'repo-tok',
        source: 'repo',
      })
    })
  })

  test('ANTHROPIC_BASE_URL pins by exact url — normalized, never guessed', (t) => {
    tmpStateDir(t)
    writeStateFile(providerStatePath(), state(LIVE, 'http://127.0.0.1:4545', '/x', 'host-tok'))
    const { root, main } = initRepo('bro-prov-pin-')
    inside(main, root, () => {
      writeServeState(main, {
        ...state(LIVE, 'http://127.0.0.1:9000', main, 'repo-tok'),
        provider: true,
      })
      // localhost + trailing slash normalize to the recorded url —
      // and the pin beats the repo-first default
      const env = { ANTHROPIC_BASE_URL: 'http://localhost:4545/' }
      assert.equal(resolveProviderEndpoint(main, env)?.source, 'host')
      // the pin names the repo serve — credential still resolves, even
      // for a facade-recorded listener (exact match is explicit intent)
      writeServeState(main, state(LIVE, 'http://127.0.0.1:9000', main, 'facade-tok'))
      assert.equal(
        resolveProviderEndpoint(main, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000' })?.token,
        'facade-tok'
      )
      // a url no live listener recorded is a miss — fail, never guess
      assert.equal(
        resolveProviderEndpoint(main, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7777' }),
        undefined
      )
      // a dead host entry falls through — only live listeners count
      writeStateFile(providerStatePath(), state(DEAD, 'http://127.0.0.1:4545'))
      assert.equal(resolveProviderEndpoint('/nowhere', {}), undefined)
    })
  })
})

// --- the thin host's request pipeline ---------------------------------------------

async function listen(
  opts: Partial<Parameters<typeof createProviderHandler>[0]> = {}
): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = createProviderHandler({
    proxy: async (_req: IncomingMessage, res: ServerResponse) => {
      res.end('p-ok')
    },
    token: 'tok',
    meta: { dir: '/d', startedAt: 't0' },
    statePathHint: '/hint/provider.json',
    ...opts,
  })
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

describe('provider host — index, health, and the guarded /v1/* plane', () => {
  test('index + health are the only unauthenticated reads; the facade is absent', async () => {
    const { url, close } = await listen()
    try {
      const idx = (await (await fetch(`${url}/`)).json()) as {
        service: string
        routes: string[]
      }
      assert.equal(idx.service, 'bro-provider')
      const health = (await (await fetch(`${url}/api/v1/health`)).json()) as {
        ok: boolean
        pid: number
      }
      assert.equal(health.ok, true)
      assert.equal(health.pid, process.pid)
      // no facade planes — a thin host, not a second serve
      for (const p of ['/fleet', '/api/v1/snapshot', '/api/v1/agents']) {
        assert.equal((await fetch(`${url}${p}`)).status, 404, p)
      }
    } finally {
      await close()
    }
  })

  test('/v1/* carries serve\'s guard stack verbatim — token, origin, content-type', async () => {
    let reached = 0
    const { url, close } = await listen({
      proxy: async (_req, res) => {
        reached++
        res.end('ok')
      },
    })
    try {
      // no credential → 401 on every method, GET included
      assert.equal((await fetch(`${url}/v1/models`)).status, 401)
      const anon = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(anon.status, 401)
      assert.equal(anon.headers.get('www-authenticate'), 'Bearer')

      // x-api-key carries the credential — the apiKeyHelper contract
      assert.equal((await fetch(`${url}/v1/models`, { headers: { 'x-api-key': 'tok' } })).status, 200)

      // bearer works too; a body-bearing write with a foreign
      // content-type is refused, and so is a non-loopback Origin
      const bearer = { authorization: 'Bearer tok' }
      const badCt = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'text/plain' },
        body: 'x',
      })
      assert.equal(badCt.status, 415)
      const foreign = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json', origin: 'http://evil.example' },
        body: '{}',
      })
      assert.equal(foreign.status, 403)
      const ok = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(ok.status, 200)
      assert.equal(await ok.text(), 'ok')
      assert.equal(reached, 2)
    } finally {
      await close()
    }
  })
})

test('the well-known default — the permanent settings.json port', () => {
  assert.equal(DEFAULT_PROVIDER_PORT, 4545)
})

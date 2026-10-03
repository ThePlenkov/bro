import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { SpawnError, type AgentConnector, type AgentInfo } from '@broject/core'
import { initRepo, inside } from './testrepo.ts'
import { SpawnInputError } from './agents.ts'
import {
  acquireServeLock,
  clearServeState,
  createServeHandler,
  HttpError,
  liveServeState,
  parseSpawnBody,
  readBody,
  readServeState,
  routeRequest,
  serveStatePath,
  writeServeState,
  type ServeDeps,
} from './serve.ts'
import { WEBUI_CSP } from './webui.ts'

const fakeConn = {
  name: 'native',
  capabilities: () => ({ supervisor: 'none' as const }),
} as AgentConnector

const fakeAgent: AgentInfo = {
  id: 'native-aa11',
  molStep: 'fx-1',
  backend: 'native',
  state: 'running',
  pid: 4242,
}

const deps = (over: Partial<ServeDeps> = {}): ServeDeps => ({
  snapshot: async () => ({ snap: true }),
  backends: async () => [{ conn: fakeConn, agents: [fakeAgent] }],
  find: async (ref) =>
    ref === fakeAgent.id || ref === fakeAgent.molStep
      ? { hit: { conn: fakeConn, agent: fakeAgent }, degraded: [] }
      : { degraded: [] },
  spawn: async () => fakeAgent,
  stop: async (ref) =>
    ref === fakeAgent.id
      ? { found: true, degraded: [], agent: fakeAgent, stopped: true }
      : { found: false, degraded: [], stopped: false },
  connectors: () => ['native'],
  ...over,
})

const route = (
  method: string,
  path: string,
  body?: string,
  d: ServeDeps = deps()
) => routeRequest(method, path, body, d, { dir: '/repo', startedAt: 't0' })

describe('serve — routes', () => {
  test('GET / is the service index; unknown paths 404 with the route list', async () => {
    const index = await route('GET', '/')
    assert.equal(index.status, 200)
    const body = index.body as { service: string; routes: string[] }
    assert.equal(body.service, 'bro')
    assert.ok(body.routes.some((r) => r.includes('/api/v1/snapshot')))

    for (const p of ['/nope', '/api/v2/agents', '/api/v1/agents/a/b']) {
      const r = await route('GET', p)
      assert.equal(r.status, 404, p)
    }
  })

  test('GET /fleet serves the webui as HTML with its CSP; non-GET is 405', async () => {
    const r = await route('GET', '/fleet')
    assert.equal(r.status, 200)
    assert.equal(r.contentType, 'text/html; charset=utf-8')
    assert.equal(r.headers?.['content-security-policy'], WEBUI_CSP)
    const html = String(r.body)
    assert.match(html, /<!doctype html>/)
    assert.match(html, /\/api\/v1\/snapshot/)

    const post = await route('POST', '/fleet', '{}')
    assert.equal(post.status, 405)
  })

  test('GET /api/v1/health answers liveness', async () => {
    const r = await route('GET', '/api/v1/health')
    assert.equal(r.status, 200)
    const body = r.body as { ok: boolean; pid: number; dir: string }
    assert.equal(body.ok, true)
    assert.equal(body.pid, process.pid)
    assert.equal(body.dir, '/repo')
  })

  test('GET /api/v1/snapshot relays the watch snapshot', async () => {
    const r = await route('GET', '/api/v1/snapshot')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { snap: true })
  })

  test('GET /api/v1/agents serializes the backend plane without conn objects', async () => {
    const r = await route('GET', '/api/v1/agents')
    assert.equal(r.status, 200)
    const body = r.body as {
      backends: { name: string; capabilities: { supervisor: string }; agents: AgentInfo[] }[]
    }
    assert.equal(body.backends[0]!.name, 'native')
    assert.equal(body.backends[0]!.capabilities.supervisor, 'none')
    assert.equal(body.backends[0]!.agents[0]!.id, 'native-aa11')
    assert.equal('conn' in body.backends[0]!, false)
  })

  test('GET /api/v1/agents/<ref> — hit returns the agent, miss 404s with degraded notes', async () => {
    const hit = await route('GET', '/api/v1/agents/native-aa11')
    assert.equal(hit.status, 200)
    assert.equal((hit.body as AgentInfo).molStep, 'fx-1')

    // a hit beside a degraded backend surfaces the note on the resource
    const partial = await route(
      'GET',
      '/api/v1/agents/native-aa11',
      undefined,
      deps({
        find: async () => ({
          hit: { conn: fakeConn, agent: fakeAgent },
          degraded: ['tmux: socket gone'],
        }),
      })
    )
    assert.equal(partial.status, 200)
    assert.equal((partial.body as AgentInfo).id, fakeAgent.id)
    assert.equal((partial.body as AgentInfo).molStep, fakeAgent.molStep)
    assert.deepEqual((partial.body as { degraded: string[] }).degraded, ['tmux: socket gone'])

    const miss = await route(
      'GET',
      '/api/v1/agents/nope',
      undefined,
      deps({ find: async () => ({ degraded: ['tmux: socket gone'] }) })
    )
    assert.equal(miss.status, 404)
    const body = miss.body as { error: string; degraded: string[] }
    assert.match(body.error, /no agent "nope"/)
    assert.deepEqual(body.degraded, ['tmux: socket gone'])
  })

  test('a ref with unsafe characters is a 400, not a lookup', async () => {
    const r = await route('GET', '/api/v1/agents/a%20b')
    assert.equal(r.status, 400)
    // malformed % escapes throw in decodeURIComponent — still a 400
    const bad = await route('GET', '/api/v1/agents/%E0%A4%A')
    assert.equal(bad.status, 400)
  })

  test('DELETE /api/v1/agents/<ref> — stopped, terminal, miss, degraded-miss', async () => {
    const stopped = await route('DELETE', '/api/v1/agents/native-aa11')
    assert.equal(stopped.status, 200)
    assert.equal((stopped.body as { stopped: boolean }).stopped, true)

    // stop() always runs on a hit — `terminal` flags there was nothing
    // live to kill, the note still reports the observed state
    const terminal = await route(
      'DELETE',
      '/api/v1/agents/native-aa11',
      undefined,
      deps({
        stop: async () => ({
          found: true,
          degraded: [],
          agent: { ...fakeAgent, state: 'exited' },
          stopped: true,
          terminal: true,
        }),
      })
    )
    assert.equal(terminal.status, 200)
    assert.equal((terminal.body as { stopped: boolean }).stopped, true)
    // terminal is the machine-readable bit — the note is for humans
    assert.equal((terminal.body as { terminal?: boolean }).terminal, true)
    assert.match((terminal.body as { note: string }).note, /already exited/)

    const miss = await route('DELETE', '/api/v1/agents/native-gone')
    assert.equal(miss.status, 404)

    // a miss beside a degraded backend is unverifiable — never a clean 404
    const blind = await route(
      'DELETE',
      '/api/v1/agents/native-gone',
      undefined,
      deps({
        stop: async () => ({ found: false, degraded: ['tmux: gone'], stopped: false }),
      })
    )
    assert.equal(blind.status, 503)
  })

  test('POST /api/v1/agents — 201 on spawn, 409 on SpawnError, 400 on input errors', async () => {
    const ok = await route('POST', '/api/v1/agents', JSON.stringify({ molStep: 'fx-1' }))
    assert.equal(ok.status, 201)
    assert.equal((ok.body as { agent: AgentInfo }).agent.id, 'native-aa11')

    const conflict = await route(
      'POST',
      '/api/v1/agents',
      JSON.stringify({ molStep: 'fx-1' }),
      deps({
        spawn: async () => {
          throw new SpawnError('fx-1 already has a live agent')
        },
      })
    )
    assert.equal(conflict.status, 409)

    // kind → status: input refusals are 400, server misconfiguration
    // 500, a missing backend 503 — not every SpawnError is a conflict
    for (const [kind, status] of [
      ['input', 400],
      ['config', 500],
      ['unavailable', 503],
    ] as const) {
      const r = await route(
        'POST',
        '/api/v1/agents',
        JSON.stringify({ molStep: 'fx-1' }),
        deps({
          spawn: async () => {
            throw new SpawnError(`spawn failed (${kind})`, kind)
          },
        })
      )
      assert.equal(r.status, status, `kind=${kind}`)
    }

    const badInput = await route(
      'POST',
      '/api/v1/agents',
      JSON.stringify({ molStep: 'fx-1', prompt: 'a', promptFile: '/f' }),
      deps({
        spawn: async () => {
          throw new SpawnInputError('prompt and promptFile are mutually exclusive')
        },
      })
    )
    assert.equal(badInput.status, 400)
  })

  test('POST with an unregistered connector is a 400 naming the known backends', async () => {
    const r = await route(
      'POST',
      '/api/v1/agents',
      JSON.stringify({ molStep: 'fx-1', connector: 'gascity' })
    )
    assert.equal(r.status, 400)
    assert.match((r.body as { error: string }).error, /not registered/)
  })

  test('wrong method on a known route is 405', async () => {
    for (const [m, p] of [
      ['POST', '/api/v1/health'],
      ['PUT', '/api/v1/agents/native-aa11'],
      ['DELETE', '/api/v1/agents'],
    ] as const) {
      const r = await route(m, p, '{}')
      assert.equal(r.status, 405, `${m} ${p}`)
    }
  })
})

describe('parseSpawnBody', () => {
  test('maps a valid body into StepSpawnRequest', () => {
    const req = parseSpawnBody(
      JSON.stringify({ molStep: 'fx-1', worktree: '/w', prompt: 'p', connector: 'native' })
    )
    assert.deepEqual(req, { molStep: 'fx-1', worktree: '/w', prompt: 'p', connector: 'native', promptFile: undefined, beadsDir: undefined })
  })

  test('rejects empty, non-JSON, non-object, unknown fields, and non-strings', () => {
    for (const bad of [undefined, '', 'not json', '[]', '42']) {
      assert.throws(() => parseSpawnBody(bad), HttpError)
    }
    assert.throws(
      () => parseSpawnBody(JSON.stringify({ molStep: 'fx-1', bogus: 1 })),
      /unknown field\(s\): bogus/
    )
    assert.throws(
      () => parseSpawnBody(JSON.stringify({ molStep: 'fx-1', worktree: 3 })),
      /must be a string/
    )
    assert.throws(() => parseSpawnBody('{}'), /molStep/)
  })
})

describe('readBody', () => {
  test('reads under the cap and refuses over it', async () => {
    assert.equal(await readBody(Readable.from(['{"a":', '1}'])), '{"a":1}')
    await assert.rejects(
      readBody(Readable.from(['x'.repeat(300 * 1024)])),
      (err: unknown) => err instanceof HttpError && err.status === 413
    )
  })
})

describe('serve state discovery', () => {
  test('write/read/live/clear roundtrip in <git-common-dir>/bro', () => {
    const { root, main } = initRepo('bro-serve-state-')
    inside(main, root, () => {
      const path = serveStatePath(main)
      assert.ok(path?.endsWith(join('.git', 'bro', 'serve.json')), String(path))

      const state = { pid: process.pid, url: 'http://127.0.0.1:9999', dir: main, startedAt: 't', token: 'sekret' }
      writeServeState(main, state)
      assert.deepEqual(readServeState(main), state)
      // our own pid is alive → the file reports a live server
      assert.equal(liveServeState(main)?.url, 'http://127.0.0.1:9999')

      clearServeState(main)
      assert.equal(readServeState(main), undefined)
      assert.equal(existsSync(path!), false)
    })
  })

  test('serve.json publishes at owner-only mode and a token-less record reads as torn', () => {
    const { root, main } = initRepo('bro-serve-state-')
    inside(main, root, () => {
      writeServeState(main, { pid: process.pid, url: 'u', dir: main, startedAt: 't', token: 'sekret' })
      // the file carries the session credential — group/other must get nothing
      const mode = statSync(serveStatePath(main)!).mode & 0o777
      assert.equal(mode & 0o077, 0, `serve.json mode ${mode.toString(8)} leaks to group/other`)

      // a state without a token is a foreign/torn record — fail closed
      writeFileSync(serveStatePath(main)!, JSON.stringify({ pid: 1, url: 'u', dir: main, startedAt: 't' }))
      assert.equal(readServeState(main), undefined)
    })
  })

  test('a dead recorded pid reads as stale, not live', () => {
    const { root, main } = initRepo('bro-serve-state-')
    inside(main, root, () => {
      // pid 2^30 is an implausible live pid on any host
      writeServeState(main, { pid: 1 << 30, url: 'http://127.0.0.1:1', dir: main, startedAt: 't', token: 'sekret' })
      assert.equal(liveServeState(main), undefined)
      assert.notEqual(readServeState(main), undefined)
    })
  })

  test("clearServeState leaves a successor's file alone", () => {
    const { root, main } = initRepo('bro-serve-state-')
    inside(main, root, () => {
      // the file names another pid — our shutdown must not unregister it
      writeServeState(main, { pid: process.ppid, url: 'u', dir: main, startedAt: 't', token: 'sekret' })
      clearServeState(main)
      assert.equal(readServeState(main)?.pid, process.ppid)
    })
  })

  test('no repo → no state path', () => {
    assert.equal(serveStatePath('/tmp'), null)
  })

  test('the serve lock is exclusive and breaks on a dead holder', () => {
    const { root, main } = initRepo('bro-serve-lock-')
    inside(main, root, () => {
      const release = acquireServeLock(main)
      assert.notEqual(release, undefined)
      // the same process re-entering is refused — the lock is held, and
      // our own pid is alive
      assert.equal(acquireServeLock(main), undefined)
      release!()
      assert.equal(existsSync(`${serveStatePath(main)}.lock`), false)

      // a leftover lock naming a dead pid is broken, not honored
      writeFileSync(`${serveStatePath(main)}.lock`, `${1 << 30}`)
      const retaken = acquireServeLock(main)
      assert.notEqual(retaken, undefined)
      assert.equal(readFileSync(`${serveStatePath(main)}.lock`, 'utf8'), `${process.pid}`)
      retaken!()
    })
  })

  test('an empty lock is in-flight while fresh, stealable when aged (wx fallback)', () => {
    const { root, main } = initRepo('bro-serve-lock-wx-')
    inside(main, root, () => {
      const lock = `${serveStatePath(main)}.lock`
      // the wx fallback's create-then-write window: a FRESH empty lock
      // is a live writer mid-write — a starter must refuse, not break
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, '')
      assert.equal(acquireServeLock(main), undefined)
      assert.equal(existsSync(lock), true, 'fresh empty lock must survive a refused acquire')
      // an empty lock older than the grace is a crashed writer's
      // leftover — the next starter breaks it and takes over
      const old = (Date.now() - 60_000) / 1000
      utimesSync(lock, old, old)
      const acquired = acquireServeLock(main)
      assert.notEqual(acquired, undefined)
      assert.equal(readFileSync(lock, 'utf8'), `${process.pid}`)
      acquired!()
    })
  })
})

describe('serve handler over a real socket', () => {
  test('health, JSON envelope, 413 cap, and bad-JSON 400 all hold on the wire', async () => {
    const TOKEN = 'test-session-token'
    const auth = { authorization: `Bearer ${TOKEN}` }
    const server = createServer(createServeHandler(deps(), { dir: '/repo', startedAt: 't0' }, TOKEN))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    try {
      const health = await fetch(`${base}/api/v1/health`)
      assert.equal(health.status, 200)
      assert.equal((await health.json() as { ok: boolean }).ok, true)

      const json = { 'content-type': 'application/json' }

      // writes without the session token are 401 — every write method
      // alike; a wrong token and a non-Bearer scheme fail closed too
      for (const [m, p] of [
        ['POST', '/api/v1/agents'],
        ['PUT', '/api/v1/agents/native-aa11'],
        ['PATCH', '/api/v1/agents/native-aa11'],
        ['DELETE', '/api/v1/agents/native-aa11'],
      ] as const) {
        const r = await fetch(`${base}${p}`, { method: m, headers: json })
        assert.equal(r.status, 401, `${m} ${p}`)
        assert.equal(r.headers.get('www-authenticate'), 'Bearer')
      }
      const wrongToken = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, authorization: 'Bearer nope' },
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(wrongToken.status, 401)
      const notBearer = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, authorization: `token ${TOKEN}` },
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(notBearer.status, 401)

      const badJson = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, ...auth },
        body: 'not json',
      })
      assert.equal(badJson.status, 400)

      const tooBig = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, ...auth },
        body: 'x'.repeat(300 * 1024),
      })
      assert.equal(tooBig.status, 413)

      // writes that aren't application/json are refused outright — the
      // loopback CSRF guard; a browser simple-request can't set it
      const csrf = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: auth,
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(csrf.status, 415)

      // a foreign Origin on a write — the browser's own CSRF stamp — is
      // refused before routing, on body-carrying and DELETE alike
      const foreignPost = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, ...auth, origin: 'http://evil.example' },
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(foreignPost.status, 403)
      const foreignDelete = await fetch(`${base}/api/v1/agents/native-aa11`, {
        method: 'DELETE',
        headers: { ...auth, origin: 'http://evil.example' },
      })
      assert.equal(foreignDelete.status, 403)
      // an unparseable or non-origin-shaped Origin fails closed — a
      // loopback hostname with a path is not a value browsers send
      const badOrigin = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, ...auth, origin: 'not a url' },
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(badOrigin.status, 403)
      const pathOrigin = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, ...auth, origin: 'http://localhost/path' },
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(pathOrigin.status, 403)
      // a loopback Origin — the fleet webui's own shape — passes the gate;
      // the 400 proves the request reached the body parser
      const sameOrigin = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, ...auth, origin: base },
        body: 'not json',
      })
      assert.equal(sameOrigin.status, 400)

      // a foreign Host — the DNS-rebinding shape — is refused before routing
      const rebound = await new Promise<IncomingMessage>((resolve) => {
        const req = request(
          `${base}/api/v1/health`,
          { headers: { host: 'attacker.example.com' } },
          resolve
        )
        req.end()
      })
      assert.equal(rebound.statusCode, 403)

      // GET routes ignore a body-less path cleanly
      const detail = await fetch(`${base}/api/v1/agents/native-aa11`)
      assert.equal(detail.status, 200)
      assert.equal((await detail.json() as AgentInfo).id, 'native-aa11')

      // the site route is verbatim HTML with its CSP — not a JSON envelope
      const page = await fetch(`${base}/fleet`)
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-type') ?? '', /text\/html/)
      assert.equal(page.headers.get('content-security-policy'), WEBUI_CSP)
      assert.match(await page.text(), /<!doctype html>/)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import {
  lockHolderPid,
  SpawnError,
  type AgentConnector,
  type AgentInfo,
  type PlaneFilter,
} from '@broject/core'
import { initRepo, inside, insideAsync } from './testrepo.ts'
import { SpawnInputError } from './agents.ts'
import {
  acquireServeLock,
  clearServeState,
  collectTicks,
  createServeHandler,
  HttpError,
  liveServeState,
  parseSpawnBody,
  readBody,
  readServeState,
  routeRequest,
  serveStatePath,
  writeServeState,
  type AgentsBoard,
  type ServeDeps,
} from './serve.ts'
import { WEBUI_CSP } from './webui.ts'
import { UI_CSP } from './ui-page.ts'

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

const fakeBoard = (): AgentsBoard => ({
  backends: [{ conn: fakeConn, agents: [fakeAgent] }],
  occupancy: { occupied: 1, maxConcurrent: 3 },
  sessions: [{ kind: 'devin', lane: 'sessions', live: 4, max: 6 }],
  discovered: [{ kind: 'devin', pid: 777, name: 'sess-1', worker: true, agentId: 'native-aa11' }],
  degraded: [],
})

const deps = (over: Partial<ServeDeps> = {}): ServeDeps => ({
  snapshot: async () => ({ snap: true }),
  agents: async () => fakeBoard(),
  queue: async () => ({ inProgress: [], ready: [], readyTotal: 0 }),
  ticks: async () => ({ heartbeat: null, drive: { pid: null, alive: false }, watches: [] }),
  mailbox: async () => ({ drops: [] }),
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
    // the dashboard polls every read plane
    for (const p of ['snapshot', 'agents', 'queue', 'ticks', 'mailbox']) {
      assert.match(html, new RegExp(`/api/v1/${p}`), p)
    }

    const post = await route('POST', '/fleet', '{}')
    assert.equal(post.status, 405)
  })

  test('GET /ui serves the catalog dashboard with its CSP; non-GET is 405', async () => {
    const r = await route('GET', '/ui')
    assert.equal(r.status, 200)
    assert.equal(r.contentType, 'text/html; charset=utf-8')
    assert.equal(r.headers?.['content-security-policy'], UI_CSP)
    const html = String(r.body)
    assert.match(html, /<!doctype html>/)
    // the dashboard is index-driven — it fetches the plane catalog,
    // not the bespoke read planes /fleet polls
    assert.match(html, /\/api\/v1\/planes/)
    // read-only: no write surface, verbs render as badges not buttons
    assert.doesNotMatch(html, /method="post"|<form/)

    const post = await route('POST', '/ui', '{}')
    assert.equal(post.status, 405)
  })

  test('GET /api/v1/events/asyncapi.json serves the generated doc', async () => {
    const r = await route('GET', '/api/v1/events/asyncapi.json', undefined, deps({
      asyncApi: () => ({ asyncapi: '3.0.0', channels: {} }),
    }))
    assert.equal(r.status, 200)
    assert.equal((r.body as { asyncapi: string }).asyncapi, '3.0.0')

    // absent dep unwires the route like any unwired plane
    const absent = await route('GET', '/api/v1/events/asyncapi.json')
    assert.equal(absent.status, 404)
    const post = await route('POST', '/api/v1/events/asyncapi.json', '{}', deps({
      asyncApi: () => ({}),
    }))
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

  test('GET /api/v1/agents serializes the full board — backends, occupancy, lanes, discoveries', async () => {
    const r = await route('GET', '/api/v1/agents')
    assert.equal(r.status, 200)
    const body = r.body as AgentsBoard & {
      backends: { name: string; capabilities: { supervisor: string }; agents: AgentInfo[] }[]
    }
    assert.equal(body.backends[0]!.name, 'native')
    assert.equal(body.backends[0]!.capabilities.supervisor, 'none')
    assert.equal(body.backends[0]!.agents[0]!.id, 'native-aa11')
    assert.equal('conn' in body.backends[0]!, false)
    assert.deepEqual(body.occupancy, { occupied: 1, maxConcurrent: 3 })
    assert.equal(body.sessions[0]!.kind, 'devin')
    assert.equal(body.discovered[0]!.name, 'sess-1')
    // a clean board carries no degraded key at all
    assert.equal('degraded' in body, false)
  })

  test('GET /api/v1/agents surfaces discovery-plane failures as degraded notes', async () => {
    const r = await route(
      'GET',
      '/api/v1/agents',
      undefined,
      deps({ agents: async () => ({ ...fakeBoard(), degraded: ['devin: cannot verify sessions'] }) })
    )
    assert.equal(r.status, 200)
    assert.deepEqual((r.body as { degraded: string[] }).degraded, ['devin: cannot verify sessions'])
  })

  test('GET /api/v1/{queue,ticks,mailbox} relay their read planes; non-GET is 405', async () => {
    for (const p of ['queue', 'ticks', 'mailbox'] as const) {
      const r = await route('GET', `/api/v1/${p}`)
      assert.equal(r.status, 200, p)
      assert.equal(await route('POST', `/api/v1/${p}`, '{}').then((x) => x.status), 405, p)
    }
    const queue = (await route('GET', '/api/v1/queue')).body as { inProgress: unknown[] }
    assert.deepEqual(queue.inProgress, [])
    const ticks = (await route('GET', '/api/v1/ticks')).body as { heartbeat: unknown; watches: unknown[] }
    assert.equal(ticks.heartbeat, null)
    assert.deepEqual(ticks.watches, [])
    const mb = (await route('GET', '/api/v1/mailbox')).body as { drops: unknown[] }
    assert.deepEqual(mb.drops, [])
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

describe('serve — /api/v1/planes dispatch', () => {
  const planeDeps = () =>
    deps({
      planeCatalog: () => [
        {
          name: 'test',
          reads: ['tail'],
          verbs: ['poke'],
          capabilities: async () => ({ read: true }),
          list: async () => [],
          get: async (ref: string) => ({ id: ref }),
          read: async (name: string) => ({ read: name }),
          exec: async () => undefined,
        },
      ],
    })

  test('the index, list, read, and get shapes all route through the dep', async () => {
    const d = planeDeps()
    const index = await routeRequest('GET', '/api/v1/planes', undefined, d, {
      dir: '/repo',
      startedAt: 't0',
    })
    assert.equal(index.status, 200)
    const body = index.body as { planes: { name: string }[] }
    assert.deepEqual(
      body.planes.map((p) => p.name),
      ['test']
    )

    for (const p of ['/api/v1/planes/test', '/api/v1/planes/test/tail', '/api/v1/planes/test/ref']) {
      const r = await routeRequest('GET', p, undefined, d, { dir: '/repo', startedAt: 't0' })
      assert.notEqual(r.status, 404, p)
    }
  })

  test('query params reach the plane filter/read args', async () => {
    let seen: unknown
    const d = deps({
      planeCatalog: () => [
        {
          name: 'work',
          reads: [],
          verbs: [],
          capabilities: async () => ({ read: true }),
          list: async (filter?: PlaneFilter) => {
            seen = filter
            return []
          },
          get: async () => undefined,
          read: async () => ({}),
          exec: async () => undefined,
        },
      ],
    })
    await routeRequest(
      'GET',
      '/api/v1/planes/work',
      undefined,
      d,
      { dir: '/repo', startedAt: 't0' },
      {},
      { status: 'open', limit: '2' }
    )
    assert.deepEqual(seen, { status: 'open', limit: 2 })
  })

  test('absent planeCatalog dep → the whole subtree 404s', async () => {
    const r = await route('GET', '/api/v1/planes')
    assert.equal(r.status, 404)
  })
})

describe('parseSpawnBody', () => {
  test('maps a valid body into StepSpawnRequest', () => {
    const req = parseSpawnBody(
      JSON.stringify({ molStep: 'fx-1', worktree: '/w', prompt: 'p', connector: 'native' })
    )
    assert.deepEqual(req, { molStep: 'fx-1', worktree: '/w', prompt: 'p', connector: 'native', promptFile: undefined, beadsDir: undefined, provider: undefined, model: undefined, profile: undefined, class: undefined, autoApprove: undefined })
  })

  test('the provider vocabulary rides the body — strings plus boolean autoApprove', () => {
    const req = parseSpawnBody(
      JSON.stringify({
        molStep: 'fx-1',
        provider: 'kilo',
        model: 'qwen3-coder',
        profile: 'cheap',
        autoApprove: true,
      })
    )
    assert.equal(req.provider, 'kilo')
    assert.equal(req.model, 'qwen3-coder')
    assert.equal(req.profile, 'cheap')
    assert.equal(req.autoApprove, true)
    // a stringified autoApprove is a type error, not a truthy coercion
    assert.throws(
      () => parseSpawnBody(JSON.stringify({ molStep: 'fx-1', autoApprove: 'yes' })),
      /autoApprove.*boolean/
    )
    assert.throws(
      () => parseSpawnBody(JSON.stringify({ molStep: 'fx-1', provider: 3 })),
      /provider.*string/
    )
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
      /non-empty string/
    )
    assert.throws(() => parseSpawnBody('{}'), /molStep/)
  })

  test('empty-string fields are 400 — they would fail only after the 201', () => {
    for (const f of ['model', 'provider', 'profile', 'connector', 'promptFile']) {
      assert.throws(
        () => parseSpawnBody(JSON.stringify({ molStep: 'fx-1', [f]: '' })),
        new RegExp(`${f}.*non-empty`),
        f
      )
    }
  })
})

describe('collectTicks', () => {
  test('empty repo — null heartbeat, no drive lock, no watches', () => {
    const { root, main } = initRepo('bro-ticks-')
    inside(main, root, () => {
      const t = collectTicks(main)
      assert.equal(t.heartbeat, null)
      assert.deepEqual(t.drive, { pid: null, alive: false })
      assert.deepEqual(t.watches, [])
    })
  })

  test('heartbeat + drive lock + watch markers all surface with liveness', () => {
    const { root, main } = initRepo('bro-ticks-')
    inside(main, root, () => {
      const bro = join(main, '.git', 'bro')
      mkdirSync(bro, { recursive: true })
      writeFileSync(join(bro, 'heartbeat.json'), JSON.stringify({ ts: new Date().toISOString(), attention: ['x', 'y'] }))
      writeFileSync(join(bro, 'drive.lock'), `${process.pid}:tok`)
      const wd = join(bro, 'watches')
      mkdirSync(wd, { recursive: true })
      // a live wait marker (<pr>-<pid>.json names the watcher's pid)
      writeFileSync(
        join(wd, `7-${process.pid}-abcd1234.json`),
        JSON.stringify({ pr: 7, link: '[#7](https://x/y/7)', pid: process.pid, merge: true, startedAt: Date.now() - 60_000, timeoutMin: 30 })
      )
      // a dead supervisor heartbeat — kind word where the pid sits
      writeFileSync(
        join(wd, '9-drive-2000000000.json'),
        JSON.stringify({ pr: 9, link: '[#9](https://x/y/9)', pid: 2_000_000_000, merge: false, startedAt: Date.now() - 120_000, timeoutMin: 5 })
      )
      const t = collectTicks(main)
      assert.equal(t.heartbeat?.attention, 2)
      assert.equal(t.drive.pid, process.pid)
      assert.equal(t.drive.alive, true)
      assert.equal(t.watches.length, 2)
      const live = t.watches.find((w) => w.pr === 7)!
      assert.equal(live.alive, true)
      assert.equal(live.kind, 'wait')
      assert.equal(live.merge, true)
      const dead = t.watches.find((w) => w.pr === 9)!
      assert.equal(dead.alive, false)
      assert.equal(dead.kind, 'drive')
    })
  })

  test('a live pid on a heartbeat-dead drive.lock reads not alive — pid reuse is bounded', () => {
    const { root, main } = initRepo('bro-ticks-')
    inside(main, root, () => {
      const bro = join(main, '.git', 'bro')
      mkdirSync(bro, { recursive: true })
      const lock = join(bro, 'drive.lock')
      writeFileSync(lock, `${process.pid}:tok`)
      // older than LOCK_ABANDONED_MS (15m): the contender's steal rule
      // calls this hold stale, so the board must not report it live
      const t0 = new Date(Date.now() - 20 * 60_000)
      utimesSync(lock, t0, t0)
      const t = collectTicks(main)
      assert.equal(t.drive.pid, process.pid)
      assert.equal(t.drive.alive, false)
    })
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
      // an EMPTY token validates yet can never authenticate — torn too
      writeFileSync(serveStatePath(main)!, JSON.stringify({ pid: 1, url: 'u', dir: main, startedAt: 't', token: '' }))
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

  test('the serve lock refuses a live foreign holder and steals a dead one', () => {
    const { root, main } = initRepo('bro-serve-lock-')
    inside(main, root, () => {
      const lock = `${serveStatePath(main)}.lock`
      const release = acquireServeLock(main)
      assert.notEqual(release, undefined)
      // the hold carries the shared filelock's pid:token shape
      assert.equal(lockHolderPid(lock), process.pid)
      // same-process re-acquire is re-entrant under filelock — a no-op
      // release, not a refusal (contention is judged cross-process)
      const again = acquireServeLock(main)
      assert.notEqual(again, undefined)
      again!()
      assert.equal(existsSync(lock), true, 're-entrant release must not drop the outer hold')
      release!()
      assert.equal(existsSync(lock), false)

      // a live foreign holder's lock refuses a second server — a
      // `pid:token` file naming a live pid that is not ours
      writeFileSync(lock, `${process.ppid}:alien`)
      assert.equal(acquireServeLock(main), undefined)
      rmSync(lock)

      // a leftover lock naming a dead pid is stolen, not honored
      writeFileSync(lock, `${1 << 30}`)
      const retaken = acquireServeLock(main)
      assert.notEqual(retaken, undefined)
      assert.equal(lockHolderPid(lock), process.pid)
      retaken!()
      assert.equal(existsSync(lock), false)
    })
  })

  test('a garbage or aged-empty lock is a dead leftover — stolen on sight', () => {
    const { root, main } = initRepo('bro-serve-lock-gone-')
    inside(main, root, () => {
      const lock = `${serveStatePath(main)}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      // an unparsable token can't prove its holder lives — dead on
      // sight, stolen without a wait
      writeFileSync(lock, 'garbage')
      const stolen = acquireServeLock(main)
      assert.notEqual(stolen, undefined)
      assert.equal(lockHolderPid(lock), process.pid)
      stolen!()
      // an EMPTY lock is the wx fallback's mid-publish file: fresh, it
      // reads as a live writer and the 250ms bound refuses it; aged past
      // filelock's fresh-empty grace it's a crashed publish — stolen
      // like any other dead leftover
      writeFileSync(lock, '')
      assert.equal(acquireServeLock(main), undefined)
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      const acquired = acquireServeLock(main)
      assert.notEqual(acquired, undefined)
      assert.equal(lockHolderPid(lock), process.pid)
      acquired!()
    })
  })

  test('a live serve hold is heartbeated — its lock never reads stale', async () => {
    const { root, main } = initRepo('bro-serve-lock-hold-')
    await insideAsync(main, root, async () => {
      const release = acquireServeLock(main, { heartbeatMs: 25 })
      assert.notEqual(release, undefined)
      try {
        const lock = `${serveStatePath(main)}.lock`
        // age the file the way a >15min untouched hold would look to
        // the janitor's sweep and contender steals — the beat must
        // re-stamp it before either judges it
        const past = new Date(Date.now() - 20 * 60_000)
        utimesSync(lock, past, past)
        const aged = statSync(lock).mtimeMs
        await new Promise((r) => setTimeout(r, 100))
        assert.ok(statSync(lock).mtimeMs > aged, 'the heartbeat must refresh the lock mtime')
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release!()
      }
      assert.equal(existsSync(`${serveStatePath(main)}.lock`), false)
    })
  })
})

describe('serve handler over a real socket', () => {
  test('GET /api/v1/agents/<ref>/log — token-gated one-shot tail and SSE follow', async () => {
    const TOKEN = 'test-session-token'
    const auth = { authorization: `Bearer ${TOKEN}` }
    const dir = mkdtempSync(join(tmpdir(), 'bro-serve-log-'))
    const logPath = join(dir, 'agent.log')
    writeFileSync(logPath, 'one\ntwo\nthree\n')
    const logged: AgentInfo = { ...fakeAgent, log: logPath }
    const logDeps = deps({
      find: async (ref) =>
        ref === logged.id
          ? { hit: { conn: fakeConn, agent: logged }, degraded: [] }
          : { degraded: [] },
    })
    const server = createServer(
      createServeHandler(logDeps, { dir: '/repo', startedAt: 't0' }, TOKEN)
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    try {
      const path = `/api/v1/agents/${logged.id}/log`
      // write-grade credential — unauthenticated reads 401
      assert.equal((await fetch(`${base}${path}`)).status, 401)
      assert.equal(
        (await fetch(`${base}${path}?token=nope`)).status,
        401,
        'a wrong ?token= fails closed'
      )

      // one-shot text/plain tail — ?lines=N bounds the replay
      const tail = await fetch(`${base}${path}?lines=2`, { headers: auth })
      assert.equal(tail.status, 200)
      assert.match(tail.headers.get('content-type') ?? '', /text\/plain/)
      assert.equal(await tail.text(), 'two\nthree\n')

      // the ?token= fallback authenticates EventSource-grade clients
      const viaParam = await fetch(`${base}${path}?lines=1&token=${TOKEN}`)
      assert.equal(viaParam.status, 200)
      assert.equal(await viaParam.text(), 'three\n')

      // ?follow — replay lands as data: frames, then live appends
      const follow = await fetch(`${base}${path}?lines=1&follow`, { headers: auth })
      assert.equal(follow.status, 200)
      assert.match(follow.headers.get('content-type') ?? '', /text\/event-stream/)
      const reader = follow.body!.getReader()
      const read = async (): Promise<string> =>
        new TextDecoder().decode((await reader.read()).value)
      assert.match(await read(), /^data: three/)
      writeFileSync(logPath, 'one\ntwo\nthree\nfour\n', 'utf8')
      let appended = ''
      for (let i = 0; i < 20 && !appended.includes('four'); i++) {
        appended += await read()
      }
      assert.match(appended, /data: four/)
      await reader.cancel()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('GET /api/v1/agents/<ref>/log — 404 unknown/missing, 422 remote ref', async () => {
    const TOKEN = 'test-session-token'
    const auth = { authorization: `Bearer ${TOKEN}` }
    const remote: AgentInfo = { ...fakeAgent, id: 'remote-bb22', log: 'https://x.example/s/1' }
    const missing: AgentInfo = { ...fakeAgent, id: 'gone-cc33', log: '/no/such/log' }
    const byRef: Record<string, AgentInfo> = { 'remote-bb22': remote, 'gone-cc33': missing }
    const d = deps({
      find: async (ref) => {
        const agent = byRef[ref]
        return agent === undefined ? { degraded: [] } : { hit: { conn: fakeConn, agent }, degraded: [] }
      },
    })
    const server = createServer(createServeHandler(d, { dir: '/repo', startedAt: 't0' }, TOKEN))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    try {
      const hit = async (ref: string) =>
        fetch(`${base}/api/v1/agents/${ref}/log`, { headers: auth })
      assert.equal((await hit('nobody')).status, 404)
      const rem = await hit('remote-bb22')
      assert.equal(rem.status, 422)
      assert.match((await rem.json() as { error: string }).error, /remote — https:\/\/x\.example/)
      assert.equal((await hit('gone-cc33')).status, 404)
      // non-GET on the log route is a flat 405
      const post = await fetch(`${base}/api/v1/agents/${fakeAgent.id}/log`, {
        method: 'POST',
        headers: auth,
      })
      assert.equal(post.status, 405)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

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

      // a valid write through the auth gate — the 201 proves the token
      // path reaches the facade, not just the validators. The auth
      // scheme itself is case-insensitive (RFC 7235)
      const spawned = await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { ...json, authorization: `bearer ${TOKEN}` },
        body: '{"molStep":"fx-1"}',
      })
      assert.equal(spawned.status, 201)
      const stopped = await fetch(`${base}/api/v1/agents/native-aa11`, {
        method: 'DELETE',
        headers: auth,
      })
      assert.equal(stopped.status, 200)

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

describe('serve — webhook routes', () => {
  const meta = { dir: '/repo', startedAt: 't0' }

  test('POST /api/v1/webhooks/<provider> dispatches headers+body to the handler', async () => {
    let seen: { headers: Record<string, string | string[] | undefined>; rawBody: string } | undefined
    const d = deps({
      webhooks: {
        github: async (req) => {
          seen = req
          return { status: 202, body: { accepted: true } }
        },
      },
    })
    const headers = { 'x-github-event': 'ping', 'content-type': 'application/json' }
    const res = await routeRequest('POST', '/api/v1/webhooks/github', '{"zen":1}', d, meta, headers)
    assert.equal(res.status, 202)
    assert.equal(seen?.rawBody, '{"zen":1}')
    assert.equal(seen?.headers['x-github-event'], 'ping')
  })

  test('a provider with no handler 404s; non-POST is 405', async () => {
    const res = await routeRequest('POST', '/api/v1/webhooks/gitlab', '{}', deps(), meta, {})
    assert.equal(res.status, 404)
    const res2 = await routeRequest(
      'GET',
      '/api/v1/webhooks/github',
      undefined,
      deps({ webhooks: { github: async () => ({ status: 202, body: {} }) } }),
      meta,
      {}
    )
    assert.equal(res2.status, 405)
  })

  test('the webhook path bypasses bearer AND Host guards — the signature is the auth', async () => {
    const TOKEN = 'test-session-token'
    let calls = 0
    const d = deps({
      webhooks: {
        github: async () => {
          calls += 1
          return { status: 401, body: { error: 'bad signature' } }
        },
      },
    })
    const server = createServer(createServeHandler(d, { dir: '/repo', startedAt: 't0' }, TOKEN))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    try {
      // no Authorization header at all — the writeGuard would 401 any
      // other route; the handler's own 401 proves it was REACHED
      const r = await fetch(`${base}/api/v1/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(r.status, 401)
      assert.equal(calls, 1)

      // a foreign Host — the DNS-rebinding shape refused everywhere
      // else — reaches the handler: a hosted tunnel's Host is public
      const rebound = await new Promise<IncomingMessage>((resolve) => {
        const req = request(
          `${base}/api/v1/webhooks/github`,
          {
            method: 'POST',
            headers: { host: 'smee.example.com', 'content-type': 'application/json' },
          },
          resolve
        )
        req.end('{}')
      })
      assert.equal(rebound.statusCode, 401)
      assert.equal(calls, 2)

      // and the same foreign Host on a normal route still 403s
      const guarded = await new Promise<IncomingMessage>((resolve) => {
        const req = request(
          `${base}/api/v1/health`,
          { headers: { host: 'smee.example.com' } },
          resolve
        )
        req.end()
      })
      assert.equal(guarded.statusCode, 403)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

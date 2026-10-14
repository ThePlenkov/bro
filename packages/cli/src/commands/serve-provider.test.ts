import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { providerConfig, providerProxy } from './serve-provider.ts'
import {
  authHeaders as auth,
  listen,
  serveDeps as deps,
  testToken as TOKEN,
} from './serve-testkit.ts'

describe('providerConfig', () => {
  test('unwired without a key; BRO_PROVIDER_API_KEY wins; ANTHROPIC_* fall back', () => {
    assert.equal(providerConfig({}), undefined)
    assert.equal(providerConfig({ BRO_PROVIDER_API_KEY: '   ' }), undefined)
    assert.deepEqual(providerConfig({ BRO_PROVIDER_API_KEY: 'sk-real' }), {
      upstream: 'https://api.anthropic.com',
      apiKey: 'sk-real',
    })
    assert.equal(providerConfig({ ANTHROPIC_API_KEY: 'sk-op' })?.apiKey, 'sk-op')
    assert.equal(providerConfig({ ANTHROPIC_AUTH_TOKEN: 'tok-op' })?.apiKey, 'tok-op')
    // a set-but-blank override starves nothing — the fallback still resolves
    assert.equal(
      providerConfig({ BRO_PROVIDER_API_KEY: '  ', ANTHROPIC_API_KEY: 'sk-fb' })?.apiKey,
      'sk-fb'
    )
    const cfg = providerConfig({
      BRO_PROVIDER_API_KEY: 'k',
      BRO_PROVIDER_UPSTREAM: 'http://127.0.0.1:9000/',
    })
    assert.equal(cfg?.upstream, 'http://127.0.0.1:9000')
  })
})

describe('serve /v1/* provider plane — guards and wiring', () => {
  test('no session token → 401 on every method, GET included', async () => {
    const { url, close } = await listen(
      deps({
        provider: async (_req, res) => {
          res.end('ok')
        },
      })
    )
    try {
      for (const [m, p] of [
        ['POST', '/v1/messages'],
        ['GET', '/v1/models'],
        ['POST', '/v1/messages/count_tokens'],
      ] as const) {
        const r = await fetch(`${url}${p}`, {
          method: m,
          headers: { 'content-type': 'application/json' },
          body: m === 'GET' ? undefined : '{}',
        })
        assert.equal(r.status, 401, `${m} ${p}`)
      }
    } finally {
      await close()
    }
  })

  test('x-api-key carries the credential too — bodiless DELETE is not 415', async () => {
    let reached = 0
    const { url, close } = await listen(
      deps({
        provider: async (_req, res) => {
          reached++
          res.end('ok')
        },
      })
    )
    try {
      const viaXApiKey = await fetch(`${url}/v1/models`, {
        headers: { 'x-api-key': TOKEN },
      })
      assert.equal(viaXApiKey.status, 200)
      // a DELETE with no body owes no content-type — the guard must not
      // demand application/json on a bodiless request
      const viaDelete = await fetch(`${url}/v1/messages/msg_1`, {
        method: 'DELETE',
        headers: auth,
      })
      assert.equal(viaDelete.status, 200)
      assert.equal(reached, 2)
    } finally {
      await close()
    }
  })

  test('unwired dep → 404; wired dep owns the raw stream — body >256KB passes', async () => {
    const miss = await listen(deps())
    try {
      const r = await fetch(`${miss.url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(r.status, 404)
      assert.match(await r.text(), /provider not wired/)
    } finally {
      await miss.close()
    }

    let seenBytes = 0
    let seenHeaders: IncomingMessage['headers'] = {}
    const { url, close } = await listen(
      deps({
        provider: async (req, res) => {
          seenHeaders = req.headers
          for await (const chunk of req) {
            seenBytes += (chunk as Buffer).length
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"id":"msg_1"}')
        },
      })
    )
    try {
      const big = 'x'.repeat(512 * 1024)
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', 'x-custom': 'rides' },
        body: `{"blob":"${big}"}`,
      })
      assert.equal(r.status, 200)
      assert.deepEqual(await r.json(), { id: 'msg_1' })
      assert.ok(seenBytes > 512 * 1024, `streamed body reached the dep — ${seenBytes}B`)
      assert.equal(seenHeaders['x-custom'], 'rides')
    } finally {
      await close()
    }
  })
})

describe('providerProxy — byte proxy to the upstream', () => {
  async function fakeUpstream(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer(handler)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    }
  }

  test('swaps credentials, preserves path+query and headers, pipes the body', async () => {
    let gotHeaders: IncomingMessage['headers'] = {}
    let gotUrl = ''
    let gotBody = ''
    const up = await fakeUpstream((req, res) => {
      gotHeaders = req.headers
      gotUrl = req.url ?? ''
      req.on('data', (c) => (gotBody += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'seen' })
        res.end('{"ok":true}')
      })
    })
    const serve = await listen(
      deps({ provider: providerProxy({ upstream: up.url, apiKey: 'sk-real' }) })
    )
    try {
      const r = await fetch(`${serve.url}/v1/messages?x=1`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          'x-api-key': 'client-fake',
          'anthropic-version': '2023-06-01',
        },
        body: '{"messages":[{"role":"user","content":"hi"}]}',
      })
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('x-upstream'), 'seen')
      assert.deepEqual(await r.json(), { ok: true })
      assert.equal(gotUrl, '/v1/messages?x=1')
      assert.equal(gotHeaders['x-api-key'], 'sk-real')
      assert.equal(gotHeaders.authorization, 'Bearer sk-real')
      assert.equal(gotHeaders['anthropic-version'], '2023-06-01')
      assert.match(gotBody, /"content":"hi"/)
    } finally {
      await serve.close()
      await up.close()
    }
  })

  test('SSE frames stream through verbatim', async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(events[0])
      setTimeout(() => {
        res.write(events[1])
        setTimeout(() => {
          res.write(events[2])
          res.end()
        }, 10)
      }, 10)
    })
    const serve = await listen(
      deps({ provider: providerProxy({ upstream: up.url, apiKey: 'k' }) })
    )
    try {
      const r = await fetch(`${serve.url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{"stream":true}',
      })
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-type'), 'text/event-stream')
      assert.equal(await r.text(), events.join(''))
    } finally {
      await serve.close()
      await up.close()
    }
  })

  test('redirect is not followed — the swapped key never crosses origins', async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/evil' })
      res.end()
    })
    const serve = await listen(
      deps({ provider: providerProxy({ upstream: up.url, apiKey: 'k' }) })
    )
    try {
      const r = await fetch(`${serve.url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
        redirect: 'manual',
      })
      assert.equal(r.status, 302)
      assert.equal(r.headers.get('location'), 'http://127.0.0.1:1/evil')
    } finally {
      await serve.close()
      await up.close()
    }
  })

  test('a client disconnect aborts the upstream request', async () => {
    let upstreamClosed = false
    const up = await fakeUpstream((req, res) => {
      req.on('close', () => {
        upstreamClosed = true
      })
      // never answers — the only way out is the client's abort
      res.on('close', () => {
        upstreamClosed = true
      })
      void res
    })
    const serve = await listen(
      deps({ provider: providerProxy({ upstream: up.url, apiKey: 'k' }) })
    )
    try {
      const controller = new AbortController()
      const pending = fetch(`${serve.url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }).catch(() => 'aborted')
      // let the request land upstream, then cut the client
      await new Promise((r) => setTimeout(r, 60))
      controller.abort()
      assert.equal(await pending, 'aborted')
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(upstreamClosed, true, 'client close must propagate upstream')
    } finally {
      await serve.close()
      await up.close()
    }
  })

  test('unreachable upstream → 502 anthropic-shaped error', async () => {
    const serve = await listen(
      deps({ provider: providerProxy({ upstream: 'http://127.0.0.1:1', apiKey: 'k' }) })
    )
    try {
      const r = await fetch(`${serve.url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(r.status, 502)
      const body = (await r.json()) as { type: string; error: { type: string } }
      assert.equal(body.type, 'error')
      assert.equal(body.error.type, 'api_error')
    } finally {
      await serve.close()
    }
  })
})

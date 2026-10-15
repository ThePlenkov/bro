import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deliverSinks,
  registerSinkBuilder,
  renderEventText,
  requestFor,
  sinkMatches,
  sinkSecrets,
  sinkStatePath,
  unregisterSinkBuilder,
  withSinks,
  type FetchFn,
} from './sinks.ts'
import { notifySection } from './config.ts'
import type { EventInput, EventPublishResult, EventsFacade } from './events.ts'

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const withRepo = (fn: (dir: string) => void): void => {
  const dir = tmp('bro-sinks-')
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const withRepoAsync = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = tmp('bro-sinks-')
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const EVENT: EventInput = {
  topic: 'convoy',
  kind: 'gate',
  key: 'convoy-gate-mol-1',
  source: 'convoy',
  payload: 'convoy mol-1: HUMAN GATE ready — human input needed',
}

interface FetchCall {
  url: string
  body: unknown
}

const fakeFetch = (
  impl?: (url: string) => { status: number } | Promise<never>
): { fetch: FetchFn; calls: FetchCall[] } => {
  const calls: FetchCall[] = []
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), body: JSON.parse((init as { body: string }).body) })
    const res = impl !== undefined ? await impl(String(url)) : { status: 200 }
    return { status: res.status, text: async () => '' } as Response
  }) as FetchFn
  return { fetch, calls }
}

describe('sinkMatches', () => {
  const ev = { topic: 'drive', kind: 'alert' }

  test('no events list matches everything', () => {
    assert.equal(sinkMatches({ type: 'slack' }, ev), true)
    assert.equal(sinkMatches({ type: 'slack', events: [] }, ev), true)
  })

  test('topic-only patterns match any kind', () => {
    assert.equal(sinkMatches({ type: 'slack', events: ['drive'] }, ev), true)
    assert.equal(sinkMatches({ type: 'slack', events: ['act'] }, ev), false)
  })

  test('topic:kind pins both halves', () => {
    assert.equal(sinkMatches({ type: 'slack', events: ['drive:alert'] }, ev), true)
    assert.equal(sinkMatches({ type: 'slack', events: ['drive:merge'] }, ev), false)
    assert.equal(sinkMatches({ type: 'slack', events: ['act:alert'] }, ev), false)
  })

  test('globs work in either half', () => {
    assert.equal(sinkMatches({ type: 'slack', events: ['dr*'] }, ev), true)
    assert.equal(sinkMatches({ type: 'slack', events: ['drive:*'] }, ev), true)
    assert.equal(sinkMatches({ type: 'slack', events: ['*'] }, ev), true)
    assert.equal(sinkMatches({ type: 'slack', events: ['act:*'] }, ev), false)
  })
})

describe('renderEventText', () => {
  test('string payload is the message', () => {
    const t = renderEventText(EVENT)
    assert.match(t, /^\[convoy\/gate\] convoy mol-1: HUMAN GATE ready/)
  })

  test('non-string payloads summarize as bounded JSON', () => {
    const t = renderEventText({ topic: 'act', kind: 'result', payload: { pr: 1 } })
    assert.equal(t, '[act/result] {"pr":1}')
  })

  test('no payload falls back to ref, then topic', () => {
    assert.equal(
      renderEventText({ topic: 'wtf', kind: 'note', ref: 'bro-123' }),
      '[wtf/note] bro-123'
    )
    assert.equal(renderEventText({ topic: 'wtf', kind: 'note' }), '[wtf/note] wtf')
  })

  test('newlines collapse to one line', () => {
    const t = renderEventText({ topic: 'a', kind: 'b', payload: 'x\ny\nz' })
    assert.equal(t, '[a/b] x y z')
  })
})

describe('requestFor', () => {
  const env = {
    SLACK_URL: 'https://hooks.slack.test/x',
  } as unknown as NodeJS.ProcessEnv

  test('slack posts {text} to the env-resolved url', () => {
    const r = requestFor({ type: 'slack', urlEnv: 'SLACK_URL' }, EVENT, env)
    assert.deepEqual(r, {
      url: 'https://hooks.slack.test/x',
      body: { text: renderEventText(EVENT) },
    })
  })

  test('unset env reports the var name, never a value', () => {
    const r = requestFor({ type: 'slack', urlEnv: 'MISSING_VAR' }, EVENT, {})
    assert.deepEqual(r, { missing: 'MISSING_VAR' })
  })

  test('literal url is the fallback for non-secret hooks', () => {
    const r = requestFor({ type: 'webhook', url: 'https://h.test/x' }, EVENT, env)
    assert.equal('url' in r && r.url, 'https://h.test/x')
    const body = 'body' in r && (r.body as Record<string, unknown>)
    assert.equal(body && body.topic, 'convoy')
    assert.equal(body && body.kind, 'gate')
  })

  test('urlEnv wins over a literal url', () => {
    const r = requestFor(
      { type: 'webhook', url: 'https://literal.test', urlEnv: 'SLACK_URL' },
      EVENT,
      env
    )
    assert.equal('url' in r && r.url, 'https://hooks.slack.test/x')
  })

  test('a named urlEnv is authoritative — unset env reports missing, no literal fallback', () => {
    const r = requestFor(
      { type: 'webhook', url: 'https://literal.test', urlEnv: 'NOPE_VAR' },
      EVENT,
      env
    )
    assert.deepEqual(r, { missing: 'NOPE_VAR' })
  })

  test('a registered builder owns its type — the plugin-layer dispatch (bro-mq1t2)', () => {
    registerSinkBuilder('webhook', () => ({ refused: 'plugin refused' }))
    try {
      assert.deepEqual(requestFor({ type: 'webhook', url: 'https://h.test/x' }, EVENT, env), {
        refused: 'plugin refused',
      })
      // other types keep the generic path
      assert.equal(
        'url' in requestFor({ type: 'slack', urlEnv: 'SLACK_URL' }, EVENT, env),
        true
      )
    } finally {
      unregisterSinkBuilder('webhook')
    }
    // the generic path is restored once the builder unregisters
    assert.equal(
      'url' in requestFor({ type: 'webhook', url: 'https://h.test/x' }, EVENT, env),
      true
    )
  })

  test('a throwing builder is a refused row — requestFor never throws', () => {
    registerSinkBuilder('webhook', () => {
      throw new Error('builder boom')
    })
    try {
      assert.deepEqual(requestFor({ type: 'webhook', url: 'https://h.test/x' }, EVENT, env), {
        refused: "builder for 'webhook' threw",
      })
    } finally {
      unregisterSinkBuilder('webhook')
    }
  })

  test('an unregistered non-generic type reports unwired, not missing url', () => {
    // telegram's builder lives in the cli layer — a bare core consumer
    // gets an honest refusal, not "env url not set"
    assert.deepEqual(
      requestFor({ type: 'telegram', tokenEnv: 'T', chatId: '1' }, EVENT, env),
      { refused: "no request builder registered for sink type 'telegram'" }
    )
  })

  test('an env-resolved http endpoint is refused — the URL is a declared secret', () => {
    const e = { HOOK: 'http://insecure.internal/hook' } as unknown as NodeJS.ProcessEnv
    assert.deepEqual(requestFor({ type: 'slack', urlEnv: 'HOOK' }, EVENT, e), {
      refused: 'env HOOK must resolve to an https:// endpoint',
    })
    assert.deepEqual(requestFor({ type: 'webhook', urlEnv: 'HOOK' }, EVENT, e), {
      refused: 'env HOOK must resolve to an https:// endpoint',
    })
  })

  test('a literal http url still resolves — the documented non-secret path', () => {
    const r = requestFor({ type: 'webhook', url: 'http://ci.internal/x' }, EVENT, env)
    assert.equal('url' in r && r.url, 'http://ci.internal/x')
  })

})

describe('deliverSinks', () => {
  test('all:true delivers past route patterns — the explicit test probe', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'https://h.test/a' } as unknown as NodeJS.ProcessEnv
      const results = await deliverSinks(dir, EVENT, {
        fetch,
        env,
        all: true,
        sinks: [{ type: 'webhook', urlEnv: 'H', events: ['act:*'] }],
      })
      assert.equal(results.length, 1)
      assert.equal(results[0].delivered, true)
      assert.equal(calls.length, 1)
    })
  })

  test('delivers to matched sinks, skips unmatched', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { HOOK: 'https://h.test/a' } as unknown as NodeJS.ProcessEnv
      const results = await deliverSinks(dir, EVENT, {
        fetch,
        env,
        sinks: [
          { type: 'webhook', urlEnv: 'HOOK' },
          { type: 'webhook', urlEnv: 'HOOK', events: ['act:*'] },
        ],
      })
      assert.equal(results.length, 1)
      assert.equal(results[0].delivered, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://h.test/a')
    })
  })

  test('missing env reports the var and posts nothing', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const results = await deliverSinks(dir, EVENT, {
        fetch,
        env: {},
        sinks: [{ type: 'slack', urlEnv: 'MISSING' }],
      })
      assert.equal(results[0].delivered, false)
      assert.equal(results[0].reason, 'env MISSING not set')
      assert.equal(calls.length, 0)
    })
  })

  test('HTTP >=400 is a result row, not a throw', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch } = fakeFetch(() => ({ status: 500 }))
      const results = await deliverSinks(dir, EVENT, {
        fetch,
        env: { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv,
        sinks: [{ type: 'webhook', urlEnv: 'H' }],
      })
      assert.equal(results[0].delivered, false)
      assert.equal(results[0].reason, 'HTTP 500')
      assert.equal(results[0].status, 500)
    })
  })

  test('a throwing fetch is a result row — never throws', async () => {
    await withRepoAsync(async (dir) => {
      const boom = (() => {
        throw new Error('conn refused')
      }) as unknown as FetchFn
      const results = await deliverSinks(dir, EVENT, {
        fetch: boom,
        env: { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv,
        sinks: [{ type: 'webhook', urlEnv: 'H' }],
      })
      assert.equal(results[0].delivered, false)
      assert.equal(results[0].reason, 'conn refused')
    })
  })

  test('delivery requests redirect:manual — the secret URL never re-POSTs elsewhere', async () => {
    await withRepoAsync(async (dir) => {
      let redirectSeen: string | undefined
      const fetch = (async (_url: unknown, init: unknown) => {
        redirectSeen = (init as { redirect?: string }).redirect
        return { status: 200, text: async () => '' } as Response
      }) as FetchFn
      await deliverSinks(dir, EVENT, {
        fetch,
        env: { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv,
        sinks: [{ type: 'webhook', urlEnv: 'H' }],
      })
      assert.equal(redirectSeen, 'manual')
    })
  })

  test('a 3xx is a failed delivery, not a follow', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch(() => ({ status: 302 }))
      const results = await deliverSinks(dir, EVENT, {
        fetch,
        env: { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv,
        sinks: [{ type: 'webhook', urlEnv: 'H' }],
      })
      assert.equal(results[0].delivered, false)
      assert.equal(results[0].reason, 'HTTP 302')
      assert.equal(calls.length, 1)
    })
  })

  test('a fetch error scrubs the endpoint from the reason', async () => {
    await withRepoAsync(async (dir) => {
      const boom = (() => {
        throw new TypeError('fetch failed: https://secret.test/hook refused')
      }) as unknown as FetchFn
      const results = await deliverSinks(dir, EVENT, {
        fetch: boom,
        env: { H: 'https://secret.test/hook' } as unknown as NodeJS.ProcessEnv,
        sinks: [{ type: 'webhook', urlEnv: 'H' }],
      })
      assert.equal(results[0].delivered, false)
      assert.equal(results[0].reason, 'fetch failed: <endpoint> refused')
    })
  })

  test('an identical event inside minInterval is deduped', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv
      const sinks = [{ type: 'webhook' as const, urlEnv: 'H' }]
      const t0 = 1_700_000_000_000
      const first = await deliverSinks(dir, EVENT, { fetch, env, sinks, now: t0 })
      assert.equal(first[0].delivered, true)
      const second = await deliverSinks(dir, EVENT, {
        fetch,
        env,
        sinks,
        now: t0 + 60_000,
      })
      assert.equal(second[0].delivered, false)
      assert.equal(second[0].reason, 'deduped')
      assert.equal(calls.length, 1)
    })
  })

  test('a changed payload is a different event and resends', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv
      const sinks = [{ type: 'webhook' as const, urlEnv: 'H' }]
      const t0 = 1_700_000_000_000
      await deliverSinks(dir, EVENT, { fetch, env, sinks, now: t0 })
      const changed = { ...EVENT, payload: 'convoy mol-1: HUMAN GATE ready — gate-2' }
      const res = await deliverSinks(dir, changed, { fetch, env, sinks, now: t0 + 1 })
      assert.equal(res[0].delivered, true)
      assert.equal(calls.length, 2)
    })
  })

  test('payloads that render identically are still different events', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv
      const sinks = [{ type: 'webhook' as const, urlEnv: 'H' }]
      const t0 = 1_700_000_000_000
      await deliverSinks(dir, { ...EVENT, payload: 'a b' }, { fetch, env, sinks, now: t0 })
      // 'a\tb' renders to the same '[convoy/gate] a b' — but the webhook
      // body carries the raw payload, so suppression would drop an event
      const res = await deliverSinks(
        dir,
        { ...EVENT, payload: 'a\tb' },
        { fetch, env, sinks, now: t0 + 1 }
      )
      assert.equal(res[0].delivered, true)
      assert.equal(calls.length, 2)
    })
  })

  test('a dedup record outlives the 7d sweep when minIntervalMs is longer', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv
      const sinks = [
        { type: 'webhook' as const, urlEnv: 'H', minIntervalMs: 30 * 24 * 60 * 60 * 1000 },
      ]
      const t0 = 1_700_000_000_000
      const day8 = 8 * 24 * 60 * 60 * 1000
      await deliverSinks(dir, EVENT, { fetch, env, sinks, now: t0 })
      // an unrelated successful send past the TTL must not prune the
      // first record — its 30d resend floor is still running
      await deliverSinks(dir, { ...EVENT, payload: 'unrelated' }, {
        fetch,
        env,
        sinks,
        now: t0 + day8,
      })
      const res = await deliverSinks(dir, EVENT, { fetch, env, sinks, now: t0 + day8 + 1 })
      assert.equal(res[0].delivered, false)
      assert.equal(res[0].reason, 'deduped')
      assert.equal(calls.length, 2)
    })
  })

  test('a refused endpoint is a result row and posts nothing', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'http://cleartext.internal/hook' } as unknown as NodeJS.ProcessEnv
      const results = await deliverSinks(dir, EVENT, {
        fetch,
        env,
        sinks: [{ type: 'webhook', urlEnv: 'H' }],
      })
      assert.equal(results[0].delivered, false)
      assert.equal(results[0].reason, 'env H must resolve to an https:// endpoint')
      assert.equal(calls.length, 0)
    })
  })

  test('minIntervalMs: 0 disables dedup', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const env = { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv
      const sinks = [{ type: 'webhook' as const, urlEnv: 'H', minIntervalMs: 0 }]
      const t0 = 1_700_000_000_000
      await deliverSinks(dir, EVENT, { fetch, env, sinks, now: t0 })
      const res = await deliverSinks(dir, EVENT, { fetch, env, sinks, now: t0 + 1 })
      assert.equal(res[0].delivered, true)
      assert.equal(calls.length, 2)
    })
  })

  test('the state file persists the dedup ledger', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch } = fakeFetch()
      const env = { H: 'https://h.test' } as unknown as NodeJS.ProcessEnv
      const sinks = [{ type: 'webhook' as const, urlEnv: 'H' }]
      await deliverSinks(dir, EVENT, { fetch, env, sinks, now: 1_700_000_000_000 })
      const path = sinkStatePath(dir)
      assert.ok(existsSync(path))
      const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
      assert.equal(Object.keys(state).length, 1)
    })
  })
})

describe('withSinks', () => {
  const base: EventsFacade = {
    publish: async (): Promise<EventPublishResult> => ({ published: true }),
    subscribe: async () => ({ close: () => {} }),
    probe: async () => ({ events: [], gapped: false }),
  }

  test('fans out to sinks on publish', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      // inject through DeliverOpts? — withSinks uses the global fetch path
      // via deliverSinks; stub globalThis.fetch for the wrapper test
      const prev = globalThis.fetch
      globalThis.fetch = fetch as unknown as typeof fetch
      const prevEnv = process.env.SINK_H
      process.env.SINK_H = 'https://h.test/x'
      try {
        // write a config the sink resolves from
        const cfg = join(dir, 'bro.config.json')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(
          cfg,
          JSON.stringify({
            notify: { sinks: [{ type: 'webhook', urlEnv: 'SINK_H', minIntervalMs: 0 }] },
          })
        )
        const wrapped = withSinks(dir, base)
        const res = await wrapped.publish(EVENT)
        assert.equal(res.published, true)
        assert.equal(calls.length, 1)
        assert.equal((calls[0].body as Record<string, unknown>).topic, 'convoy')
      } finally {
        globalThis.fetch = prev
        if (prevEnv === undefined) {
          delete process.env.SINK_H
        } else {
          process.env.SINK_H = prevEnv
        }
      }
    })
  })

  test('invalid event input never reaches a sink', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const prev = globalThis.fetch
      globalThis.fetch = fetch as unknown as typeof fetch
      try {
        const wrapped = withSinks(dir, base)
        // topic:'' fails isEventInput — the transport reports, sinks stay silent
        await wrapped.publish({ topic: '', kind: 'x' } as EventInput)
        assert.equal(calls.length, 0)
      } finally {
        globalThis.fetch = prev
      }
    })
  })

  test('a transport rejection does not cancel delivery', async () => {
    await withRepoAsync(async (dir) => {
      const { fetch, calls } = fakeFetch()
      const prev = globalThis.fetch
      globalThis.fetch = fetch as unknown as typeof fetch
      const prevEnv = process.env.SINK_H2
      process.env.SINK_H2 = 'https://h.test/y'
      try {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(
          join(dir, 'bro.config.json'),
          JSON.stringify({
            notify: { sinks: [{ type: 'webhook', urlEnv: 'SINK_H2', minIntervalMs: 0 }] },
          })
        )
        const rejecting: EventsFacade = {
          ...base,
          publish: async (): Promise<EventPublishResult> => {
            throw new Error('broker exploded')
          },
        }
        const wrapped = withSinks(dir, rejecting)
        await assert.rejects(() => wrapped.publish(EVENT))
        assert.equal(calls.length, 1)
      } finally {
        globalThis.fetch = prev
        if (prevEnv === undefined) {
          delete process.env.SINK_H2
        } else {
          process.env.SINK_H2 = prevEnv
        }
      }
    })
  })
})

describe('notifySection', () => {
  test('absent section yields no sinks', () => {
    assert.deepEqual(notifySection(undefined), { sinks: [] })
    assert.deepEqual(notifySection({}), { sinks: [] })
    assert.deepEqual(notifySection({ sinks: 'nope' }), { sinks: [] })
  })

  test('valid entries survive with normalized fields', () => {
    const { sinks } = notifySection({
      sinks: [
        {
          type: 'slack',
          urlEnv: 'HOOK',
          events: ['act:*', 'convoy'],
          timeoutMs: 3000,
          minIntervalMs: 0,
        },
      ],
    })
    assert.equal(sinks.length, 1)
    assert.equal(sinks[0].type, 'slack')
    assert.equal(sinks[0].urlEnv, 'HOOK')
    assert.deepEqual(sinks[0].events, ['act:*', 'convoy'])
    assert.equal(sinks[0].timeoutMs, 3000)
    assert.equal(sinks[0].minIntervalMs, 0)
  })

  test('bad type and dead-endpoint entries drop', () => {
    const { sinks } = notifySection({
      sinks: [
        { type: 'pigeon', urlEnv: 'H' },
        { type: 'slack' }, // no url and no urlEnv — structurally dead
        { type: 'telegram', tokenEnv: 'T' }, // no chatId at all — dead
        { type: 'webhook', url: 'https://h.test' },
        'not-an-object',
      ],
    })
    assert.equal(sinks.length, 1)
    assert.equal(sinks[0].type, 'webhook')
  })

  test('non-string events entries are filtered out', () => {
    const { sinks } = notifySection({
      sinks: [{ type: 'webhook', url: 'https://h.test', events: ['act', 7, null, ''] }],
    })
    assert.deepEqual(sinks[0].events, ['act'])
  })

  test('a route list that parses to nothing fails closed — the sink drops', () => {
    const { sinks } = notifySection({
      sinks: [
        { type: 'webhook', url: 'https://h.test', events: [7, null, ''] },
        { type: 'webhook', url: 'https://h.test', events: 'convoy' },
        { type: 'webhook', url: 'https://h.test', events: [] },
        { type: 'webhook', url: 'https://h.test' },
      ],
    })
    assert.equal(sinks.length, 2)
    assert.equal(sinks[0].events, undefined)
    assert.equal(sinks[1].events, undefined)
  })
})

describe('sinkSecrets', () => {
  test('lists only the configured env names', () => {
    assert.deepEqual(sinkSecrets({ type: 'slack', urlEnv: 'A' }), ['A'])
    assert.deepEqual(
      sinkSecrets({ type: 'telegram', tokenEnv: 'T', chatIdEnv: 'C' }),
      ['T', 'C']
    )
    assert.deepEqual(sinkSecrets({ type: 'webhook', url: 'https://x' }), [])
  })
})

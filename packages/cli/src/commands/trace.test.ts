/** Unit tests for the OTLP exporter — span mapping, cursor, endpoint
 *  resolution, and the hook-side spawn throttle. Repo-level cases ride
 *  the shared git fixture; the POST is a stubbed global fetch. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo } from './testrepo.ts'
import {
  exportTraces,
  journalSpans,
  lineToSpan,
  maybeSpawnTraceFlush,
  parseJournalLine,
  spansPayload,
  type ExportResult,
} from './trace.ts'
import {
  DEFAULT_OTLP_FLUSH_MS,
  parseOtlpHeaders,
  resolveOtlp,
  telemetrySection,
  tracesUrl,
} from './trace-config.ts'

const traceDir = (main: string): string => join(main, '.git', 'bro', 'hooks', 'trace')

function journal(main: string, session: string, lines: object[]): void {
  const dir = traceDir(main)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${session}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

/** Stub global fetch — records bodies, answers what the test dictates. */
function stubFetch(respond: (body: string) => { ok: boolean; status?: number }): {
  calls: string[]
  restore: () => void
} {
  const calls: string[] = []
  const prev = globalThis.fetch
  globalThis.fetch = ((_: unknown, init?: { body?: unknown }) => {
    calls.push(String(init?.body ?? ''))
    const r = respond(String(init?.body ?? ''))
    return Promise.resolve({ ok: r.ok, status: r.status ?? (r.ok ? 200 : 500) } as Response)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = prev
    },
  }
}

const otlp = { endpoint: 'http://collector:4318', headers: {}, serviceName: 'bro', flushMs: 60_000, timeoutMs: 5_000 }

describe('telemetry section + otlp resolution', () => {
  test('defaults — off, bro service, sane budgets', () => {
    const c = telemetrySection(undefined)
    assert.equal(c.otlp.endpoint, '')
    assert.equal(c.otlp.serviceName, 'bro')
    assert.equal(c.otlp.flushMs, DEFAULT_OTLP_FLUSH_MS)
    assert.deepEqual(c.otlp.headers, {})
  })

  test('env beats config; traces-endpoint beats the generic one', () => {
    const cfg = telemetrySection({
      otlp: { endpoint: 'http://conf:4318', headers: { a: '1' }, serviceName: 'svc' },
    }).otlp
    const r = resolveOtlp(cfg, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'b=2, bad, =x, c=3',
    })
    assert.equal(r.endpoint, 'http://traces:4318/v1/traces')
    assert.equal(r.signalUrl, true)
    assert.deepEqual(r.headers, { a: '1', b: '2', c: '3' })
    assert.equal(r.serviceName, 'svc')
    // base sources stay appendable — only the per-signal env pins verbatim
    assert.equal(
      resolveOtlp(cfg, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic:4318' }).signalUrl,
      false
    )
    assert.equal(resolveOtlp(cfg, {}).signalUrl, false)
  })

  test('a blank env value falls through to config, not to empty', () => {
    const cfg = telemetrySection({ otlp: { endpoint: 'http://conf:4318' } }).otlp
    assert.equal(resolveOtlp(cfg, { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }).endpoint, 'http://conf:4318')
    assert.equal(
      resolveOtlp(cfg, {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic:4318',
      }).endpoint,
      'http://generic:4318'
    )
  })

  test('BRO_TELEMETRY=0 blanks the endpoint entirely', () => {
    const cfg = telemetrySection({ otlp: { endpoint: 'http://c:4318' } }).otlp
    assert.equal(resolveOtlp(cfg, { BRO_TELEMETRY: '0' }).endpoint, '')
  })

  test('headers parse skips malformed members', () => {
    assert.deepEqual(parseOtlpHeaders(' a=1,b=2 , , nope, =v'), { a: '1', b: '2' })
    assert.deepEqual(parseOtlpHeaders(undefined), {})
  })

  test('tracesUrl appends only when the signal path is absent', () => {
    assert.equal(tracesUrl('http://h:4318'), 'http://h:4318/v1/traces')
    assert.equal(tracesUrl('http://h:4318/'), 'http://h:4318/v1/traces')
    assert.equal(tracesUrl('https://langfuse/api/public/otel/v1/traces'), 'https://langfuse/api/public/otel/v1/traces')
    // a per-signal env endpoint is complete — verbatim, no append
    assert.equal(tracesUrl('http://gw/custom/traces', true), 'http://gw/custom/traces')
  })
})

describe('span mapping', () => {
  test('a tool line becomes a bro.<tool> span with journal attrs', () => {
    const s = lineToSpan('s1', { ts: 1000, tool: 'exec', command: 'git status', ok: true, bead: 'b-1' }, 1500)
    assert.ok(s !== null)
    assert.equal(s.name, 'bro.exec')
    assert.equal(s.startTimeUnixNano, '1000000000')
    assert.equal(s.endTimeUnixNano, '1500000000')
    assert.equal(s.status, undefined)
    const attrs = Object.fromEntries(s.attributes.map((a) => [a.key, a.value]))
    assert.deepEqual(attrs['bro.session'], { stringValue: 's1' })
    assert.deepEqual(attrs['bro.command'], { stringValue: 'git status' })
    assert.deepEqual(attrs['bro.bead'], { stringValue: 'b-1' })
    assert.deepEqual(attrs['bro.tool'], { stringValue: 'exec' })
  })

  test('ok:false sets ERROR status; paths land as an array attribute', () => {
    const s = lineToSpan('s', { ts: 5, tool: 'edit', paths: ['a.ts', 'b.ts'], ok: false }, undefined)
    assert.ok(s !== null)
    assert.deepEqual(s.status, { code: 2 })
    // last entry in a journal — zero duration, not a missing end
    assert.equal(s.endTimeUnixNano, s.startTimeUnixNano)
    const paths = s.attributes.find((a) => a.key === 'bro.paths')
    assert.deepEqual(paths?.value, {
      arrayValue: { values: [{ stringValue: 'a.ts' }, { stringValue: 'b.ts' }] },
    })
  })

  test('numeric extras become int/double bro.* attrs — token fields pass through', () => {
    const s = lineToSpan('s', { ts: 1, tool: 't', tokens_in: 42, cost_usd: 0.5 }, undefined)
    const attrs = Object.fromEntries(s!.attributes.map((a) => [a.key, a.value]))
    assert.deepEqual(attrs['bro.tokens_in'], { intValue: 42 })
    assert.deepEqual(attrs['bro.cost_usd'], { doubleValue: 0.5 })
  })

  test('missing ts yields no span; objects never serialize', () => {
    assert.equal(lineToSpan('s', { tool: 'x' }, undefined), null)
    const s = lineToSpan('s', { ts: 1, meta: { deep: true }, tool: 'x' }, undefined)
    assert.equal(s!.attributes.some((a) => a.key === 'bro.meta'), false)
  })

  test('journalSpans chains durations and skips torn lines', () => {
    const spans = journalSpans('s', [
      JSON.stringify({ ts: 10, tool: 'read' }),
      '{"ts":',
      JSON.stringify({ ts: 20, tool: 'exec', command: 'x' }),
      JSON.stringify({ ts: 30, tool: 'read' }),
    ])
    assert.equal(spans.length, 3)
    assert.equal(spans[0]!.endTimeUnixNano, '20000000')
    assert.equal(spans[1]!.endTimeUnixNano, '30000000')
    assert.equal(spans[2]!.endTimeUnixNano, '30000000')
    // same trace, distinct content-keyed span ids
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1)
    assert.equal(new Set(spans.map((s) => s.spanId)).size, 3)
  })

  test('payload wraps spans with service + repo resource attrs', () => {
    const spans = journalSpans('s1', [JSON.stringify({ ts: 1, tool: 'x' })])
    const p = spansPayload(spans, 'myrepo', otlp) as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }>
    }
    const attrs = Object.fromEntries(
      p.resourceSpans[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue])
    )
    assert.equal(attrs['service.name'], 'bro')
    assert.equal(attrs['bro.repo'], 'myrepo')
  })
})

describe('exportTraces', () => {
  test('posts new lines once — the cursor blocks a resend', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      journal(main, 's1', [
        { ts: 1000, tool: 'exec', command: 'ls', ok: true },
        { ts: 1100, tool: 'read', paths: ['a.ts'] },
      ])
      const stub = stubFetch(() => ({ ok: true }))
      try {
        const r1 = await exportTraces({ dir: main, otlp })
        assert.equal(r1?.posted, true)
        assert.equal(r1?.spans, 2)
        assert.equal(stub.calls.length, 1)
        const body = JSON.parse(stub.calls[0]!) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>
        }
        assert.equal(body.resourceSpans[0]!.scopeSpans[0]!.spans.length, 2)

        const r2 = await exportTraces({ dir: main, otlp })
        assert.equal(r2?.spans, 0)
        assert.equal(stub.calls.length, 1)
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('only the delta ships on the second flush', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      journal(main, 's1', [{ ts: 1, tool: 'a' }])
      const stub = stubFetch(() => ({ ok: true }))
      try {
        await exportTraces({ dir: main, otlp })
        journal(main, 's1', [{ ts: 1, tool: 'a' }, { ts: 2, tool: 'b' }])
        const r = await exportTraces({ dir: main, otlp })
        assert.equal(r?.spans, 1)
        const body = JSON.parse(stub.calls[1]!) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
        }
        assert.equal(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name, 'bro.b')
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed POST records lastError and keeps the cursor behind', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      journal(main, 's1', [{ ts: 1, tool: 'a' }])
      const stub = stubFetch(() => ({ ok: false, status: 503 }))
      try {
        const r = await exportTraces({ dir: main, otlp })
        assert.equal(r?.posted, false)
        assert.match(r?.error ?? '', /503/)
        const cur = JSON.parse(
          readFileSync(join(traceDir(main), '.export.json'), 'utf8')
        ) as { lastError?: string; sessions: Record<string, { line: number }> }
        assert.match(cur.lastError ?? '', /503/)
        assert.equal(cur.sessions['s1.jsonl'], undefined)
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no endpoint resolves to an error result — nothing posts', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      journal(main, 's1', [{ ts: 1, tool: 'a' }])
      const r = await exportTraces({
        dir: main,
        otlp: { ...otlp, endpoint: '' },
      })
      assert.equal(r?.posted, false)
      assert.match(r?.error ?? '', /no OTLP endpoint/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--session narrows the flush to one journal', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      journal(main, 's1', [{ ts: 1, tool: 'a' }])
      journal(main, 's2', [{ ts: 1, tool: 'b' }, { ts: 2, tool: 'b' }])
      const stub = stubFetch(() => ({ ok: true }))
      try {
        const r = await exportTraces({ dir: main, session: 's1', otlp })
        assert.equal(r?.spans, 1)
        // s2's journal is untouched — its cursor never advanced
        const r2 = await exportTraces({ dir: main, otlp })
        assert.equal(r2?.spans, 2)
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a front-trimmed journal resyncs when the cursor pin no longer matches', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      const lines = [
        { ts: 1, tool: 'a' },
        { ts: 2, tool: 'b' },
        { ts: 3, tool: 'c' },
        { ts: 4, tool: 'd' },
      ]
      journal(main, 's1', lines)
      const dir = traceDir(main)
      // cursor says lines 0..1 went out; the janitor then caps the
      // journal to its last 3 lines — off=2 stays inside the retained
      // count, only the pin can tell the file shifted
      writeFileSync(
        join(dir, '.export.json'),
        JSON.stringify({
          v: 1,
          sessions: { 's1.jsonl': { line: 2, at: 1, tail: JSON.stringify(lines[1]) } },
        })
      )
      journal(main, 's1', lines.slice(1))
      const stub = stubFetch(() => ({ ok: true }))
      try {
        const r = await exportTraces({ dir: main, otlp })
        // all 3 retained lines ship — the unsent c/d must not be skipped
        assert.equal(r?.spans, 3)
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a matching pin keeps the delta — only fresh lines ship', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      const lines = [
        { ts: 1, tool: 'a' },
        { ts: 2, tool: 'b' },
        { ts: 3, tool: 'c' },
      ]
      journal(main, 's1', lines)
      const dir = traceDir(main)
      writeFileSync(
        join(dir, '.export.json'),
        JSON.stringify({
          v: 1,
          sessions: { 's1.jsonl': { line: 2, at: 1, tail: JSON.stringify(lines[1]) } },
        })
      )
      const stub = stubFetch(() => ({ ok: true }))
      try {
        const r = await exportTraces({ dir: main, otlp })
        assert.equal(r?.spans, 1)
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a cursor ahead of a trimmed journal resyncs to the live tail', async () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      const dir = traceDir(main)
      mkdirSync(dir, { recursive: true })
      journal(main, 's1', [{ ts: 5, tool: 'a' }, { ts: 6, tool: 'b' }])
      writeFileSync(join(dir, '.export.json'), JSON.stringify({ v: 1, sessions: { 's1.jsonl': { line: 99, at: 1 } } }))
      const stub = stubFetch(() => ({ ok: true }))
      try {
        const r = await exportTraces({ dir: main, otlp })
        assert.equal(r?.spans, 2)
      } finally {
        stub.restore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('maybeSpawnTraceFlush', () => {
  test('off without an endpoint — no spawn, no stamp', () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      const spawned: string[] = []
      maybeSpawnTraceFlush(main, {}, Date.now(), (e) => spawned.push(e))
      assert.equal(spawned.length, 0)
      assert.equal(existsSync(join(traceDir(main), '.export.json')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an endpoint spawns once per flushMs — the stamp throttles', () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }
      const spawned: string[] = []
      const now = Date.now()
      maybeSpawnTraceFlush(main, env, now, (e) => spawned.push(e))
      assert.equal(spawned.length, 1)
      assert.equal(spawned[0], process.argv[1] !== undefined ? process.argv[1] : spawned[0])
      // inside the window — throttled
      maybeSpawnTraceFlush(main, env, now + 1_000, (e) => spawned.push(e))
      assert.equal(spawned.length, 1)
      // past the window — respawns
      maybeSpawnTraceFlush(main, env, now + DEFAULT_OTLP_FLUSH_MS + 1, (e) => spawned.push(e))
      assert.equal(spawned.length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('BRO_TELEMETRY=0 suppresses the spawn even with an endpoint', () => {
    const { root, main } = initRepo('bro-trace-')
    try {
      const spawned: string[] = []
      maybeSpawnTraceFlush(
        main,
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', BRO_TELEMETRY: '0' },
        Date.now(),
        (e) => spawned.push(e)
      )
      assert.equal(spawned.length, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no journal file yet still flushes — export reads whatever exists', () => {
    // flush is journal-agnostic; the spawn must not require trace/ to
    // already hold files (a fresh session's first event creates it)
    const { root, main } = initRepo('bro-trace-')
    try {
      const spawned: string[] = []
      maybeSpawnTraceFlush(
        main,
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' },
        Date.now(),
        (e) => spawned.push(e)
      )
      assert.equal(spawned.length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('parseJournalLine', () => {
  test('objects pass, everything else drops', () => {
    assert.deepEqual(parseJournalLine('{"ts":1,"tool":"x"}'), { ts: 1, tool: 'x' })
    assert.equal(parseJournalLine('{"ts":'), null)
    assert.equal(parseJournalLine('[1,2]'), null)
    assert.equal(parseJournalLine('"x"'), null)
    assert.equal(parseJournalLine(''), null)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { collectFields, emitHook, hookRecord, otelSinkPath, readSinkRows, type OtelHookRecord } from './facade.ts'
import { otelSection } from './config.ts'
import { tmpDir } from './testtmp.ts'

const PAYLOAD = {
  session_id: 'sess-1',
  tool_name: 'exec',
  tool_input: { command: 'git push origin main' },
  tool_response: { success: true },
  prompt: 'do the thing',
}

describe('collectFields', () => {
  test('dotted paths to scalar leaves; objects and misses skip', () => {
    const { fields, skipped } = collectFields(PAYLOAD, [
      'tool_name',
      'tool_input.command',
      'tool_response.success',
      'tool_input', // object leaf — skipped
      'tool_response.missing',
    ])
    assert.deepEqual(fields, {
      tool_name: 'exec',
      'tool_input.command': 'git push origin main',
      'tool_response.success': true,
    })
    assert.deepEqual(skipped, ['tool_input', 'tool_response.missing'])
  })

  test('non-object payloads collect nothing', () => {
    assert.deepEqual(collectFields('junk', ['a']), { fields: {}, skipped: ['a'] })
    assert.deepEqual(collectFields(undefined, ['a']), { fields: {}, skipped: ['a'] })
  })
})

describe('hookRecord', () => {
  test('meta-only record when collect is empty', () => {
    const { record, skipped } = hookRecord('post-tool', PAYLOAD, {
      sessionId: 'sess-1',
      client: 'cursor',
      durationMs: 7,
      ok: true,
    }, { enabled: true, sample: 1, collect: [] })
    assert.equal(record.event, 'hook.post-tool')
    assert.equal(record.session, 'sess-1')
    assert.equal(record.client, 'cursor')
    assert.equal(record.ms, 7)
    assert.equal(record.ok, true)
    assert.equal(record.payload, undefined)
    assert.deepEqual(skipped, [])
  })

  test('collect allowlist fills payload, error marks the record', () => {
    const { record } = hookRecord('stop', PAYLOAD, { ok: false, error: 'gate' }, {
      enabled: true, sample: 1, collect: ['tool_name'],
    })
    assert.equal(record.ok, false)
    assert.equal(record.error, 'gate')
    assert.deepEqual(record.payload, { tool_name: 'exec' })
  })
})

describe('emitHook — file sink', () => {
  function rowsOf(sink: string): OtelHookRecord[] {
    return readSinkRows(sink)
  }

  test('enabled=false writes nothing — zero overhead contract', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { enabled: false, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    emitHook('session-start', PAYLOAD, { sessionId: 's', dir })
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
  })

  test('enabled + default * policy → one meta-only row per event', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'out/sink.jsonl' } } })
    )
    const sink = join(dir, 'out', 'sink.jsonl')
    emitHook('session-start', PAYLOAD, { sessionId: 's', dir, durationMs: 3 })
    emitHook('prompt-submit', PAYLOAD, { sessionId: 's', dir })
    emitHook('post-tool', PAYLOAD, { sessionId: 's', dir, durationMs: 9 })
    const events = rowsOf(sink).map((r) => r.event)
    assert.deepEqual(events, ['hook.session-start', 'hook.prompt-submit', 'hook.post-tool'])
    const rows = rowsOf(sink)
    assert.equal(rows[0]?.session, 's')
    assert.equal(rows[0]?.ms, 3)
    assert.equal(rows[0]?.payload, undefined) // collect never defaults on
  })

  test('collect allowlist exports only named fields', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        otel: {
          enabled: true,
          exporter: { type: 'file', path: 'sink.jsonl' },
          hooks: { 'post-tool': { collect: ['tool_name', 'tool_response.success'] } },
        },
      })
    )
    emitHook('post-tool', PAYLOAD, { dir })
    const row = rowsOf(join(dir, 'sink.jsonl'))[0]
    assert.deepEqual(row?.payload, { tool_name: 'exec', 'tool_response.success': true })
  })

  test('hook:false drops the event, * policy still covers the rest', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        otel: {
          enabled: true,
          exporter: { type: 'file', path: 'sink.jsonl' },
          hooks: { '*': true, 'prompt-submit': false },
        },
      })
    )
    emitHook('session-start', PAYLOAD, { dir })
    emitHook('prompt-submit', PAYLOAD, { dir })
    emitHook('post-tool', PAYLOAD, { dir })
    assert.deepEqual(rowsOf(join(dir, 'sink.jsonl')).map((r) => r.event), [
      'hook.session-start',
      'hook.post-tool',
    ])
  })

  test('sample 0 keeps nothing', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        otel: {
          enabled: true,
          exporter: { type: 'file', path: 'sink.jsonl' },
          hooks: { '*': { sample: 0 } },
        },
      })
    )
    for (let i = 0; i < 10; i++) emitHook('session-start', PAYLOAD, { dir })
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
  })

  test('BRO_TELEMETRY=0 kills emission outright', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    const prev = process.env.BRO_TELEMETRY
    process.env.BRO_TELEMETRY = '0'
    try {
      emitHook('session-start', PAYLOAD, { dir })
    } finally {
      if (prev === undefined) delete process.env.BRO_TELEMETRY
      else process.env.BRO_TELEMETRY = prev
    }
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
  })

  test('default file path lands under <git-common>/bro/otel/', () => {
    const dir = tmpDir('otel-facade-')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { enabled: true } })
    )
    emitHook('session-start', PAYLOAD, { dir })
    const def = join(dir, '.git', 'bro', 'otel', 'hooks.jsonl')
    assert.equal(existsSync(def), true, `expected sink at ${def}`)
    assert.equal(rowsOf(def)[0]?.event, 'hook.session-start')
  })
})

describe('emitHook — stdout sink', () => {
  test('rows go to stderr, never stdout (hook protocol channel)', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'stdout' } } })
    )
    const errs: string[] = []
    const outs: string[] = []
    const oe = console.error
    const oo = process.stdout.write.bind(process.stdout)
    console.error = (m: unknown) => errs.push(String(m))
    process.stdout.write = ((c: unknown) => { outs.push(String(c)); return true }) as typeof process.stdout.write
    try {
      emitHook('post-tool', PAYLOAD, { dir, durationMs: 2 })
    } finally {
      console.error = oe
      process.stdout.write = oo
    }
    assert.equal(outs.length, 0)
    assert.equal(errs.length, 1)
    assert.equal(JSON.parse(errs[0]!).event, 'hook.post-tool')
  })
})

describe('emitHook — otlp sink', () => {
  test('detached POST carries the OTLP log record to the configured endpoint', async () => {
    const got: { path?: string; body?: string } = {}
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        got.path = req.url
        got.body = body
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        otel: {
          enabled: true,
          exporter: { type: 'otlp', endpoint: `http://127.0.0.1:${port}` },
        },
      })
    )
    try {
      emitHook('session-start', PAYLOAD, { sessionId: 's', dir, durationMs: 5 })
      // the detached poster is a separate node process — wait for the hit
      const deadline = Date.now() + 10_000
      while (got.body === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.equal(got.path, '/v1/logs')
      const parsed = JSON.parse(got.body ?? '{}')
      const rec = parsed.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]
      assert.equal(rec?.body?.stringValue, 'bro.hook.session-start')
      const attrs = Object.fromEntries(
        (rec?.attributes ?? []).map((a: { key: string; value: Record<string, unknown> }) => [
          a.key,
          Object.values(a.value)[0],
        ])
      )
      assert.equal(attrs['event.name'], 'hook.session-start')
      assert.equal(attrs.session, 's')
    } finally {
      server.close()
    }
  })
})

describe('otelSinkPath / readSinkRows', () => {
  test('configured path resolves against dir', () => {
    const cfg = otelSection({ exporter: { type: 'file', path: 'var/t.jsonl' } })
    assert.equal(otelSinkPath(cfg, '/repo'), '/repo/var/t.jsonl')
  })

  test('readSinkRows skips torn lines and missing files', () => {
    const dir = tmpDir('otel-facade-')
    const p = join(dir, 'rows.jsonl')
    writeFileSync(p, '{"event":"hook.a","client":"default","ok":true}\nGARBAGE\n{"nope":1}\n')
    const rows = readSinkRows(p)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.event, 'hook.a')
    assert.deepEqual(readSinkRows(join(dir, 'absent.jsonl')), [])
  })
})

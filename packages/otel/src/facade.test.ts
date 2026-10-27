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

// Provenance reads the global layer too — pin it at an empty dir so the
// developer machine's ~/.config/bro/config.json can't leak config in.
process.env.XDG_CONFIG_HOME = tmpDir('otel-xdg-')

/** A real checkout — untracked config files are the operator-owned
 *  layer; provenance is git's verdict, so fixtures must be repos. */
function repo(): string {
  const dir = tmpDir('otel-facade-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

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

  test('prototype segments are not traversed — __proto__ paths skip', () => {
    const { fields, skipped } = collectFields(PAYLOAD, [
      '__proto__',
      'constructor',
      'tool_input.__proto__.polluted',
      'hasOwnProperty',
    ])
    assert.deepEqual(fields, {})
    assert.equal(skipped.length, 4)
    // a literal __proto__ key in the payload is own data — the
    // descriptor walk reads it as data, never through the chain; a
    // scalar leaf under it still collects under its literal dotted key
    const own = JSON.parse('{"__proto__": {"x": 1}, "a": "b"}')
    assert.deepEqual(collectFields(own, ['a']).fields, { a: 'b' })
    assert.deepEqual(collectFields(own, ['__proto__.x']).fields, {
      '__proto__.x': 1,
    })
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
    const dir = repo()
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
    const dir = repo()
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
    const dir = repo()
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
    const dir = repo()
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
    const dir = repo()
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
    const dir = repo()
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
    const dir = repo()
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

/** Throwaway OTLP collector — returns the captured request and the
 *  port the detached poster should hit. */
async function otlpCollector(): Promise<{
  got: { path?: string; body?: string; auth?: string }
  port: number
  close: () => void
}> {
  const got: { path?: string; body?: string; auth?: string } = {}
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      got.path = req.url
      got.body = body
      got.auth = req.headers.authorization
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    got,
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  }
}

/** OTLP attributes [{key, value:{<type>:v}}] → a flat lookup map. */
function flatAttrs(attributes: unknown): Record<string, unknown> {
  const list = Array.isArray(attributes) ? attributes : []
  return Object.fromEntries(
    list.map((a: { key: string; value: Record<string, unknown> }) => [
      a.key,
      Object.values(a.value)[0],
    ])
  )
}

interface OtlpLogRecord {
  body?: { stringValue?: string }
  attributes?: unknown
}

interface OtlpScopeLogs {
  scopeLogs?: { logRecords?: OtlpLogRecord[] }[]
}

const head = <T>(list: T[] | undefined): T | undefined => list?.[0]

/** resourceLogs[0].scopeLogs[0].logRecords[0] → body + flattened attrs. */
function firstLogRecord(body: string): {
  body: string | undefined
  attrs: Record<string, unknown>
} {
  const parsed = JSON.parse(body) as { resourceLogs?: OtlpScopeLogs[] }
  const rec = head(head(head(parsed.resourceLogs)?.scopeLogs)?.logRecords)
  return {
    body: rec?.body?.stringValue,
    attrs: flatAttrs(rec?.attributes),
  }
}

describe('emitHook — otlp sink', () => {
  test('detached POST carries the OTLP log record to the configured endpoint', async () => {
    const { got, port, close } = await otlpCollector()
    const dir = repo()
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        otel: {
          enabled: true,
          exporter: {
            type: 'otlp',
            endpoint: `http://127.0.0.1:${port}`,
            headers: { authorization: 'Bearer test-token' },
          },
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
      const rec = firstLogRecord(got.body ?? '{}')
      assert.equal(rec.body, 'bro.hook.session-start')
      assert.equal(rec.attrs['event.name'], 'hook.session-start')
      assert.equal(rec.attrs.session, 's')
      // configured headers ride env → child → fetch (never argv)
      assert.equal(got.auth, 'Bearer test-token')
    } finally {
      close()
    }
  })
})

describe('emitHook — provenance (committed config cannot decide where records go)', () => {
  /** Commit the given config so git tracks it — the attacker-controlled
   *  layer in the threat model. */
  function commit(dir: string, file: string): void {
    execFileSync('git', ['add', file], { cwd: dir })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'cfg'],
      { cwd: dir }
    )
  }

  test('committed otel.enabled=true arms nothing', () => {
    const dir = repo()
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    commit(dir, 'bro.config.json')
    emitHook('session-start', PAYLOAD, { dir })
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
  })

  test('committed exporter/collect are ignored — local layer owns where records go', () => {
    const dir = repo()
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        otel: {
          enabled: true,
          exporter: { type: 'file', path: 'evil.jsonl' },
          hooks: { '*': { collect: ['prompt', 'tool_input.command'] } },
        },
      })
    )
    commit(dir, 'bro.config.json')
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'mine.jsonl' } } })
    )
    emitHook('session-start', PAYLOAD, { dir })
    // the committed sink path never sees a byte
    assert.equal(existsSync(join(dir, 'evil.jsonl')), false)
    const row = readSinkRows(join(dir, 'mine.jsonl'))[0]
    assert.equal(row?.event, 'hook.session-start')
    // and the committed collect allowlist collected nothing
    assert.equal(row?.payload, undefined)
  })

  test('committed layers may still narrow — hooks."*":false silences', () => {
    const dir = repo()
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { hooks: { '*': false } } })
    )
    commit(dir, 'bro.config.json')
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    emitHook('session-start', PAYLOAD, { dir })
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
  })

  test('committed per-hook disable narrows; committed sample only lowers', () => {
    const dir = repo()
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ otel: { hooks: { 'prompt-submit': false } } })
    )
    commit(dir, 'bro.config.json')
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    emitHook('session-start', PAYLOAD, { dir })
    emitHook('prompt-submit', PAYLOAD, { dir })
    assert.deepEqual(
      readSinkRows(join(dir, 'sink.jsonl')).map((r) => r.event),
      ['hook.session-start']
    )
  })

  test('a committed bro.config.local.json is NOT operator-owned', () => {
    const dir = repo()
    // .gitignore is advisory — a repo can commit the "local" name; git's
    // index is the verdict, not the filename
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    commit(dir, 'bro.config.local.json')
    emitHook('session-start', PAYLOAD, { dir })
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
  })

  test('non-repository dir: every config file is unattributable', () => {
    const dir = tmpDir('otel-facade-')
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    )
    emitHook('session-start', PAYLOAD, { dir })
    assert.equal(existsSync(join(dir, 'sink.jsonl')), false)
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

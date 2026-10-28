/** `bro otel` — status | test | on | off (spec: specs/bro-xgejl.md). */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { runOtelCommand } from './otel.ts'
import { git, scrubEnv, tmpDir } from './testrepo.ts'

// ambient repo/agent/store pins must not reach fixture git children
after(scrubEnv())

function repo(cfg: unknown = {}): string {
  const dir = tmpDir('bro-otel-')
  git(['init', '-q'], dir)
  writeFileSync(join(dir, 'bro.config.json'), `${JSON.stringify(cfg)}\n`)
  return dir
}

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`)
  }
}

/** Run `bro otel <argv>` with cwd in the tmp repo, capturing console and
 *  the exit verdict (process.exit code, else process.exitCode). */
const capture = (
  dir: string,
  argv: string[]
): { out: string[]; err: string[]; exit: number } => {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  const origExit = process.exit
  const origCode = process.exitCode
  let exit: number | undefined
  console.log = (m?: unknown) => out.push(String(m))
  console.error = (m?: unknown) => err.push(String(m))
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as typeof process.exit
  process.exitCode = 0
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    runOtelCommand(argv)
  } catch (e: any) {
    if (e instanceof ExitSignal) {
      exit = e.code
    } else if (e && (e.name === 'CommandError' || e.constructor?.name === 'CommandError')) {
      exit = typeof e.code === 'number' ? e.code : 1
      if (e.message) err.push(String(e.message))
    } else {
      throw e
    }
  } finally {
    process.chdir(cwd)
    console.log = origLog
    console.error = origErr
    process.exit = origExit
    const code = exit ?? process.exitCode ?? 0
    process.exitCode = origCode
    exit = code
  }
  return { out, err, exit }
}

describe('bro otel on|off', () => {
  test('on writes otel.enabled=true to bro.config.local.json', () => {
    const dir = repo()
    const r = capture(dir, ['on'])
    assert.equal(r.exit, 0)
    const cfg = JSON.parse(readFileSync(join(dir, 'bro.config.local.json'), 'utf8'))
    assert.equal(cfg.otel.enabled, true)
    assert.match(r.out[0] ?? '', /otel\.enabled=true.*bro\.config\.local\.json/)
  })

  test('off flips false and preserves sibling keys', () => {
    const dir = repo()
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ otel: { enabled: true, hooks: { stop: false } }, other: { keep: 1 } })
    )
    const r = capture(dir, ['off'])
    assert.equal(r.exit, 0)
    const cfg = JSON.parse(readFileSync(join(dir, 'bro.config.local.json'), 'utf8'))
    assert.equal(cfg.otel.enabled, false)
    assert.deepEqual(cfg.otel.hooks, { stop: false })
    assert.deepEqual(cfg.other, { keep: 1 })
  })

  test('a bro.config.local.ts shadows and refuses the write', () => {
    const dir = repo()
    writeFileSync(join(dir, 'bro.config.local.ts'), 'export default {}\n')
    const r = capture(dir, ['on'])
    assert.equal(r.exit, 2)
    assert.match(r.err.join('\n'), /bro\.config\.local\.ts shadows/)
    assert.equal(existsSync(join(dir, 'bro.config.local.json')), false)
  })

  test('malformed local config refuses — never silently overwritten', () => {
    const dir = repo()
    const path = join(dir, 'bro.config.local.json')
    writeFileSync(path, '{ "providers": { "a": 1 }, broken,')
    const r = capture(dir, ['on'])
    assert.equal(r.exit, 2)
    assert.match(r.err.join('\n'), /does not parse/)
    // the malformed file is untouched — operator data survived
    assert.equal(readFileSync(path, 'utf8'), '{ "providers": { "a": 1 }, broken,')
  })

  test('valid-JSON non-object local config refuses too', () => {
    const dir = repo()
    writeFileSync(join(dir, 'bro.config.local.json'), '[1,2,3]')
    const r = capture(dir, ['off'])
    assert.equal(r.exit, 2)
    assert.equal(readFileSync(join(dir, 'bro.config.local.json'), 'utf8'), '[1,2,3]')
  })
})

describe('bro otel status', () => {
  test('disabled default reports DISABLED with the resolved sink', () => {
    const dir = repo()
    const r = capture(dir, ['status'])
    assert.equal(r.exit, 0)
    assert.match(r.out.join('\n'), /otel: DISABLED/)
    assert.match(r.out.join('\n'), /exporter=file → .*bro.*otel.*hooks\.jsonl/)
  })

  test('event counts read back from the file sink', () => {
    const dir = repo({ otel: { enabled: true, exporter: { type: 'file', path: 'sink.jsonl' } } })
    writeFileSync(
      join(dir, 'sink.jsonl'),
      [
        { ts: 't', event: 'hook.session-start', client: 'default', ok: true },
        { ts: 't', event: 'hook.post-tool', client: 'default', ok: true },
        { ts: 't', event: 'hook.post-tool', client: 'default', ok: true },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n'
    )
    const r = capture(dir, ['status', '--json'])
    assert.equal(r.exit, 0)
    const report = JSON.parse(r.out.join('\n'))
    assert.equal(report.enabled, true)
    assert.equal(report.counts['hook.post-tool'], 2)
    assert.equal(report.counts['hook.session-start'], 1)
    assert.equal(report.sink, join(dir, 'sink.jsonl'))
  })

  test('otlp exporter reports the configured endpoint', () => {
    const dir = repo({
      otel: { enabled: true, exporter: { type: 'otlp', endpoint: 'http://collector:4318' } },
    })
    const r = capture(dir, ['status'])
    assert.match(r.out.join('\n'), /exporter=otlp → http:\/\/collector:4318/)
  })
})

describe('bro otel test', () => {
  test('missing hook name is a usage error', () => {
    const dir = repo()
    const r = capture(dir, ['test'])
    assert.equal(r.exit, 2)
    assert.match(r.err.join('\n'), /needs a hook name/)
  })

  test('host names normalize — sessionStart prints the session-start record', () => {
    const dir = repo({ otel: { enabled: true } })
    const r = capture(dir, ['test', 'sessionStart'])
    assert.equal(r.exit, 0)
    const record = JSON.parse(r.out[0] ?? '{}')
    assert.equal(record.event, 'hook.session-start')
    assert.equal(record.session, 'otel-test-session')
    assert.equal(record.client, 'test')
  })

  test('collect allowlist exports only named fields; the rest list as not collected', () => {
    const dir = repo({
      otel: { enabled: true, hooks: { 'post-tool': { collect: ['tool_name'] } } },
    })
    const r = capture(dir, ['test', 'PostToolUse', '--json'])
    const report = JSON.parse(r.out.join('\n'))
    assert.equal(report.hook, 'post-tool')
    assert.deepEqual(report.record.payload, { tool_name: 'exec' })
    assert.ok(report.payloadFieldsNotCollected.includes('tool_input'))
    assert.ok(report.payloadFieldsNotCollected.includes('prompt'))
  })

  test('disabled otel still previews the would-be record', () => {
    const dir = repo()
    const r = capture(dir, ['test', 'stop'])
    assert.equal(r.exit, 0)
    assert.match(r.out.join('\n'), /otel\.enabled=false.*would-be/)
    assert.match(r.out.join('\n'), /"event": "hook\.stop"/)
  })
})

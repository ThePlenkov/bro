/** OTLP export e2e — `bro trace export` run as the built CLI against a
 *  local collector (node:http): the real POST wire, the cursor file,
 *  and the post-tool hook's detached flush end-to-end. The collector
 *  lives IN this process, so the CLI must spawn async — spawnSync
 *  would freeze the event loop and dead-lock the POST. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CLI_DIST,
  e2eEnv,
  git,
  initRepo,
  insideAsync,
  type CliResult,
} from './testrepo.ts'

/** Async `node dist/index.js <args>` — same contract as runCli but the
 *  test process keeps its event loop (the in-process collector can only
 *  answer while the loop turns). */
function runCliAsync(
  args: string[],
  opts: { cwd: string; input?: string; env?: Record<string, string> }
): Promise<CliResult> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      cwd: opts.cwd,
      env: e2eEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (e) => resolveRun({ code: null, stdout, stderr: stderr + e.message }))
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
    child.stdin.end(opts.input ?? '')
  })
}

interface Collector {
  url: string
  /** raw request bodies, one per POST */
  bodies: string[]
  paths: string[]
  close: () => Promise<void>
}

/** A throwaway OTLP/HTTP sink on 127.0.0.1:0. */
function collector(): Promise<Collector> {
  const bodies: string[] = []
  const paths: string[] = []
  const srv: Server = createServer((req, res) => {
    paths.push(`${req.method ?? ''} ${req.url ?? ''}`)
    let body = ''
    req.setEncoding('utf8').on('data', (d: string) => (body += d))
    req.on('end', () => {
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return new Promise((resolveListen) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolveListen({
        url: `http://127.0.0.1:${port}`,
        bodies,
        paths,
        close: () => new Promise((done) => srv.close(() => done())),
      })
    })
  })
}

/** Poll `fn` until it answers or the deadline passes — a detached
 *  flush's arrival is timing-shaped, never instant. */
async function until(fn: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!fn() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return fn()
}

interface Fixture {
  root: string
  main: string
  markerDir: string
}

function fixture(): Fixture {
  const { root, main } = initRepo('bro-trace-e2e-', (m) => {
    writeFileSync(join(m, 'bro.config.json'), '{}')
  })
  const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
  return { root, main, markerDir: join(common, 'bro', 'hooks') }
}

const journal = (f: Fixture, session: string, lines: object[]): void => {
  const dir = join(f.markerDir, 'trace')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${session}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

const cursor = (f: Fixture): Record<string, unknown> =>
  JSON.parse(readFileSync(join(f.markerDir, 'trace', '.export.json'), 'utf8')) as Record<
    string,
    unknown
  >

interface OtlpBody {
  resourceSpans: Array<{
    scopeSpans: Array<{ spans: Array<{ name: string; attributes?: Array<{ key: string }> }> }>
  }>
}

const postedSpans = (c: Collector): OtlpBody['resourceSpans'][number]['scopeSpans'][number]['spans'] =>
  c.bodies.flatMap(
    (b) =>
      (JSON.parse(b) as OtlpBody).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
  )

/** Collector + fixture wired for one test — the try/finally is owned
 *  here so each test body stays inside `insideAsync`. */
async function withCollector(fn: (c: Collector, f: Fixture) => Promise<void>): Promise<void> {
  const c = await collector()
  try {
    const f = fixture()
    await insideAsync(f.main, f.root, () => fn(c, f))
  } finally {
    await c.close()
  }
}

/** One post-tool hook invocation with the collector pointed by env. */
const postTool = (f: Fixture, env: Record<string, string>): Promise<CliResult> =>
  runCliAsync(['hooks', 'post-tool'], {
    cwd: f.main,
    input: JSON.stringify({
      tool_name: 'exec',
      tool_input: { command: 'true' },
      tool_response: { success: true },
      session_id: 's1',
    }),
    env: { XDG_STATE_HOME: join(f.root, 'xdg-state'), ...env },
  })

const otlpEnv = (c: Collector): { OTEL_EXPORTER_OTLP_ENDPOINT: string } => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: c.url,
})

describe('bro trace export', () => {
  test('no endpoint configured exits 1 with the opt-in hint', async () => {
    await withCollector(async (c, f) => {
      journal(f, 's1', [{ ts: 1, tool: 'exec', command: 'ls' }])
      const r = await runCliAsync(['trace', 'export'], { cwd: f.main })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /no OTLP endpoint/)
      assert.equal(c.bodies.length, 0)
    })
  })

  test('env endpoint: new lines post as spans, cursor blocks resend', async () => {
    await withCollector(async (c, f) => {
      journal(f, 's1', [
        { ts: 1000, tool: 'exec', command: 'ls', ok: true },
        { ts: 1200, tool: 'edit', paths: ['a.ts'], ok: false },
      ])
      const env = otlpEnv(c)
      const r = await runCliAsync(['trace', 'export'], { cwd: f.main, env })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /exported 2 span/)
      assert.deepEqual(c.paths, ['POST /v1/traces'])
      const spans = postedSpans(c)
      assert.equal(spans.length, 2)
      assert.equal(spans[0]!.name, 'bro.exec')
      assert.equal(spans[1]!.name, 'bro.edit')

      const again = await runCliAsync(['trace', 'export'], { cwd: f.main, env })
      assert.equal(again.code, 0)
      assert.match(again.stdout, /nothing to export/)
      assert.equal(c.bodies.length, 1)
      // the cursor recorded the advance
      const cur = cursor(f) as { sessions: Record<string, { line: number }> }
      assert.equal(cur.sessions['s1.jsonl']?.line, 2)
    })
  })

  test('--dry-run prints the payload and never posts', async () => {
    await withCollector(async (c, f) => {
      journal(f, 's1', [{ ts: 1, tool: 'exec', command: 'ls' }])
      const r = await runCliAsync(['trace', 'export', '--dry-run'], {
        cwd: f.main,
        env: otlpEnv(c),
      })
      assert.equal(r.code, 0, r.stderr)
      const payload = JSON.parse(r.stdout) as OtlpBody
      assert.equal(payload.resourceSpans.length, 1)
      assert.equal(c.bodies.length, 0)
      // dry-run must not consume the lines — a real export still sends
      const r2 = await runCliAsync(['trace', 'export'], { cwd: f.main, env: otlpEnv(c) })
      assert.equal(r2.code, 0)
      assert.equal(c.bodies.length, 1)
    })
  })

  test('post-tool hook flushes detached — bead pin lands as a span attr', async () => {
    await withCollector(async (c, f) => {
      const r = await postTool(f, { ...otlpEnv(c), BRO_BEAD_ID: 'bro-x1' })
      // the hook itself is untouched by the exporter — exit 0, no stall
      assert.equal(r.code, 0, r.stderr)
      // the journal line carries the spawn pin
      const line = readFileSync(join(f.markerDir, 'trace', 's1.jsonl'), 'utf8').trim()
      assert.equal((JSON.parse(line) as { bead?: string }).bead, 'bro-x1')
      // the detached export lands shortly after — poll, never block
      const arrived = await until(() => c.bodies.length > 0)
      assert.equal(arrived, true, 'detached flush never reached the collector')
      const span = postedSpans(c)[0]!
      assert.equal(span.name, 'bro.exec')
      const keys = (span.attributes ?? []).map((a) => a.key)
      assert.ok(keys.includes('bro.bead'))
      assert.ok(keys.includes('bro.session'))
    })
  })

  test('BRO_TELEMETRY=0 suppresses the hook flush entirely', async () => {
    await withCollector(async (c, f) => {
      const r = await postTool(f, { ...otlpEnv(c), BRO_TELEMETRY: '0' })
      assert.equal(r.code, 0)
      await new Promise((res) => setTimeout(res, 500))
      assert.equal(c.bodies.length, 0)
      // and no throttle stamp was written either
      assert.equal(existsSync(join(f.markerDir, 'trace', '.export.json')), false)
    })
  })

  test('--json reports the export without the payload', async () => {
    await withCollector(async (c, f) => {
      journal(f, 's1', [{ ts: 1, tool: 'exec', command: 'ls' }])
      const r = await runCliAsync(['trace', 'export', '--json'], {
        cwd: f.main,
        env: otlpEnv(c),
      })
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as { spans: number; posted: boolean; payload?: unknown }
      assert.equal(out.spans, 1)
      assert.equal(out.posted, true)
      assert.equal(out.payload, undefined)
    })
  })
})

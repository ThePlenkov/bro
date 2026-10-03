/**
 * `bro serve` — the facade host for thin clients (TUI/webui/IDE).
 * Spec: specs/sessions/bro-f4ot/spec.md.
 *
 *   bro serve [--port <n>]
 *
 * HTTP/JSON bound to 127.0.0.1 — the loopback bind IS the v1 trust
 * boundary: no remote exposure, no auth model. Write ops (spawn/stop)
 * are safe because the server runs inside the local session context;
 * remote orchestration, if ever, is a separate spec. Loopback alone is
 * not a write barrier though — a hostile web page can fire simple
 * cross-origin POSTs, so writes additionally require
 * `content-type: application/json` (a request a browser can't make
 * without a preflight this server never answers), and every request
 * needs a loopback `Host` — a rebound name is 403 (DNS rebinding).
 *
 *   GET    /                    service index
 *   GET    /fleet               the fleet webui — an HTML dashboard over
 *                               /api/v1/snapshot (spec bro-1rir)
 *   GET    /api/v1/health       {ok, pid, dir, startedAt}
 *   GET    /api/v1/snapshot     the watch snapshot — mols × gates × fleet
 *   GET    /api/v1/agents       per-backend agent plane
 *   GET    /api/v1/agents/<ref> one agent — ref is agentId or molStep
 *   POST   /api/v1/agents       spawn {molStep, worktree?, prompt?|promptFile?,
 *                               connector?, beadsDir?} → 201 {agent}
 *   DELETE /api/v1/agents/<ref> stop — always invokes the connector's
 *                               idempotent stop; terminal agents report
 *                               `terminal:true` + a note. A miss beside a
 *                               degraded backend is 503 (unverifiable),
 *                               a clean miss 404
 *
 * Discovery: `<git-common-dir>/bro/serve.json` {pid, url, dir,
 * startedAt} written on listen (tmp+rename), removed on shutdown. A
 * second serve on the same repo refuses while the recorded pid is
 * alive — two live servers would make the file a coin flip.
 */
import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { gitTry, SpawnError, type AgentConnector, type AgentInfo } from '@broject/core'
import {
  agentConnectorNames,
  loadAgentEnv,
  pidAlive,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import {
  collectAgentBackends,
  findAgent,
  SpawnInputError,
  spawnStepAgent,
  stopAgent,
  type AgentBackendPlane,
  type StepSpawnRequest,
  type StopOutcome,
} from './agents.ts'
import { flag, positionals } from './args.ts'
import { collectSnapshot } from './watch.ts'
import { FLEET_PAGE, WEBUI_CSP } from './webui.ts'

// --- serve state (discovery) ---------------------------------------------------

/** What a client needs to find and trust the server for a repo. */
export interface ServeState {
  pid: number
  url: string
  dir: string
  startedAt: string
}

/** `<git-common-dir>/bro/serve.json` — shared across linked worktrees,
 *  same anchor as agents.json and the hooks markers. Null outside a
 *  repo. */
export function serveStatePath(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'serve.json')
}

export function readServeState(dir: string): ServeState | undefined {
  const path = serveStatePath(dir)
  if (path === null) {
    return undefined
  }
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServeState>
    // a torn/garbage entry is not a state — only a full record counts
    if (
      typeof v.pid === 'number' &&
      typeof v.url === 'string' &&
      typeof v.dir === 'string'
    ) {
      return v as ServeState
    }
    return undefined
  } catch {
    return undefined
  }
}

/** tmp+rename — readers never see a half-written state file. */
export function writeServeState(dir: string, state: ServeState): void {
  const path = serveStatePath(dir)
  if (path === null) {
    throw new Error('no git common dir — cannot write serve.json')
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Remove the state file only while it still names THIS process — a
 *  successor that already rewrote it must not be unregistered by the
 *  dying predecessor's cleanup. */
export function clearServeState(dir: string): void {
  try {
    const state = readServeState(dir)
    if (state !== undefined && state.pid === process.pid) {
      const path = serveStatePath(dir)
      if (path !== null) {
        rmSync(path, { force: true })
      }
    }
  } catch {
    // best-effort — the stale-pid check on next start covers leftovers
  }
}

/** A recorded serve whose pid is still alive — a second `bro serve`
 *  refuses to start against this (two servers, one discovery file). */
export function liveServeState(dir: string): ServeState | undefined {
  const state = readServeState(dir)
  return state !== undefined && pidAlive(state.pid) ? state : undefined
}

/** Drop our lock file — only while it still carries OUR pid, so a
 *  broken-stale-then-retaken lock stays with its new holder. */
function releaseServeLock(lock: string): void {
  try {
    if (readFileSync(lock, 'utf8') === `${process.pid}`) {
      rmSync(lock, { force: true })
    }
  } catch {
    // raced removal is already the desired end state
  }
}

/** One acquisition attempt — link the staged pid file over `lock`.
 *  EEXIST means held: a live holder refuses; a dead holder's leftover
 *  is broken so the next attempt wins. */
function tryLockOnce(staged: string, lock: string): 'acquired' | 'held' | 'retry' {
  try {
    linkSync(staged, lock)
    return 'acquired'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
  }
  let holder = Number.NaN
  try {
    holder = Number(readFileSync(lock, 'utf8').trim())
  } catch {
    // raced removal — the retry decides
    return 'retry'
  }
  if (Number.isInteger(holder) && pidAlive(holder)) {
    return 'held'
  }
  try {
    rmSync(lock, { force: true })
  } catch {
    // another starter broke it first — the retry decides
  }
  return 'retry'
}

/** `<serve.json>.lock` — atomic create is the singleton gate, so two
 *  starters can't both pass the live-state check and both write
 *  serve.json (the lock is held for the server's whole lifetime, not a
 *  critical section). The file carries the holder pid: a live holder
 *  refuses, a dead holder's leftover is broken. Returns the release, or
 *  undefined when another server holds it. */
export function acquireServeLock(dir: string): (() => void) | undefined {
  const statePath = serveStatePath(dir)
  if (statePath === null) {
    return undefined
  }
  const lock = `${statePath}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  // link(2) publishes the populated file atomically — open('wx')+write
  // would leave a window where the lock exists but reads empty, and a
  // racing starter could break it as "stale"
  const staged = `${lock}.${process.pid}.tmp`
  writeFileSync(staged, `${process.pid}`)
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const verdict = tryLockOnce(staged, lock)
      if (verdict === 'acquired') {
        return () => releaseServeLock(lock)
      }
      if (verdict === 'held') {
        return undefined
      }
    }
    return undefined
  } finally {
    rmSync(staged, { force: true })
  }
}

// --- HTTP plumbing ---------------------------------------------------------------

/** Fail-closed request error carrying its status — the handler maps it
 *  without a second decode of the failure. */
export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

const MAX_BODY_BYTES = 256 * 1024

/** Read a request body with a hard cap — a thin client never legitimately
 *  sends more than a prompt's worth of JSON, and an unbounded read is a
 *  memory DoS even on loopback. */
export async function readBody(stream: Readable, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    // IncomingMessage yields Buffers, but tests feed string chunks —
    // normalize so the cap counts bytes either way
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > limit) {
      throw new HttpError(413, `request body over ${limit} bytes`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// --- routing -----------------------------------------------------------------------

/** The seam between transport and facade — tests inject fakes; the real
 *  command wires it to the same machinery `bro agents`/`bro watch` use. */
export interface ServeDeps {
  snapshot(): Promise<unknown>
  backends(): Promise<AgentBackendPlane[]>
  find(
    ref: string
  ): Promise<{ hit?: { conn: AgentConnector; agent: AgentInfo }; degraded: string[] }>
  spawn(req: StepSpawnRequest): Promise<AgentInfo>
  stop(ref: string): Promise<StopOutcome>
  connectors(): string[]
}

export interface ServeResponse {
  status: number
  body: unknown
  /** non-JSON routes declare their type — `send` then emits the body
   *  verbatim instead of a JSON envelope */
  contentType?: string
  /** extra response headers — the webui's CSP rides this */
  headers?: Record<string, string>
}

const ROUTES = [
  'GET /fleet',
  'GET /api/v1/health',
  'GET /api/v1/snapshot',
  'GET /api/v1/agents',
  'POST /api/v1/agents',
  'GET /api/v1/agents/<ref>',
  'DELETE /api/v1/agents/<ref>',
]

/** Per-server context — startedAt is captured at LISTEN time, not module
 *  load: the health payload must say when this server came up. */
export interface ServeMeta {
  dir: string
  startedAt: string
}

/** refs are agentIds (`native-ab12`) or molStep ids (`bro-mol-z0l`) —
 *  conservative charset so a weird segment can't smuggle path or query
 *  syntax into downstream lookups. */
const SAFE_REF = /^[A-Za-z0-9._~-]+$/

function parseRef(seg: string): string {
  let ref: string
  try {
    ref = decodeURIComponent(seg)
  } catch {
    // malformed % escapes throw URIError — that's bad input, a 400,
    // not a 500
    throw new HttpError(400, `invalid agent ref "${seg}"`)
  }
  if (!SAFE_REF.test(ref)) {
    throw new HttpError(400, `invalid agent ref "${ref}"`)
  }
  return ref
}

const SPAWN_FIELDS = new Set([
  'molStep',
  'worktree',
  'prompt',
  'promptFile',
  'connector',
  'beadsDir',
])

/** POST body → StepSpawnRequest — strict: a misspelled field must be a
 *  400, not a silently dropped option. */
export function parseSpawnBody(raw: string | undefined): StepSpawnRequest {
  if (raw === undefined || raw.trim() === '') {
    throw new HttpError(400, 'POST /api/v1/agents needs a JSON body')
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  const unknown = Object.keys(doc).filter((k) => !SPAWN_FIELDS.has(k))
  if (unknown.length > 0) {
    throw new HttpError(400, `unknown field(s): ${unknown.join(', ')}`)
  }
  const req = doc as Record<string, unknown>
  for (const [k, v] of Object.entries(req)) {
    if (v !== undefined && typeof v !== 'string') {
      throw new HttpError(400, `field "${k}" must be a string`)
    }
  }
  if (typeof req.molStep !== 'string' || req.molStep.trim() === '') {
    throw new HttpError(400, 'field "molStep" is required')
  }
  return {
    molStep: req.molStep as string,
    worktree: req.worktree as string | undefined,
    prompt: req.prompt as string | undefined,
    promptFile: req.promptFile as string | undefined,
    connector: req.connector as string | undefined,
    beadsDir: req.beadsDir as string | undefined,
  }
}

/** Serialize the backend plane exactly like `bro agents status --json`
 *  — conn objects don't cross the wire. */
function backendJson(backends: AgentBackendPlane[]): unknown {
  return {
    backends: backends.map(({ conn, agents, degraded }) => ({
      name: conn.name,
      capabilities: conn.capabilities(),
      agents,
      ...(degraded !== undefined ? { degraded } : {}),
    })),
  }
}

function missBody(ref: string, degraded: string[]): Record<string, unknown> {
  return {
    error: `no agent "${ref}"`,
    ...(degraded.length > 0 ? { degraded } : {}),
  }
}

export async function routeRequest(
  method: string,
  pathname: string,
  rawBody: string | undefined,
  deps: ServeDeps,
  meta: ServeMeta
): Promise<ServeResponse> {
  try {
    return await route(method, pathname, rawBody, deps, meta)
  } catch (err) {
    // HttpError is fail-closed input validation — a response, not a crash
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.message } }
    }
    throw err
  }
}

const NOT_FOUND: ServeResponse = { status: 404, body: { error: 'not found', routes: ROUTES } }
const NOT_ALLOWED: ServeResponse = { status: 405, body: { error: 'method not allowed' } }

function routeHealth(method: string, meta: ServeMeta): ServeResponse {
  if (method !== 'GET') {
    return NOT_ALLOWED
  }
  return {
    status: 200,
    body: { ok: true, pid: process.pid, dir: meta.dir, startedAt: meta.startedAt },
  }
}

async function routeSnapshot(method: string, deps: ServeDeps): Promise<ServeResponse> {
  if (method !== 'GET') {
    return NOT_ALLOWED
  }
  return { status: 200, body: await deps.snapshot() }
}

async function routeAgents(
  method: string,
  rawBody: string | undefined,
  deps: ServeDeps
): Promise<ServeResponse> {
  if (method === 'GET') {
    return { status: 200, body: backendJson(await deps.backends()) }
  }
  if (method !== 'POST') {
    return NOT_ALLOWED
  }
  const req = parseSpawnBody(rawBody)
  if (req.connector !== undefined && !deps.connectors().includes(req.connector)) {
    return {
      status: 400,
      body: {
        error: `agent connector "${req.connector}" is not registered`,
        connectors: deps.connectors(),
      },
    }
  }
  try {
    const agent = await deps.spawn(req)
    return { status: 201, body: { agent } }
  } catch (err) {
    if (err instanceof SpawnInputError || err instanceof HttpError) {
      return { status: 400, body: { error: err.message } }
    }
    if (err instanceof SpawnError) {
      return { status: 409, body: { error: err.message } }
    }
    throw err
  }
}

async function routeAgentGet(ref: string, deps: ServeDeps): Promise<ServeResponse> {
  const { hit, degraded } = await deps.find(ref)
  if (!hit) {
    return { status: 404, body: missBody(ref, degraded) }
  }
  // a hit beside a degraded backend is a partial read — surface the
  // note on the resource rather than claiming a complete view
  return {
    status: 200,
    body: { ...hit.agent, ...(degraded.length > 0 ? { degraded } : {}) },
  }
}

async function routeAgentDelete(ref: string, deps: ServeDeps): Promise<ServeResponse> {
  const outcome = await deps.stop(ref)
  if (!outcome.found) {
    // a degraded read can't confirm "gone" — unverifiable is not 404
    if (outcome.degraded.length > 0) {
      return {
        status: 503,
        body: {
          error: `cannot verify "${ref}" — backend(s) degraded`,
          degraded: outcome.degraded,
        },
      }
    }
    return { status: 404, body: { error: `no agent "${ref}"` } }
  }
  return {
    status: 200,
    body: {
      agent: outcome.agent,
      stopped: outcome.stopped,
      // machine-readable "was already terminal" — clients shouldn't
      // string-match the note to tell it from a live stop
      ...(outcome.terminal === true ? { terminal: true } : {}),
      ...(outcome.terminal === true && outcome.agent !== undefined
        ? { note: `already ${outcome.agent.state}` }
        : {}),
      ...(outcome.respawned !== undefined ? { respawned: outcome.respawned } : {}),
    },
  }
}

async function routeAgentRef(
  method: string,
  seg: string,
  deps: ServeDeps
): Promise<ServeResponse> {
  const ref = parseRef(seg)
  if (method === 'GET') {
    return routeAgentGet(ref, deps)
  }
  if (method === 'DELETE') {
    return routeAgentDelete(ref, deps)
  }
  return NOT_ALLOWED
}

/** The site route — read-only HTML over the snapshot plane; the
 *  loopback Host check guards it like every other route. */
function routeFleet(method: string): ServeResponse {
  if (method !== 'GET') {
    return NOT_ALLOWED
  }
  return {
    status: 200,
    body: FLEET_PAGE,
    contentType: 'text/html; charset=utf-8',
    headers: { 'content-security-policy': WEBUI_CSP },
  }
}

async function route(
  method: string,
  pathname: string,
  rawBody: string | undefined,
  deps: ServeDeps,
  meta: ServeMeta
): Promise<ServeResponse> {
  const seg = pathname.split('/').filter((s) => s !== '')

  if (method === 'GET' && seg.length === 0) {
    return { status: 200, body: { service: 'bro', routes: ROUTES } }
  }

  if (seg.length === 1 && seg[0] === 'fleet') {
    return routeFleet(method)
  }

  const api = seg[0] === 'api' && seg[1] === 'v1' ? seg.slice(2) : undefined
  if (api === undefined || api.length === 0) {
    return NOT_FOUND
  }

  if (api[0] === 'health' && api.length === 1) {
    return routeHealth(method, meta)
  }
  if (api[0] === 'snapshot' && api.length === 1) {
    return routeSnapshot(method, deps)
  }
  if (api[0] === 'agents') {
    if (api.length === 1) {
      return routeAgents(method, rawBody, deps)
    }
    if (api.length === 2) {
      return routeAgentRef(method, api[1]!, deps)
    }
  }
  return NOT_FOUND
}

// --- server ----------------------------------------------------------------------------

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  opts: { contentType?: string; headers?: Record<string, string> } = {}
): void {
  const contentType = opts.contentType ?? 'application/json'
  res.writeHead(status, { 'content-type': contentType, ...opts.headers })
  res.end(contentType === 'application/json' ? `${JSON.stringify(body)}\n` : String(body))
}

export function createServeHandler(
  deps: ServeDeps,
  meta: ServeMeta
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        // DNS-rebinding guard: a rebound browser request still carries
        // the attacker's Host — only loopback names are real clients.
        // Covers reads too: CSRF only blinds the response, rebinding
        // would expose the snapshot/agents planes to the page.
        const rawHost = (req.headers.host ?? '').toLowerCase()
        const host = rawHost.startsWith('[')
          ? rawHost.slice(0, rawHost.indexOf(']') + 1)
          : rawHost.split(':')[0]
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
          send(res, 403, { error: 'loopback host only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const wantsBody =
          req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
        // loopback alone is not a write barrier — a hostile web page can
        // POST simple requests (text/plain/form) cross-origin. Requiring
        // a non-simple content-type forces a preflight this server never
        // answers, so the browser blocks the write before it lands.
        if (
          wantsBody &&
          !(req.headers['content-type'] ?? '').startsWith('application/json')
        ) {
          send(res, 415, { error: 'writes need content-type: application/json' })
          return
        }
        const rawBody = wantsBody ? await readBody(req) : undefined
        const r = await routeRequest(req.method ?? 'GET', url.pathname, rawBody, deps, meta)
        send(res, r.status, r.body, r)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500
        send(res, status, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }
}

function realDeps(dir: string, env: AgentConnectorEnv): ServeDeps {
  return {
    snapshot: () => collectSnapshot(dir),
    backends: async () => (await collectAgentBackends(dir, env)).backends,
    find: (ref) => findAgent(dir, env, ref),
    spawn: (req) => spawnStepAgent(dir, env, req),
    stop: (ref) => stopAgent(dir, env, ref),
    connectors: () => agentConnectorNames(),
  }
}

function usage(): never {
  console.error(`usage:
  bro serve [--port <n>]

HTTP/JSON facade host on 127.0.0.1 (default port: ephemeral — the bound
address is printed and written to <git-common-dir>/bro/serve.json).

Routes: ${ROUTES.join(', ')}`)
  process.exit(2)
}

export async function runServeCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  const pos = positionals(argv, new Set(['--port']))
  if (pos.length > 0) {
    usage()
  }
  // reject unknown options — `--prot 3000` must fail, not silently serve
  // on an ephemeral port nobody can see
  for (const a of argv) {
    if (a.startsWith('--') && a.split('=')[0] !== '--port') {
      console.error(`error: unknown option ${a}`)
      usage()
    }
  }
  const portRaw = flag(argv, '--port')
  let port = 0
  if (portRaw !== undefined) {
    port = Number(portRaw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`error: --port needs an integer 0–65535, got "${portRaw}"`)
      process.exit(2)
    }
  }

  const dir = process.cwd()
  if (serveStatePath(dir) === null) {
    console.error('error: not inside a git repository — bro serve needs the git common dir')
    process.exit(1)
  }
  const live = liveServeState(dir)
  if (live !== undefined) {
    console.error(`error: already serving ${live.url} (pid ${live.pid}) — one host per repo`)
    process.exit(1)
  }
  // the lock makes the singleton atomic — live-state check → write has a
  // gap two starters could both pass through; O_EXCL create cannot
  const releaseLock = acquireServeLock(dir)
  if (releaseLock === undefined) {
    console.error('error: another bro serve is starting or running (serve.json.lock held)')
    process.exit(1)
  }

  const env = loadAgentEnv(dir)
  const meta: ServeMeta = { dir, startedAt: '' }
  const server = createServer(createServeHandler(realDeps(dir, env), meta))

  try {
    const url = await new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      // 127.0.0.1 only — the loopback bind IS the trust boundary; there is
      // no --host flag to widen it with.
      server.listen(port, '127.0.0.1', () => {
        meta.startedAt = new Date().toISOString()
        const addr = server.address()
        resolve(`http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : port}`)
      })
    }).catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })

    writeServeState(dir, { pid: process.pid, url, dir, startedAt: meta.startedAt })
    console.log(`bro serve — ${url}`)
    console.log('discovery: <git-common-dir>/bro/serve.json · ctrl-c to stop')

    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        // close() waits on keep-alive sockets — cap the grace so a
        // parked connection can't hang SIGTERM forever; in-flight
        // requests get a short window to land first
        const force = setTimeout(() => {
          server.closeAllConnections()
        }, 2_000)
        server.close(() => {
          clearTimeout(force)
          resolve()
        })
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    clearServeState(dir)
  } finally {
    releaseLock()
  }
}

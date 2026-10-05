/**
 * `bro serve` — the facade host for thin clients (TUI/webui/IDE).
 * Spec: specs/sessions/bro-f4ot/spec.md.
 *
 *   bro serve [--port <n>]
 *
 * HTTP/JSON bound to 127.0.0.1 — the loopback bind IS the v1 trust
 * boundary: no remote exposure. "Local session context" is concrete:
 * writes (spawn/stop mutate agents and beads claims) must present
 * `Authorization: Bearer <token>` where the token is a per-server
 * random secret published inside serve.json — written mode 0600, so
 * read access to that file IS the authorization boundary (same-UID
 * local process, the same privilege needed to run `bro agents up`
 * directly). A browser can't mint the header cross-site (non-simple
 * headers force a preflight this server never answers) and a
 * non-owner local process can't read the file. Remote orchestration,
 * if ever, is a separate spec. The browser layers stay on top: every
 * write also refuses a non-loopback `Origin` (the browser stamps every
 * cross-site request — a foreign one is 403), and body-bearing writes
 * require `content-type: application/json` (a request a browser can't
 * make without a preflight). Every request needs a loopback `Host` —
 * a rebound name is 403 (DNS rebinding). Reads keep the Host guard
 * alone: the planes expose repo state a same-UID process can read
 * from disk anyway.
 *
 *   GET    /                    service index
 *   GET    /fleet               the fleet webui — an HTML dashboard over
 *                               /api/v1/snapshot (spec bro-1rir)
 *   GET    /api/v1/health       {ok, pid, dir, startedAt}
 *   GET    /api/v1/snapshot     the watch snapshot — mols × gates × fleet
 *   GET    /api/v1/agents       per-backend agent plane
 *   GET    /api/v1/agents/<ref> one agent — ref is agentId or molStep
 *   POST   /api/v1/agents       spawn {molStep, worktree?, prompt?|promptFile?,
 *                               connector?, beadsDir?, provider?, model?,
 *                               profile?, autoApprove?} → 201 {agent}
 *   DELETE /api/v1/agents/<ref> stop — always invokes the connector's
 *                               idempotent stop; terminal agents report
 *                               `terminal:true` + a note. A miss beside a
 *                               degraded backend is 503 (unverifiable),
 *                               a clean miss 404
 *
 * Discovery + credentials: `<git-common-dir>/bro/serve.json` {pid,
 * url, dir, startedAt, token} written on listen (tmp+rename, mode
 * 0600), removed on shutdown. A second serve on the same repo refuses
 * while the recorded pid is alive — two live servers would make the
 * file a coin flip.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import {
  gitTry,
  SpawnError,
  type AgentConnector,
  type AgentInfo,
  type SpawnErrorKind,
} from '@broject/core'
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

/** What a client needs to find and trust the server for a repo. The
 *  token is the session credential: every write must present it as
 *  `Authorization: Bearer`, and the file's 0600 mode makes "can read
 *  the token" mean "same-UID local process". */
export interface ServeState {
  pid: number
  url: string
  dir: string
  startedAt: string
  token: string
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
      typeof v.dir === 'string' &&
      typeof v.token === 'string' &&
      // an empty token would validate yet never authenticate — a
      // malformed record is torn state, not a live server
      v.token.length > 0
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
  // the file carries the session token — publish at 0600 so "can read
  // it" equals "same-UID local process". rm first so the create-mode
  // always applies (a pre-existing tmp would keep its old mode through
  // the truncate, leaving a permissive file until a later chmod); the
  // chmod then pins 0600 exactly — create-mode is `mode & ~umask`, and
  // a pathological umask could strip even owner bits, leaving the token
  // unreadable to its own clients
  rmSync(tmp, { force: true })
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
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

/** A lock file read that came back empty — the wx fallback below has a
 *  create-then-write window where a racer sees zero bytes. A fresh
 *  empty lock is in-flight (retry, never break it); one older than the
 *  grace is a crashed writer's leftover. */
const EMPTY_LOCK_GRACE_MS = 5_000

/** Filesystems where link(2) is not implemented (some fuse/9p/drvfs
 *  mounts) — the serve lock falls back to a single O_CREAT|O_EXCL
 *  write, which is the same atomic-create contract. */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

/** The lock exists — decide held vs stealable. A live pid refuses; a
 *  dead/unparseable one is broken so the next attempt wins; a fresh
 *  empty file is an in-flight wx writer (retry, don't break). */
function heldOrRetry(lock: string): 'held' | 'retry' {
  let raw: string
  let age = 0
  try {
    raw = readFileSync(lock, 'utf8')
    age = Date.now() - statSync(lock).mtimeMs
  } catch {
    // raced removal — the retry decides
    return 'retry'
  }
  if (raw.trim() === '' && age < EMPTY_LOCK_GRACE_MS) {
    return 'retry'
  }
  if (Number.isInteger(Number(raw.trim())) && raw.trim() !== '' && pidAlive(Number(raw.trim()))) {
    return 'held'
  }
  try {
    rmSync(lock, { force: true })
  } catch {
    // another starter broke it first — the retry decides
  }
  return 'retry'
}

/** One acquisition attempt — link the staged pid file over `lock`, or
 *  wx-write it on filesystems without hard links. A held lock reports
 *  'held' (live holder) or 'retry' (dead holder broken, try again). */
function tryLockOnce(staged: string, lock: string): 'acquired' | 'held' | 'retry' {
  try {
    linkSync(staged, lock)
    return 'acquired'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      return heldOrRetry(lock)
    }
    if (!NO_HARDLINK_CODES.has(code ?? '')) {
      throw err
    }
  }
  // wx = create-then-write — a writer paused past EMPTY_LOCK_GRACE_MS
  // mid-call can have its still-empty lock broken and the path stolen;
  // the re-read proves the lock still names us before the acquisition
  // counts (a stolen path holds the thief's pid, or nothing at all)
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return heldOrRetry(lock)
    }
    throw err
  }
  try {
    const pid = `${process.pid}`
    for (let off = 0; off < pid.length; ) {
      off += writeSync(fd, pid.slice(off))
    }
  } finally {
    closeSync(fd)
  }
  try {
    return readFileSync(lock, 'utf8') === `${process.pid}` ? 'acquired' : 'retry'
  } catch {
    // the path no longer names our file — broken mid-write, retry
    return 'retry'
  }
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
    // extra attempts with a beat between them cover the wx fallback's
    // create-then-write window — a live writer fills the lock in
    // microseconds, so a fresh-empty verdict resolves on retry 2+
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const verdict = tryLockOnce(staged, lock)
      if (verdict === 'acquired') {
        return () => releaseServeLock(lock)
      }
      if (verdict === 'held') {
        return undefined
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
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

/** State-changing methods — the Origin allowlist applies to all of
 *  them, not just the body-carrying ones: DELETE writes too. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** A browser stamps every cross-site request — and every same-site
 *  POST — with `Origin`. Loopback origins are the fleet webui and
 *  local tooling; anything else (or unparseable) is a foreign page. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    // origin-shaped only — `http://localhost/path` parses to a loopback
    // hostname but is not a value a browser would send as Origin
    return (
      parsed.origin === origin &&
      (parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

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
  'provider',
  'model',
  'profile',
  'autoApprove',
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
    if (k === 'autoApprove') {
      if (v !== undefined && typeof v !== 'boolean') {
        throw new HttpError(400, 'field "autoApprove" must be a boolean')
      }
    } else if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) {
      // an empty string is not "unset" — it would ride through as an
      // empty argv element or lookup key and fail AFTER the 201
      throw new HttpError(400, `field "${k}" must be a non-empty string`)
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
    provider: req.provider as string | undefined,
    model: req.model as string | undefined,
    profile: req.profile as string | undefined,
    autoApprove: req.autoApprove as boolean | undefined,
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
      // honest statuses: a claim refusal is a conflict, a missing
      // command config is the server's problem, a dead backend is
      // unavailable — one flat 409 lied about all three
      const status = SPAWN_ERROR_STATUS[err.kind]
      return { status, body: { error: err.message } }
    }
    throw err
  }
}

const SPAWN_ERROR_STATUS: Record<SpawnErrorKind, number> = {
  conflict: 409,
  input: 400,
  config: 500,
  unavailable: 503,
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
      ...(outcome.cleared === true ? { cleared: true } : {}),
      ...(outcome.terminal === true && outcome.agent !== undefined
        ? {
            note:
              outcome.cleared === true
                ? 'blocked — cleared'
                : `already ${outcome.agent.state}`,
          }
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

  // one comparison — a compound condition would push route() over the
  // SonarCloud cognitive-complexity ceiling; join() tolerates stray slashes
  if (seg.join('/') === 'fleet') {
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

/** The session-token check — a write must carry `Authorization:
 *  Bearer <token>` (scheme case-insensitive, token exact). Constant-time
 *  compare: the token is a
 *  random secret, so the compare is hygiene, not load-bearing — but a
 *  naive === would leak prefix length to a same-box attacker who
 *  somehow can't read the 0600 file. */
function bearerMatch(header: string | undefined, token: string): boolean {
  // string ops, not a regex — the credential check stays linear even on
  // a megabyte-long header a hostile client could send. The auth SCHEME
  // is case-insensitive (RFC 7235); the token compare stays exact
  const presented =
    header?.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7) : ''
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(token, 'utf8')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** The guards on state-changing requests — returns the refusal to
 *  send, or undefined when the write may proceed. Order: bearer token
 *  first (the "local session context" check — spawn/stop mutate agents
 *  and beads claims, so the caller must present the session token from
 *  serve.json, mode 0600 — normally readable only by the owner, so
 *  possession means a same-UID process, the privilege `bro agents up`
 *  itself needs; a browser can't send Authorization cross-site without
 *  a preflight we never answer), then the Origin allowlist (a hostile
 *  page can't hide its Origin — a present-but-foreign one is refused;
 *  Origin-less clients like curl/TUI/node fetch pass, the content-type
 *  gate is the second barrier for the simple-request shape), then the
 *  non-simple content-type on body-bearing writes (a browser can't
 *  send it cross-site without a preflight this server never answers). */
function writeGuard(
  req: IncomingMessage,
  token: string,
  wantsBody: boolean,
  statePathHint: string
): ServeResponse | undefined {
  if (!bearerMatch(req.headers.authorization, token)) {
    return {
      status: 401,
      body: {
        error: `session token required — read it from ${statePathHint}`,
      },
      headers: { 'www-authenticate': 'Bearer' },
    }
  }
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return { status: 403, body: { error: 'loopback origin only' } }
  }
  if (wantsBody && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return { status: 415, body: { error: 'writes need content-type: application/json' } }
  }
  return undefined
}

export function createServeHandler(
  deps: ServeDeps,
  meta: ServeMeta,
  token: string
): (req: IncomingMessage, res: ServerResponse) => void {
  // resolved once at handler creation — the path is stable for the
  // server lifetime, and a per-request resolve would spawnSync('git')
  // on every unauthenticated write, blocking the loop under 401 spam
  const statePathHint =
    serveStatePath(meta.dir) ?? '<git-common-dir>/bro/serve.json'
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
        const wantsBody =
          req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
        if (WRITE_METHODS.has(req.method ?? 'GET')) {
          const refusal = writeGuard(req, token, wantsBody, statePathHint)
          if (refusal !== undefined) {
            send(res, refusal.status, refusal.body, refusal)
            return
          }
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
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
  // the session token — the "local session context" made concrete.
  // Generated per serve, never printed: clients read it out of the
  // 0600 serve.json below, so possession implies same-UID file access
  const token = randomBytes(32).toString('hex')
  const server = createServer(createServeHandler(realDeps(dir, env), meta, token))

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

    writeServeState(dir, { pid: process.pid, url, dir, startedAt: meta.startedAt, token })
    // filesystems that ignore mode bits (some fuse/9p/drvfs mounts) can
    // leave the token group/other-readable — the auth boundary then
    // doesn't hold, so say so loudly rather than trusting silently
    const statePath = serveStatePath(dir)
    if (statePath !== null && (statSync(statePath).mode & 0o077) !== 0) {
      console.error(
        `warning: ${statePath} is readable by group/other — the session token is exposed to other local users on this filesystem`
      )
    }
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

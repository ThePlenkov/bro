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
 *                               the read planes below (spec bro-w4a45)
 *   GET    /ui                  the plane-catalog dashboard — one panel
 *                               per descriptor, index-driven (bro-9rls.4)
 *   GET    /api/v1/events/stream  SSE over the bus — Last-Event-ID
 *                               `<gen>:<seq>` resume, gap→re-derive
 *   GET    /api/v1/events/asyncapi.json
 *                               generated AsyncAPI 3.x for the stream
 *   GET    /api/v1/health       {ok, pid, dir, startedAt}
 *   GET    /api/v1/snapshot     the watch snapshot — mols × gates × fleet × loop
 *   GET    /api/v1/agents       the agents board — per-backend registry
 *                               agents + occupancy + armed quota lanes +
 *                               session-plane discovery rows
 *   GET    /api/v1/agents/<ref>/log?lines=N[&follow]
 *                               one-shot text/plain tail of the agent's
 *                               log; `follow` upgrades to text/event-stream
 *                               (replay lands as data: frames, followLog
 *                               notes as `event: note`). Bearer- or
 *                               `?token=`gated like the writes — the log
 *                               can carry secrets, loopback alone is not
 *                               the auth boundary.
 *   GET    /api/v1/agents/<ref>/events?lines=N[&follow]
 *                               the 'agent' bus topic scoped to one
 *                               worker (bro-0ppt0): `follow` streams SSE
 *                               through the broker key-filtered to the
 *                               agent; plain GET tails the durable
 *                               .events.jsonl archive as NDJSON. Same
 *                               credential boundary as the log route.
 *   GET    /api/v1/terminals/<id>/output[?follow]
 *                               the conductor's acp terminal registry
 *                               (bro-eua0d) — a REAL shell the agent ran:
 *                               {output, truncated, exitStatus} JSON, or
 *                               `follow` → SSE data: chunks + `event: exit`.
 *                               Same credential rule as the log route.
 *   GET    /api/v1/queue        the beads queue — claimed (in-progress)
 *                               work + ready depth (`bro status` shape)
 *   GET    /api/v1/ticks        supervision — the watch heartbeat file,
 *                               the drive singleton lock, pending watch
 *                               markers (armed waits: live pid or stale)
 *   GET    /api/v1/mailbox      {drops} — the notify tail: pending drops,
 *                               newest first, read-only (consumes nothing)
 *   GET    /api/v1/planes       the plane-catalog index — every registered
 *                               descriptor with its reads, verbs, and live
 *                               capabilities (specs/bro-9rls.1.md)
 *   GET    /api/v1/planes/<p>   the plane's list(?status&limit&filters)
 *   GET    /api/v1/planes/<p>/<name>
 *                               a declared named read, else get(<name>)
 *   POST   /api/v1/planes/<p>/<verb>
 *                               exec — the body IS the args object; the
 *                               uniform write shape under the same
 *                               serve.json-token gate as every write
 *   GET    /api/v1/agents/<ref> one agent — ref is agentId or molStep
 *   POST   /api/v1/agents       spawn {molStep, worktree?, prompt?|promptFile?,
 *                               connector?, beadsDir?, provider?, model?,
 *                               profile?, class?, autoApprove?} → 201 {agent}
 *   DELETE /api/v1/agents/<ref> stop — always invokes the connector's
 *                               idempotent stop; terminal agents report
 *                               `terminal:true` + a note. A miss beside a
 *                               degraded backend is 503 (unverifiable),
 *                               a clean miss 404
 *   POST   /api/v1/webhooks/github  GitHub webhook ingest → `github:*`
 *                               bus topics (spec specs/bro-huy5o.7.md).
 *                               Armed by BRO_GITHUB_WEBHOOK_SECRET; the
 *                               X-Hub-Signature-256 HMAC is the auth —
 *                               this route bypasses the bearer AND Host
 *                               guards so a hosted tunnel whose Host is
 *                               not loopback still reaches it
 *   ALL    /v1/*                the Messages-API provider plane
 *                               (bro-om6m8): a byte-proxy to the env-
 *                               configured upstream — claude-code
 *                               pointed at ANTHROPIC_BASE_URL=<serve>
 *                               talks to Anthropic THROUGH bro. Streams
 *                               below the JSON envelope; wired only when
 *                               BRO_PROVIDER_API_KEY (or ANTHROPIC_*)
 *                               is set in the server env — the session
 *                               token is still required, it is the
 *                               client-side credential
 *
 * Discovery + credentials: `<git-common-dir>/bro/serve.json` {pid,
 * url, dir, startedAt, token} written on listen (tmp+rename, mode
 * 0600), removed on shutdown. A second serve on the same repo refuses
 * while the recorded pid is alive — two live servers would make the
 * file a coin flip.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import {
  busPublish,
  busSocketPath,
  busSubscribe,
  deliverSinks,
  gitCommonDir,
  gitTry,
  holdFileLock,
  LockTimeout,
  lockHolderPid,
  mainWorktreeRoot,
  peekMailbox,
  planes,
  SpawnError,
  staleLock,
  startBusBroker,
  type AgentConnector,
  type AgentInfo,
  type BusBroker,
  type EventInput,
  type HeldLockOptions,
  type PlaneDescriptor,
  type SpawnErrorKind,
} from '@broject/core'
import { GITHUB_WEBHOOK_SECRET_ENV, githubWebhookHandler } from '@broject/github'
import { listWatches, prStateCache, watchMarkerKind } from '@broject/act'
import {
  agentConnectorNames,
  loadAgentEnv,
  pidAlive,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import {
  collectAgentBackends,
  discoverSessions,
  findAgent,
  followLog,
  occupancyOf,
  sessionQuotaViewsOf,
  SpawnInputError,
  spawnStepAgent,
  stopAgent,
  tailLines,
  type AgentBackendPlane,
  type DiscoveredAgentSession,
  type FleetOccupancy,
  type SessionQuotaView,
  type StepSpawnRequest,
  type StopOutcome,
} from './agents.ts'
import { flag, positionals } from './args.ts'
import { loadBroConfig } from '../plugins.ts'
import '../planes/index.ts'
import { routePlanes } from '../planes/rest.ts'
import {
  asyncapiDocument,
  openEventsSse,
  routeEventsStream,
  type EventsStreamBus,
} from '../planes/stream.ts'
import { providerConfig, providerProxy, type ProviderConfig } from './serve-provider.ts'
import { conductorConfig, conductorProxy, type ConductorConfig } from './serve-conductor.ts'
import type { AcpTerminals, TerminalFollow } from '@broject/providers'
import { readBeads } from './status.ts'
import { collectSnapshot } from './watch.ts'
import { readHeartbeat, type HeartbeatSummary } from './watch-heartbeat.ts'
import { FLEET_PAGE, WEBUI_CSP } from './webui.ts'
import { UI_CSP, UI_PAGE } from './ui-page.ts'

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
  /** The `/v1/*` provider plane is wired (bro-om6m8.1) — `bro provider`
   *  resolution skips facade-only serves so `url` never names an
   *  endpoint whose Messages routes 404. Absent on pre-flag files:
   *  treated as unwired, which is the safe read. */
  provider?: boolean
}

/** `<git-common-dir>/bro/serve.json` — shared across linked worktrees,
 *  same anchor as agents.json and the hooks markers. Null outside a
 *  repo. */
export function serveStatePath(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'serve.json')
}

/** The state-file read — full-record validation shared by serve.json
 *  and provider.json: a torn/garbage entry is not a state. */
export function readStateFile(path: string): ServeState | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServeState>
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

export function readServeState(dir: string): ServeState | undefined {
  const path = serveStatePath(dir)
  return path === null ? undefined : readStateFile(path)
}

/** tmp+rename — readers never see a half-written state file. Path-based:
 *  serve.json (repo) and provider.json (host) share the discipline. */
export function writeStateFile(path: string, state: ServeState): void {
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

export function writeServeState(dir: string, state: ServeState): void {
  const path = serveStatePath(dir)
  if (path === null) {
    throw new Error('no git common dir — cannot write serve.json')
  }
  writeStateFile(path, state)
}

/** Remove the state file only while it still names THIS process — a
 *  successor that already rewrote it must not be unregistered by the
 *  dying predecessor's cleanup. */
export function clearStateFile(path: string): void {
  try {
    const state = readStateFile(path)
    if (state !== undefined && state.pid === process.pid) {
      rmSync(path, { force: true })
    }
  } catch {
    // best-effort — the stale-pid check on next start covers leftovers
  }
}

export function clearServeState(dir: string): void {
  const path = serveStatePath(dir)
  if (path !== null) {
    clearStateFile(path)
  }
}

/** A recorded serve whose pid is still alive — a second `bro serve`
 *  refuses to start against this (two servers, one discovery file). */
export function liveServeState(dir: string): ServeState | undefined {
  const state = readServeState(dir)
  return state !== undefined && pidAlive(state.pid) ? state : undefined
}

/** `<serve.json>.lock` — the singleton gate, so two starters can't
 *  both pass the live-state check and both write serve.json. The hold
 *  rides `holdFileLock` (spec bro-2duu9): heartbeated for the server's
 *  whole lifetime so a >15min serve never reads abandoned to the
 *  janitor's `*.lock` sweep or to filelock contenders — the file
 *  carries the shared `pid:token` shape. A live foreign holder refuses,
 *  a dead/tokenless leftover is stolen. Returns the release, or
 *  undefined when another server holds it. */
export function acquireServeLock(
  dir: string,
  opts: HeldLockOptions = {}
): (() => void) | undefined {
  const statePath = serveStatePath(dir)
  if (statePath === null) {
    return undefined
  }
  try {
    // a held lock refuses the start, not waits — the small bound only
    // covers stealing a dead holder's leftover and the re-link after
    return holdFileLock(`${statePath}.lock`, {
      waitMs: 250,
      label: 'serve lock',
      ...opts,
    })
  } catch (err) {
    if (err instanceof LockTimeout) {
      return undefined
    }
    throw err
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
/** A webhook ingest endpoint — verify, map, publish. The handler owns
 *  provider semantics (signature, body encodings, event mapping); serve
 *  owns transport only. Absent from deps means no ingest is wired —
 *  the route 404s like any unknown path. */
export type ServeWebhookRequest = {
  headers: Record<string, string | string[] | undefined>
  rawBody: string
}

export type ServeWebhookHandler = (
  req: ServeWebhookRequest
) => Promise<{ status: number; body: unknown }>

/** The /api/v1/agents payload beyond the backend list — `bro agents
 *  status --json` parity (fleet occupancy + armed session-quota lanes)
 *  plus session-plane discovery rows the registry never spawned
 *  (interactive/foreign sessions, acp workers a legacy path skipped
 *  registering). `degraded` carries discovery-plane failures — backend
 *  list failures still ride their own per-backend note. */
export interface AgentsBoard {
  backends: AgentBackendPlane[]
  occupancy: FleetOccupancy
  sessions: SessionQuotaView[]
  discovered: DiscoveredAgentSession[]
  degraded: string[]
}

export interface ServeDeps {
  snapshot(): Promise<unknown>
  agents(): Promise<AgentsBoard>
  /** The beads queue — claimed (in-progress) + ready depth. */
  queue(): Promise<unknown>
  /** Supervision — heartbeat, drive lock, pending watches. */
  ticks(): Promise<unknown>
  /** The notify tail — pending drops, newest first. */
  mailbox(): Promise<unknown>
  find(
    ref: string
  ): Promise<{ hit?: { conn: AgentConnector; agent: AgentInfo }; degraded: string[] }>
  spawn(req: StepSpawnRequest): Promise<AgentInfo>
  stop(ref: string): Promise<StopOutcome>
  connectors(): string[]
  /** `/api/v1/planes*` — the descriptor-catalog surface (spec
   *  bro-9rls.1): absent → the whole subtree 404s like any unwired
   *  plane. Sync — planes() builds descriptors, capabilities() is the
   *  live probe. */
  planeCatalog?(): PlaneDescriptor[]
  /** `/api/v1/events/stream` — the SSE bus seam (spec bro-9rls.5).
   *  Absent or a null socket → 503; the route is a raw stream below
   *  the ServeResponse envelope, read-only under the Host guard. */
  eventsBus?(): EventsStreamBus
  /** `/api/v1/events/asyncapi.json` — the generated doc; absent
   *  unwires the route to a plain 404. */
  asyncApi?(): unknown
  /** `/api/v1/webhooks/<provider>` handlers keyed by provider slug. */
  webhooks?: Record<string, ServeWebhookHandler>
  /** `/v1/*` Messages-API provider proxy (bro-om6m8) — raw-stream,
   *  below the ServeResponse envelope: real request bodies exceed the
   *  256KB read cap and SSE answers must pipe. Absent means no
   *  upstream credential — the route 404s like any unknown path. */
  provider?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** `/api/v1/terminals/<id>/output` — the conductor's live acp
   *  terminal registry (bro-eua0d). Absent → the route 404s like any
   *  unwired plane (no conductor, no agent shells to read). */
  terminals?: () => AcpTerminals | undefined
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
  'GET /ui',
  'GET /api/v1/health',
  'GET /api/v1/snapshot',
  'GET /api/v1/agents',
  'GET /api/v1/queue',
  'GET /api/v1/ticks',
  'GET /api/v1/mailbox',
  'GET /api/v1/planes',
  'GET /api/v1/planes/<plane>',
  'GET /api/v1/planes/<plane>/<read|ref>',
  'POST /api/v1/planes/<plane>/<verb>',
  'GET /api/v1/events/stream',
  'GET /api/v1/events/asyncapi.json',
  'POST /api/v1/agents',
  'GET /api/v1/agents/<ref>',
  'GET /api/v1/agents/<ref>/log',
  'GET /api/v1/agents/<ref>/events',
  'GET /api/v1/terminals/<id>/output',
  'DELETE /api/v1/agents/<ref>',
  'POST /api/v1/webhooks/github',
  'ALL /v1/*',
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
  'class',
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
    class: req.class as string | undefined,
    autoApprove: req.autoApprove as boolean | undefined,
  }
}

/** Serialize the agents board for the wire — `bro agents status
 *  --json` shape (occupancy, armed quota lanes, per-backend agents)
 *  plus the discovery rows. Conn objects never cross the wire; their
 *  capabilities do, so a thin client renders the supervisor column. */
function agentsJson(board: AgentsBoard): unknown {
  return {
    occupancy: board.occupancy,
    sessions: board.sessions,
    discovered: board.discovered,
    backends: board.backends.map(({ conn, agents, degraded }) => ({
      name: conn.name,
      capabilities: conn.capabilities(),
      agents,
      ...(degraded !== undefined ? { degraded } : {}),
    })),
    ...(board.degraded.length > 0 ? { degraded: board.degraded } : {}),
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
  meta: ServeMeta,
  headers: Record<string, string | string[] | undefined> = {},
  query: Record<string, string> = {}
): Promise<ServeResponse> {
  try {
    return await route(method, pathname, rawBody, deps, meta, headers, query)
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

/** A GET-only read plane — the snapshot/queue/ticks/mailbox shape:
 *  non-GET 405s, the body is whatever the dep collected. Dep failures
 *  propagate to the handler's 500 — a plane that can't compose at all
 *  is an outage, not a degraded payload. */
async function routePlane(
  method: string,
  read: () => Promise<unknown>
): Promise<ServeResponse> {
  if (method !== 'GET') {
    return NOT_ALLOWED
  }
  return { status: 200, body: await read() }
}

async function routeAgents(
  method: string,
  rawBody: string | undefined,
  deps: ServeDeps
): Promise<ServeResponse> {
  if (method === 'GET') {
    return { status: 200, body: agentsJson(await deps.agents()) }
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
  cap: 503,
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

/** The site routes — read-only HTML pages; the loopback Host check
 *  guards them like every other route. `fleet` is the bespoke snapshot
 *  view (spec bro-w4a45); `ui` is the index-driven catalog dashboard
 *  (bro-9rls.4). */
const PAGES: Record<string, { body: string; csp: string }> = {
  fleet: { body: FLEET_PAGE, csp: WEBUI_CSP },
  ui: { body: UI_PAGE, csp: UI_CSP },
}

function routePage(method: string, page: { body: string; csp: string }): ServeResponse {
  if (method !== 'GET') {
    return NOT_ALLOWED
  }
  return {
    status: 200,
    body: page.body,
    contentType: 'text/html; charset=utf-8',
    headers: { 'content-security-policy': page.csp },
  }
}

/** The GET-only read planes all share the routePlane shape — a table
 *  keeps route()'s dispatch flat enough for the SonarCloud ceiling. */
const READ_PLANES: Record<string, (deps: ServeDeps) => Promise<unknown>> = {
  snapshot: (deps) => deps.snapshot(),
  queue: (deps) => deps.queue(),
  ticks: (deps) => deps.ticks(),
  mailbox: (deps) => deps.mailbox(),
}

async function route(
  method: string,
  pathname: string,
  rawBody: string | undefined,
  deps: ServeDeps,
  meta: ServeMeta,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string>
): Promise<ServeResponse> {
  const seg = pathname.split('/').filter((s) => s !== '')

  if (method === 'GET' && seg.length === 0) {
    return { status: 200, body: { service: 'bro', routes: ROUTES } }
  }

  // a table lookup keeps route() under the SonarCloud ceiling —
  // a compound condition per site page would not
  const page = seg.length === 1 ? PAGES[seg[0]!] : undefined
  if (page !== undefined) {
    return routePage(method, page)
  }

  const api = seg[0] === 'api' && seg[1] === 'v1' ? seg.slice(2) : undefined
  if (api === undefined || api.length === 0) {
    return NOT_FOUND
  }

  if (api[0] === 'health' && api.length === 1) {
    return routeHealth(method, meta)
  }
  const plane = api.length === 1 ? READ_PLANES[api[0]!] : undefined
  if (plane !== undefined) {
    return routePlane(method, () => plane(deps))
  }
  return routeApiBranch(method, api, rawBody, deps, headers, query)
}

/** The deeper `/api/v1/*` dispatch — kept out of `route` so the top
 *  dispatcher stays under the SonarCloud cognitive ceiling. */
function routeApiBranch(
  method: string,
  api: string[],
  rawBody: string | undefined,
  deps: ServeDeps,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string>
): ServeResponse | Promise<ServeResponse> {
  if (api[0] === 'events' && api[1] === 'asyncapi.json' && api.length === 2) {
    const doc = deps.asyncApi?.()
    return doc === undefined ? NOT_FOUND : routePlane(method, () => Promise.resolve(doc))
  }
  if (api[0] === 'planes') {
    return routePlanes(method, api, rawBody, deps.planeCatalog?.(), query)
  }
  if (api[0] === 'agents') {
    return routeAgentsBranch(method, api, rawBody, deps)
  }
  if (api[0] === 'webhooks') {
    return routeWebhook(method, api, rawBody, deps, headers)
  }
  return NOT_FOUND
}

/** The `/agents` subtree — list+spawn at the collection, ref ops one
 *  level deeper. Kept out of `route` so the top dispatch stays flat
 *  enough for the SonarCloud cognitive ceiling. */
function routeAgentsBranch(
  method: string,
  api: string[],
  rawBody: string | undefined,
  deps: ServeDeps
): ServeResponse | Promise<ServeResponse> {
  if (api.length === 1) {
    return routeAgents(method, rawBody, deps)
  }
  if (api.length === 2) {
    return routeAgentRef(method, api[1]!, deps)
  }
  return NOT_FOUND
}

/** The `/webhooks/<provider>` ingest — POST only, handler lookup by
 *  provider slug. An unwired provider 404s like any unknown path. */
function routeWebhook(
  method: string,
  api: string[],
  rawBody: string | undefined,
  deps: ServeDeps,
  headers: Record<string, string | string[] | undefined>
): ServeResponse | Promise<ServeResponse> {
  const handler = api.length === 2 ? deps.webhooks?.[api[1]!] : undefined
  if (handler === undefined) {
    return NOT_FOUND
  }
  if (method !== 'POST') {
    return NOT_ALLOWED
  }
  return handler({ headers, rawBody: rawBody ?? '' })
}

// --- server ----------------------------------------------------------------------------

export function send(
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
  return tokenEq(presented, token)
}

/** Constant-time token compare — the shared core of bearerMatch and
 *  the `?token=` SSE fallback. An empty presented token fails closed:
 *  `?token=` on a log route must never validate. */
function tokenEq(presented: string, token: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(token, 'utf8')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** The provider credential check — the session token presented as
 *  EITHER `Authorization: Bearer` or `x-api-key`. Claude Code puts
 *  apiKeyHelper/ANTHROPIC_API_KEY output in `x-api-key`; accepting
 *  only the Bearer header would 401 a client that authenticates
 *  correctly. Same constant-time compare. */
function apiKeyMatch(header: string | string[] | undefined, token: string): boolean {
  const presented = Array.isArray(header) ? header[0] : header
  if (presented === undefined || presented === '') {
    return false
  }
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(token, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** `/v1/*` write guard — writeGuard's shape (bearer → Origin →
 *  content-type) but the credential accepts x-api-key too: the
 *  provider contract is "the session token IS the API key". */
export function providerGuard(
  req: IncomingMessage,
  token: string,
  wantsBody: boolean,
  statePathHint: string
): ServeResponse | undefined {
  const credentialed =
    bearerMatch(req.headers.authorization, token) ||
    apiKeyMatch(req.headers['x-api-key'], token)
  if (!credentialed) {
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

/** DNS-rebinding guard: a rebound browser request still carries the
 *  attacker's Host — only loopback names are real clients. Covers
 *  reads too: CSRF only blinds the response, rebinding would expose
 *  the snapshot/agents planes to the page. */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const rawHost = (hostHeader ?? '').toLowerCase()
  const host = rawHost.startsWith('[')
    ? rawHost.slice(0, rawHost.indexOf(']') + 1)
    : rawHost.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

/** One request's guard → route → send pipeline, lifted out of the
 *  handler closure so each level stays under the SonarCloud
 *  cognitive-complexity ceiling. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServeDeps,
  meta: ServeMeta,
  token: string,
  statePathHint: string
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Webhook routes carry their own auth — the delivery's HMAC
    // signature — so they bypass BOTH guards below: the loopback
    // Host check (a hosted tunnel forwards with a public Host, and
    // rejecting it would defeat hosted mode) and the bearer write
    // guard (the producer can't read serve.json). Nothing else is
    // special: a mis-signed POST is a 401 inside the handler and
    // the 202 body leaks nothing (spec specs/bro-huy5o.7.md).
    const webhookRoute = url.pathname.startsWith('/api/v1/webhooks/')
    if (!webhookRoute && !isLoopbackHostHeader(req.headers.host)) {
      send(res, 403, { error: 'loopback host only' })
      return
    }
    // self-answering routes chain first — each returns true once it
    // owns the response (guarded refusal, SSE upgrade, or a 404 it
    // alone can phrase); anything else falls through to the envelope
    const routed =
      (await routeProvider(req, res, url.pathname, deps, token, statePathHint)) ||
      (await routeAgentLog(req, res, url, deps, token, statePathHint)) ||
      (await routeAgentEvents(req, res, url, deps, token, statePathHint)) ||
      (await routeTerminalOutput(req, res, url, deps, token, statePathHint)) ||
      (await routeEventsStream(req, res, url.pathname, deps.eventsBus?.()))
    if (routed) {
      return
    }
    const wantsBody =
      req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
    if (!webhookRoute && WRITE_METHODS.has(req.method ?? 'GET')) {
      const refusal = writeGuard(req, token, wantsBody, statePathHint)
      if (refusal !== undefined) {
        send(res, refusal.status, refusal.body, refusal)
        return
      }
    }
    const rawBody = wantsBody ? await readBody(req) : undefined
    const r = await routeRequest(
      req.method ?? 'GET',
      url.pathname,
      rawBody,
      deps,
      meta,
      req.headers,
      Object.fromEntries(url.searchParams)
    )
    send(res, r.status, r.body, r)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    send(res, status, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The provider plane owns its own stream — a Messages request can
 *  carry a whole session context (megabytes) and an SSE answer
 *  pipes for minutes; neither fits the readBody cap nor the
 *  ServeResponse envelope. The credential check is the same one
 *  writes pay — the session token IS the provider credential — but
 *  it applies to every method, GETs included: an unauthenticated
 *  /v1/* could spend the upstream key even blinded to the answer.
 *  True once the /v1/* path is answered (guarded refusal, unwired
 *  404, or proxied); any other path falls through to the JSON
 *  routes. */
async function routeProvider(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ServeDeps,
  token: string,
  statePathHint: string
): Promise<boolean> {
  if (!pathname.startsWith('/v1/')) {
    return false
  }
  const wantsBody =
    req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
  const refusal = providerGuard(req, token, wantsBody, statePathHint)
  if (refusal !== undefined) {
    send(res, refusal.status, refusal.body, refusal)
    return true
  }
  if (deps.provider === undefined) {
    send(res, 404, {
      error:
        'provider not wired — set BRO_PROVIDER_API_KEY (or ANTHROPIC_API_KEY) in the server env',
    })
    return true
  }
  await deps.provider(req, res)
  return true
}

/** `GET /api/v1/agents/<ref>/log` — the SSE leg sits below the
 *  ServeResponse envelope: `follow` upgrades the response and pipes
 *  for as long as the client stays. The plain tail could fit the
 *  envelope — but BOTH legs stay here: route()/routeAgentsBranch
 *  carry no request headers or token, so the credential check would
 *  be unenforceable inside routeRequest. The divergence is deliberate
 *  and confined to this function. Auth is write-grade: log payloads
 *  can carry secrets, so the loopback bind is the transport boundary,
 *  not the auth one. Credentials: Bearer
 *  like the writes, or `?token=` for EventSource clients that can't
 *  set headers — the query-param fallback is a known CWE-598 tradeoff
 *  (URL-borne secrets can land in access logs/browser history; this
 *  server keeps no request log and serves loopback only, and the
 *  token itself is the 0600 serve.json file a same-UID process can
 *  already read). True once the path matches — any verdict
 *  (401/404/405/422 or the stream); false lets other paths through. */
async function routeAgentLog(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServeDeps,
  token: string,
  statePathHint: string
): Promise<boolean> {
  const m = /^\/api\/v1\/agents\/([^/]+)\/log$/.exec(url.pathname)
  if (m === null) {
    return false
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method not allowed' })
    return true
  }
  const credentialed =
    bearerMatch(req.headers.authorization, token) ||
    tokenEq(url.searchParams.get('token') ?? '', token)
  if (!credentialed) {
    send(
      res,
      401,
      { error: `session token required — read it from ${statePathHint}` },
      { headers: { 'www-authenticate': 'Bearer' } }
    )
    return true
  }
  let ref: string
  try {
    ref = parseRef(m[1]!)
  } catch (err) {
    // keep the refusal local — a bad ref answers 400 here rather than
    // escaping to handleRequest's catch, which would try to write an
    // error body after this route's stream may already have started
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message })
      return true
    }
    throw err
  }
  const { hit, degraded } = await deps.find(ref)
  if (!hit) {
    send(res, 404, missBody(ref, degraded))
    return true
  }
  const log = logTarget(hit.agent)
  if ('status' in log) {
    send(res, log.status, { error: log.error })
    return true
  }
  const replay = readLogTail(log.path)
  if (!url.searchParams.has('follow')) {
    send(res, 200, tailLines(replay.text, logLineCount(url)), {
      contentType: 'text/plain; charset=utf-8',
    })
    return true
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const sse = (chunk: string) => {
    if (res.writableEnded || res.destroyed) {
      return
    }
    // drop the trailing newline BEFORE fanning \n out to `data: ` —
    // otherwise a newline-terminated chunk ends the frame on an empty
    // `data:` field, polluting the client's event payload
    const trimmed = chunk.replace(/\n$/, '')
    res.write(`data: ${trimmed.replace(/\n/g, '\ndata: ')}\n\n`)
  }
  sse(tailLines(replay.text, logLineCount(url)))
  const handle = followLog(
    log.path,
    {
      data: sse,
      note: (line) => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: note\ndata: ${line}\n\n`)
        }
      },
    },
    // replay.byteLength is the TRUE file size at snapshot — followLog
    // offsets from there, so appends after the bounded tail read still
    // stream and never get skipped
    { startOffset: replay.byteLength }
  )
  res.on('close', () => handle.stop())
  return true
}

/** GET /api/v1/agents/<id>/events — the agent-scoped leg of the bus's
 *  'agent' topic (bro-0ppt0). Same credential surface as the log
 *  route: the structured stream reveals exactly what the .log renders,
 *  so the same same-UID token boundary applies.
 *
 *  `?follow` → SSE through the broker, filtered broker-side to this
 *  agent's event key — the live tail.
 *  plain GET → the durable `.events.jsonl` archive tail (NDJSON) —
 *  the archive is the record the ring only mirrors transiently. */
async function routeAgentEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServeDeps,
  token: string,
  statePathHint: string
): Promise<boolean> {
  const m = /^\/api\/v1\/agents\/([^/]+)\/events$/.exec(url.pathname)
  if (m === null) {
    return false
  }
  return routeAgentEventsImpl(req, res, url, deps, token, statePathHint, m)
}

/** `GET /api/v1/terminals/<id>/output` — the conductor's acp terminal
 *  registry (bro-eua0d): the agent's shells spawn inside THIS process,
 *  so the buffer a `terminal/output` poll reads is a real shell, not a
 *  transcript line. Same raw-stream seat and credential rule as the
 *  agent-log route (bearer or `?token=` — output can carry secrets;
 *  route()/routeRequest carry no headers, so the check lives here).
 *  Plain GET answers the `terminal/output` wire shape as JSON;
 *  `?follow` upgrades to SSE — the buffer at subscribe time lands as
 *  `data:` frames (atomic with the taps, nothing slips between), live
 *  chunks follow, `event: exit` carries the TerminalExitStatus JSON.
 *  True once the path matches — false lets other paths through. */
async function routeTerminalOutput(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServeDeps,
  token: string,
  statePathHint: string
): Promise<boolean> {
  const m = /^\/api\/v1\/terminals\/([^/]+)\/output$/.exec(url.pathname)
  if (m === null) {
    return false
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method not allowed' })
    return true
  }
  const credentialed =
    bearerMatch(req.headers.authorization, token) ||
    tokenEq(url.searchParams.get('token') ?? '', token)
  if (!credentialed) {
    send(
      res,
      401,
      { error: `session token required — read it from ${statePathHint}` },
      { headers: { 'www-authenticate': 'Bearer' } }
    )
    return true
  }
  const reg = deps.terminals?.()
  if (reg === undefined) {
    // no live link yet (or a non-conductor serve) — same answer the
    // other unwired planes give
    send(res, 404, { error: 'no conductor terminal registry' })
    return true
  }
  let id: string
  try {
    id = parseRef(m[1]!)
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message })
      return true
    }
    throw err
  }
  let snap: ReturnType<AcpTerminals['snapshot']>
  try {
    snap = reg.snapshot(id)
  } catch {
    send(res, 404, { error: `no terminal "${id}"` })
    return true
  }
  if (!url.searchParams.has('follow')) {
    send(res, 200, snap, { contentType: 'application/json' })
    return true
  }
  const sse = (chunk: string) => {
    if (res.writableEnded || res.destroyed) {
      return
    }
    // a trailing '\n' maps to its own empty data: line — clients strip
    // exactly one newline at dispatch, so the chunk round-trips
    // byte-exact against what plain GET's `output` carries
    res.write(`data: ${chunk.replace(/\n/g, '\ndata: ')}\n\n`)
  }
  // headers before follow() — a registry that fires `exit` at subscribe
  // time must never res.end() ahead of them, and the snapshot probe
  // above keeps the unknown-id 404 reachable now that writeHead is first
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  let handle: TerminalFollow
  try {
    handle = reg.follow(id, {
      data: sse,
      exit: (status) => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: exit\ndata: ${JSON.stringify(status)}\n\n`)
          res.end()
        }
      },
    })
  } catch {
    // released between the probe and here — the stream just opened, so
    // close it; the client's reconnect lands on the 404 above
    res.end()
    return true
  }
  sse(handle.snapshot.output)
  if (handle.completed) {
    // already-final terminal — no taps attached, the snapshot carries
    // the verdict. exitStatus alone can't gate this: it lands at the
    // child's 'exit' while 'close' still owes the last piped bytes, and
    // ending here would drop them plus leak the registered listener
    res.write(`event: exit\ndata: ${JSON.stringify(handle.snapshot.exitStatus)}\n\n`)
    res.end()
    return true
  }
  res.on('close', () => handle.stop())
  return true
}

async function routeAgentEventsImpl(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServeDeps,
  token: string,
  statePathHint: string,
  m: RegExpExecArray
): Promise<boolean> {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method not allowed' })
    return true
  }
  const credentialed =
    bearerMatch(req.headers.authorization, token) ||
    tokenEq(url.searchParams.get('token') ?? '', token)
  if (!credentialed) {
    send(
      res,
      401,
      { error: `session token required — read it from ${statePathHint}` },
      { headers: { 'www-authenticate': 'Bearer' } }
    )
    return true
  }
  let ref: string
  try {
    ref = parseRef(m[1]!)
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message })
      return true
    }
    throw err
  }
  const { hit, degraded } = await deps.find(ref)
  if (!hit) {
    send(res, 404, missBody(ref, degraded))
    return true
  }
  if (url.searchParams.has('follow')) {
    const bus = deps.eventsBus?.()
    const socket = bus?.socketPath() ?? null
    if (bus === undefined || socket === null) {
      send(res, 503, { error: 'event broker unavailable — no live bus on this repo' })
      return true
    }
    // the envelope key IS the agent id (unbadged turns key
    // `acp:<sessionId>` — those address by session, not by this route)
    await openEventsSse(req, res, bus, socket, {
      topics: ['agent'],
      keys: [hit.agent.id],
    })
    return true
  }
  // the durable archive sits next to the .log — derive from the same
  // pointer so remote-backend honesty (a URL `log`, a missing file)
  // applies identically to its structured sibling
  const log = logTarget(hit.agent)
  if ('status' in log) {
    send(res, log.status, { error: log.error })
    return true
  }
  // derive the sibling the writer actually names — bro/agents/
  // <agentId>.events.jsonl (basename pins the id to one segment so a
  // weird registry id can't walk the path). A blind .log→.events.jsonl
  // replace would silently check the log itself whenever the log's
  // name drifts (rotation, a non-standard name).
  const archive = join(dirname(log.path), `${basename(hit.agent.id)}.events.jsonl`)
  if (!existsSync(archive)) {
    send(res, 404, {
      error: `no events archive for agent ${hit.agent.id} — the worker predates the event plane or its turn never wrote`,
    })
    return true
  }
  send(res, 200, tailLines(readLogTail(archive).text, logLineCount(url)), {
    contentType: 'application/x-ndjson; charset=utf-8',
  })
  return true
}

/** The replay bound for one leg — default the CLI's 50, a non-integer
 *  or negative `lines=` falls back rather than 400ing (the CLI's own
 *  flag parser is the strict surface). */
function logLineCount(url: URL): number {
  const n = Number(url.searchParams.get('lines') ?? '50')
  return Number.isInteger(n) && n >= 0 ? n : 50
}

/** Cap on the replay read — a log's tail-N never needs the whole file,
 *  and an unbounded readFileSync on a fat agent log would block the
 *  event loop for every concurrent client. Generous next to the
 *  janitor's own tail-cap. */
const LOG_READ_CAP = 8 * 1024 * 1024

/** Read only the file's last LOG_READ_CAP bytes — plus the byte length
 *  of the WHOLE file at snapshot time, the follow offset that pins the
 *  replay boundary (never a second statSync, which could land past a
 *  janitor truncation). `text` keeps a torn head on a truncated read —
 *  tailLines drops the first partial line below. */
function readLogTail(path: string): { text: string; byteLength: number } {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const from = Math.max(0, size - LOG_READ_CAP)
    const buf = Buffer.allocUnsafe(size - from)
    const n = readSync(fd, buf, 0, buf.length, from)
    let text = buf.subarray(0, n).toString('utf8')
    // a capped read starts mid-line — drop the torn head so clients
    // never see a log fragment that begins halfway through a byte run
    if (from > 0) {
      text = text.slice(text.indexOf('\n') + 1)
    }
    return { text, byteLength: size }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/** Where the agent's log lives — a path to stream, or the refusal the
 *  route answers (remote refs name the pointer, missing files 404) —
 *  mirrors `bro fleet agents log`'s shapes. */
function logTarget(a: AgentInfo): { path: string } | { status: number; error: string } {
  if (a.log === undefined) {
    return { status: 404, error: `agent ${a.id} has no recorded log` }
  }
  // a remote backend records its attach pointer, not a file — name it
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(a.log)) {
    return { status: 422, error: `agent ${a.id}'s log is remote — ${a.log}` }
  }
  if (!existsSync(a.log)) {
    return { status: 404, error: `log missing: ${a.log} — reaped or never written` }
  }
  return { path: a.log }
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
    void handleRequest(req, res, deps, meta, token, statePathHint)
  }
}

/** The mailbox tail cap — a board shows the recent conversation, not
 *  an unbounded replay of the hour's drops. */
const MAILBOX_TAIL = 25

/** One armed wait as the ticks board reports it — the marker's own
 *  fields plus the derived liveness/kind the session-start report
 *  applies. `ageMs` is the board's staleness read (how long the watch
 *  has been armed); `alive:false` on an unreported marker is the
 *  stale-promise signal. */
export interface TickWatch {
  pr: number
  link: string
  pid: number
  /** 'wait' for an `act wait` marker, the supervisor's kind word
   *  ('drive') for a heartbeat marker. */
  kind: string
  merge?: boolean
  cleanup?: boolean
  workdir?: string
  bead?: string
  timeoutMin?: number
  startedAt?: number
  alive: boolean
  /** The marker was claimed by a session-start report — flagged, not
   *  necessarily delivered. */
  reported?: boolean
  /** A settled wait's finding — 'blocked' markers carry `blockers` and
   *  never read alive. */
  verdict?: string
  blockers?: string[]
  ageMs: number
}

/** The supervision board the /fleet ticks section renders:
 *  - `heartbeat` — heartbeat.json's last-tick summary; null = no watch
 *    has ever ticked here (ordinary state, not an error)
 *  - `drive` — the drive supervisor's singleton lock: pid + liveness +
 *    lock age (the hold is heartbeated, so a stale mtime IS a stale
 *    supervisor); no lock = no supervisor running
 *  - `watches` — pending watch markers, each with pid liveness and the
 *    kind the filename records — an unreported dead marker is the
 *    broken promise the session-start nudge flags */
export interface TickBoard {
  heartbeat: HeartbeatSummary | null
  drive: { pid: number | null; alive: boolean; ageMs?: number }
  watches: TickWatch[]
}

export function collectTicks(dir: string, now = Date.now()): TickBoard {
  const common = gitCommonDir(dir)
  const lock = common === null ? null : join(common, 'bro', 'drive.lock')
  const drivePid = lock === null ? null : lockHolderPid(lock)
  let driveAgeMs: number | undefined
  if (lock !== null && existsSync(lock)) {
    try {
      driveAgeMs = Math.max(0, now - statSync(lock).mtimeMs)
    } catch {
      // raced release — the pid/age stay unknown rather than fatal
    }
  }
  return {
    heartbeat: readHeartbeat(dir, now),
    drive: {
      pid: drivePid,
      // the contender's steal rule bounds liveness — a recycled pid on
      // an un-heartbeated lock is a dead supervisor, not a live one
      alive: drivePid !== null && pidAlive(drivePid) && lock !== null && !staleLock(lock),
      ...(driveAgeMs === undefined ? {} : { ageMs: driveAgeMs }),
    },
    watches: listWatches(dir).map((l) => ({
      pr: l.watch.pr,
      link: l.watch.link,
      pid: l.watch.pid,
      kind: watchMarkerKind(l.file, l.watch),
      merge: l.watch.merge,
      cleanup: l.watch.cleanup,
      workdir: l.watch.workdir,
      bead: l.watch.bead,
      timeoutMin: l.watch.timeoutMin,
      startedAt: l.watch.startedAt,
      alive: l.alive,
      reported: l.reported,
      verdict: l.watch.verdict,
      blockers: l.watch.blockers,
      ageMs: Number.isFinite(l.watch.startedAt)
        ? Math.max(0, now - l.watch.startedAt)
        : 0,
    })),
  }
}

/** A verified github delivery moved the gate's inputs — the shared
 *  feed's next read must fetch, not serve pre-event state to the
 *  `act wait` the event just woke (bro-0tcrl). Mirror of
 *  `githubEventConcernsPr`: a delivery naming PRs drops those entries;
 *  one naming none (a base-branch check_suite, a hand-published
 *  event) concerns every waiter, so it drops the whole feed. */
function dropActStateForEvent(dir: string, event: EventInput): void {
  try {
    const cache = prStateCache(dir)
    if (cache === null) {
      return
    }
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {}
    const prs = payload['prs']
    const repo = payload['repo']
    if (
      Array.isArray(prs) &&
      prs.length > 0 &&
      prs.every((n): n is number => typeof n === 'number') &&
      typeof repo === 'string'
    ) {
      for (const pr of prs) {
        cache.invalidate({ repo, pr })
      }
      return
    }
    cache.invalidateAll()
  } catch {
    // freshness polish — a missed drop is bounded by the feed's ttl
  }
}

function realDeps(
  dir: string,
  env: AgentConnectorEnv,
  provider: { conductorCfg?: ConductorConfig; providerCfg?: ProviderConfig }
): ServeDeps {
  const socketPath = busSocketPath(dir)
  const { conductorCfg, providerCfg } = provider
  // the conductor's proxy carries the live link's terminal registry —
  // the /api/v1/terminals plane reads through it (bro-eua0d)
  const conductor = conductorCfg !== undefined ? conductorProxy(conductorCfg) : undefined
  return {
    snapshot: () => collectSnapshot(dir),
    agents: async () => {
      const [{ backends }, discovered] = await Promise.all([
        collectAgentBackends(dir, env),
        Promise.resolve(discoverSessions(env)),
      ])
      return {
        backends,
        occupancy: occupancyOf(dir, env),
        sessions: sessionQuotaViewsOf(env),
        discovered: discovered.sessions,
        degraded: discovered.degraded,
      }
    },
    queue: async () => readBeads(dir),
    ticks: async () => collectTicks(dir),
    mailbox: async () => ({ drops: peekMailbox(dir, MAILBOX_TAIL) }),
    find: (ref) => findAgent(dir, env, ref),
    spawn: (req) => spawnStepAgent(dir, env, req),
    stop: (ref) => stopAgent(dir, env, ref),
    connectors: () => agentConnectorNames(),
    // resolved once at serve start — loadBroConfig is a filesystem read
    // and planeCatalog() answers per request
    planeCatalog: (() => {
      const connectors = loadBroConfig(dir).connectors
      return () => planes(dir, { connectors })
    })(),
    eventsBus: () => ({
      // the socket is re-probed per stream — a broker that comes up
      // after serve start must not stay invisible until restart
      socketPath: () => busSocketPath(dir),
      subscribe: busSubscribe,
    }),
    asyncApi: () => asyncapiDocument(),
    webhooks: {
      github: githubWebhookHandler({
        secret: () => process.env[GITHUB_WEBHOOK_SECRET_ENV],
        publish: async (event) => {
          // drop BEFORE the publish reaches the broker: it fans the
          // event out to subscribers ahead of the publisher's ack, so
          // a poll woken by the event must already miss the feed entry
          dropActStateForEvent(dir, event)
          // this ingest bypasses the events facade — sinks fan out in
          // this process too or a routed webhook never reaches a person
          void deliverSinks(dir, event)
          return socketPath === null
            ? { published: false as const, reason: 'not a repository' }
            : busPublish(socketPath, event)
        },
      }),
    },
    ...(conductor !== undefined
      ? { provider: conductor, terminals: conductor.terminals }
      : providerCfg !== undefined
        ? { provider: providerProxy(providerCfg) }
        : {}),
  }
}

function usage(): never {
  console.error(`usage:
  bro serve [--port <n>]
  bro serve ensure --port <n>
  bro serve watchdog --port <n> --pid <p>   (internal — armed by serve)

HTTP/JSON facade host on 127.0.0.1 (default port: ephemeral — the bound
address is printed and written to <git-common-dir>/bro/serve.json).

ensure: the apiKeyHelper contract for a repo-bound listener — probe the
port, spawn \`bro serve\` detached when dead, then print this repo's
serve.json token on stdout. Failures are stderr + nonzero; stdout never
carries an empty key.

Routes: ${ROUTES.join(', ')}`)
  process.exit(2)
}

// --- ensure ----------------------------------------------------------------

interface ServeHealth {
  ok?: boolean
  dir?: string
  pid?: number
}

/** Injectable seams — tests drive the probe/spawn without a real port
 *  or a detached CLI re-exec. */
export interface EnsureDeps {
  probe?: (port: number) => Promise<ServeHealth | undefined>
  spawnServer?: () => void
  /** The stale-serve stop — a test asserts the kill without signaling
   *  a real process. */
  stopServe?: (pid: number) => Promise<void>
  timeoutMs?: number
  pollMs?: number
}

async function defaultProbe(port: number): Promise<ServeHealth | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!r.ok) return undefined
    return (await r.json()) as ServeHealth
  } catch {
    return undefined
  }
}

/** One health-probe answer's verdict. Identity is the recorded pid, not
 *  the dir string: serve.json can only be written by a starter that
 *  resolved this repo's common dir, so a pid-matching listener IS this
 *  repo's serve — its dir answer then only grades the anchor. */
type EnsureVerdict =
  | { kind: 'token'; token: string }
  | { kind: 'down' } // nothing answering — the spawn path's job
  | { kind: 'respawn'; pid: number } // ours, but the recorded anchor is gone
  | { kind: 'missing-state' } // listener up, no serve.json
  | { kind: 'impostor'; reported: number | undefined; recorded: number }
  | { kind: 'foreign'; dir: string }

/** SIGTERM the stale generation, wait out its grace, SIGKILL only if
 *  wedged — the shutdown path still clears state for a graceful exit.
 *  Returns with the pid down or the kill budget spent (the spawn then
 *  surfaces a still-held port honestly through the poll deadline). */
async function stopRecordedServe(pid: number, stepMs = 50): Promise<void> {
  const waitDead = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, stepMs))
    }
    return !pidAlive(pid)
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  if (await waitDead(5_000)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  await waitDead(1_000)
}

/** `bro serve ensure` — resolve-or-spawn this repo's listener on a
 *  fixed port, then the token a client authenticates with. Returns the
 *  token or throws; the command wrapper owns stderr + exit codes. */
export async function ensureServe(
  dir: string,
  port: number,
  deps: EnsureDeps = {}
): Promise<string> {
  const probe = deps.probe ?? defaultProbe
  const stopServe = deps.stopServe ?? stopRecordedServe
  const timeoutMs = deps.timeoutMs ?? 20_000
  const pollMs = deps.pollMs ?? 250

  const statePath = serveStatePath(dir)
  if (statePath === null) {
    throw new Error('not inside a git repository — cannot anchor serve.json')
  }
  // node reports serve's dir as its realpath'd cwd — compare alike. The
  // serve anchors to the MAIN worktree root (bro-ofbw4), so the caller
  // resolves the same identity through the same helper no matter which
  // checkout invoked the helper.
  const root = mainWorktreeRoot(dir) ?? dir
  const repo = ((): string => {
    try {
      return realpathSync(root)
    } catch {
      return root // a dead anchor can't canonicalize — compare raw
    }
  })()

  const classify = async (): Promise<EnsureVerdict> => {
    const h = await probe(port)
    if (h?.ok !== true || typeof h.dir !== 'string') return { kind: 'down' }
    const state = readStateFile(statePath)
    if (state !== undefined && h.pid === state.pid) {
      // pid-match settles ownership — the file could only be written by
      // a starter that resolved this repo's common dir. The dir answer
      // then grades the anchor strictly: the main root → healthy; any
      // other dir (deleted worktree, pre-fix linked anchor) → heal by
      // respawn so the anchor lands on the durable root now.
      if (h.dir === repo) {
        return { kind: 'token', token: state.token }
      }
      return { kind: 'respawn', pid: state.pid }
    }
    if (h.dir !== repo) return { kind: 'foreign', dir: h.dir }
    if (state === undefined) return { kind: 'missing-state' }
    // a same-dir answer alone is spoofable — the listener must also be
    // the recorded process, else a squatter claims our repo and
    // receives the token we hand out
    return { kind: 'impostor', reported: h.pid, recorded: state.pid }
  }

  const killed = new Set<number>()
  const heal = async (pid: number): Promise<void> => {
    if (killed.has(pid)) return
    killed.add(pid)
    await stopServe(pid)
  }

  const first = await classify()
  switch (first.kind) {
    case 'token':
      return first.token
    case 'foreign':
      throw new Error(
        `port ${port} already serves ${first.dir} — not this repo; pick another port`
      )
    case 'missing-state':
      throw new Error(`listener on ${port} is up but ${statePath} is missing`)
    case 'impostor':
      throw new Error(
        `listener on ${port} claims this repo but is not the recorded serve ` +
          `(pid ${first.reported ?? '?'} vs ${first.recorded})`
      )
    case 'respawn':
      await heal(first.pid)
  }

  if (deps.spawnServer !== undefined) {
    deps.spawnServer()
  } else {
    const logDir = dirname(statePath)
    mkdirSync(logDir, { recursive: true })
    const logFd = openSync(join(logDir, 'serve.log'), 'a')
    try {
      // ENTRY_FILE, not argv[1] — the child resolves its script under
      // `cwd: repo`, so a relative argv[1] (CLI launched from a linked
      // worktree) would point under the main root and never start
      spawn(process.execPath, [ENTRY_FILE, 'serve', '--port', String(port)], {
        cwd: repo,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
      }).unref()
    } finally {
      closeSync(logFd)
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    const v = await classify()
    if (v.kind === 'token') return v.token
    if (v.kind === 'foreign') {
      throw new Error(
        `port ${port} came up serving ${v.dir} — not this repo; pick another port`
      )
    }
    if (v.kind === 'respawn') {
      await heal(v.pid)
    }
    // down / missing-state / impostor — startup race (serve binds before
    // writing serve.json) or a predecessor still tearing down; the
    // deadline is the honest bound
  }
  throw new Error(
    `bro serve never came up on ${port} — see ${join(dirname(statePath), 'serve.log')}`
  )
}

async function cmdEnsure(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) usage()
  const pos = positionals(argv, new Set(['--port']))
  if (pos.length > 0) usage()
  for (const a of argv) {
    if (a.startsWith('--') && a.split('=')[0] !== '--port') {
      console.error(`error: unknown option ${a}`)
      usage()
    }
  }
  const portRaw = flag(argv, '--port')
  if (portRaw === undefined) {
    console.error('error: ensure needs --port <n> — the client base url is a fixed port')
    usage()
  }
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`error: --port needs an integer 1–65535, got "${portRaw}"`)
    process.exit(2)
  }
  try {
    console.log(await ensureServe(process.cwd(), port))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// --- watchdog ---------------------------------------------------------------

/** The keepalive leg's poll cadence — the apiKeyHelper only re-ensures
 *  on auth refresh, so without a respawn leg a dead listener costs
 *  minutes of failed calls. Seconds, not minutes (bro-ofbw4). */
const WATCHDOG_POLL_MS = 5_000
/** A respawned serve needs bind + serve.json write before the next
 *  verdict reads — settle, else the watchdog fires a duplicate starter
 *  every poll while the new generation is still coming up. */
const WATCHDOG_SETTLE_MS = 15_000

/** The entry script the user invoked, made absolute at load —
 *  runServeCommand chdirs to the main-worktree anchor before spawning
 *  children, so a relative argv[1] resolved later (or passed through
 *  unchanged) would point under the anchor, not the cwd `bro` ran
 *  from. Both watchdog spawns must name THIS file. */
const ENTRY_FILE = resolve(process.argv[1] ?? fileURLToPath(import.meta.url))

/** The env a watchdog respawn uses to hand the dead generation's token
 *  to its successor — env, not argv, because /proc/<pid>/environ is
 *  same-UID like the 0600 serve.json while argv is world-readable.
 *  Without it the respawn mints a fresh token and every client holding
 *  the old one (the apiKeyHelper only re-ensures on auth refresh)
 *  eats 401s through the very window the keepalive exists to close. */
export const SERVE_TOKEN_ENV = 'BRO_SERVE_TOKEN'

/** The session token this generation binds — adopted from
 *  SERVE_TOKEN_ENV when a watchdog respawned us, fresh otherwise. */
export function serveSessionToken(env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env[SERVE_TOKEN_ENV]
  return typeof inherited === 'string' && inherited !== '' ? inherited : randomBytes(32).toString('hex')
}

/** One watchdog tick — exported for the unit tests; `cmdWatchdog` is
 *  the thin spawn/sleep shell around it. */
export type WatchdogVerdict = 'retire' | 'alive' | 'respawn'
export function watchdogVerdict(
  state: ServeState | undefined,
  pid: number,
  alive: (pid: number) => boolean = pidAlive
): WatchdogVerdict {
  // a retracted record is a deliberate stop; a different recorded pid
  // is a successor generation that armed its own watchdog — either way
  // this leg's work is over. Only OUR dead pid standing in the file
  // earns a respawn.
  if (state === undefined || state.pid !== pid) return 'retire'
  return alive(pid) ? 'alive' : 'respawn'
}

/** `bro serve watchdog --port <n> --pid <p>` — internal: `bro serve`
 *  arms exactly one detached watchdog per generation. It polls the
 *  serve.json record and respawns the listener on the bound port while
 *  OUR dead entry stands; a cleared record or a successor's pid retires
 *  the leg. Never hand-run — it exists so a crashed serve is seconds of
 *  outage, not an auth-refresh interval of it. */
async function cmdWatchdog(argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--port', '--pid']), { strict: true })
  if (pos.length > 0) usage()
  const port = Number(flag(argv, '--port'))
  const pid = Number(flag(argv, '--pid'))
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !Number.isInteger(pid) || pid <= 0) {
    console.error('error: watchdog needs --port <n> and --pid <n>')
    process.exit(2)
  }
  const dir = process.cwd()
  const statePath = serveStatePath(dir)
  if (statePath === null) {
    process.exit(1)
  }
  const logDir = dirname(statePath)
  for (;;) {
    await new Promise((r) => setTimeout(r, WATCHDOG_POLL_MS))
    const state = readStateFile(statePath)
    const verdict = watchdogVerdict(state, pid)
    if (verdict === 'retire') return
    if (verdict === 'alive') continue
    try {
      mkdirSync(logDir, { recursive: true })
      const logFd = openSync(join(logDir, 'serve.log'), 'a')
      try {
        // the new generation writes its own serve.json and arms its own
        // watchdog — we retire on the next tick's superseded pid. The
        // serve.json.lock serializes a racing `ensure` starter; the
        // loser refuses and exits, harmless either way. The dead
        // generation's token rides the child's env (state is defined —
        // 'retire' above covers undefined) so cached clients survive
        // the crash with no 401 window.
        spawn(process.execPath, [ENTRY_FILE, 'serve', '--port', String(port)], {
          cwd: dir,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, [SERVE_TOKEN_ENV]: state!.token },
        })
          // an async spawn error (e.g. the anchor itself is gone) is a
          // no-op starter — unhandled it would kill the leg; the next
          // tick reads the same dead record and retries anyway
          .once('error', () => {})
          .unref()
        console.error(`watchdog: serve pid ${pid} dead — respawned on port ${port}`)
      } finally {
        closeSync(logFd)
      }
    } catch {
      // a transient spawn failure must not kill the leg — the next tick
      // reads the same dead record and retries
    }
    await new Promise((r) => setTimeout(r, WATCHDOG_SETTLE_MS))
  }
}

/** Argument validation → the bound port (0 = ephemeral). Exits via
 *  `usage()` on any malformed input — a mistyped flag must never
 *  silently serve. */
function parseServePort(argv: string[]): number {
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
  if (portRaw === undefined) {
    return 0
  }
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`error: --port needs an integer 0–65535, got "${portRaw}"`)
    process.exit(2)
  }
  return port
}

/** This serve is the bus's co-host (bro-0ppt0): the events stream, the
 *  per-agent SSE, the webui's live activity pane and the conductor's
 *  own turn events all ride the repo socket — a broker must live
 *  somewhere for any of it to flow, and the long-lived serve process
 *  is the natural host. An already-running `bro bus serve` wins (same
 *  socket either way); any other failure degrades the routes to
 *  503/published:false — fail-open, serve still answers. Webhook
 *  ingest publishes through the same socket when armed. */
async function armBusBroker(dir: string, url: string): Promise<BusBroker | undefined> {
  const webhookArmed = (process.env[GITHUB_WEBHOOK_SECRET_ENV] ?? '') !== ''
  try {
    const broker = await startBusBroker(dir)
    console.log(`bus: broker on ${broker.socketPath}`)
    if (webhookArmed) {
      console.log(`webhooks: POST ${url}/api/v1/webhooks/github → bus ${broker.socketPath}`)
    }
    return broker
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already running/.test(msg)) {
      if (webhookArmed) {
        console.log(`webhooks: POST ${url}/api/v1/webhooks/github → existing bus broker`)
      }
    } else {
      console.error(`warning: bus broker did not start — ${msg}`)
    }
    return undefined
  }
}

export async function runServeCommand(argv: string[]): Promise<void> {
  if (argv[0] === 'ensure') {
    await cmdEnsure(argv.slice(1))
    return
  }
  if (argv[0] === 'watchdog') {
    await cmdWatchdog(argv.slice(1))
    return
  }
  const port = parseServePort(argv)

  // One listener per repo — serve.json lives in the common dir shared
  // by every linked worktree, so the anchor must be the path that
  // outlives them all: the MAIN worktree root. A serve spawned inside
  // a `bro work` checkout that later got `leave`d kept its cwd there —
  // acp spawns died with the directory and `ensure` refused from main
  // (bro-ofbw4). chdir first so `dir`, the recorded state, and every
  // inherited child cwd land on the durable path.
  const anchor = mainWorktreeRoot(process.cwd())
  if (anchor !== null && anchor !== process.cwd()) {
    process.chdir(anchor)
  }
  const dir = process.cwd()
  const statePath = serveStatePath(dir)
  if (statePath === null) {
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
  // the conductor answers /v1 from a configured acp provider
  // (BRO_PROVIDER_BACKEND) — explicit backend intent beats the byte
  // proxy's upstream+key pair, which stays the plain-HTTP fallback
  const conductorCfg = conductorConfig(process.env, dir)
  const providerCfg = conductorCfg === undefined ? providerConfig(process.env) : undefined
  if (conductorCfg !== undefined) {
    console.log(`provider: /v1/* → acp conductor (${conductorCfg.backend})`)
  } else if (providerCfg !== undefined) {
    console.log(`provider: /v1/* → ${providerCfg.upstream}`)
  }
  // the session token — the "local session context" made concrete.
  // Adopted from SERVE_TOKEN_ENV when a watchdog respawned this serve
  // (crash recovery keeps the credential clients already hold), else
  // generated fresh. Never printed: clients read it out of the 0600
  // serve.json below, so possession implies same-UID file access
  const token = serveSessionToken()
  const server = createServer(
    createServeHandler(realDeps(dir, env, { conductorCfg, providerCfg }), meta, token)
  )

  try {
    let boundPort = port
    const url = await new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      // 127.0.0.1 only — the loopback bind IS the trust boundary; there is
      // no --host flag to widen it with.
      server.listen(port, '127.0.0.1', () => {
        meta.startedAt = new Date().toISOString()
        const addr = server.address()
        boundPort = typeof addr === 'object' && addr !== null ? addr.port : port
        resolve(`http://127.0.0.1:${boundPort}`)
      })
    }).catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })

    writeServeState(dir, {
      pid: process.pid,
      url,
      dir,
      startedAt: meta.startedAt,
      token,
      // the flag `bro provider` resolution reads — a facade-only serve
      // must not shadow the host listener's endpoint
      ...(providerCfg !== undefined || conductorCfg !== undefined ? { provider: true } : {}),
    })
    // filesystems that ignore mode bits (some fuse/9p/drvfs mounts) can
    // leave the token group/other-readable — the auth boundary then
    // doesn't hold, so say so loudly rather than trusting silently
    if ((statSync(statePath).mode & 0o077) !== 0) {
      console.error(
        `warning: ${statePath} is readable by group/other — the session token is exposed to other local users on this filesystem`
      )
    }
    // the keepalive leg (bro-ofbw4): between apiKeyHelper runs — clients
    // only re-ensure on auth refresh — a dead listener is minutes of
    // failed calls. One detached watchdog per generation polls the
    // recorded pid and respawns `bro serve` on the bound port; it
    // retires when the record is retracted (clean stop) or superseded
    // (the next generation arms its own).
    {
      // arming failure is a warning, never a crash — a serve already
      // listening must not exit over a supervisor it can live without;
      // the next generation's own arm is unaffected either way
      try {
        const logFd = openSync(join(dirname(statePath), 'serve.log'), 'a')
        try {
          spawn(
            process.execPath,
            [
              ENTRY_FILE,
              'serve',
              'watchdog',
              '--port',
              String(boundPort),
              '--pid',
              String(process.pid),
            ],
            { cwd: dir, detached: true, stdio: ['ignore', logFd, logFd], env: process.env }
          )
            .once('error', (e) => {
              console.error(`warning: watchdog did not arm — ${e.message}`)
            })
            .unref()
        } finally {
          closeSync(logFd)
        }
      } catch (err) {
        console.error(
          `warning: watchdog did not arm — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    console.log(`bro serve — ${url}`)
    console.log('discovery: <git-common-dir>/bro/serve.json · ctrl-c to stop')

    const broker = await armBusBroker(dir, url)

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
    await broker?.close()
    clearServeState(dir)
  } finally {
    releaseLock()
  }
}

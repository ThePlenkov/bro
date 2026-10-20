/**
 * `bro provider` — the host-level Messages-API provider plane and the
 * helpers that wire a claude client to it once (spec:
 * specs/bro-om6m8.1.md).
 *
 *   bro provider serve [--port <n>]   the machine-level listener — a
 *                                     thin host serving only GET /,
 *                                     /api/v1/health and the /v1/*
 *                                     plane (acp conductor when the
 *                                     global config carries
 *                                     serve.backend, else the upstream
 *                                     byte-proxy), bound to the
 *                                     well-known port (default 4545)
 *                                     so ANTHROPIC_BASE_URL is a static
 *                                     settings.json entry. Repo-free:
 *                                     state lives at
 *                                     $XDG_STATE_HOME/bro/provider.json
 *                                     (0600) — same file-discipline and
 *                                     token trust model as serve.json.
 *   bro provider ensure [--port <n>]  resolve-or-spawn the listener,
 *                                     print the session token — the
 *                                     self-starting apiKeyHelper: the
 *                                     client is the supervision, no
 *                                     dedicated server start exists
 *   bro provider url                  the endpoint to point
 *                                     ANTHROPIC_BASE_URL at
 *   bro provider token                the session token — same helper
 *                                     contract; self-heals through the
 *                                     ensure path on a dead listener
 *   bro provider env [--json]         eval-able exports, or the
 *                                     settings.json block verbatim
 *
 * Endpoint resolution is cwd-aware (spec picks): ANTHROPIC_BASE_URL in
 * the environment pins the pick by exact url match — the apiKeyHelper
 * always agrees with the URL the client will call; unset, the live
 * host listener wins (one gateway per machine), else the cwd repo's
 * own provider-wired serve as the fallback. The /v1/* guard stack is
 * serve's unchanged — loopback Host, then the session token as Bearer
 * OR x-api-key.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { holdFileLock, LockTimeout, pidAlive } from '@broject/core'
import { flag, positionals } from './args.ts'
import {
  clearStateFile,
  isLoopbackHostHeader,
  liveServeState,
  providerGuard,
  readStateFile,
  send,
  writeStateFile,
  type ServeState,
} from './serve.ts'
import { conductorConfig, conductorProxy } from './serve-conductor.ts'
import { providerConfig, providerProxy } from './serve-provider.ts'

/** The well-known port — the whole point of the host listener is that
 *  `ANTHROPIC_BASE_URL=http://127.0.0.1:4545` is a permanent
 *  settings.json entry. `--port 0` stays for tests/ephemeral use. */
export const DEFAULT_PROVIDER_PORT = 4545

/** `$XDG_STATE_HOME/bro/provider.json` — the machine-level anchor, same
 *  fallback chain as the user-level notify mailbox (`||` not `??`: an
 *  empty XDG_STATE_HOME is unset, not a path). */
export function providerStatePath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'bro', 'provider.json')
}

export function liveProviderState(): ServeState | undefined {
  const state = readStateFile(providerStatePath())
  return state !== undefined && pidAlive(state.pid) ? state : undefined
}

// --- endpoint resolution --------------------------------------------------------

/** One listener a claude client can authenticate to. `source` says
 *  which plane minted it — the host listener or the cwd repo's serve. */
export interface ProviderEndpoint {
  url: string
  token: string
  source: 'host' | 'repo'
}

/** Compare ANTHROPIC_BASE_URL to a recorded listener url — the env
 *  spells it however the user wrote it (localhost, default port,
 *  trailing slash); URL parsing normalizes all three. The path
 *  survives — a base carrying one (/custom) is not a listener that
 *  serves root-anchored /v1/*, so the pin misses (fails closed)
 *  instead of returning a token for a URL that would only 404.
 *  [::1] stays unfolded: the bind is IPv4-only, so an ipv6 pin is an
 *  endpoint the listener never serves and must miss like a remote. */
function normalizeBase(raw: string): string {
  try {
    const u = new URL(raw.trim())
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1'
    }
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return raw.trim().replace(/\/+$/, '')
  }
}

/** Which endpoint a claude client from `dir` would reach — the pick
 *  `url` prints, `token` authenticates, and `env` exports, so all
 *  three always agree:
 *   1. env.ANTHROPIC_BASE_URL pins by exact match — the apiKeyHelper
 *      must return the credential for the URL the client will call,
 *      never a guess (a wrong token is worse than a nonzero exit);
 *   2. unset — the live host listener (one gateway per machine);
 *   3. else the cwd repo's own provider-wired serve — the back-compat
 *      fallback and the per-run-port escape hatch;
 *   4. else undefined — the caller reports, nothing is invented. */
export function resolveProviderEndpoint(
  dir: string,
  env: NodeJS.ProcessEnv
): ProviderEndpoint | undefined {
  const baseRaw = env.ANTHROPIC_BASE_URL
  const host = liveProviderState()
  const repo = liveServeState(dir)
  if (typeof baseRaw === 'string' && baseRaw.trim() !== '') {
    const base = normalizeBase(baseRaw)
    // the recorded side normalizes too — a state file written with
    // localhost, a default port, or a trailing slash still matches
    if (host !== undefined && normalizeBase(host.url) === base) {
      return { url: host.url, token: host.token, source: 'host' }
    }
    if (repo !== undefined && normalizeBase(repo.url) === base) {
      return { url: repo.url, token: repo.token, source: 'repo' }
    }
    return undefined
  }
  // host-first: one gateway per machine — the repo serve is the
  // fallback, reached primarily through the explicit base-url pin (the
  // per-run-port escape hatch). A facade-only repo serve (provider flag
  // absent) never shadows — its /v1/* 404s
  if (host !== undefined) {
    return { url: host.url, token: host.token, source: 'host' }
  }
  if (repo?.provider === true) {
    return { url: repo.url, token: repo.token, source: 'repo' }
  }
  return undefined
}

/** The shared dead-end text — url/token/env all report the same way. */
function noEndpointError(): string {
  const base = process.env.ANTHROPIC_BASE_URL
  return typeof base === 'string' && base.trim() !== ''
    ? `no live bro provider listener at ${normalizeBase(base)} — the recorded listener is gone; ensure should have revived it`
    : 'no live provider endpoint — `bro provider ensure` self-starts the host listener'
}

/** Resolve or report — the shared failure path for url/env. */
function endpointOrExit(dir: string): ProviderEndpoint {
  const ep = resolveProviderEndpoint(dir, process.env)
  if (ep !== undefined) {
    return ep
  }
  console.error(`error: ${noEndpointError()}`)
  process.exit(1)
}

// --- the host listener ------------------------------------------------------------

const PROVIDER_ROUTES = ['GET /', 'GET /api/v1/health', 'ALL /v1/*']

/** The thin host's request pipeline — the /v1/* guard stack is serve's
 *  verbatim (loopback Host → session token via Bearer or x-api-key →
 *  loopback Origin → json content-type on body-bearing methods); the
 *  only extras are the index and a liveness route. No facade planes —
 *  a client that needs the board runs `bro serve` in the repo. */
export function createProviderHandler(opts: {
  proxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  token: string
  meta: { dir: string; startedAt: string }
  statePathHint: string
}): (req: IncomingMessage, res: ServerResponse) => void {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!isLoopbackHostHeader(req.headers.host)) {
        send(res, 403, { error: 'loopback host only' })
        return
      }
      if (req.method === 'GET' && url.pathname === '/') {
        send(res, 200, { service: 'bro-provider', routes: PROVIDER_ROUTES })
        return
      }
      if (url.pathname === '/api/v1/health') {
        if (req.method !== 'GET') {
          send(res, 405, { error: 'method not allowed' })
          return
        }
        send(res, 200, {
          ok: true,
          pid: process.pid,
          dir: opts.meta.dir,
          startedAt: opts.meta.startedAt,
        })
        return
      }
      if (url.pathname.startsWith('/v1/')) {
        const wantsBody =
          req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
        const refusal = providerGuard(req, opts.token, wantsBody, opts.statePathHint)
        if (refusal !== undefined) {
          send(res, refusal.status, refusal.body, refusal)
          return
        }
        await opts.proxy(req, res)
        return
      }
      send(res, 404, { error: 'not found', routes: PROVIDER_ROUTES })
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return (req, res) => {
    void handle(req, res)
  }
}

/** `<provider.json>.lock` — the singleton gate, same steal-vs-refuse
 *  rule as the serve lock: a live foreign holder refuses, a dead
 *  leftover is stolen. */
function acquireProviderLock(statePath: string): (() => void) | undefined {
  try {
    return holdFileLock(`${statePath}.lock`, {
      waitMs: 250,
      label: 'provider lock',
    })
  } catch (err) {
    if (err instanceof LockTimeout) {
      return undefined
    }
    throw err
  }
}

function parsePort(argv: string[], defaultPort: number): number {
  const raw = flag(argv, '--port')
  if (raw === undefined) {
    return defaultPort
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`error: --port needs an integer 0–65535, got "${raw}"`)
    process.exit(2)
  }
  return port
}

/** Graceful shutdown shared shape with `bro serve` — close() waits on
 *  keep-alive sockets, so the grace is capped; in-flight requests get
 *  a short window before connections are reaped. */
function waitForSignal(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const shutdown = (): void => {
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
}

async function cmdServe(argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--port']), { strict: true })
  if (pos.length > 0) {
    usage()
  }
  const port = parsePort(argv, DEFAULT_PROVIDER_PORT)

  const statePath = providerStatePath()
  const live = liveProviderState()
  // a live pid is not a live listener — a record surviving an unclean
  // shutdown can name a recycled pid a stranger now holds, and refusing
  // on it would pin the gateway dead forever; only a listener answering
  // health on the recorded pid counts as 'already serving'
  if (live !== undefined && (await stateServing(live))) {
    console.error(
      `error: already serving ${live.url} (pid ${live.pid}) — one provider listener per host`
    )
    process.exit(1)
  }

  // Config resolves at the GLOBAL layer only — the host service must
  // not inherit whichever repo happened to spawn it, and a state dir
  // inside a checkout (dotfiles $HOME, XDG_STATE_HOME under a repo)
  // must not re-root it either: 'global' scans ~/.config/bro alone.
  // serve.backend / providers.* for the gateway live in
  // ~/.config/bro/config.* — a throwing conductorConfig (unknown backend
  // name, non-acp entry) stays loud. Resolved before the lock so a
  // refused start holds nothing.
  const configDir = dirname(statePath)
  const conductorCfg = conductorConfig(process.env, configDir, undefined, 'global')
  const providerCfg = conductorCfg === undefined ? providerConfig(process.env) : undefined
  if (conductorCfg === undefined && providerCfg === undefined) {
    console.error(
      'error: nothing to serve — no serve.backend in the global config and no upstream ' +
        'credential in the server env (BRO_PROVIDER_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)'
    )
    process.exit(1)
  }
  if (conductorCfg !== undefined) {
    // sessions anchor at the operator's home — the state dir is for
    // files, and a deletable checkout must never be an acp cwd
    conductorCfg.cwd = homedir()
  }
  // the conductor plane carries dispose() — the pooled acp child pins
  // the loop until its transport closes, so the 'exit' hook alone can
  // never run; the shutdown path below calls it explicitly
  const proxy: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
    dispose?: () => void
  } =
    conductorCfg !== undefined ? conductorProxy(conductorCfg) : providerProxy(providerCfg!)

  // the lock makes the singleton atomic — live-state check → write has
  // a gap two starters could both pass through; O_EXCL create cannot
  const releaseLock = acquireProviderLock(statePath)
  if (releaseLock === undefined) {
    console.error(
      'error: another bro provider serve is starting or running (provider.json.lock held)'
    )
    process.exit(1)
  }

  const meta = { dir: process.cwd(), startedAt: '' }
  // the session token — generated per serve, never printed: clients
  // resolve it through `bro provider token` / the 0600 state file
  const token = randomBytes(32).toString('hex')
  const server = createServer(
    createProviderHandler({
      proxy,
      token,
      meta,
      statePathHint: statePath,
    })
  )

  try {
    let url: string
    try {
      url = await new Promise<string>((resolve, reject) => {
        server.once('error', reject)
        // 127.0.0.1 only — the loopback bind IS the trust boundary; there
        // is no --host flag to widen it with
        server.listen(port, '127.0.0.1', () => {
          meta.startedAt = new Date().toISOString()
          const addr = server.address()
          resolve(
            `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : port}`
          )
        })
      })
    } catch (err) {
      // process.exit never reaches the outer finally — a dead starter
      // must not leave provider.json.lock held for the next one
      releaseLock()
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    writeStateFile(statePath, {
      pid: process.pid,
      url,
      dir: meta.dir,
      startedAt: meta.startedAt,
      token,
    })
    // filesystems that ignore mode bits leave the token readable — say
    // so loudly rather than trusting silently (same check serve runs)
    if ((statSync(statePath).mode & 0o077) !== 0) {
      console.error(
        `warning: ${statePath} is readable by group/other — the session token is exposed to other local users on this filesystem`
      )
    }
    const plane =
      conductorCfg !== undefined ? `acp conductor (${conductorCfg.backend})` : providerCfg!.upstream
    console.log(`bro provider — ${url} → ${plane}`)
    console.log(`discovery: ${statePath} · ctrl-c to stop`)
    console.log(
      `wire once into ~/.claude/settings.json: {"env":{"ANTHROPIC_BASE_URL":"${url}"},"apiKeyHelper":"bro provider ensure"}`
    )

    await waitForSignal(server)
    proxy.dispose?.()
    clearStateFile(statePath)
  } finally {
    releaseLock()
  }
}

// --- ensure ------------------------------------------------------------------

interface ProviderHealth {
  ok?: boolean
  pid?: number
}

function providerLogPath(statePath: string): string {
  return join(dirname(statePath), 'provider.log')
}

async function defaultProbe(port: number): Promise<ProviderHealth | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!r.ok) return undefined
    return (await r.json()) as ProviderHealth
  } catch {
    return undefined
  }
}

/** Does the recorded listener still answer? The state file's pid only
 *  proves some process holds it — after an unclean shutdown the pid can
 *  belong to a stranger — so a record counts as serving only when
 *  /api/v1/health on its url reports the recorded pid (the contract
 *  ensureProvider's healthy() already applies to the host listener). */
async function stateServing(state: ServeState): Promise<boolean> {
  try {
    const h = await defaultProbe(Number(new URL(state.url).port))
    return h?.ok === true && h.pid === state.pid
  } catch {
    return false // a malformed recorded url is a dead record
  }
}

/** Is the resolved endpoint's HOST listener actually answering? The
 *  apiKeyHelper helpers print a recorded token only while its listener
 *  provably answers; a recycled-pid provider.json reads as dead, not
 *  live. A repo-serve record is trusted as recorded — its liveness is
 *  the repo serve's own business (the watchdog owns revival), and a
 *  dead one is never hijacked by a host listener on its port. */
async function endpointAlive(ep: ProviderEndpoint): Promise<boolean> {
  if (ep.source !== 'host') return true
  const state = liveProviderState()
  return state !== undefined && (await stateServing(state))
}

/** Injectable seams — tests drive the probe/spawn without a real port
 *  or a detached CLI re-exec (same shape as serve ensure). */
export interface EnsureProviderDeps {
  probe?: (port: number) => Promise<ProviderHealth | undefined>
  spawnServer?: () => void
  timeoutMs?: number
  pollMs?: number
}

/** `bro provider ensure` — resolve-or-spawn THE host listener, then its
 *  session token: the apiKeyHelper contract that makes the gateway
 *  self-initiated. One listener per machine — the state file + lock
 *  dedupe concurrent ensures; a healthy listener counts only when its
 *  reported pid equals the recorded provider.json pid (a port squatter
 *  never receives the token we hand out). */
export async function ensureProvider(
  port: number = DEFAULT_PROVIDER_PORT,
  deps: EnsureProviderDeps = {}
): Promise<string> {
  const probe = deps.probe ?? defaultProbe
  const timeoutMs = deps.timeoutMs ?? 20_000
  const pollMs = deps.pollMs ?? 250
  const statePath = providerStatePath()

  const healthy = async (): Promise<string | undefined> => {
    const h = await probe(port)
    if (h?.ok !== true || typeof h.pid !== 'number') return undefined
    // liveProviderState gates on pidAlive — a dead recorded pid is a
    // stale file even while something healthy answers the port
    const state = liveProviderState()
    if (state === undefined || state.pid !== h.pid) return undefined
    return state.token
  }

  const first = await healthy()
  if (first !== undefined) return first

  if (deps.spawnServer !== undefined) {
    deps.spawnServer()
  } else {
    mkdirSync(dirname(statePath), { recursive: true })
    const logFd = openSync(providerLogPath(statePath), 'a')
    try {
      // resolve() — argv[1] can be relative, and the child's cwd is
      // reset to $HOME where a relative entry path resolves to nothing
      spawn(process.execPath, [resolve(process.argv[1]!), 'provider', 'serve', '--port', String(port)], {
        // the operator's home — never the caller's cwd: a deleted
        // worktree must not orphan the host service's anchor
        cwd: homedir(),
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
    const tok = await healthy()
    if (tok !== undefined) return tok
  }
  throw new Error(
    `bro provider serve never came up on ${port} — see ${providerLogPath(statePath)}`
  )
}

/** Which port a token self-heal may spawn on: unset base → the
 *  well-known default; a loopback pin → its port; anything else can
 *  never be a local spawn — fail closed, never bind it. */
function ensurePort(base: string | undefined): number | undefined {
  if (base === undefined || base.trim() === '') return DEFAULT_PROVIDER_PORT
  try {
    const u = new URL(base.trim())
    // the spawned listener serves plain HTTP on IPv4 loopback at root
    // only — an https, [::1], or path-carrying pin names an endpoint it
    // can never satisfy, so it fails closed like a remote target
    // rather than print a token for a URL the client cannot use
    if (
      u.protocol !== 'http:' ||
      (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') ||
      u.pathname !== '/'
    ) {
      return undefined
    }
    // a portless base names no listener — the implied 80/443 is a
    // privileged bind (or a TLS port a plain listener can't serve), so
    // it fails closed like a remote target
    if (u.port === '') return undefined
    const p = Number(u.port)
    // a :0 pin means "any port" to a bind but nothing to a probe — a
    // self-heal spawning on a random port could never be found again
    return p === 0 ? undefined : p
  } catch {
    return undefined
  }
}

async function cmdEnsure(argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--port']), { strict: true })
  if (pos.length > 0) {
    usage()
  }
  const flagPort = parsePort(argv, -1)
  if (flagPort === 0) {
    console.error('error: ensure needs a fixed port — --port 0 can never be probed back')
    process.exit(2)
  }
  try {
    // the client's pin decides WHICH listener matters: a live endpoint —
    // the host listener, or an explicitly pinned repo serve — holds the
    // token the client will actually present. 'Recorded' is not
    // 'answering': a recycled pid passes pidAlive while the listener is
    // long gone, so the token prints only when the listener proves
    // itself on its recorded pid — a stale record falls through to the
    // self-start below
    const ep = resolveProviderEndpoint(process.cwd(), process.env)
    if (ep !== undefined && (await endpointAlive(ep))) {
      console.log(ep.token)
      return
    }
    // nothing live → self-start on --port, else the pinned loopback
    // port, else the well-known host port
    const port = flagPort !== -1 ? flagPort : ensurePort(process.env.ANTHROPIC_BASE_URL)
    if (port === undefined) {
      throw new Error(
        'ANTHROPIC_BASE_URL names an endpoint the listener cannot serve (non-http, non-loopback, path-carrying, portless, or :0) — refusing to bind a local listener for it'
      )
    }
    // apiKeyHelper contract: the token alone on stdout — no decoration
    console.log(await ensureProvider(port))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// --- helpers ------------------------------------------------------------------

function cmdUrl(argv: string[]): void {
  const pos = positionals(argv, new Set(), { strict: true })
  if (pos.length > 0) {
    usage()
  }
  console.log(endpointOrExit(process.cwd()).url)
}

async function cmdToken(argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(), { strict: true })
  if (pos.length > 0) {
    usage()
  }
  const cwd = process.cwd()
  let ep = resolveProviderEndpoint(cwd, process.env)
  // the same recycled-pid stale provider.json as ensure: a token for a
  // dead host listener is a dead credential — treat it as a miss and
  // self-heal
  if (ep !== undefined && !(await endpointAlive(ep))) {
    ep = undefined
  }
  if (ep === undefined) {
    // self-heal: a dead listener spawns on demand — the apiKeyHelper
    // IS the supervision, there is no separate start step
    const port = ensurePort(process.env.ANTHROPIC_BASE_URL)
    if (port !== undefined) {
      try {
        await ensureProvider(port)
      } catch (err) {
        console.error(`note: listener self-start failed — ${err instanceof Error ? err.message : String(err)}`)
      }
      ep = resolveProviderEndpoint(cwd, process.env)
    }
  }
  if (ep === undefined) {
    console.error(`error: ${noEndpointError()}`)
    process.exit(1)
  }
  // apiKeyHelper contract: the token alone on stdout — no decoration
  console.log(ep.token)
}

function cmdEnv(argv: string[]): void {
  const json = argv.includes('--json')
  const pos = positionals(argv, new Set(), {
    boolFlags: new Set(['--json']),
    strict: true,
  })
  if (pos.length > 0) {
    usage()
  }
  const ep = endpointOrExit(process.cwd())
  const block = {
    env: { ANTHROPIC_BASE_URL: ep.url },
    apiKeyHelper: 'bro provider ensure',
  }
  if (json) {
    // the settings.json block verbatim — mergeable, jq-able
    console.log(JSON.stringify(block, null, 2))
    return
  }
  // eval-able output is shell — quote defensively: a ' in a recorded
  // field must not break out of the literal
  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  console.log(`export ANTHROPIC_BASE_URL=${sq(ep.url)}`)
  console.log(`export ANTHROPIC_AUTH_TOKEN=${sq(ep.token)}`)
  console.log('# ~/.claude/settings.json — one-time, survives every repo:')
  console.log(`# ${JSON.stringify(block)}`)
}

function usage(): never {
  console.error(`usage:
  bro provider serve [--port <n>]   host-level provider listener — /v1/* only,
                                    state at $XDG_STATE_HOME/bro/provider.json
                                    (default port ${DEFAULT_PROVIDER_PORT})
  bro provider ensure [--port <n>]  resolve-or-spawn the host listener, print
                                    its token — the self-starting apiKeyHelper
  bro provider url                  the endpoint ANTHROPIC_BASE_URL points at
  bro provider token                the session token — self-heals like ensure
  bro provider env [--json]         eval-able exports, or the settings.json block

Resolution is cwd-aware: ANTHROPIC_BASE_URL pins by exact url, else the
live host listener, else the cwd repo's provider-wired serve.`)
  process.exit(2)
}

export async function runProviderCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    usage()
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    usage()
  }
  switch (sub) {
    case 'serve':
      await cmdServe(rest)
      return
    case 'ensure':
      await cmdEnsure(rest)
      return
    case 'url':
      cmdUrl(rest)
      return
    case 'token':
      await cmdToken(rest)
      return
    case 'env':
      cmdEnv(rest)
      return
    default:
      console.error(`error: unknown subcommand ${sub}`)
      usage()
  }
}

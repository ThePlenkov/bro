/**
 * `bro provider` — the host-level Messages-API provider plane and the
 * helpers that wire a claude client to it once (spec:
 * specs/bro-om6m8.1.md).
 *
 *   bro provider serve [--port <n>]   the machine-level listener — a
 *                                     thin host serving only GET /,
 *                                     /api/v1/health and the /v1/*
 *                                     byte-proxy, bound to the
 *                                     well-known port (default 4545)
 *                                     so ANTHROPIC_BASE_URL is a static
 *                                     settings.json entry. Repo-free:
 *                                     state lives at
 *                                     $XDG_STATE_HOME/bro/provider.json
 *                                     (0600) — same file-discipline and
 *                                     token trust model as serve.json.
 *   bro provider url                  the endpoint to point
 *                                     ANTHROPIC_BASE_URL at
 *   bro provider token                the session token — the claude
 *                                     apiKeyHelper contract: token on
 *                                     stdout, failures on stderr
 *   bro provider env [--json]         eval-able exports, or the
 *                                     settings.json block verbatim
 *
 * Endpoint resolution is cwd-aware (spec picks): ANTHROPIC_BASE_URL in
 * the environment pins the pick by exact url match — the apiKeyHelper
 * always agrees with the URL the client will call; unset, the cwd
 * repo's own provider-wired serve wins, else the host listener. The
 * /v1/* guard stack is serve's unchanged — loopback Host, then the
 * session token as Bearer OR x-api-key.
 */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 *  instead of returning a token for a URL that would only 404. */
function normalizeBase(raw: string): string {
  try {
    const u = new URL(raw.trim())
    if (u.hostname === 'localhost' || u.hostname === '[::1]') {
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
 *   2. unset — the cwd repo's own provider-wired serve (the specific
 *      context wins over the general one);
 *   3. else the live host listener — the always-on fallback;
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
  // a facade-only repo serve (provider flag absent) must not shadow
  // the host listener — its /v1/* 404s
  if (repo?.provider === true) {
    return { url: repo.url, token: repo.token, source: 'repo' }
  }
  if (host !== undefined) {
    return { url: host.url, token: host.token, source: 'host' }
  }
  return undefined
}

/** Resolve or report — the shared failure path for url/token/env. */
function endpointOrExit(dir: string): ProviderEndpoint {
  const ep = resolveProviderEndpoint(dir, process.env)
  if (ep !== undefined) {
    return ep
  }
  const base = process.env.ANTHROPIC_BASE_URL
  console.error(
    typeof base === 'string' && base.trim() !== ''
      ? `error: no live bro provider listener at ${normalizeBase(base)} — the recorded listener is gone; restart it: bro provider serve`
      : 'error: no live provider endpoint — start one: `bro provider serve` (host) or `bro serve` inside a repo'
  )
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

  const cfg = providerConfig(process.env)
  if (cfg === undefined) {
    console.error(
      'error: no upstream credential — set BRO_PROVIDER_API_KEY (or ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) in the server env'
    )
    process.exit(1)
  }

  const statePath = providerStatePath()
  const live = liveProviderState()
  if (live !== undefined) {
    console.error(
      `error: already serving ${live.url} (pid ${live.pid}) — one provider listener per host`
    )
    process.exit(1)
  }
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
      proxy: providerProxy(cfg),
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
    console.log(`bro provider — ${url} → ${cfg.upstream}`)
    console.log(`discovery: ${statePath} · ctrl-c to stop`)
    console.log(
      `wire once into ~/.claude/settings.json: {"env":{"ANTHROPIC_BASE_URL":"${url}"},"apiKeyHelper":"bro provider token"}`
    )

    await waitForSignal(server)
    clearStateFile(statePath)
  } finally {
    releaseLock()
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

function cmdToken(argv: string[]): void {
  const pos = positionals(argv, new Set(), { strict: true })
  if (pos.length > 0) {
    usage()
  }
  // apiKeyHelper contract: the token alone on stdout — no decoration
  console.log(endpointOrExit(process.cwd()).token)
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
    apiKeyHelper: 'bro provider token',
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
  bro provider url                  the endpoint ANTHROPIC_BASE_URL points at
  bro provider token                the session token — claude apiKeyHelper
  bro provider env [--json]         eval-able exports, or the settings.json block

Resolution is cwd-aware: ANTHROPIC_BASE_URL pins by exact url, else the
cwd repo's provider-wired serve, else the host listener.`)
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
    case 'url':
      cmdUrl(rest)
      return
    case 'token':
      cmdToken(rest)
      return
    case 'env':
      cmdEnv(rest)
      return
    default:
      console.error(`error: unknown subcommand ${sub}`)
      usage()
  }
}

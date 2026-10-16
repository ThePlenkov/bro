/** Native ACP transport (spec bro-ymbq1) — `/api/v1/acp` brokers
 *  ACP-capable clients onto the same pooled `devin acp` peer the
 *  conductor warms, but WITHOUT translation: JSON-RPC messages pass
 *  through in both directions. The wire shape is ACP Streamable HTTP —
 *  the SDK's AcpServer + createNodeHttpHandler own connection
 *  bookkeeping (`Acp-Connection-Id`), per-session outbound streams
 *  (`Acp-Session-Id`), pending-response routes, and the
 *  buffered-bytes/output-stall limits:
 *
 *    POST /api/v1/acp   one JSON-RPC message; initialize answers
 *                       synchronously with Acp-Connection-Id, later
 *                       calls answer 202 and their response rides the
 *                       SSE stream
 *    GET  /api/v1/acp   Accept: text/event-stream — the agent→client
 *                       stream (connection-level, or per-session when
 *                       Acp-Session-Id is sent)
 *    DELETE /api/v1/acp drop the connection — its brokered sessions
 *                       close upstream best-effort
 *
 *  One logical link serves the whole transport (`initialize` opens it
 *  eagerly so the downstream answer is the upstream handshake minus
 *  loadSession); every brokered session multiplexes on it. Client-bound
 *  calls — session/request_permission, fs/*, terminal/*,
 *  elicitation/create, mcp/message — arrive on the link's bridge and
 *  are routed to the session's owning connection by params.sessionId.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { agent, RequestError } from '@agentclientprotocol/sdk'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node'
import type {
  AgentContext,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
} from '@agentclientprotocol/sdk'
import { acpSessionRetain, otelEvent, otelParent, otelSpan } from '@broject/providers'
import type {
  AcpClientBridge,
  AcpPeer,
  AcpRetainedSession,
  ProviderWireOpts,
} from '@broject/providers'
import { acpLinkPool, disposeQuiet, type ConductorConfig } from './serve-conductor.ts'
import { peerAttrs } from './peer.ts'

/** A session one downstream connection owns — the retained upstream
 *  handle, the peer it lives on, and the connection state back-pointer
 *  so teardown can clear both indexes. */
interface BrokeredSession {
  retained: AcpRetainedSession
  peer: AcpPeer
  client: AgentContext
  conn: ConnState
  /** A prompt turn is in flight — a second concurrent prompt is an
   *  error: the update queue is per-session single-reader, a second
   *  pump would steal the first turn's updates (spec §wire table). */
  busy: boolean
}

/** Per-connection state — minted inside `buildAgent` so it is exactly
 *  one downstream connection's (the SDK hands each request a FRESH
 *  AgentContext wrapper — `ctx.client` identity can't key a map; the
 *  per-connection app closure can). */
interface ConnState {
  /** initialize's clientInfo.name — otel attribution. */
  clientName: string
  sessions: Set<string>
}

/** What the brokered link advertises upstream: the union — every
 *  client-served surface MAY reach a downstream client, so the upstream
 *  agent must see it all offered. A client that advertised less simply
 *  refuses the call and the refusal rides back verbatim. */
const BROKER_CLIENT_CAPS: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
}

/** Thrown handler errors land on the wire as JSON-RPC errors — a plain
 *  Error becomes "Internal error" and loses the detail. Preserve the
 *  message (and any RequestError code) so the client sees what
 *  happened. */
function asWireError(err: unknown): never {
  if (err instanceof RequestError) {
    throw err
  }
  throw new RequestError(-32603, err instanceof Error ? err.message : String(err))
}

const idOf = (params: Record<string, unknown>): string | undefined =>
  typeof params.sessionId === 'string' ? params.sessionId : undefined

export function acpTransport(
  cfg: ConductorConfig,
  opts: ProviderWireOpts = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const by = `acp-transport:${cfg.backend}`
  // upstream sessionId → the brokered session; the upstream id is used
  // verbatim downstream, so one key serves both directions
  const sessions = new Map<string, BrokeredSession>()
  const sessionOf = (params: Record<string, unknown>): BrokeredSession | undefined => {
    const sid = idOf(params)
    return sid === undefined ? undefined : sessions.get(sid)
  }

  /** Agent→client calls arrive on the link's bridge — route by
   *  params.sessionId to the owning connection and let the downstream
   *  client answer (or refuse; the error rides back upstream). */
  const bridge: AcpClientBridge = {
    request: (method, params, signal) => {
      const sess = sessionOf(params)
      if (sess === undefined) {
        throw RequestError.methodNotFound(method)
      }
      return sess.client.request(method, params, { cancellationSignal: signal })
    },
    notify: (method, params) => {
      const sess = sessionOf(params)
      if (sess === undefined) {
        return
      }
      sess.client.notify(method, params).catch(() => {
        // a dead downstream stream is not the agent's problem — the
        // conn.closed cleanup drops the session anyway
      })
    },
  }

  const wireOpts: ProviderWireOpts = {
    ...opts,
    model: opts.model ?? cfg.model,
    acp: {
      cwd: cfg.cwd,
      clientCapabilities: BROKER_CLIENT_CAPS,
      ...opts.acp,
      bridge,
    },
  }
  const pool = acpLinkPool(by, cfg.entry, wireOpts, cfg.timeoutMs)

  /** Out of every index + the local handle dropped — the caller owns
   *  whether upstream gets a session/close first (it can't once the
   *  link itself is dead). */
  const release = (sid: string): void => {
    const sess = sessions.get(sid)
    if (sess === undefined) {
      return
    }
    sessions.delete(sid)
    sess.conn.sessions.delete(sid)
    disposeQuiet(sess.retained)
  }

  /** Client disconnect (DELETE, socket death, the SDK's output-stall
   *  close) → close each owned session upstream best-effort, then drop
   *  the local handles — a disconnect never leaks a peer session. */
  const dropConn = (st: ConnState): void => {
    for (const sid of st.sessions) {
      const sess = sessions.get(sid)
      if (sess === undefined) {
        continue
      }
      sessions.delete(sid)
      void sess.peer.ctx.request('session/close', { sessionId: sid }).catch(() => {
        // dead upstream — the local drop is the point
      })
      disposeQuiet(sess.retained)
    }
    st.sessions.clear()
  }

  // link death ⇒ every session it carried is dead weight — drop them
  // all (the conductor's dropSessions convention); the next client
  // request respawns the link
  pool.onDeath(() => {
    for (const [sid, sess] of sessions) {
      sessions.delete(sid)
      sess.conn.sessions.delete(sid)
      disposeQuiet(sess.retained)
    }
  })

  /** A session-scoped method forwarded verbatim — set_config_option and
   *  set_mode ride the session's own peer. */
  const forwardSession = async (
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> => {
    const sess = sessionOf(params)
    if (sess === undefined) {
      throw RequestError.resourceNotFound(idOf(params))
    }
    try {
      return (await sess.peer.ctx.request(method, params)) ?? {}
    } catch (err) {
      asWireError(err)
    }
  }

  /** Raw passthrough — the identity parser keeps client params
   *  byte-for-byte (a typed registration would run the SDK schema and
   *  could strip fields newer than this binding knows). */
  const raw = (p: unknown): Record<string, unknown> => p as Record<string, unknown>

  /** One agent app per accepted downstream connection — `st` is that
   *  connection's state for its whole life (the SDK gives handlers a
   *  fresh AgentContext wrapper per request, so the app closure is the
   *  only stable conn-scope). */
  const buildAgent = () => {
    const st: ConnState = { clientName: '', sessions: new Set() }
    return (
      agent({ name: 'bro-acp' })
      // AcpServer runs onConnect after initialize answers — attach the
      // disconnect cleanup there
      .onConnect((conn) => {
        // settle-either-way: a rejected `closed` still means the
        // connection is gone — the sessions must not leak
        void conn.closed.then(
          () => dropConn(st),
          () => dropConn(st)
        )
      })
      .onRequest<Record<string, unknown>, unknown>(
        'initialize',
        raw,
        async (ctx): Promise<InitializeResponse> => {
          const params = ctx.params as unknown as InitializeRequest
          st.clientName = params.clientInfo?.name ?? ''
          try {
            const peer = await pool.link()
            otelEvent('acp.transport.connect', {
              backend: cfg.backend,
              'acp.client': st.clientName,
            })
            // the upstream handshake verbatim, minus loadSession — the
            // brokered surface never joins a session it didn't open
            const { loadSession: _dropped, ...caps } = {
              ...(peer.init.agentCapabilities ?? {}),
            } as Record<string, unknown>
            return {
              ...peer.init,
              agentCapabilities: caps as InitializeResponse['agentCapabilities'],
            }
          } catch (err) {
            asWireError(err)
          }
        }
      )
      .onRequest<Record<string, unknown>, unknown>(
        'session/new',
        raw,
        async (ctx) => {
          try {
            const peer = await pool.link()
            // the client's session/new params verbatim (cwd, mcpServers,
            // _meta) + the configured model pin inside acpSessionRetain
            const retained = await acpSessionRetain(
              peer,
              cfg.entry,
              wireOpts,
              Date.now() + cfg.timeoutMs,
              { by, sessionRequest: ctx.params as NewSessionRequest }
            )
            sessions.set(retained.sessionId, {
              retained,
              peer,
              client: ctx.client,
              conn: st,
              busy: false,
            })
            st.sessions.add(retained.sessionId)
            // a bro--<bead-id>-shaped session cwd attributes the
            // session (dirs are named <repo>--<beadId>, the bead id
            // itself is <prefix>-<slug>)
            const beadCwd = typeof ctx.params.cwd === 'string' ? ctx.params.cwd : ''
            const bead = /--([a-z0-9]+-[a-z0-9]+)/i.exec(beadCwd)?.[1]
            otelEvent('acp.transport.session', {
              backend: cfg.backend,
              'acp.client': st.clientName,
              'acp.session_id': retained.sessionId,
              ...(bead !== undefined ? { bead } : {}),
            })
            return retained.newSessionResponse
          } catch (err) {
            asWireError(err)
          }
        }
      )
      .onRequest<Record<string, unknown>, unknown>(
        'session/prompt',
        raw,
        async (ctx) => {
          const sid = idOf(ctx.params)
          const sess = sid === undefined ? undefined : sessions.get(sid)
          if (sess === undefined) {
            throw RequestError.resourceNotFound(sid)
          }
          if (sess.busy) {
            throw new RequestError(
              -32603,
              `session ${sid} is mid-turn — one prompt at a time`
            )
          }
          sess.busy = true
          try {
            const r = await sess.retained.prompt(
              ctx.params.prompt as ContentBlock[],
              Date.now() + cfg.timeoutMs,
              {
                signal: ctx.signal,
                by,
                onUpdate: (update) => {
                  // forward each update as it arrives — notify queues
                  // onto the session's SSE stream and the SDK's
                  // buffered-bytes/output-stall limits are the
                  // backpressure contract
                  sess.client
                    .notify('session/update', { sessionId: sid, update })
                    .catch(() => {
                      // the client went away mid-turn — conn.closed
                      // cleanup owns the session drop
                    })
                },
              }
            )
            return r.response
          } catch (err) {
            asWireError(err)
          } finally {
            sess.busy = false
          }
        }
      )
      .onNotification<Record<string, unknown>>('session/cancel', raw, (ctx) => {
        const sess = sessionOf(ctx.params)
        sess?.peer.ctx.notify<Record<string, unknown>>('session/cancel', ctx.params).catch(() => {})
      })
      .onRequest<Record<string, unknown>, unknown>(
        'session/close',
        raw,
        async (ctx) => {
          const sid = idOf(ctx.params)
          const sess = sid === undefined ? undefined : sessions.get(sid)
          if (sess === undefined) {
            throw RequestError.resourceNotFound(sid)
          }
          try {
            return (await sess.peer.ctx.request('session/close', ctx.params)) ?? {}
          } catch (err) {
            asWireError(err)
          } finally {
            // whether upstream answered or not, the brokered handle is
            // done — the close IS the release
            if (sid !== undefined) {
              release(sid)
            }
          }
        }
      )
      .onRequest<Record<string, unknown>, unknown>(
        'session/set_config_option',
        raw,
        (ctx) => forwardSession('session/set_config_option', ctx.params)
      )
      .onRequest<Record<string, unknown>, unknown>(
        'session/set_mode',
        raw,
        (ctx) => forwardSession('session/set_mode', ctx.params)
      )
      .onRequest<Record<string, unknown>, unknown>(
        'authenticate',
        raw,
        async (ctx) => {
          try {
            const peer = await pool.link()
            return (await peer.ctx.request('authenticate', ctx.params)) ?? {}
          } catch (err) {
            asWireError(err)
          }
        }
      )
    )
    // session/load · resume · fork · list · delete · providers_* ·
    // logout · nes_* · document_* stay unregistered — the SDK answers
    // method-not-found and advertised capabilities never offer them
  }

  const handle = createNodeHttpHandler(new AcpServer({ createAgent: buildAgent }))
  return (req, res) => {
    const t0 = Date.now()
    const method = req.method ?? 'GET'
    const httpSpan = otelSpan(
      `serve.http ${method} /api/v1/acp`,
      {
        backend: cfg.backend,
        'http.method': method,
        'http.route': '/api/v1/acp',
        ...peerAttrs(req.socket),
      },
      { parent: otelParent(req.headers.traceparent) }
    )
    // a GET SSE stream stays open for the connection's life — 'close'
    // fires on finish AND on a dropped socket, so it bounds both
    res.once('close', () => {
      httpSpan.end(
        { 'http.status': res.statusCode, 'http.duration_ms': Date.now() - t0 },
        res.statusCode >= 500 ? 'error' : 'ok'
      )
      otelEvent('serve.request', {
        route: `${method} /api/v1/acp`,
        status: res.statusCode,
        duration_ms: Date.now() - t0,
        backend: cfg.backend,
      })
    })
    handle(req, res)
  }
}

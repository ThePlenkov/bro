/**
 * `GET /api/v1/events/stream` — SSE over the local event broker
 * (specs/bro-9rls.1.md "SSE — the events plane, live", bro-9rls.5),
 * plus `GET /api/v1/events/asyncapi.json`, the generated AsyncAPI 3.x
 * projection of the same topic table.
 *
 * SSE, not WebSocket: the stream is server→client only, the wire
 * carries `Last-Event-ID` resume natively, and no handshake layer is
 * needed. Cursor = `BusCursor {gen, seq}` rendered `<gen>:<seq>` —
 * the frame's `id:` line, exactly what a browser EventSource echoes
 * back on reconnect.
 *
 *   cursorless connect        → BUS_PROBE_LIMIT-sized ring tail + live
 *   `<gen>:<seq>` in window   → replay after seq + live
 *   foreign gen / past window → one `gap` frame then live — the
 *                               client's cue to re-derive from the
 *                               planes (the ring is a replay buffer,
 *                               never the record)
 *   unparseable header        → cursorless tail (the `bro bus --since`
 *                               convention: absent means "from now",
 *                               never a silent resume into the wrong
 *                               seq space)
 *
 * SSE is a *read* — the loopback Host guard upstream is the whole
 * boundary; the stream leaks nothing a `GET /api/v1/planes` doesn't
 * already expose to a same-UID reader.
 *
 * This is a raw-stream route like routeAgentLog — it sits below the
 * ServeResponse envelope because the response pipes for as long as
 * the client stays, and it needs `Last-Event-ID` request headers the
 * route() layer never sees.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BUS_PROBE_LIMIT,
  type BusCursor,
  type BusSubscription,
  type BusSubscriptionHandlers,
  type EventFilter,
} from '@broject/core'
import { EVENTS_TOPICS } from './events.ts'

/** The bus seam the stream consumes — same shape `busSubscribe` has,
 *  declared here so tests drive a fake without a broker. */
export interface EventsStreamBus {
  socketPath(): string | null
  subscribe(
    socketPath: string,
    filter: EventFilter,
    handlers: BusSubscriptionHandlers,
    opts: { since?: number | BusCursor; limit?: number; timeoutMs?: number }
  ): Promise<BusSubscription>
}

/** A backed-up SSE client gets disconnected, not buffered without
 *  bound — reconnect resumes through Last-Event-ID, the broker's own
 *  SLOW_CONSUMER_BYTES rule projected one hop out. */
const SSE_BACKPRESSURE_BYTES = 1024 * 1024

const SSE_KEEPALIVE_MS = 30_000

/** `Last-Event-ID` → `BusCursor`. Present-but-unparseable degrades to
 *  cursorless — a header that cannot name a gen+seq cannot resume. */
export function parseEventCursor(raw: string | string[] | undefined): BusCursor | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v === undefined) {
    return undefined
  }
  const m = /^([^:]+):(\d+)$/.exec(v.trim())
  if (m === null) {
    return undefined
  }
  return { gen: m[1]!, seq: Number(m[2]) }
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  // reverse proxies (hosted mode) buffer event-streams unless told
  'x-accel-buffering': 'no',
} as const

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(`${JSON.stringify(body)}\n`)
}

/** Pump a filtered broker stream onto an SSE response — the shared
 *  leg `/api/v1/events/stream` and `/api/v1/agents/<id>/events?follow`
 *  ride. `filter` is applied broker-side: an agent-scoped stream never
 *  pays for the fleet's traffic. Takes over `res` (200 + SSE headers,
 *  keepalives, close cleanup); resolves when the subscription is armed
 *  — NOT when the client leaves, the caller returns immediately. */
export async function openEventsSse(
  req: IncomingMessage,
  res: ServerResponse,
  bus: EventsStreamBus,
  socket: string,
  filter: EventFilter
): Promise<void> {
  const cursor = parseEventCursor(req.headers['last-event-id'])

  res.writeHead(200, SSE_HEADERS)
  // headers must leave NOW, not with the first frame — an idle ring
  // would otherwise keep a client (and undici's fetch) blind until the
  // keepalive tick, mistaking a live stream for a hung request
  res.flushHeaders()
  // the stream dies on a wedged write — EventSource's own reconnect
  // re-enters with Last-Event-ID and gets gap-or-replay, never a lie.
  // Domain envelopes go out UNNAMED (`data:` only — the topic lives
  // inside the JSON) so a browser's onmessage catches every one;
  // `gap` is the lone named frame — a distinct client signal
  const frame = (id: string | undefined, event: string | undefined, data: string): void => {
    if (res.writableEnded || res.destroyed) {
      return
    }
    res.write(
      (id !== undefined ? `id: ${id}\n` : '') +
        (event !== undefined ? `event: ${event}\n` : '') +
        `data: ${data}\n\n`
    )
  }
  let sub: BusSubscription | undefined
  let clientGone = false
  const drop = (): void => {
    sub?.close()
    clearInterval(keepalive)
    if (!res.writableEnded && !res.destroyed) {
      res.end()
    }
  }
  const keepalive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': ka\n\n')
    }
  }, SSE_KEEPALIVE_MS)
  keepalive.unref?.()
  // close must be armed BEFORE the subscribe await — a client that
  // disconnects mid-handshake would otherwise leave the broker
  // subscription and the keepalive leaking
  res.on('close', () => {
    clientGone = true
    drop()
  })
  try {
    sub = await bus.subscribe(
      socket,
      filter,
      {
        onEvent: (e) => {
          const rec = e as { gen?: string; seq?: number }
          // the id line is wire text — a gen carrying CR/LF would
          // inject frames; the broker's own gen is a token, but the
          // field is sanitized because the frame boundary depends on it
          const id =
            typeof rec.gen === 'string' && typeof rec.seq === 'number'
              ? `${rec.gen.replace(/[\r\n]/g, '')}:${rec.seq}`
              : undefined
          frame(id, undefined, JSON.stringify(e))
          if (res.writableLength > SSE_BACKPRESSURE_BYTES) {
            drop()
          }
        },
        onGap: (seq) =>
          frame(undefined, 'gap', JSON.stringify({ seq: typeof seq === 'number' ? seq : null })),
        onClose: () => drop(),
      },
      // cursorless: the BUS_PROBE_LIMIT ring tail. A cursor replays
      // from seq; a foreign gen or a window-evicted cursor answers a
      // `gap` frame broker-side — re-derive is the client's ladder
      { since: cursor ?? 0, ...(cursor === undefined ? { limit: BUS_PROBE_LIMIT } : {}) }
    )
  } catch {
    drop()
    return
  }
  if (clientGone) {
    // the client left while subscribe was in flight — nothing reads
    // this subscription; release it instead of streaming into a hole
    sub.close()
    return
  }
}

/** True once the path matched — any verdict (405/503 or the stream);
 *  false lets other paths through. */
export async function routeEventsStream(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  bus: EventsStreamBus | undefined
): Promise<boolean> {
  if (pathname !== '/api/v1/events/stream') {
    return false
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const socket = bus?.socketPath() ?? null
  if (bus === undefined || socket === null) {
    sendJson(res, 503, { error: 'event broker unavailable — no live bus on this repo' })
    return true
  }
  await openEventsSse(req, res, bus, socket, {})
  return true
}

/** The topic registry the AsyncAPI doc projects — the plane owns this
 *  table; the doc is GENERATED from it so a doc/event drift is
 *  impossible by construction. */
export function asyncapiDocument(): unknown {
  const messages = Object.fromEntries(
    EVENTS_TOPICS.map((t) => [
      t.topic,
      {
        name: t.topic,
        title: t.summary,
        contentType: 'application/json',
        payload: { type: 'object' },
      },
    ])
  )
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'bro events',
      version: '1.0.0',
      description:
        'Server-sent events over the local bro broker — cursor resume via Last-Event-ID `<gen>:<seq>`, `gap` frames mean re-derive from the planes.',
    },
    channels: {
      events: {
        address: '/api/v1/events/stream',
        description: 'the live bus — mailbox-mirrored notify drops plus rig lifecycle',
        messages: {
          ...messages,
          gap: {
            name: 'gap',
            title: 'cursor fell outside the ring — re-derive state before trusting the next event',
            payload: { type: 'object', properties: { seq: { type: 'integer' } } },
          },
        },
      },
    },
    operations: {
      eventsStream: {
        // bro SENDS the channel's events to the client — AsyncAPI's
        // action names the documented application's direction
        action: 'send',
        channel: { $ref: '#/channels/events' },
      },
    },
  }
}

/**
 * `events` facade connectors — the transports that can carry an event.
 *
 * Registration order is the fallback precedence (`connectors.ts:250`),
 * so `mailbox` registers first and stays the default: `bro notify` works
 * with no broker, no config and no daemon, and that is its most valuable
 * property. The bus is opt-in via `bro.config.json`:
 *
 *   { "connectors": { "events": "bus" } }
 *
 * The mailbox is the honest floor, not a degraded bus. It has no total
 * order, so its events carry no `seq`; it delivers text verbatim, which
 * is what the postTool probe has always printed; and it can only deliver
 * once, so `subscribe` resolves after that delivery. Absence is reported
 * as a `reason`, never faked and never thrown.
 */
import { drainMailbox, dropMailbox, notifyDir } from './notify.ts'
import type { Connector, ConnectorCtx } from './connectors.ts'
import {
  busProbe,
  busPublish,
  busSocketPath,
  busSubscribe,
} from './bus.ts'
import {
  eventMatches,
  isEventInput,
  type EventEnvelope,
  type EventFilter,
  type EventHandlers,
  type EventInput,
  type EventProbeResult,
  type EventPublishResult,
  type EventsFacade,
  type EventSubscription,
} from './events.ts'

/** What a mailbox drop can honestly claim. It is a text transport: no
 *  order, no topics — a consumer that needs those configures a bus. */
const MAILBOX_TOPIC = 'mailbox'
const MAILBOX_KIND = 'note'

/**
 * The mailbox text for an event. A plain note is written verbatim, because
 * drops are injected as-is and a heartbeat's formatting is part of the
 * event (`notify.ts:143-145`) — that is `bro notify` today and its bytes
 * must not move. Anything with identity beyond topic/kind is JSON, or the
 * topic would be dropped on the floor and the event could never be
 * filtered on the way back out.
 */
function mailboxText(event: EventInput): string {
  const plainNote =
    event.topic === 'notify' &&
    event.kind === 'note' &&
    event.key === undefined &&
    event.cause === undefined &&
    event.ref === undefined &&
    event.source === undefined
  // A verbatim note whose text parses as an event would come back out of
  // the drain as that event — a different topic and a lost payload — so
  // JSON-shaped notes go through the envelope like everything else.
  if (plainNote && typeof event.payload === 'string' && parseEvent(event.payload) === undefined) {
    return event.payload
  }
  return JSON.stringify(event)
}

/** The one place a drop's text is asked "are you an event?" — shared by
 *  the write side (to keep raw notes distinguishable) and the read side
 *  (to decode envelopes). */
function parseEvent(text: string): EventInput | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) {
    return undefined
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isEventInput(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Drops are text, so a drain cannot recover a topic the writer did not
 *  encode. A bare note is reported as a note; a JSON drop is parsed back
 *  into the event that was published. */
function mailboxEvent(text: string, locator: string | undefined): EventEnvelope {
  const parsed = parseEvent(text)
  if (parsed !== undefined) {
    return {
      ...parsed,
      ts: new Date().toISOString(),
      ...(locator !== undefined ? { locator } : {}),
    }
  }
  return {
    topic: MAILBOX_TOPIC,
    kind: MAILBOX_KIND,
    payload: text,
    ts: new Date().toISOString(),
    ...(locator !== undefined ? { locator } : {}),
  }
}

/** The mailbox as an `events` provider — publish is a drop, delivery is a
 *  one-shot drain of what this session has not seen. */
export function mailboxEvents(dir: string, sessionId: string | undefined): EventsFacade {
  const noCursor: EventProbeResult = {
    events: [],
    gapped: false,
    reason: sessionId === undefined ? 'mailbox delivery needs a session cursor' : 'mailbox is not running',
  }

  const deliver = (filter: EventFilter, handlers: EventHandlers): EventEnvelope[] => {
    if (sessionId === undefined) {
      return []
    }
    // The filter reaches into the drain: a drop this subscription does
    // not match stays unseen for the session, or a filtered subscribe
    // would permanently consume drops a later subscription was due.
    const texts = drainMailbox(dir, sessionId, (text) =>
      eventMatches(filter, mailboxEvent(text, undefined))
    )
    const out: EventEnvelope[] = []
    for (const text of texts) {
      const event = mailboxEvent(text, undefined)
      out.push(event)
      handlers.onEvent(event)
    }
    return out
  }

  return {
    async publish(event: EventInput): Promise<EventPublishResult> {
      const target = notifyDir(dir)
      // No seq: a set of files has no total order, and inventing one is
      // exactly the kind of lie this facade refuses to tell. A failed
      // write is a transport problem — a result, not a rejection.
      try {
        const locator = dropMailbox(target, mailboxText(event), 'note')
        return { published: true, locator }
      } catch (err) {
        return { published: false, reason: err instanceof Error ? err.message : String(err) }
      }
    },

    async subscribe(
      filter: EventFilter,
      handlers: EventHandlers,
      opts?: { since?: number }
    ): Promise<EventSubscription> {
      if (opts?.since !== undefined) {
        // The facade's `since` is a cursor this transport cannot honour;
        // silently ignoring it would let a consumer believe it caught up.
        // No seq either — a transport with no order has none to report.
        handlers.onGap?.()
      }
      deliver(filter, handlers)
      // One-shot: the drain already consumed everything this session
      // had, so there is nothing left to stream.
      return { close: () => {} }
    },

    async probe(opts?: { since?: number; limit?: number }): Promise<EventProbeResult> {
      if (sessionId === undefined) {
        return noCursor
      }
      const events = deliver({}, { onEvent: () => {} })
      // `since` asks for a cursor replay the mailbox cannot honour —
      // deliver what it can, but mark the gap so nobody reads a partial
      // drain as a complete one.
      const cursorGap = opts?.since !== undefined
      const limit = opts?.limit
      if (limit !== undefined && events.length > limit) {
        return { events: limit === 0 ? [] : events.slice(-limit), gapped: true }
      }
      return { events, gapped: cursorGap }
    },
  }
}

/** The local bus as an `events` provider — every operation already fails
 *  open, so the facade's contract holds by construction. */
export function busEvents(dir: string): EventsFacade {
  const socketPath = busSocketPath(dir)
  const down: EventPublishResult = { published: false, reason: 'broker down' }
  if (socketPath === null) {
    return {
      publish: async () => down,
      subscribe: async () => {
        throw new Error('bro bus: not a repository')
      },
      probe: async () => ({ events: [], gapped: false, reason: 'not a repository' }),
    }
  }
  return {
    publish: (event, opts) => busPublish(socketPath, event, opts ?? {}),
    subscribe: (filter: EventFilter, handlers: EventHandlers, opts?: { since?: number; timeoutMs?: number }) =>
      busSubscribe(socketPath, filter, handlers, {
        ...(opts?.since !== undefined ? { since: opts.since } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    probe: (opts) => busProbe(socketPath, opts ?? {}),
  }
}

/** The default `events` connector — a mailbox. Registered first so it
 *  wins the fallback precedence and `notify` keeps working untouched. */
export const mailboxConnector: Connector = {
  name: 'mailbox',
  events: (ctx: ConnectorCtx) => mailboxEvents(ctx.dir, ctx.sessionId),
}

/** The bus as a connector — opt-in, because a bus that is not running is
 *  a routine state and a default would make every event a silent no-op. */
export const busConnector: Connector = {
  name: 'bus',
  // Requires a running broker and moves events off the mailbox, so it
  // is named in config or not used at all.
  optIn: true,
  events: (ctx: ConnectorCtx) => busEvents(ctx.dir),
}

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
import {
  coalesceDrops,
  drainMailbox,
  dropMailbox,
  mailboxEvent,
  mailboxIdentity,
  mailboxText,
  notifyDir,
} from './notify.ts'
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

/** The mailbox as an `events` provider — publish is a drop, delivery is a
 *  one-shot drain of what this session has not seen. The codec lives in
 *  notify.ts — the drain path parses envelopes for addressing, so the
 *  "is this text an event" question has exactly one home. */
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
    // Addressing (`to`) is gated by the consumer's real identity inside
    // the drain — env-derived, not declared — so the keep fn strips it
    // or a probe with no declared `to` could never see its own mail.
    const texts = drainMailbox(dir, sessionId, {
      keep: (text) => {
        const { to: _addressed, ...unaddressed } = mailboxEvent(text, undefined)
        return eventMatches(filter, unaddressed)
      },
      for: mailboxIdentity(sessionId),
    })
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
      // Malformed input is a caller bug: an event that cannot satisfy
      // the contract (an empty-string `to` reading as broadcast is the
      // sharp edge) must never reach a consumer as something it is not.
      if (!isEventInput(event)) {
        return { published: false, reason: 'invalid event input' }
      }
      try {
        // `--key` coalesces: pending same-key drops from this source are
        // stale by definition — the writer repeating a key has fresher
        // news, and a chatty fleet must not inflate every drain
        if (event.key !== undefined) {
          coalesceDrops(target, event.key, {
            source: event.source,
            topic: event.topic,
            to: event.to,
          })
        }
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

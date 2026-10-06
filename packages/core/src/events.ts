/**
 * Events — bro's event capability, as a FACADE.
 *
 * The contract is named by domain semantics (topic, kind, key, cause,
 * ref) and never by a transport: `mqttPublish` has no place here, the
 * same way `checkRuns` has none in ReviewFacade. Which wire carries an
 * event is a connector's business — a mailbox file today, the local bus,
 * MQTT or AMQP when the fleet goes multi-host — and `bro.config.json`'s
 * `connectors.events` picks between them.
 *
 * Two things are deliberately optional rather than faked:
 *
 * - `seq` — a transport with no total order (a mailbox is a set of files)
 *   leaves it undefined instead of inventing one. A consumer that needs
 *   ordering asks for events that have it.
 * - the delivery cursor — `probe` is the hook-path primitive and must
 *   resolve even when there is nothing to say. Absence of a transport is
 *   reported as a `reason`, never as a throw, because every caller worth
 *   having sits on a hook that must fail open.
 */

/** One event as published. Identity fields are optional; `topic` and
 *  `kind` are what a subscriber filters on, so they are required. */
export interface EventInput {
  topic: string
  kind: string
  /** Subject identity — a bead id, a PR number, an agent id. A notify
   *  drop with a `key` also coalesces: a newer drop replaces pending
   *  same-key drops from the same source. */
  key?: string
  /** Recipient address — an agent id, a session id, or the reserved
   *  role `orchestrator` (the session that owns agents: one without
   *  BRO_AGENT_ID). Absent means broadcast. A transport must honor it —
   *  an addressed event that reaches unmatched consumers is a leak,
   *  not a delivery. */
  to?: string
  /** Who published it. */
  source?: string
  /** What this event answers: a prior `seq`, a bead/step id, or a
   *  mailbox drop — `--in-reply-to` threading rides this field. */
  cause?: string
  /** Opaque handle to an artifact: a worktree, a PR, a log file. */
  ref?: string
  payload?: unknown
}

/** One event as delivered. `seq` and `ts` belong to the transport. */
export interface EventEnvelope extends EventInput {
  /** Transport-assigned order. Undefined on a transport with no total
   *  order — absence is honest, a fabricated counter is not. */
  seq?: number
  ts: string
  /** Where the transport put it, when a caller needs to point at the
   *  stored event — a mailbox file path, a durable log offset. */
  locator?: string
}

/** Subscriber-side selection, applied once by the transport. */
export interface EventFilter {
  topics?: string[]
  kinds?: string[]
  /** The subscriber's address. An event carrying `to` matches only a
   *  filter declaring the same address; broadcast events (no `to`)
   *  match any filter. */
  to?: string
}

export interface EventHandlers {
  onEvent: (event: EventEnvelope) => void
  /** The cursor fell outside what the transport still holds, or a slow
   *  consumer lost events — re-derive from state rather than trust the
   *  events you did get. `seq` is the transport's head when it has one;
   *  a transport with no sequence (the mailbox) omits it rather than
   *  invent a number. */
  onGap?: (seq?: number) => void
}

export interface EventSubscription {
  close(): void
}

export interface EventPublishResult {
  published: boolean
  /** The assigned `seq`, when the transport has one. */
  seq?: number
  /** Why it did not publish. A transport that is simply not running is a
   *  routine state, so this is a reason and not an exception. */
  reason?: string
  locator?: string
}

export interface EventProbeResult {
  events: EventEnvelope[]
  gapped: boolean
  reason?: string
}

export interface EventsFacade {
  /** Fire one event. Fail-open by contract — a caller on the hook path
   *  cannot let a transport problem become a session problem. */
  publish(event: EventInput, opts?: { timeoutMs?: number }): Promise<EventPublishResult>
  /** Stream matching events. Without a cursor this is the live stream
   *  from now; `since` replays from an offset where the transport has
   *  one. A transport that can only deliver once resolves after that
   *  delivery rather than pretending to stream. */
  subscribe(
    filter: EventFilter,
    handlers: EventHandlers,
    opts?: { since?: number; timeoutMs?: number }
  ): Promise<EventSubscription>
  /** Collect whatever is waiting, within a window. The hook-path
   *  primitive: it resolves, it never throws, and it never outlives its
   *  budget. */
  probe(opts?: { since?: number; windowMs?: number; limit?: number }): Promise<EventProbeResult>
}

/** `'*'`, an exact topic, or a trailing-`*` prefix glob. */
export function eventTopicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') {
    return true
  }
  if (pattern.endsWith('*')) {
    return topic.startsWith(pattern.slice(0, -1))
  }
  return pattern === topic
}

/** Topics and kinds intersect; an omitted or empty list is not a filter,
 *  because treating "no narrowing given" as "match nothing" would hide
 *  every event from a subscriber that asked for no narrowing. */
export function eventMatches(filter: EventFilter, event: { topic: string; kind: string }): boolean {
  // A filter can arrive off the wire, so its shape is not the caller's
  // to guarantee — `Array.isArray`, not a cast: a string `topics` has
  // no `.some`, and throwing inside the broker's socket callback would
  // take the whole bus down over one bad frame.
  const topics = filter.topics
  // `Array.isArray` alone is not enough — `{topics: [null]}` is an array,
  // and `eventTopicMatches` would call `.endsWith` on null inside the
  // transport's socket callback. A non-string entry matches nothing; it
  // must not throw.
  if (
    Array.isArray(topics) &&
    topics.length > 0 &&
    !topics.some((p) => typeof p === 'string' && eventTopicMatches(p, event.topic))
  ) {
    return false
  }
  const kinds = filter.kinds
  if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(event.kind)) {
    return false
  }
  // Addressed events reach only the declared recipient — anything else
  // is a leak (EventInput.to's contract). Broadcast events reach all.
  const to = (event as { to?: unknown }).to
  if (typeof to === 'string' && to !== '' && to !== filter.to) {
    return false
  }
  return true
}

/** `topic` and `kind` are required and non-empty — an event that cannot
 *  be filtered on cannot be routed. Optional identity fields are
 *  checked too: a `key: 7` sailing through the narrow would hand typed
 *  consumers a number where the contract promises a string. */
export function isEventInput(value: unknown): value is EventInput {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    typeof v['topic'] === 'string' &&
    v['topic'] !== '' &&
    typeof v['kind'] === 'string' &&
    v['kind'] !== '' &&
    (v['key'] === undefined || typeof v['key'] === 'string') &&
    (v['to'] === undefined || typeof v['to'] === 'string') &&
    (v['source'] === undefined || typeof v['source'] === 'string') &&
    (v['cause'] === undefined || typeof v['cause'] === 'string') &&
    (v['ref'] === undefined || typeof v['ref'] === 'string')
  )
}
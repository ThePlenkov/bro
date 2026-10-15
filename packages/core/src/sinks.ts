/**
 * Notify sinks — the HUMAN edge of the event plane (spec:
 * specs/bro-huy5o.8.md). The mailbox and bus deliver events to agents;
 * sinks deliver them to people: a convoy that hits a HUMAN GATE, a drive
 * pass that found a stuck PR or a silent reviewer, an `act wait` that
 * settled, a wtf that was just captured — moments whose whole point is
 * that a human hears about them now, not at next session start.
 *
 * Sinks ride the publish edge: `withSinks` wraps an `events` facade so
 * every `facade('events').publish` also fans out to the `notify.sinks`
 * config entries the event matches — the emitter writes once, the
 * event reaches agents and humans down their own planes.
 *
 * Three rules carry the bead's contract:
 *
 * - routing is config: `events` patterns pick which topics/kinds a sink
 *   hears (same "no narrowing = everything" rule as EventFilter)
 * - secrets come from env: `urlEnv`/`tokenEnv`/`chatIdEnv` name the
 *   variable; the value never enters config, argv, or logs
 * - delivery never blocks the agent: every request is bounded by an
 *   AbortSignal timeout, every failure is a result row, and nothing in
 *   this module throws on a delivery problem
 *
 * A dedup file (`<notifyDir>/sink-state.json`) suppresses identical
 * re-emits inside a sink's `minIntervalMs` (default 4h) — a `drive
 * --every` pass re-alerts on the interval, not every tick. A changed
 * message is a different event and always sends.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig, type SinkDef, type SinkType } from './config.ts'
import {
  eventTopicMatches,
  isEventInput,
  type EventInput,
  type EventsFacade,
} from './events.ts'
import { notifyDir } from './notify.ts'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000
/** Dedup records past this age are swept — the file is a cache, not a
 *  ledger; a stale hash that outlived its use is just noise. */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type FetchFn = typeof fetch

/** One sink's resolved wire shape — the `{url, body}` pair, a missing
 *  env var name, or a refused reason. Core owns the contract; a sink
 *  type's builder owns the policy that produces it. */
export type SinkRequest = { url: string; body: unknown } | { missing: string } | { refused: string }

export type SinkRequestBuilder = (
  sink: SinkDef,
  event: EventInput,
  env: NodeJS.ProcessEnv
) => SinkRequest

/** Per-type request builders registered by the plugin layer — a sink's
 *  delivery policy (url shape, apiBase rules, secret fields) lives with
 *  the plugin that ships the type, not in core (bro-mq1t2). An
 *  unregistered type takes the generic {url,body} path below. */
const sinkBuilders = new Map<string, SinkRequestBuilder>()

/** Types whose wire shape the generic path below knows — every other
 *  type without a registered builder reports unwired, not "no url". */
const GENERIC_SINK_TYPES = new Set<string>(['slack', 'webhook'])

export function registerSinkBuilder(type: string, build: SinkRequestBuilder): void {
  sinkBuilders.set(type, build)
}

/** Tests unregister what they registered — a leak would hijack every
 *  later requestFor for that type in the same process. */
export function unregisterSinkBuilder(type: string): void {
  sinkBuilders.delete(type)
}

/** Does `event` pass this sink's routing patterns? `topic` or
 *  `topic:kind`, each half `*`/trailing-`*`-able; absent/empty means
 *  the sink hears everything. */
export function sinkMatches(sink: SinkDef, event: { topic: string; kind: string }): boolean {
  const patterns = sink.events
  if (patterns === undefined || patterns.length === 0) {
    return true
  }
  return patterns.some((p) => {
    const colon = p.indexOf(':')
    const topic = colon === -1 ? p : p.slice(0, colon)
    const kind = colon === -1 ? undefined : p.slice(colon + 1)
    return (
      eventTopicMatches(topic, event.topic) &&
      (kind === undefined || eventTopicMatches(kind, event.kind))
    )
  })
}

/** The one-line human form of an event — sinks post text, not
 *  envelopes. A string payload is already the message; anything else
 *  is summarized as JSON (bounded — a webhook is not a data pipe). */
export function renderEventText(event: EventInput): string {
  let body: string
  if (typeof event.payload === 'string') {
    body = event.payload
  } else if (event.payload !== undefined) {
    const json = JSON.stringify(event.payload)
    body = json !== undefined && json.length <= 500 ? json : event.topic
  } else {
    body = event.ref ?? event.topic
  }
  const head = `[${event.topic}/${event.kind}]`
  return `${head} ${body}`.replace(/\s+/g, ' ').trim()
}

/** The env vars a sink needs — for `bro sinks list`, which reports
 *  "secret configured?" without ever printing a value. */
export function sinkSecrets(sink: SinkDef): string[] {
  return [sink.urlEnv, sink.tokenEnv, sink.chatIdEnv].filter(
    (e): e is string => e !== undefined
  )
}

/** The wire shape per sink type. Resolution happens per delivery: env
 *  is process state, and a worker spawned before the var existed
 *  should fail then, not at parse time. Returns `{missing: <env name>}`
 *  when a required secret is unset and `{refused: <reason>}` when the
 *  endpoint itself is unacceptable — a credential-bearing URL (a
 *  `urlEnv` indirection marks the endpoint as a secret) must be
 *  `https://`, since an `http://`
 *  first hop hands the secret to any on-path observer. `requestFor`
 *  never reveals the secret itself: the URL goes to the wire, never to
 *  a log, and `refused` names the field, not the value. */
export function requestFor(
  sink: SinkDef,
  event: EventInput,
  env: NodeJS.ProcessEnv = process.env
): SinkRequest {
  // a registered builder owns its type's whole wire shape — the generic
  // path below is the contract for url/urlEnv sinks
  const build = sinkBuilders.get(sink.type)
  if (build !== undefined) {
    try {
      return build(sink, event, env)
    } catch {
      // a throwing builder is a policy bug — report it like any refused
      // endpoint; the contract is "requestFor never throws"
      return { refused: `builder for '${sink.type}' threw` }
    }
  }
  // a non-generic type with no builder and no endpoint fields is unwired
  // — say so plainly instead of a misleading "env url not set"
  if (
    !GENERIC_SINK_TYPES.has(sink.type) &&
    sink.url === undefined &&
    sink.urlEnv === undefined
  ) {
    return { refused: `no request builder registered for sink type '${sink.type}'` }
  }
  // `urlEnv` when named is the whole channel — falling back to a
  // literal `url` would post events to a stale endpoint the operator
  // declared env-indirected; an unset var reports missing, not a swap
  const url = sink.urlEnv !== undefined ? env[sink.urlEnv]?.trim() : sink.url
  if (url === undefined || url === '') {
    return { missing: sink.urlEnv ?? 'url' }
  }
  // A `urlEnv`-resolved endpoint is a declared secret — cleartext http
  // would hand it to the wire. Literal `url` is the documented
  // non-secret path and stays unrestricted (internal http receivers).
  if (sink.urlEnv !== undefined && !url.toLowerCase().startsWith('https://')) {
    return { refused: `env ${sink.urlEnv} must resolve to an https:// endpoint` }
  }
  const body =
    sink.type === 'slack'
      ? { text: renderEventText(event) }
      : { ...event, ts: new Date().toISOString(), text: renderEventText(event) }
  return { url, body }
}

/** One sink's outcome — `delivered` is the only success; `reason`
 *  carries the why otherwise (unset env var, dedup suppression, HTTP
 *  or transport failure). Rows are for `bro sinks` output and tests. */
export interface SinkDelivery {
  sink: string
  type: SinkType
  delivered: boolean
  reason?: string
  status?: number
}

/** `sink-state.json` next to the mailbox — the dedup ledger: hash →
 *  ISO timestamp of the last successful send. */
export function sinkStatePath(dir: string): string {
  return join(notifyDir(dir), 'sink-state.json')
}

/** What makes a send "the same event at the same sink" — the sink's
 *  slot (name or position), the routing identity, the rendered text,
 *  and the raw payload. `key` coalescing stays a mailbox rule; sinks
 *  dedupe on the whole message so two different keyed events never
 *  suppress each other just for sharing a key. The raw payload rides
 *  alongside the text because render collapses — 'a\tb' and 'a b' are
 *  one message on screen but two distinct webhook bodies. */
function dedupHash(sinkId: string, event: EventInput, text: string): string {
  const raw = event.payload === undefined ? '' : (JSON.stringify(event.payload) ?? '')
  // to/ref ride the generic webhook body but not the rendered text —
  // key them or two events differing only in addressee collapse
  return createHash('sha256')
    .update(
      `${sinkId}\0${event.topic}\0${event.kind}\0${event.key ?? ''}\0${event.to ?? ''}\0${event.ref ?? ''}\0${text}\0${raw}`
    )
    .digest('hex')
    .slice(0, 24)
}

function readState(path: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, string>
    }
  } catch {
    // missing or unreadable — treated as empty, dedup fails open
  }
  return {}
}

/** Persist the updated ledger — tmp+rename like mailbox drops, and
 *  prune entries past `retentionMs` on every write so the file stays a
 *  cache. The retention floor is STATE_TTL_MS but extends to the
 *  longest configured resend interval — pruning inside that floor
 *  would let an active dedup record die early and re-page a human
 *  before its `minIntervalMs` is up. A failed write just means a
 *  re-send next event: fail-open. */
function writeState(
  path: string,
  state: Record<string, string>,
  now: number,
  retentionMs: number
): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const cutoff = now - retentionMs
    const pruned = Object.fromEntries(
      Object.entries(state).filter(([, ts]) => {
        const t = Date.parse(ts)
        return Number.isFinite(t) && t > cutoff
      })
    )
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(pruned))
    renameSync(tmp, path)
  } catch {
    // best-effort — a lost dedup record is a duplicate message, not a crash
  }
}

export interface DeliverOpts {
  /** Injected for tests; default global fetch. */
  fetch?: FetchFn
  /** Injected clock for tests; default Date.now(). */
  now?: number
  /** Explicit sink list — bypasses config (tests, `bro sinks test`). */
  sinks?: SinkDef[]
  /** Deliver to every sink regardless of route patterns — explicit
   *  test delivery (`bro sinks test` proves the endpoint, not the
   *  routing table). Normal publishes leave it unset. */
  all?: boolean
  env?: NodeJS.ProcessEnv
}

/** Deliver `event` to every configured sink it routes to. NEVER throws:
 *  config read, matching, resolution, dedup IO, and the POST itself are
 *  all fail-open — a sink problem is a row in the result, never an
 *  exception in the publisher's call stack. */
export async function deliverSinks(
  dir: string,
  event: EventInput,
  opts: DeliverOpts = {}
): Promise<SinkDelivery[]> {
  const fetchImpl = opts.fetch ?? fetch
  const now = opts.now ?? Date.now()
  const env = opts.env ?? process.env
  let sinks: SinkDef[]
  try {
    sinks = opts.sinks ?? loadConfig(dir).notify.sinks
  } catch {
    return []
  }
  const matched = sinks
    .map((sink, i) => ({ sink, id: sink.name ?? `${sink.type}#${i}` }))
    .filter(({ sink }) => opts.all === true || sinkMatches(sink, event))
  if (matched.length === 0) {
    return []
  }
  const retentionMs = sinks.reduce(
    (max, sink) => Math.max(max, sink.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS),
    STATE_TTL_MS
  )
  const text = renderEventText(event)
  const statePath = sinkStatePath(dir)
  const state = readState(statePath)
  const nowIso = new Date(now).toISOString()
  const results = await Promise.all(
    matched.map(async ({ sink, id }): Promise<SinkDelivery> => {
      const hash = dedupHash(id, event, text)
      const last = state[hash]
      const minInterval = sink.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
      if (minInterval > 0 && last !== undefined && Date.parse(last) > now - minInterval) {
        return { sink: id, type: sink.type, delivered: false, reason: 'deduped' }
      }
      const req = requestFor(sink, event, env)
      if ('missing' in req) {
        return { sink: id, type: sink.type, delivered: false, reason: `env ${req.missing} not set` }
      }
      if ('refused' in req) {
        return { sink: id, type: sink.type, delivered: false, reason: req.refused }
      }
      try {
        const res = await fetchImpl(req.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req.body),
          // the URL is the secret (telegram token in path, webhook
          // endpoint) — never let a redirect carry the POST elsewhere
          redirect: 'manual',
          signal: AbortSignal.timeout(sink.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })
        if (res.status >= 300 || res.type === 'opaqueredirect' || res.status === 0) {
          return {
            sink: id,
            type: sink.type,
            delivered: false,
            reason: `HTTP ${res.status}`,
            status: res.status,
          }
        }
        state[hash] = nowIso
        return { sink: id, type: sink.type, delivered: true, status: res.status }
      } catch (err) {
        const name = (err as { name?: string })?.name
        let reason: string
        if (name === 'TimeoutError' || name === 'AbortError') {
          reason = `timeout after ${sink.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        } else {
          // fetch errors can embed the request URL ("Failed to parse
          // URL from …") — the endpoint is a secret, scrub it before
          // the reason reaches a report or a log
          const msg = err instanceof Error ? err.message : String(err)
          reason = msg.replaceAll(req.url, '<endpoint>')
        }
        return { sink: id, type: sink.type, delivered: false, reason }
      }
    })
  )
  if (results.some((r) => r.delivered)) {
    writeState(statePath, state, now, retentionMs)
  }
  return results
}

/** Wrap an events facade so every publish also fans out to configured
 *  sinks — the human plane rides the same call as the agent transport.
 *  Sinks run in parallel with the transport publish and only for input
 *  that satisfies the event contract; a transport rejection does not
 *  cancel a human delivery that is already in flight. */
export function withSinks(dir: string, facade: EventsFacade): EventsFacade {
  return {
    ...facade,
    publish: async (event, opts) => {
      const sinks = isEventInput(event) ? deliverSinks(dir, event).catch(() => []) : undefined
      const res = await facade.publish(event, opts)
      if (sinks !== undefined) {
        await sinks // publish resolves only once the human edge settled too
      }
      return res
    },
  }
}

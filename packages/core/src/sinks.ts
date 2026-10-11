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
const TELEGRAM_API = 'https://api.telegram.org'
/** Dedup records past this age are swept — the file is a cache, not a
 *  ledger; a stale hash that outlived its use is just noise. */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type FetchFn = typeof fetch

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
 *  when a required secret is unset — `requestFor` never reveals the
 *  secret itself (the URL contains the telegram token, but it goes to
 *  the wire, never to a log). */
export function requestFor(
  sink: SinkDef,
  event: EventInput,
  env: NodeJS.ProcessEnv = process.env
): { url: string; body: unknown } | { missing: string } {
  if (sink.type === 'telegram') {
    const token = sink.tokenEnv !== undefined ? env[sink.tokenEnv]?.trim() : undefined
    if (token === undefined || token === '') {
      return { missing: sink.tokenEnv ?? 'tokenEnv' }
    }
    const chatId =
      sink.chatId ?? (sink.chatIdEnv !== undefined ? env[sink.chatIdEnv]?.trim() : undefined)
    if (chatId === undefined || chatId === '') {
      return { missing: sink.chatIdEnv ?? 'chatId' }
    }
    // linear trim — a `/+$/` regex on operator input is a ReDoS shape
    let base = sink.apiBase ?? TELEGRAM_API
    while (base.endsWith('/')) {
      base = base.slice(0, -1)
    }
    return {
      url: `${base}/bot${token}/sendMessage`,
      body: {
        chat_id: chatId,
        text: renderEventText(event),
        disable_web_page_preview: true,
      },
    }
  }
  // `urlEnv` when named is the whole channel — falling back to a
  // literal `url` would post events to a stale endpoint the operator
  // declared env-indirected; an unset var reports missing, not a swap
  const url = sink.urlEnv !== undefined ? env[sink.urlEnv]?.trim() : sink.url
  if (url === undefined || url === '') {
    return { missing: sink.urlEnv ?? 'url' }
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
 *  slot (name or position), the routing identity, and the rendered
 *  text. `key` coalescing stays a mailbox rule; sinks dedupe on the
 *  whole message so two different keyed events never suppress each
 *  other just for sharing a key. */
function dedupHash(sinkId: string, event: EventInput, text: string): string {
  return createHash('sha256')
    .update(`${sinkId}\0${event.topic}\0${event.kind}\0${event.key ?? ''}\0${text}`)
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
 *  prune entries past STATE_TTL_MS on every write so the file stays a
 *  cache. A failed write just means a re-send next event: fail-open. */
function writeState(path: string, state: Record<string, string>, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const cutoff = new Date(now - STATE_TTL_MS).toISOString()
    const pruned = Object.fromEntries(
      Object.entries(state).filter(([, ts]) => typeof ts === 'string' && ts > cutoff)
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
    writeState(statePath, state, now)
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

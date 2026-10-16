/**
 * The 'agent' topic — normalized in-turn activity published at the
 * pumpTurn chokepoint (bro-0ppt0). Every ACP turn (conductor pool,
 * fleet acp-worker, judge) funnels through one pump, so one observer
 * here serves every transport; no per-transport patches.
 *
 * Two sinks, both fail-open:
 *
 * - the repo's bus — the live tail. Topics/kinds are normalized so the
 *   broker ring answers "agent last did X" without the consumer knowing
 *   ACP wire shapes. Per-chunk text deltas stay OFF the socket: a busy
 *   turn emits thousands of them and the broker's slow-consumer drop
 *   would make that noise cost real events.
 * - `<git-common>/bro/agents/<agentId>.events.jsonl` — the durable
 *   archive next to the rendered `.log`. Full fidelity: every raw
 *   session/update lands as a row, chunks included, bookended by turn
 *   start/stop. Written only when the process carries a BRO_AGENT_ID
 *   badge — unmanaged turns (conductor sessions, judge calls) have no
 *   agent artifact home and simply don't archive.
 *
 * Neither sink can fail a turn: publishes are serialized on a settled
 * queue and drain() is capped, file writes are swallowed whole — an
 * observer that throws is a dead observer, not a dead agent.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  busPublish,
  busSocketPath,
  gitCommonDir,
  type EventInput,
} from '@broject/core'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

/** agentIds minted by agent-connectors are filename-safe — a badge
 *  that is not must never become a path segment under bro/agents/.
 *  Same shape the registry itself guards with. */
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** usage_update ticks per-chunk on some agents — the bus is not a
 *  per-chunk wire, so intermediate counters coalesce at this interval.
 *  The final counters still land at turn stop (stop() flushes the
 *  pending one), so nothing is lost — just decimated in flight. */
export const AGENT_USAGE_THROTTLE_MS = 2_000

/** Upper bound on drain() — publishes self-bound at the bus timeout
 *  each, but a wedged half-open socket could still serialize N events
 *  into N×timeout; the drain cap keeps a worker's exit prompt. */
const DRAIN_CAP_MS = 3_000

export interface AgentTurnPlaneOpts {
  /** The session's cwd — resolves the repo's bus socket and the agent
   *  archive under its common dir. Defaults to process.cwd(). */
  cwd?: string
  /** Provenance label → the envelope's `source` (conductor:<backend>,
   *  "acp provider 'kilo'", …). */
  by: string
  /** The ACP session id — part of the payload, and the fallback event
   *  `key` when no BRO_AGENT_ID badge is pinned. */
  sessionId: string
}

/** The per-turn observer pumpTurn drives: update() per session/update,
 *  start()/stop() bookends, drain() to settle queued publishes. */
export interface AgentTurnPlane {
  update(u: SessionUpdate): void
  start(): void
  stop(stopReason: string | undefined, opts?: { error?: string; replyLen?: number }): void
  drain(): Promise<void>
}

const TERMINAL_STATUS = new Set(['completed', 'failed'])

type Toolish = {
  toolCallId: string
  title?: string | null
  name?: string | null
  kind?: string | null
  status?: string | null
  content?: Array<{ type: string; terminalId?: string }> | null
}

/** The tool fields consumers need — kind/title/status/terminalId per
 *  the bead, plus the ids and name so a pane can dedupe or label. */
function toolPayload(u: Toolish, phase: 'open' | 'finish'): Record<string, unknown> {
  const p: Record<string, unknown> = { phase, toolCallId: u.toolCallId }
  if (typeof u.title === 'string' && u.title !== '') p['title'] = u.title
  if (typeof u.name === 'string' && u.name !== '') p['name'] = u.name
  if (typeof u.kind === 'string' && u.kind !== '') p['kind'] = u.kind
  if (typeof u.status === 'string' && u.status !== '') p['status'] = u.status
  // terminalId rides in tool content ({type:'terminal'}) on the ACP
  // wire — surface the first one so consumers can point at the
  // terminal registry (bro-eua0d) without knowing the content shape
  const terminal = (u.content ?? []).find(
    (c) => c.type === 'terminal' && typeof c.terminalId === 'string'
  )
  if (terminal !== undefined) p['terminalId'] = terminal.terminalId
  return p
}

/** The plane for one turn — resolved sinks are computed once so the
 *  per-update cost is a Map lookup plus a queued socket write. */
export function agentTurnPlane(opts: AgentTurnPlaneOpts): AgentTurnPlane {
  const cwd = opts.cwd ?? process.cwd()
  const badge = process.env.BRO_AGENT_ID?.trim()
  const agentId =
    badge !== undefined && badge !== '' && SAFE_AGENT_ID.test(badge) ? badge : undefined
  const cause = process.env.BRO_BEAD_ID?.trim() || undefined
  // unbadged turns key by session so consumers can still pin one —
  // the 'acp:' prefix keeps the namespace from colliding with real ids
  const key = agentId ?? `acp:${opts.sessionId}`
  const socket = busSocketPath(cwd)
  const common = agentId === undefined ? null : gitCommonDir(cwd)
  const file =
    agentId !== undefined && common !== null
      ? join(common, 'bro', 'agents', `${agentId}.events.jsonl`)
      : undefined

  let queue: Promise<unknown> = Promise.resolve()
  const seenTools = new Set<string>()
  const seenSubs = new Set<string>()
  let lastUsageAt = 0
  let pendingUsage: Record<string, unknown> | undefined

  const emit = (kind: string, payload: Record<string, unknown>): void => {
    if (socket === null) {
      return
    }
    const event: EventInput = {
      topic: 'agent',
      kind,
      key,
      source: opts.by,
      ...(cause !== undefined ? { cause } : {}),
      payload,
    }
    // serialized — publish order IS arrival order on the ring, so an
    // 'open' must never overtake its own turn's 'start'
    queue = queue.then(() => busPublish(socket, event))
  }

  const record = (row: Record<string, unknown>): void => {
    if (file === undefined) {
      return
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(row)}\n`)
    } catch {
      /* the archive is telemetry — a disk failure never fails a turn */
    }
  }

  const stamp = (): Record<string, unknown> => ({
    ts: new Date().toISOString(),
    session: opts.sessionId,
    by: opts.by,
    key,
  })

  const emitUsage = (): void => {
    if (pendingUsage !== undefined) {
      const p = pendingUsage
      pendingUsage = undefined
      emit('usage', p)
      lastUsageAt = Date.now()
    }
  }

  return {
    start() {
      record({ ...stamp(), kind: 'turn', phase: 'start' })
      emit('turn', { phase: 'start', sessionId: opts.sessionId })
    },

    update(u) {
      // the durable row is the full-fidelity record — every update,
      // chunks included, written BEFORE the bus sees the filtered view
      record({ ...stamp(), kind: 'update', update: u })
      switch (u.sessionUpdate) {
        case 'tool_call': {
          const terminal = u.status !== undefined && TERMINAL_STATUS.has(u.status)
          const fresh = !seenTools.has(u.toolCallId)
          if (fresh) seenTools.add(u.toolCallId)
          // a mid-flight repeat of an already-open call is churn — only
          // lifecycle edges (open, finish) go on the wire
          if (!fresh && !terminal) return
          emit('tool_call', toolPayload(u, terminal ? 'finish' : 'open'))
          return
        }
        case 'tool_call_update': {
          const terminal = u.status != null && TERMINAL_STATUS.has(u.status)
          if (!terminal) return
          seenTools.add(u.toolCallId)
          emit('tool_call', toolPayload(u, 'finish'))
          return
        }
        case 'subagent_update': {
          const fresh = !seenSubs.has(u.sessionId)
          if (fresh) seenSubs.add(u.sessionId)
          const p: Record<string, unknown> = {
            phase: fresh ? 'open' : 'update',
            sessionId: u.sessionId,
          }
          if (typeof u.title === 'string' && u.title !== '') p['title'] = u.title
          if (typeof u.description === 'string' && u.description !== '') {
            p['description'] = u.description
          }
          emit('subagent', p)
          return
        }
        case 'usage_update': {
          const p: Record<string, unknown> = { used: u.used, size: u.size }
          if (u.cost != null && typeof u.cost.amount === 'number') {
            p['cost'] = u.cost
          }
          if (Date.now() - lastUsageAt >= AGENT_USAGE_THROTTLE_MS) {
            emit('usage', p)
            lastUsageAt = Date.now()
          } else {
            pendingUsage = p
          }
          return
        }
        default:
          // text deltas and the rest stay off the bus — the archive
          // row above already holds them for the durable record
          return
      }
    },

    stop(stopReason, o = {}) {
      record({
        ...stamp(),
        kind: 'turn',
        phase: 'stop',
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(o.error !== undefined ? { error: o.error } : {}),
      })
      // usage precedes stop on the wire — chronology, and consumers
      // reading 'turn stop' can trust the final counters already landed
      emitUsage()
      const p: Record<string, unknown> = { phase: 'stop', sessionId: opts.sessionId }
      if (stopReason !== undefined) p['stopReason'] = stopReason
      if (o.error !== undefined) p['error'] = o.error
      if (o.replyLen !== undefined) p['replyLen'] = o.replyLen
      emit('turn', p)
    },

    async drain() {
      await Promise.race([
        queue.then(() => undefined),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, DRAIN_CAP_MS)
          t.unref?.()
        }),
      ])
    },
  }
}

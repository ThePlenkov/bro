/**
 * The devin lane's account usage — the numbers the fleet needs to stop
 * walking into the free-model wall.
 *
 * The wall is a RATE, not a quota: devin answers "Reached free model
 * rate limit ... Your limit will reset in 22 seconds" (burst tier) and
 * "... in 26 minutes" (hourly tier).
 *
 * The ground truth for "how many requests did the account make" lives in
 * devin's own session store, in `message_nodes.chat_message ->
 * $.metadata.request_id`. Two things make that count non-obvious:
 *
 *  - a REQUEST is a request_id, not a prompt-history row. The prompt
 *    history holds one row per user PROMPT, while an agent session makes
 *    dozens of model requests per prompt (tool loops) — counting rows
 *    understates the real rate by an order of magnitude.
 *  - the store is huge (650k message nodes) and a full scan costs
 *    ~40s of JSON extraction. `row_id` is an autoincrement, so the recent
 *    rows are the TAIL: sampling the last N rows by `row_id DESC` is
 *    ~2s and covers far more than one sampling window.
 *
 * So the sampler is INCREMENTAL: it remembers the last row_id it saw and
 * only counts what came after it, keeping a cumulative counter per model
 * in bro's own state. The counter is monotone, which is what a rate
 * metric needs.
 *
 * Reading is read-only and best-effort: a missing store, an unreadable
 * store or a Node without node:sqlite costs the numbers, never the run.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { otelEvent } from '@broject/providers'
import { gitCommonDir } from '@broject/core'
import { devinSessionPlane } from './devin.ts'

/** One model's usage in a sample. */
export interface DevinModelUsage {
  model: string
  /** DISTINCT request ids in this sample */
  requests: number
  /** distinct sessions that made them */
  sessions: number
}

/** The live lane counts the plane already knows. */
export interface DevinLaneCounts {
  sessions: number
  workers: number
  batchWorkers: number
}

/** The sampler's own state — the cursor and the cumulative counters. */
export interface DevinUsageState {
  /** the last message_nodes row_id counted */
  lastRowId: number
  /** cumulative distinct requests per model */
  models: Record<string, { requests: number; sessions: number }>
}

/** devin's store — the sibling of the session-locks dir the plane
 *  already derives (`<base>/devin/cli/`). */
export function devinStorePath(
  env: Record<string, string | undefined> = process.env
): string {
  const xdg = env['XDG_DATA_HOME']
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : join(
          env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir(),
          '.local',
          'share'
        )
  return join(base, 'devin', 'cli', 'sessions.db')
}

/** How many message rows a sample looks at. The tail covers far more
 *  requests than one sampling window (20k rows ≈ 4.5k requests); a
 *  bigger tail costs seconds, not minutes. */
const SAMPLE_ROWS = 20_000

/** The sampler's state file — bro's own state, next to the other
 *  lane state. */
export function devinUsageStatePath(root: string): string | null {
  const common = gitCommonDir(root)
  if (common === null || common === '') {
    return null
  }
  return join(common, 'bro', 'devin-usage.json')
}

export function readDevinUsageState(root: string): DevinUsageState {
  const path = devinUsageStatePath(root)
  const empty: DevinUsageState = { lastRowId: 0, models: {} }
  if (path === null) {
    return empty
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const lastRowId = (parsed as { lastRowId?: unknown } | null)?.lastRowId
    const models = (parsed as { models?: unknown } | null)?.models
    return {
      lastRowId: typeof lastRowId === 'number' ? lastRowId : 0,
      models:
        typeof models === 'object' && models !== null
          ? (models as DevinUsageState['models'])
          : {},
    }
  } catch {
    return empty
  }
}

export function writeDevinUsageState(root: string, state: DevinUsageState): void {
  const path = devinUsageStatePath(root)
  if (path === null) {
    return
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, path)
  } catch {
    // fail-open — the numbers cost the next sample, never the run
  }
}

/** The usage query — the tail of the store, the rows after the cursor,
 *  counted by DISTINCT request id (a request is a request id, not a
 *  prompt row: a session makes dozens of requests per prompt). */
const USAGE_SQL = `SELECT s.model AS model,
                COUNT(DISTINCT json_extract(m.chat_message, '$.metadata.request_id')) AS requests,
                COUNT(DISTINCT m.session_id) AS sessions
           FROM (SELECT row_id, session_id, chat_message FROM message_nodes
                  ORDER BY row_id DESC LIMIT ?) m
           JOIN sessions s ON s.id = m.session_id
          WHERE m.row_id > ?
            AND m.row_id <= ?
            AND json_extract(m.chat_message, '$.metadata.request_id') IS NOT NULL
          GROUP BY s.model`

/** The sqlite handle — node:sqlite's shape, narrowed to what the
 *  sampler uses. */
type SqliteDatabase = {
  prepare: (sql: string) => {
    all: (...p: unknown[]) => unknown[]
    get: (...p: unknown[]) => unknown
  }
  close: () => void
}

/** Open the store read-only. node:sqlite is unflagged from Node 23 on;
 *  on 22.x it needs a flag, so the import is dynamic and its failure is
 *  a missing number, not a crash. */
async function openSqlite(
  env: Record<string, string | undefined>
): Promise<SqliteDatabase | undefined> {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase
    }
    return new mod.DatabaseSync(devinStorePath(env), { readOnly: true })
  } catch {
    return undefined
  }
}

/** One sample: the distinct requests and sessions per model among the
 *  rows AFTER `sinceRowId`, plus the newest row id seen. */
export interface DevinUsageSample {
  lastRowId: number
  usage: DevinModelUsage[]
  /** false when the store could not be read at all — 'no requests' and
   *  'could not look' are different facts and must not look alike. */
  ok: boolean
}

export async function sampleDevinUsage(opts: {
  sinceRowId?: number
  limit?: number
  env?: Record<string, string | undefined>
}): Promise<DevinUsageSample> {
  const env = opts.env ?? process.env
  const since = opts.sinceRowId ?? 0
  const limit = opts.limit ?? SAMPLE_ROWS
  const db = await openSqlite(env)
  if (db === undefined) {
    return { lastRowId: since, usage: [], ok: false }
  }
  try {
    // The cursor is the TAIL's boundary — every row scanned, including
    // the ones without a request id. A cursor that only advanced over
    // the request-bearing rows would never move past a tail of plain
    // messages, and the same rows would be counted again on the next
    // pass (the cumulative counter would inflate every time).
    const tail = db
      .prepare(
        `SELECT MAX(row_id) AS last_row FROM (
           SELECT row_id FROM message_nodes ORDER BY row_id DESC LIMIT ?)`
      )
      .get(limit) as { last_row: number | null } | undefined
    const boundary = tail?.last_row ?? since
    if (boundary <= since) {
      return { lastRowId: since, usage: [], ok: true }
    }
    const rows = db
      .prepare(USAGE_SQL)
      .all(limit, since, boundary) as Array<{
      model: string | null
      requests: number
      sessions: number
    }>
    return {
      lastRowId: boundary,
      usage: rows.map((r) => ({
        model: r.model ?? '(none)',
        requests: Number(r.requests),
        sessions: Number(r.sessions),
      })),
      ok: true,
    }
  } catch {
    return { lastRowId: since, usage: [], ok: false }
  } finally {
    try {
      db.close()
    } catch {
      // closing a read-only handle never fails the read
    }
  }
}

/** Emit the lane's telemetry: the account's request rate per model (the
 *  ground truth from devin's own store) and the lane's live counts.
 *
 *  Never throws and never blocks: a missing store or a missing OTLP
 *  endpoint costs the numbers, not the run. The two halves are isolated
 *  from each other — an unreadable store must not cost the live counts. */
export async function emitDevinUsage(
  root: string,
  bag: Record<string, unknown>,
  now: number = Date.now()
): Promise<void> {
  // the live counts — the plane already knows them
  try {
    const plane = devinSessionPlane
    const counts: DevinLaneCounts = {
      sessions: plane.countLive(bag),
      workers: plane.countWorkers?.(bag) ?? 0,
      batchWorkers: plane.countBatchWorkers?.(bag) ?? 0,
    }
    otelEvent('lane.devin.lane', {
      sessions: counts.sessions,
      workers: counts.workers,
      batch_workers: counts.batchWorkers,
    })
  } catch {
    // the counts are lost, the rate is not
  }
  // the account's request rate — an incremental sample of devin's store
  try {
    const state = readDevinUsageState(root)
    const sample = await sampleDevinUsage({ sinceRowId: state.lastRowId })
    if (!sample.ok) {
      // the store could not be read — the numbers are UNKNOWN, and the
      // cursor must not advance (or the next sample would skip the rows
      // in between). Say so instead of reporting a rate of zero.
      otelEvent('lane.devin.usage.unavailable', { since_row_id: state.lastRowId })
      return
    }
    for (const u of sample.usage) {
      const prior = state.models[u.model] ?? { requests: 0, sessions: 0 }
      const cumulative = {
        requests: prior.requests + u.requests,
        sessions: Math.max(prior.sessions, u.sessions),
      }
      state.models[u.model] = cumulative
      // the DELTA over the sampling window — a rate, not a level: the
      // dashboard sums the deltas per interval
      otelEvent('lane.devin.model.usage', {
        model: u.model,
        requests: u.requests,
        sessions: u.sessions,
        total_requests: cumulative.requests,
        sampled_at: new Date(now).toISOString(),
      })
    }
    state.lastRowId = Math.max(state.lastRowId, sample.lastRowId)
    writeDevinUsageState(root, state)
  } catch {
    // the rate is lost, the counts are not
  }
}

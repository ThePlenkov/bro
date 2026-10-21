/**
 * The devin lane's account usage — the numbers the fleet needs to stop
 * walking into the free-model wall.
 *
 * The wall is a RATE, not a quota: devin answers "Reached free model
 * rate limit ... Your limit will reset in 22 seconds" (burst tier) and
 * "... in 26 minutes" (hourly tier). The request volume is tiny (tens
 * a day) — what the fleet does wrong is fire them in parallel bursts.
 *
 * The ground truth for "how many requests did the account make" lives
 * in devin's own session store, and each request is stored TWICE there
 * (once per prompt_history row, once in the message tree) — so the
 * count must be DISTINCT request ids, never raw rows. Reading it is
 * read-only and best-effort: a missing store, an unreadable store or a
 * Node without node:sqlite costs the numbers, never the run.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { otelEvent } from '@broject/providers'
import { devinSessionPlane } from './devin.ts'

/** One model's usage in the window. */
export interface DevinModelUsage {
  model: string
  /** distinct requests */
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

/** The account's per-model request usage since a cutoff (epoch ms).
 *  Empty when the store cannot be read — the caller treats that as
 *  "no numbers", never as "no requests". */
export async function devinAccountUsage(
  sinceMs: number,
  env: Record<string, string | undefined> = process.env
): Promise<DevinModelUsage[]> {
  const path = devinStorePath(env)
  let DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] }
    close: () => void
  }
  try {
    // node:sqlite is unflagged from Node 23 on; on 22.x it needs a flag,
    // so the import is dynamic and its failure is a missing number.
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean }
      ) => InstanceType<typeof DatabaseSync>
    }
    DatabaseSync = mod.DatabaseSync as never
  } catch {
    return []
  }
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const rows = db
      .prepare(
        `SELECT s.model AS model, COUNT(DISTINCT p.id) AS requests,
                COUNT(DISTINCT p.session_id) AS sessions
           FROM prompt_history p JOIN sessions s ON s.id = p.session_id
          WHERE p.timestamp > ? GROUP BY s.model`
      )
      .all(Math.floor(sinceMs / 1000)) as Array<{
      model: string | null
      requests: number
      sessions: number
    }>
    return rows.map((r) => ({
      model: r.model ?? '(none)',
      requests: Number(r.requests),
      sessions: Number(r.sessions),
    }))
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // closing a read-only handle never fails the read
    }
  }
}

/** Emit the lane's telemetry: the account's request rate per model (the
 *  ground truth from devin's own store) and the lane's live counts.
 *
 *  Never throws and never blocks: a missing store or a missing OTLP
 *  endpoint costs the numbers, not the run. */
export async function emitDevinUsage(
  bag: Record<string, unknown>,
  now: number = Date.now()
): Promise<void> {
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
    // The burst window is the one that must never have a hole: a model
    // with no request in the last minute still reports zero, so the
    // dashboard reads a rate, not a gap. The hour window seeds the model
    // list (a model that used the account at all).
    const hour = await devinAccountUsage(now - 3_600_000)
    const burst = await devinAccountUsage(now - 60_000)
    const models = new Set([...hour.map((u) => u.model), ...burst.map((u) => u.model)])
    for (const model of models) {
      const h = hour.find((u) => u.model === model)
      const b = burst.find((u) => u.model === model)
      otelEvent('lane.devin.model.usage', {
        model,
        window_ms: 3_600_000,
        requests: h?.requests ?? 0,
        sessions: h?.sessions ?? 0,
      })
      otelEvent('lane.devin.model.usage', {
        model,
        window_ms: 60_000,
        requests: b?.requests ?? 0,
        sessions: b?.sessions ?? 0,
      })
    }
  } catch {
    // telemetry must not stall the caller
  }
}

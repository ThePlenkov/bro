/**
 * JSONL ledger store — `.agents/review-debt/` in the current working repo.
 * Append-only harvest snapshots + ledger.jsonl status overlays.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '@bro/core'
import type {
  AuthorPolicy,
  DebtRecord,
  DebtSummary,
  LedgerOverlay,
} from './types.ts'

function debtDir(cwd: string = process.cwd()): string {
  return process.env.BRO_DEBT_DIR ?? join(cwd, loadConfig(cwd).debt.dir)
}

function harvestDir(cwd?: string): string {
  return join(debtDir(cwd), 'harvests')
}

function debtFile(cwd?: string): string {
  return join(debtDir(cwd), 'debt.jsonl')
}

function ledgerFile(cwd?: string): string {
  return join(debtDir(cwd), 'ledger.jsonl')
}

function summaryFile(cwd?: string): string {
  return join(debtDir(cwd), 'debt-summary.json')
}

function processedFile(cwd?: string): string {
  return join(debtDir(cwd), 'processed.json')
}

function configFile(cwd?: string): string {
  return join(debtDir(cwd), 'config.json')
}

export function loadAuthorPolicy(cwd?: string): AuthorPolicy {
  const fallback: AuthorPolicy = { excluded_authors: [], non_actionable_authors: [] }
  const path = configFile(cwd)
  if (!existsSync(path)) {
    return fallback
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AuthorPolicy>
    return {
      excluded_authors: parsed.excluded_authors ?? [],
      non_actionable_authors: parsed.non_actionable_authors ?? [],
    }
  } catch {
    return fallback
  }
}

function readJsonlLines<T>(path: string): T[] {
  if (!existsSync(path)) {
    return []
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

function listHarvestFiles(cwd?: string): string[] {
  const dir = harvestDir(cwd)
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(dir, name))
}

/**
 * runId lands in a filename — strip anything that could traverse directories.
 * If sanitizing changed the id, append a short hash so distinct ids like
 * "a/b" and "a-b" can't collapse into the same file within one second.
 */
function sanitizeRunId(runId: string): string {
  const clean = runId.replace(/[^a-zA-Z0-9_-]/g, '-')
  if (clean === runId && runId !== '') {
    return runId
  }
  const hash = createHash('sha256').update(runId).digest('hex').slice(0, 8)
  return `${clean || 'run'}-${hash}`
}

export function harvestFilename(opts: {
  harvestedAt: string
  pr: number
  runId: string
}): string {
  const d = new Date(opts.harvestedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return `${ts}-pr-${opts.pr}-run-${sanitizeRunId(opts.runId)}.jsonl`
}

/** Append-only harvest snapshot (one new file per PR per run — no merge conflicts). */
export function writeHarvestFile(opts: {
  pr: number
  runId: string
  harvestedAt: string
  records: DebtRecord[]
  cwd?: string
}): string {
  if (opts.records.length === 0) {
    throw new Error('writeHarvestFile: no records to write')
  }
  const dir = harvestDir(opts.cwd)
  const path = join(
    dir,
    harvestFilename({ harvestedAt: opts.harvestedAt, pr: opts.pr, runId: opts.runId })
  )
  mkdirSync(dir, { recursive: true })
  const lines = opts.records.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(path, `${lines}\n`, 'utf8')
  return path
}

/** tmp+rename so a crashed/concurrent writer can't leave a torn ledger. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  // Preserve the existing file's mode (e.g. 0600) — rename would reset it.
  try {
    chmodSync(tmp, statSync(path).mode)
  } catch {
    /* first write — default mode */
  }
  renameSync(tmp, path)
}

export function readLedgerOverlays(cwd?: string): Map<string, LedgerOverlay> {
  const map = new Map<string, LedgerOverlay>()
  for (const row of readJsonlLines<LedgerOverlay>(ledgerFile(cwd))) {
    map.set(row.thread_id, row)
  }
  return map
}

export function upsertLedgerOverlays(
  updates: LedgerOverlay[],
  cwd?: string
): Map<string, LedgerOverlay> {
  const map = readLedgerOverlays(cwd)
  for (const row of updates) {
    map.set(row.thread_id, row)
  }
  const path = ledgerFile(cwd)
  mkdirSync(dirname(path), { recursive: true })
  const lines = [...map.values()]
    .sort((a, b) => a.thread_id.localeCompare(b.thread_id))
    .map((r) => JSON.stringify(r))
    .join('\n')
  atomicWrite(path, lines.length > 0 ? `${lines}\n` : '')
  return map
}

function applyLedgerOverlays(records: DebtRecord[], cwd?: string): DebtRecord[] {
  const overlays = readLedgerOverlays(cwd)
  if (overlays.size === 0) {
    return records
  }
  return records.map((row) => {
    const overlay = overlays.get(row.thread_id)
    if (!overlay) {
      return row
    }
    return {
      ...row,
      status: overlay.status,
      fix_pr: overlay.fix_pr,
      fixed_at: overlay.fixed_at,
      notes: overlay.notes,
    }
  })
}

export function readDebtRecords(cwd?: string): DebtRecord[] {
  const sources = [...listHarvestFiles(cwd)]
  const legacy = debtFile(cwd)
  if (existsSync(legacy)) {
    sources.push(legacy)
  }

  let merged: DebtRecord[] = []
  for (const file of sources) {
    merged = upsertRecords(merged, readJsonlLines<DebtRecord>(file))
  }
  return applyLedgerOverlays(merged, cwd)
}

export function upsertRecords(existing: DebtRecord[], incoming: DebtRecord[]): DebtRecord[] {
  const byId = new Map(existing.map((r) => [r.thread_id, r]))
  for (const row of incoming) {
    const prev = byId.get(row.thread_id)
    if (!prev) {
      byId.set(row.thread_id, row)
      continue
    }
    if (prev.status === 'done' || prev.status === 'wontfix') {
      // Re-harvest means the thread is still unresolved on GitHub — reopen.
      byId.set(row.thread_id, {
        ...row,
        times_seen: prev.times_seen + 1,
        status: 'open',
        fix_pr: null,
        fixed_at: null,
        notes: null,
      })
      continue
    }
    byId.set(row.thread_id, {
      ...row,
      times_seen: prev.times_seen + 1,
      status: prev.status === 'claimed' ? 'claimed' : row.status,
      fix_pr: prev.fix_pr,
      fixed_at: prev.fixed_at,
      notes: prev.notes,
    })
  }
  return [...byId.values()].sort((a, b) => a.harvested_at.localeCompare(b.harvested_at))
}

export function buildSummary(records: DebtRecord[]): DebtSummary {
  const open = records.filter((r) => r.status === 'open')
  const byArea: Record<string, number> = {}
  const byAuthor: Record<string, number> = {}
  for (const row of open) {
    byArea[row.area] = (byArea[row.area] ?? 0) + 1
    byAuthor[row.author] = (byAuthor[row.author] ?? 0) + 1
  }

  const fpMap = new Map<string, { count: number; prs: Set<number> }>()
  for (const row of open) {
    const entry = fpMap.get(row.fingerprint) ?? { count: 0, prs: new Set<number>() }
    entry.count += 1
    entry.prs.add(row.source_pr)
    fpMap.set(row.fingerprint, entry)
  }

  const duplicate_fingerprints = [...fpMap.entries()]
    .filter(([, v]) => v.count > 1)
    .map(([fingerprint, v]) => ({
      fingerprint,
      count: v.count,
      prs: [...v.prs].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count)

  return {
    generated_at: new Date().toISOString(),
    open_count: open.length,
    by_area: byArea,
    by_author: byAuthor,
    duplicate_fingerprints,
    oldest_open:
      open.length === 0
        ? null
        : open.reduce(
            (min, row) => (row.harvested_at < min ? row.harvested_at : min),
            open[0]!.harvested_at
          ),
  }
}

export function writeSummary(summary: DebtSummary, cwd?: string): void {
  const path = summaryFile(cwd)
  mkdirSync(dirname(path), { recursive: true })
  atomicWrite(path, `${JSON.stringify(summary, null, 2)}\n`)
}

/**
 * Per-PR "scanned at" timestamps — the label alone can't tell whether a
 * review bot commented AFTER we marked the PR processed. `collect` compares
 * PR `updatedAt` against this map to rescan stale labels.
 */
export function readProcessedAt(cwd?: string): Map<number, string> {
  const path = processedFile(cwd)
  if (!existsSync(path)) {
    return new Map()
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    return new Map(
      Object.entries(raw)
        .filter(
          ([k, v]) =>
            Number.isInteger(Number(k)) &&
            typeof v === 'string' &&
            !Number.isNaN(Date.parse(v))
        )
        .map(([k, v]) => [Number(k), v])
    )
  } catch {
    return new Map()
  }
}

export function markProcessedAt(prs: number[], at: string, cwd?: string): void {
  const path = processedFile(cwd)
  mkdirSync(dirname(path), { recursive: true })
  // mkdir is atomic on all platforms — a lock dir serializes the
  // read-modify-write so concurrent collects can't lose each other's
  // timestamps.
  const lock = `${path}.lock`
  for (let i = 0; i < 100; i++) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // Steal a stale lock: a killed process never runs the finally, so a
      // lock dir older than 30s can't be a live write.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true })
        }
      } catch {
        // lock vanished or unreadable — retry loop handles both
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      if (i === 99) {
        throw new Error(`could not acquire lock ${lock}`)
      }
    }
  }
  try {
    const map = readProcessedAt(cwd)
    for (const pr of prs) {
      map.set(pr, at)
    }
    const obj = Object.fromEntries(
      [...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])
    )
    atomicWrite(path, `${JSON.stringify(obj, null, 2)}\n`)
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

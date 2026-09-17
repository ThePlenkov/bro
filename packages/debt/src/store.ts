/**
 * JSONL ledger store — `.agents/review-debt/` in the current working repo.
 * Append-only harvest snapshots + ledger.jsonl status overlays.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
import { dirname, isAbsolute, join, relative } from 'node:path'
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

const excludedDebtDirs = new Set<string>()

/**
 * The ledger is machine-local state — same contract as the gitignored
 * bro.config.json and `bd init --stealth`. When the debt dir sits inside a
 * git worktree that doesn't already ignore it, append it to
 * .git/info/exclude so harvest evidence can't be committed by accident.
 * Local-only — never a repo diff.
 */
function ensureDebtDirExcluded(dir: string): void {
  if (excludedDebtDirs.has(dir)) {
    return
  }
  excludedDebtDirs.add(dir)
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { // NOSONAR — git is already a hard dependency of the whole flow
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  let root: string
  try {
    mkdirSync(dir, { recursive: true }) // git -C fails on a missing dir
    root = git(['rev-parse', '--show-toplevel'])
  } catch {
    return // not a git worktree (or no git) — nothing to exclude
  }
  const rel = relative(root, dir)
  if (rel === '' || rel.startsWith('..')) {
    return // debt dir is the repo root or outside the worktree
  }
  // Inside a worktree from here — exclusion failures are surfaced, since a
  // silently trackable ledger is exactly what this guard prevents.
  try {
    try {
      // Query from the repo root — pathspecs resolve against cwd, and `dir`
      // is the ledger dir itself, not the root.
      execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'ignore' }) // NOSONAR
      return // already covered by .gitignore / info/exclude / global excludes
    } catch {
      /* not ignored — exclude it locally */
    }
    const excludePath = git(['rev-parse', '--git-path', 'info/exclude'])
    const path = isAbsolute(excludePath) ? excludePath : join(dir, excludePath)
    // Concurrent writers can race the read-modify-write — serialize under
    // the same lock the ledger uses so a later write can't drop an entry.
    withFileLock(path, () => {
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
      if (!existing.split('\n').includes(`${rel}/`)) {
        const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
        writeFileSync(path, `${existing}${sep}${rel}/\n`)
      }
    })
  } catch (err) {
    console.error(
      `warning: could not git-exclude ${rel} — ` +
        `${err instanceof Error ? err.message : err}; the ledger may be trackable`
    )
  }
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
  ensureDebtDirExcluded(debtDir(opts.cwd))
  const lines = opts.records.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(path, `${lines}\n`, 'utf8')
  return path
}

/** tmp+rename so a crashed/concurrent writer can't leave a torn ledger. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  // Read the destination mode first and create the temp file with it —
  // chmod-after-write leaves a window where the temp file holds content
  // under default (broader) permissions. (CWE-377)
  let mode: number | undefined
  try {
    mode = statSync(path).mode
  } catch {
    /* first write — default mode */
  }
  // A temp file left by a crash may carry permissive mode — drop it before
  // recreating. Creation honors `mode & ~umask` (never broader), then chmod
  // restores the exact mode. Single open: reopening a 0o444 temp would EACCES.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  if (mode !== undefined) {
    chmodSync(tmp, mode)
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

function upsertLedgerOverlaysUnlocked(
  updates: LedgerOverlay[],
  cwd?: string
): Map<string, LedgerOverlay> {
  const map = readLedgerOverlays(cwd)
  for (const row of updates) {
    map.set(row.thread_id, row)
  }
  const path = ledgerFile(cwd)
  mkdirSync(dirname(path), { recursive: true })
  ensureDebtDirExcluded(debtDir(cwd))
  const lines = [...map.values()]
    .sort((a, b) => a.thread_id.localeCompare(b.thread_id))
    .map((r) => JSON.stringify(r))
    .join('\n')
  atomicWrite(path, lines.length > 0 ? `${lines}\n` : '')
  return map
}

export function upsertLedgerOverlays(
  updates: LedgerOverlay[],
  cwd?: string
): Map<string, LedgerOverlay> {
  return withFileLock(ledgerFile(cwd), () => upsertLedgerOverlaysUnlocked(updates, cwd))
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
  ensureDebtDirExcluded(debtDir(cwd))
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

// Critical sections here are synchronous file writes — an event-loop
// heartbeat can't fire while the lock is held, so staleness is judged
// by mtime + owner liveness instead. A live holder (kill(pid,0)) keeps
// the lock until the abandoned bound, which also caps an orphan whose
// pid was recycled onto an unrelated live process.
const LOCK_STALE_MS = 30_000
const LOCK_ABANDONED_MS = 10 * 60_000

function lockOwnerAlive(lock: string): boolean {
  try {
    const pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) {
      return false
    }
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // ESRCH = dead; EPERM = alive under another user.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch {
    return false // no readable pid file
  }
}

function lockStealable(lock: string): boolean {
  let ageMs: number
  try {
    ageMs = Date.now() - statSync(lock).mtimeMs
  } catch {
    return false // lock vanished — the retry loop's mkdir handles it
  }
  if (ageMs <= LOCK_STALE_MS) {
    return false
  }
  return !lockOwnerAlive(lock) || ageMs > LOCK_ABANDONED_MS
}

// Capture-then-check: rename grabs whatever instance sits at `lock`
// atomically. Re-check THAT instance — if a fresh lock replaced the
// stale one mid-race, put it back instead of deleting a live hold.
function stealLock(lock: string): boolean {
  if (!lockStealable(lock)) {
    return false
  }
  const dest = `${lock}.stale-${process.pid}-${process.hrtime.bigint()}`
  try {
    renameSync(lock, dest)
  } catch {
    return false // already stolen or released
  }
  if (lockStealable(dest)) {
    rmSync(dest, { recursive: true, force: true })
    return true
  }
  try {
    renameSync(dest, lock)
  } catch {
    rmSync(dest, { recursive: true, force: true })
  }
  return false
}

// mkdir is atomic on all platforms — a lock dir serializes the
// read-modify-write so concurrent processes can't lose each other's
// updates.
function acquireFileLock(lock: string): void {
  for (let i = 0; i < 100; i++) {
    try {
      mkdirSync(lock)
    } catch {
      // Held by someone else — steal if stale, otherwise wait and retry.
      if (!stealLock(lock)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      continue
    }
    try {
      writeFileSync(join(lock, 'pid'), String(process.pid))
      return
    } catch (err) {
      rmSync(lock, { recursive: true, force: true })
      throw err
    }
  }
  throw new Error(`could not acquire lock ${lock}`)
}

// Capture the lock instance before deleting: only ever remove a dir
// whose pid file is ours — if our lock was stolen, the dir at `lock`
// belongs to the stealer and is put back untouched.
function releaseFileLock(lock: string): void {
  const dest = `${lock}.release-${process.pid}`
  try {
    renameSync(lock, dest)
  } catch {
    return // lock already gone (stolen or never fully created)
  }
  let ours = false
  try {
    ours = readFileSync(join(dest, 'pid'), 'utf8').trim() === String(process.pid)
  } catch {
    // unreadable owner — treat as not ours
  }
  if (ours) {
    rmSync(dest, { recursive: true, force: true })
    return
  }
  try {
    renameSync(dest, lock)
  } catch {
    rmSync(dest, { recursive: true, force: true })
  }
}

export function withFileLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  acquireFileLock(lock)
  try {
    return fn()
  } finally {
    releaseFileLock(lock)
  }
}

export function markProcessedAt(prs: number[], at: string, cwd?: string): void {
  const path = processedFile(cwd)
  ensureDebtDirExcluded(debtDir(cwd))
  withFileLock(path, () => {
    const map = readProcessedAt(cwd)
    for (const pr of prs) {
      map.set(pr, at)
    }
    const obj = Object.fromEntries(
      [...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])
    )
    atomicWrite(path, `${JSON.stringify(obj, null, 2)}\n`)
  })
}

export function claimDebtRecord(threadId: string, cwd?: string): DebtRecord | null {
  // Compare-and-swap under the ledger lock: two concurrent `debt next
  // --claim` callers can't both win — the second sees the claimed status
  // and gets null.
  return withFileLock(ledgerFile(cwd), () => {
    const row = readDebtRecords(cwd).find((r) => r.thread_id === threadId)
    if (!row || row.status !== 'open') {
      return null
    }
    upsertLedgerOverlaysUnlocked(
      [
        {
          thread_id: threadId,
          status: 'claimed',
          fix_pr: null,
          fixed_at: null,
          notes: row.notes,
        },
      ],
      cwd
    )
    return { ...row, status: 'claimed' }
  })
}

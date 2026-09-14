/**
 * beads (bd) projection of the debt ledger.
 *
 * JSONL stays the immutable evidence store; bd becomes the executable work
 * queue (`bd ready -l debt`). Upsert key: `external_ref` = `thread_id`, so
 * `bro debt sync` is idempotent. Status reconciles ledger → bead on re-runs.
 */
import { execFileSync } from 'node:child_process'
import type { DebtPriority, DebtRecord, DebtStatus } from './types.ts'

export interface BeadRef {
  id: string
  status: string
}

function bd(args: string[]): string {
  return execFileSync('bd', args, { encoding: 'utf8' }) // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
}

export function checkBeads(): void {
  try {
    bd(['--version'])
  } catch {
    throw new Error('bd not found — install beads, or keep store: jsonl')
  }
  try {
    bd(['list', '--json', '-n', '1'])
  } catch {
    throw new Error('beads not initialized in this repo — run `bd init` first')
  }
}

/** external_ref → bead, for every issue labeled `debt` (closed included). */
export function listDebtBeads(): Map<string, BeadRef> {
  let rows: Array<{ id: string; status: string; external_ref?: string | null }>
  try {
    rows = JSON.parse(bd(['list', '--json', '-n', '0', '--all', '-l', 'debt']))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`bd list failed or returned malformed JSON — ${msg}`)
  }
  const map = new Map<string, BeadRef>()
  for (const row of rows) {
    if (row.external_ref) {
      map.set(row.external_ref, { id: row.id, status: row.status })
    }
  }
  return map
}

const PRIORITY_MAP: Record<DebtPriority, number> = {
  blocking: 1,
  human: 2,
  nit: 3,
  scan: 4,
  noise: 4,
}

const STATUS_MAP: Record<DebtStatus, 'open' | 'in_progress' | 'closed'> = {
  open: 'open',
  claimed: 'in_progress',
  done: 'closed',
  wontfix: 'closed',
  duplicate: 'closed',
}

export interface SyncResult {
  created: number
  updated: number
  closed: number
  reopened: number
  unchanged: number
  linked: number
}

function reconcileStatus(
  beadId: string,
  beadStatus: string,
  want: DebtStatus,
  res: SyncResult
): void {
  const target = STATUS_MAP[want]
  const isClosed = beadStatus === 'closed' || beadStatus === 'done'
  if (target === 'closed' && !isClosed) {
    bd(['close', beadId, '--reason', `debt status: ${want}`])
    res.closed += 1
  } else if (target !== 'closed' && isClosed) {
    bd(['reopen', beadId])
    res.reopened += 1
    if (target === 'in_progress') {
      bd(['update', beadId, '--status', 'in_progress'])
    }
  } else if (target === 'in_progress' && beadStatus === 'open') {
    bd(['update', beadId, '--status', 'in_progress'])
    res.updated += 1
  } else {
    res.unchanged += 1
  }
}

function beadArgs(rec: DebtRecord): string[] {
  return [
    'create',
    '--silent',
    '--title',
    `${rec.area}: ${rec.body_preview}`,
    '--description',
    `${rec.body}\n\n---\nthread: ${rec.thread_url}\npr: ${rec.source_pr_url}`,
    '-l',
    `debt,pr:${rec.source_pr},area:${rec.area},author:${rec.author},priority:${rec.priority}`,
    '--priority',
    String(PRIORITY_MAP[rec.priority]),
    '--external-ref',
    rec.thread_id,
    '--metadata',
    JSON.stringify({
      thread_id: rec.thread_id,
      fingerprint: rec.fingerprint,
      path: rec.path,
      line: rec.line,
      source_pr: rec.source_pr,
      times_seen: rec.times_seen,
    }),
  ]
}

function syncRecord(
  rec: DebtRecord,
  existing: Map<string, BeadRef>,
  res: SyncResult,
  dryRun: boolean
): void {
  const bead = existing.get(rec.thread_id)
  if (!bead) {
    res.created += 1
    if (dryRun) {
      return
    }
    const id = bd(beadArgs(rec)).trim()
    existing.set(rec.thread_id, { id, status: 'open' })
    if (rec.status !== 'open') {
      reconcileStatus(id, 'open', rec.status, res)
    }
    return
  }
  if (dryRun) {
    res.unchanged += 1
    return
  }
  reconcileStatus(bead.id, bead.status, rec.status, res)
}

function tryLink(dup: BeadRef, canonical: BeadRef, res: SyncResult, dryRun: boolean): void {
  if (dryRun) {
    res.linked += 1
    return
  }
  try {
    bd(['link', dup.id, canonical.id, '--type', 'related'])
    res.linked += 1
  } catch {
    // link already exists — fine
  }
}

/** Fingerprint duplicates → `related` links to the canonical bead. */
function linkFingerprintDupes(
  records: DebtRecord[],
  existing: Map<string, BeadRef>,
  res: SyncResult,
  dryRun: boolean
): void {
  const byFingerprint = new Map<string, DebtRecord[]>()
  for (const rec of records) {
    const group = byFingerprint.get(rec.fingerprint) ?? []
    group.push(rec)
    byFingerprint.set(rec.fingerprint, group)
  }
  for (const group of byFingerprint.values()) {
    if (group.length < 2) {
      continue
    }
    const sorted = [...group].sort((a, b) => a.source_pr - b.source_pr)
    const canonical = existing.get(sorted[0]!.thread_id)
    if (!canonical) {
      continue
    }
    for (const dup of sorted.slice(1)) {
      const dupBead = existing.get(dup.thread_id)
      if (dupBead) {
        tryLink(dupBead, canonical, res, dryRun)
      }
    }
  }
}

/** Upsert ledger records into bd — idempotent via external_ref = thread_id. */
export function syncDebtToBeads(
  records: DebtRecord[],
  opts: { dryRun?: boolean } = {}
): SyncResult {
  checkBeads()
  const existing = listDebtBeads()
  const res: SyncResult = {
    created: 0,
    updated: 0,
    closed: 0,
    reopened: 0,
    unchanged: 0,
    linked: 0,
  }
  const dryRun = opts.dryRun === true
  for (const rec of records) {
    syncRecord(rec, existing, res, dryRun)
  }
  linkFingerprintDupes(records, existing, res, dryRun)
  return res
}

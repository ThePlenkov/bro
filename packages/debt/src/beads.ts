/**
 * beads (bd) projection of the debt ledger.
 *
 * JSONL stays the immutable evidence store; bd becomes the executable work
 * queue (`bd ready -l debt`). Upsert key: `external_ref` = `thread_id`, so
 * `bro debt sync` is idempotent. Status reconciles ledger → bead on re-runs.
 */
import { bd, initBeadsStealth } from '@bro/core'
import type { DebtPriority, DebtRecord, DebtStatus } from './types.ts'

export interface BeadRef {
  id: string
  status: string
  title?: string
  priority?: number
  timesSeen?: number
}

export function checkBeads(opts: { autoInit?: boolean } = {}): void {
  try {
    bd(['--version'])
  } catch {
    throw new Error(
      'bd not found — install beads, or opt out with "stores": ["jsonl"] in bro.config.json'
    )
  }
  // beads is a default store — a repo without .beads gets a stealth init
  // (local exclude, nothing lands in git) instead of a setup error.
  // Dry runs must not mutate: they skip init and let `bd list` report
  // the missing workspace instead.
  if (opts.autoInit !== false) {
    initBeadsStealth()
  }
  try {
    bd(['list', '--json', '-n', '1'])
  } catch (err) {
    // preserve the real failure — "not initialized" is only one cause
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new Error(
      `bd list failed — ${stderr || (err instanceof Error ? err.message : String(err))} ` +
        '(run `bd init` if beads is not initialized here)'
    )
  }
}

/** external_ref → bead, for every issue labeled `debt` (closed included). */
export function listDebtBeads(): Map<string, BeadRef> {
  let rows: Array<{
    id: string
    status: string
    title?: string
    priority?: number
    external_ref?: string | null
    metadata?: { times_seen?: number } | null
  }>
  try {
    rows = JSON.parse(bd(['list', '--json', '-n', '0', '--all', '-l', 'debt']))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`bd list failed or returned malformed JSON — ${msg}`)
  }
  const map = new Map<string, BeadRef>()
  for (const row of rows) {
    if (row.external_ref) {
      map.set(row.external_ref, {
        id: row.id,
        status: row.status,
        title: row.title,
        priority: row.priority,
        timesSeen: row.metadata?.times_seen,
      })
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
  } else if (target === 'open' && beadStatus !== 'open') {
    // Ledger is truth: a bead left claimed after the record went back to
    // open must return to the queue, not sit as in_progress forever.
    bd(['update', beadId, '--status', 'open'])
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
  reconcileDrift(bead, rec, res)
}

/** Reharvested fields (title body, times_seen, priority) drift — push them. */
function reconcileDrift(bead: BeadRef, rec: DebtRecord, res: SyncResult): void {
  const wantTitle = `${rec.area}: ${rec.body_preview}`
  const wantPriority = PRIORITY_MAP[rec.priority]
  const updateArgs = ['update', bead.id]
  if (bead.title !== undefined && bead.title !== wantTitle) {
    updateArgs.push('--title', wantTitle)
  }
  if (bead.priority !== undefined && bead.priority !== wantPriority) {
    updateArgs.push('--priority', String(wantPriority))
  }
  if (bead.timesSeen !== rec.times_seen) {
    updateArgs.push('--set-metadata', `times_seen=${rec.times_seen}`)
  }
  if (updateArgs.length > 2) {
    bd(updateArgs)
    res.updated += 1
  }
}

function tryLink(dup: BeadRef, canonical: BeadRef, res: SyncResult, dryRun: boolean): void {
  if (dryRun) {
    res.linked += 1
    return
  }
  // bd link is idempotent on existing edges — failures are real, let them throw.
  bd(['link', dup.id, canonical.id, '--type', 'related'])
  res.linked += 1
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
  const dryRun = opts.dryRun === true
  checkBeads({ autoInit: !dryRun })
  const existing = listDebtBeads()
  const res: SyncResult = {
    created: 0,
    updated: 0,
    closed: 0,
    reopened: 0,
    unchanged: 0,
    linked: 0,
  }
  for (const rec of records) {
    syncRecord(rec, existing, res, dryRun)
  }
  linkFingerprintDupes(records, existing, res, dryRun)
  return res
}

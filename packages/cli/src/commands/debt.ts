/**
 * `bro debt <sub>` — review-debt pipeline commands.
 *
 *   collect [OWNER REPO] [filters]   collect findings from unprocessed merged PRs
 *   status                           ledger summary + unprocessed merged-PR count
 *   prs [--limit N] [--all]          unprocessed merged PRs (--all: full matrix)
 *   list [filters]                   ledger rows
 *   mark PR collected|clean|skipped|none
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  dataRefCommit,
  dataRefPush,
  dataRefRoot,
  ensureAuth,
  reviewHost,
  type MergedPrScan,
  type PrLabelOp,
  type ReviewFacade,
} from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import {
  applyCollectLabel,
  applyDebtLabel,
  applyDebtVerdicts,
  applyLastN,
  buildSummary,
  claimDebtRecord,
  clearDebtLabels,
  collectPr,
  collectThreads,
  type CollectPrResult,
  DEBT_ROW_STATUSES,
  DEBT_STATES,
  debtLabel,
  ensureDebtLabels,
  groupStats,
  hasHarvestSelection,
  parseCsvInts,
  parseCsvStrings,
  partitionByProcessed,
  prDebtState,
  readDebtRecords,
  readLedgerOverlays,
  readProcessedAt,
  markProcessedAt,
  resolveHarvestPrs,
  syncDebtToBeads,
  upsertLedgerOverlays,
  writeHarvestFile,
  writeSummary,
  ALL_SOURCES,
  COLLECTORS,
  DEBT_SOURCES,
  parseSources,
  resolvedThreadIds,
  type DebtPrState,
  type DebtRecord,
  type DebtStatus,
  type DebtVerdict,
  type StatsGroupBy,
  type HarvestPrFilters,
} from '@broject/debt'

function readOption(argv: string[], index: number): string | null {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    return null
  }
  return value
}

function usage(): never {
  console.error(`Usage: bro debt <command> [args…]

Commands:
  collect [OWNER REPO] [filters]  Collect findings from unprocessed merged PRs
                                  Filters: --pr-ids, --merged-since, --merged-until,
                                  --last, --pr-author, --labels, --thread-author
                                  Flags: --dry-run, --list-only, --reharvest, --no-label
                                  Sources: debt.sources config — default review-threads;
                                  opt in: ${DEBT_SOURCES.join(', ')}
                                  debt.stale_days tunes stale-prs (default 14)
  status                          Ledger summary + unprocessed merged PR count
  stats [--by author|source|area] Signal per reviewer/source/area — fix% is
        [--json]                  done share of decided rows (default: author)
  prs [--limit N] [--all]         Unprocessed merged PRs (--all: full matrix)
  list [filters]                  Ledger rows (--status, --area, --author,
                                  --priority, --pr, --limit)
  mark PR <state> [OWNER REPO]    Set debt label: ${[...DEBT_STATES, 'none'].join('|')}
  set <status> --thread-id ID…    Ledger status: open|claimed|done|wontfix|duplicate
        [--threads-file PATH] [--fix-pr N] [--notes T]
  sync [--dry-run]                Project the ledger into beads (bd) — idempotent
  next [--json] [--claim]         Top open finding for an agent to fix
        [--area A] [--author U]   (--claim marks it claimed atomically)
  watch [collect flags]           Collect on an interval until Ctrl-C
        [--interval SEC=300]`)
  process.exit(1)
}

// --- collect ---------------------------------------------------------------

interface CollectArgs {
  repo: string
  filters: HarvestPrFilters
  threadAuthor: string | null
  runId: string
  dryRun: boolean
  listOnly: boolean
  reharvest: boolean
  noLabel: boolean
}

function parsePositiveInt(flag: string, value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`error: ${flag} must be a positive integer, got "${value}"`)
    process.exit(2)
  }
  return n
}

function parseCollectArgs(rev: ReviewFacade, argv: string[]): CollectArgs {
  const positional: string[] = []
  const filters: HarvestPrFilters = {
    prIds: [],
    mergedSince: null,
    mergedUntil: null,
    lastN: null,
    prAuthor: null,
    labels: [],
  }
  let threadAuthor: string | null = null
  let runId = 'local'
  const bools = { dryRun: false, listOnly: false, reharvest: false, noLabel: false }
  const boolFlags: Record<string, keyof typeof bools> = {
    '--dry-run': 'dryRun',
    '--list-only': 'listOnly',
    '--reharvest': 'reharvest',
    '--no-label': 'noLabel',
  }
  const valueFlags: Record<string, (v: string) => void> = {
    // An all-invalid --pr-ids parses to [] — which reads as "no explicit
    // selection" and silently falls back to the default 50-PR queue.
    '--pr-ids': (v) => {
      const ids = parseCsvInts(v)
      if (ids.length === 0) {
        console.error(`error: --pr-ids has no valid PR numbers in "${v}"`)
        process.exit(2)
      }
      filters.prIds = ids
    },
    '--merged-since': (v) => (filters.mergedSince = v),
    '--merged-until': (v) => (filters.mergedUntil = v),
    '--last': (v) => (filters.lastN = parsePositiveInt('--last', v)),
    '--pr-author': (v) => (filters.prAuthor = v),
    '--labels': (v) => (filters.labels = parseCsvStrings(v)),
    '--thread-author': (v) => (threadAuthor = v),
    '--run-id': (v) => (runId = v),
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const bool = boolFlags[arg]
    if (bool) {
      bools[bool] = true
      continue
    }
    const set = valueFlags[arg]
    if (set) {
      const value = readOption(argv, i)
      // A value flag without a value must not silently parse as absent —
      // a dropped selection flag downgrades to the default 50-PR queue.
      if (value === null) {
        console.error(`error: ${arg} requires a value`)
        process.exit(2)
      }
      set(value)
      i += 1
      continue
    }
    positional.push(arg)
  }

  const repo = rev.resolveRepo(positional)

  // No explicit selection → default queue: last 50 merged PRs.
  if (!hasHarvestSelection(filters)) {
    filters.lastN = 50
  }

  return {
    repo,
    filters,
    threadAuthor,
    runId,
    ...bools,
  }
}

async function cmdCollect(argv: string[]): Promise<void> {
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  // Auth gate before resolveRepo — an unauthenticated `gh repo view`
  // must not beat the remediation message.
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const args = parseCollectArgs(rev, argv)

  const debtCfg = loadBroConfig().debt
  const knownSources = new Set<string>(ALL_SOURCES)
  const sources = new Set(parseSources(debtCfg.sources))
  for (const s of debtCfg.sources.filter((x) => !knownSources.has(x))) {
    console.error(`debt collect: unknown source "${s}" — ignored`)
  }

  if (sources.has('review-threads')) {
    await collectReviewThreads(rev, args)
  }

  // Multi-source collectors — opt-in feeds landing in the same ledger.
  for (const source of DEBT_SOURCES) {
    if (!sources.has(source)) {
      continue
    }
    const harvestedAt = new Date().toISOString()
    let records: DebtRecord[] = []
    try {
      records = COLLECTORS[source](
        { repo: args.repo, runId: args.runId, harvestedAt },
        debtCfg.stale_days
      )
    } catch (err) {
      console.error(
        `debt: source ${source} failed — ${err instanceof Error ? err.message : err}`
      )
      continue
    }
    console.error(`debt: ${source} — ${records.length} finding(s)`)
    if (args.dryRun) {
      for (const row of records) {
        console.log(JSON.stringify(row))
      }
      continue
    }
    if (records.length > 0) {
      writeHarvestFile({
        pr: 0,
        source,
        runId: args.runId,
        harvestedAt,
        records,
      })
    }
    // Alerts/CI are server-side truth: a finding absent from the fresh
    // fetch resolved upstream — close its ledger row so the queue shrinks.
    const gone = resolvedThreadIds(readDebtRecords(), source, records)
    if (gone.length > 0) {
      upsertLedgerOverlays(
        gone.map((thread_id) => ({
          thread_id,
          status: 'done' as const,
          fix_pr: null,
          fixed_at: new Date().toISOString(),
          notes: 'resolved upstream — no longer reported',
        }))
      )
      console.error(`debt: ${source} — resolved ${gone.length} row(s) no longer reported`)
    }
  }

  if (!args.dryRun) {
    const totalRows = readDebtRecords().length
    if (totalRows > 0) {
      writeSummary(buildSummary(readDebtRecords()))
    }

    // store: beads|both → also project into bd. Collection results are
    // already durable; a sync failure is reported as its own error, not
    // allowed to mask them — but it still fails the run (no silent degrade).
    // Explicit values only — a typo like "beed" must fall back to jsonl,
    // not fail in bd after the ledger was already written.
    if (loadBroConfig().stores.includes('beads')) {
      try {
        const res = syncDebtToBeads(readDebtRecords())
        console.error(
          `debt sync: ${res.created} created, ${res.closed} closed, ` +
            `${res.reopened} reopened, ${res.linked} linked`
        )
      } catch (err) {
        console.error(`debt sync FAILED: ${err instanceof Error ? err.message : err}`)
        console.error('evidence is written; run `bro debt sync` to retry the projection')
        process.exitCode = 1
      }
    }
  }
}

// Review bots can comment AFTER merge+label. A labeled PR whose updatedAt
// is newer than our scan timestamp goes back into the queue — except
// `debt:skipped`, which is a human opt-out and is never rescanned.
function selectTargets(
  matched: Awaited<ReturnType<typeof resolveHarvestPrs>>,
  args: CollectArgs
): { targets: typeof matched; staleCount: number; processedCount: number } {
  const { pending, processed } = partitionByProcessed(matched)
  const processedAt = readProcessedAt()
  const futureBound = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const stale = processed.filter((pr) => {
    if (prDebtState(pr.labels) === 'skipped') {
      return false
    }
    const at = processedAt.get(pr.number)
    // No timestamp = labeled before this feature existed (or manually) —
    // rescan once to backfill; the scan then writes the timestamp.
    // A far-future cursor would suppress rescans forever — treat as stale.
    // Tolerance: the cursor is server time, so compare against local now+5m
    // to survive clock skew without flagging every PR.
    return (
      at === undefined ||
      at > futureBound ||
      (pr.updatedAt !== null && pr.updatedAt > at)
    )
  })
  return {
    targets: args.reharvest
      ? matched.filter((pr) => prDebtState(pr.labels) !== 'skipped')
      : [...pending, ...stale],
    staleCount: stale.length,
    processedCount: processed.length,
  }
}

/** A reharvested thread that was marked done/wontfix is unresolved again
 *  — the terminal overlay must not shadow the fresh open evidence. */
function reopenTerminalRows(rows: DebtRecord[]): void {
  const overlays = readLedgerOverlays()
  const reopen = rows.filter((r) => {
    const s = overlays.get(r.thread_id)?.status
    return s === 'done' || s === 'wontfix'
  })
  if (reopen.length === 0) {
    return
  }
  upsertLedgerOverlays(
    reopen.map((r) => {
      const prev = overlays.get(r.thread_id)
      return {
        thread_id: r.thread_id,
        status: 'open' as const,
        fix_pr: null,
        fixed_at: null,
        notes: prev?.notes ? `${prev.notes} | reopened by reharvest` : 'reopened by reharvest',
      }
    })
  )
  console.error(`debt: reopened ${reopen.length} terminal row(s) — still unresolved`)
}

interface ScannedPr {
  pr: number
  result: CollectPrResult
  /** Labels for the debt-state decision — probe-fresh in the bulk path,
   *  re-fetched post-collect in the serial path (same window as before). */
  labels: string[]
  /** updatedAt at probe time — the cursor for PRs that get no label
   *  write (nothing bumped it since the probe). Null in the serial path:
   *  the cursor phase re-fetches like the old loop did. */
  updatedAt: string | null
  /** The candidate's list-time updatedAt — last-resort cursor fallback. */
  listedAt: string | null
  scannedAt: string
}

/** Records for one PR — classified from the bulk probe when present,
 *  else the serial per-PR fetch (meta + threads + labels). Writes the
 *  harvest file; returns null on probe failure (warned, not thrown). */
async function scanPr(
  rev: ReviewFacade,
  args: CollectArgs,
  pr: { number: number; updatedAt: string | null },
  scan: MergedPrScan | undefined,
  labelingEnabled: boolean,
  pos: number,
  total: number
): Promise<ScannedPr | null> {
  // Captured before fetching threads: activity arriving mid-scan is then
  // newer than the recorded timestamp and gets picked up next run.
  const scannedAt = new Date().toISOString()
  let result: CollectPrResult
  let labels: string[] = []
  let updatedAt: string | null = null
  try {
    if (scan !== undefined) {
      result = collectThreads({
        meta: scan.info,
        threads: scan.threads,
        pr: pr.number,
        runId: args.runId,
        threadAuthor: args.threadAuthor,
        harvestedAt: scannedAt,
      })
      labels = scan.labels
      updatedAt = scan.updatedAt
    } else {
      result = await collectPr(rev, {
        repo: args.repo,
        pr: pr.number,
        runId: args.runId,
        threadAuthor: args.threadAuthor,
      })
      // Re-fetch labels: the candidate snapshot predates this PR's
      // collection, and a human may have opted out while we scanned.
      // Skipped under --dry-run — no write will consult them.
      if (labelingEnabled && !args.dryRun) {
        labels = rev.labels({ repo: args.repo, pr: pr.number })
      }
    }
  } catch (err) {
    console.error(
      `warning: PR ${rev.prLink(args.repo, pr.number)} skipped — ${err instanceof Error ? err.message : err}`
    )
    return null
  }
  console.error(
    `debt: [${pos}/${total}] PR ${rev.prLink(args.repo, pr.number)} — ${result.incoming.length} thread(s)`
  )

  if (args.dryRun) {
    for (const row of result.incoming) {
      console.log(JSON.stringify(row))
    }
    return { pr: pr.number, result, labels, updatedAt, listedAt: pr.updatedAt, scannedAt }
  }

  if (result.incoming.length > 0) {
    writeHarvestFile({
      pr: result.pr,
      runId: args.runId,
      harvestedAt: result.incoming[0]!.harvested_at,
      records: result.incoming,
    })
    reopenTerminalRows(result.incoming)
  }
  return { pr: pr.number, result, labels, updatedAt, listedAt: pr.updatedAt, scannedAt }
}

interface LabelWrite {
  s: ScannedPr
  op: PrLabelOp
}

/** One label op per non-skipped PR — the machine state from the scan
 *  outcome. `skipped` is never in the remove set: a late human opt-out
 *  survives the write either way. */
function buildLabelWrites(args: CollectArgs, scanned: ScannedPr[]): LabelWrite[] {
  const writes: LabelWrite[] = []
  for (const s of scanned) {
    if (prDebtState(s.labels) === 'skipped') {
      continue
    }
    const state: DebtPrState = s.result.incoming.length > 0 ? 'collected' : 'clean'
    writes.push({
      s,
      op: {
        t: { repo: args.repo, pr: s.pr },
        add: [debtLabel(state)],
        // A remove names only labels the probe observed — removing an
        // absent label fails the whole pr-edit call, losing the add.
        remove: DEBT_STATES.filter((x) => x !== 'skipped' && x !== state)
          .map(debtLabel)
          .filter((l) => s.labels.some((have) => have.toLowerCase() === l)),
      },
    })
  }
  return writes
}

/** The bulk write — post-write updatedAt per applied PR; null when the
 *  connector lacks the fast path or the batch failed outright. */
async function bulkLabelWrites(
  rev: ReviewFacade,
  writes: LabelWrite[]
): Promise<Map<number, string | null> | null> {
  if (typeof rev.labelPrs !== 'function' || writes.length === 0) {
    return null
  }
  try {
    return await rev.labelPrs(writes.map((w) => w.op))
  } catch (err) {
    console.error(
      `warning: bulk label write failed — falling back per-PR ` +
        `(${err instanceof Error ? err.message : err})`
    )
    return null
  }
}

/** One write — applied in bulk already, else the serial pre-bulk path.
 *  `stamp` is the post-write updatedAt when observed; `ok: false` means
 *  the write failed (unlabeled → rescan next run, self-healing). */
function ensureLabelWritten(
  rev: ReviewFacade,
  args: CollectArgs,
  w: LabelWrite,
  wrote: Map<number, string | null> | null
): { ok: boolean; stamp: string | null } {
  if (wrote?.has(w.s.pr)) {
    return { ok: true, stamp: wrote.get(w.s.pr) ?? null }
  }
  try {
    applyCollectLabel(rev, {
      repo: args.repo,
      pr: w.s.pr,
      state: w.s.result.incoming.length > 0 ? 'collected' : 'clean',
    })
  } catch (err) {
    console.error(
      `warning: label write on ${rev.prLink(args.repo, w.s.pr)} failed — ` +
        `${err instanceof Error ? err.message : err}`
    )
    return { ok: false, stamp: null }
  }
  return { ok: true, stamp: null }
}

/** Label writes + processed cursors for the scanned PRs — batched through
 *  `labelPrs` when the connector offers it, serial per-PR otherwise.
 *  `debt:skipped` is never written over and still earns a cursor: nothing
 *  changed for it, so probe-time updatedAt is the honest marker. */
async function labelScannedPrs(
  rev: ReviewFacade,
  args: CollectArgs,
  scanned: ScannedPr[]
): Promise<number> {
  const writes = buildLabelWrites(args, scanned)
  const wrote = await bulkLabelWrites(rev, writes)

  let labeled = 0
  for (const w of writes) {
    const res = ensureLabelWritten(rev, args, w, wrote)
    if (!res.ok) {
      continue // write failed — unlabeled, next run rescans
    }
    labeled += 1
    // Cursor: post-write updatedAt (bulk result or a fresh fetch) — a
    // pre-write stamp would flag the PR stale on every later run.
    const cursor =
      res.stamp ?? rev.prUpdatedAt(w.op.t) ?? w.s.updatedAt ?? w.s.listedAt ?? w.s.scannedAt
    markProcessedAt([w.s.pr], cursor)
  }
  // Skipped PRs: no write touched them — probe-time updatedAt IS current;
  // serial-path PRs fetch fresh, exactly like the old loop.
  for (const s of scanned) {
    if (prDebtState(s.labels) !== 'skipped') {
      continue
    }
    const cursor =
      s.updatedAt ??
      rev.prUpdatedAt({ repo: args.repo, pr: s.pr }) ??
      s.listedAt ??
      s.scannedAt
    markProcessedAt([s.pr], cursor)
  }
  return labeled
}

/** The bulk probe — one call carries meta + threads + labels + updatedAt
 *  for every target when the connector offers it. Returns null when
 *  unavailable/failed: the per-PR loop then probes serially. */
async function probeTargets(
  rev: ReviewFacade,
  repo: string,
  targets: Array<{ number: number }>
): Promise<Map<number, MergedPrScan> | null> {
  if (typeof rev.scanMergedPrs !== 'function' || targets.length === 0) {
    return null
  }
  const started = Date.now()
  try {
    return await rev.scanMergedPrs(
      targets.map((pr) => ({ repo, pr: pr.number })),
      {
        onProgress: (done, total) => {
          const left =
            done > 0 && done < total
              ? `, ~${Math.round((((Date.now() - started) / done) * (total - done)) / 1000)}s left`
              : ''
          console.error(`debt collect: probed ${done}/${total} merged PR(s)${left}`)
        },
      }
    )
  } catch (err) {
    console.error(
      `warning: bulk scan failed — falling back to serial probes ` +
        `(${err instanceof Error ? err.message : err})`
    )
    return null
  }
}

/** Probe → commit → label. The bulk probe carries meta+threads+labels+
 *  updatedAt per PR when the connector offers it; serial per-PR fetches
 *  inside scanPr cover whatever the bulk pass missed. */
async function harvestTargets(
  rev: ReviewFacade,
  args: CollectArgs,
  targets: Awaited<ReturnType<typeof resolveHarvestPrs>>,
  labelingEnabled: boolean
): Promise<{ rows: number; labeled: number }> {
  const scans = await probeTargets(rev, args.repo, targets)

  const scanned: ScannedPr[] = []
  let rows = 0
  for (const [i, pr] of targets.entries()) {
    // Serial commit phase by design: ledger writes and the per-PR
    // progress line keep a deterministic order.
    const s = await scanPr( // NOSONAR — deliberate serial awaits
      rev,
      args,
      pr,
      scans?.get(pr.number),
      labelingEnabled,
      i + 1,
      targets.length
    )
    if (s === null) {
      continue
    }
    scanned.push(s)
    rows += s.result.incoming.length
  }

  const labeled =
    labelingEnabled && !args.dryRun && scanned.length > 0
      ? await labelScannedPrs(rev, args, scanned)
      : 0
  return { rows, labeled }
}

async function collectReviewThreads(rev: ReviewFacade, args: CollectArgs): Promise<void> {
  // Fetch at least as many candidates as --last requests, or it silently caps.
  const listLimit = Math.max(args.filters.lastN ?? 0, 100)
  const matched = resolveHarvestPrs(rev, {
    repo: args.repo,
    filters: args.filters,
    listLimit,
  })
  const { targets, staleCount, processedCount } = selectTargets(matched, args)

  console.error(
    `debt collect: ${matched.length} merged PR(s) matched, ` +
      `${processedCount - staleCount} already processed (debt:* label)` +
      (staleCount > 0 ? `, ${staleCount} stale (post-scan activity)` : '') +
      `, scanning ${targets.length}`
  )

  if (args.listOnly) {
    for (const pr of targets) {
      console.log(`${pr.number}\t${pr.mergedAt}\t${pr.author}\t${prDebtState(pr.labels) ?? 'none'}`)
    }
    return
  }
  if (targets.length === 0) {
    return
  }

  // A thread-author-filtered run is a partial scan — a PR-level "processed"
  // label would hide other authors' unresolved threads from future runs.
  const labelingEnabled = !args.noLabel && args.threadAuthor === null
  if (args.threadAuthor !== null && !args.noLabel) {
    console.error('debt collect: --thread-author is a partial scan — labels disabled')
  }
  if (!args.dryRun && labelingEnabled) {
    ensureDebtLabels(rev, args.repo)
  }

  const { rows, labeled } = await harvestTargets(rev, args, targets, labelingEnabled)

  const labeledMsg = labelingEnabled ? `labeled ${labeled} PR(s)` : 'labels disabled'
  console.error(`debt collect: wrote ${rows} row(s), ${labeledMsg}`)
}

// --- status ----------------------------------------------------------------

function cmdStatus(): void {
  const records = readDebtRecords()
  const summary = buildSummary(records)

  const byStatus: Record<string, number> = {}
  for (const row of records) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  }

  console.log(`rows: ${records.length} total`)
  for (const [status, count] of Object.entries(byStatus).sort()) {
    console.log(`  ${status}: ${count}`)
  }
  if (summary.open_count > 0) {
    console.log(`\nopen by area:`)
    for (const [area, count] of Object.entries(summary.by_area).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${area}: ${count}`)
    }
    console.log(`open by author:`)
    for (const [author, count] of Object.entries(summary.by_author).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${author}: ${count}`)
    }
    if (summary.duplicate_fingerprints.length > 0) {
      console.log(`duplicate fingerprints: ${summary.duplicate_fingerprints.length}`)
    }
    console.log(`oldest open: ${summary.oldest_open}`)
  }

  // Best-effort: count merged PRs still lacking a debt:* label. Skipped
  // silently when no repo resolves (not in a clone, host unreachable).
  try {
    const rev = reviewHost(undefined, loadBroConfig().connectors)
    const merged = rev.mergedPrs(rev.resolveRepo([]), { limit: 100 })
    const { pending } = partitionByProcessed(merged)
    console.log(`\nunprocessed merged PRs: ${pending.length} (of last ${merged.length})`)
  } catch {
    // no repo context — ledger stats above still stand on their own
  }
}

// --- stats -----------------------------------------------------------------

const STATS_BY: readonly StatsGroupBy[] = ['author', 'source', 'area']

function cmdStats(argv: string[]): void {
  const json = argv.includes('--json')
  let by: StatsGroupBy = 'author'
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--by') {
      const value = readOption(argv, i)
      if (!value || !(STATS_BY as readonly string[]).includes(value)) {
        console.error(`error: --by must be one of ${STATS_BY.join('|')}, got "${value}"`)
        process.exit(2)
      }
      by = value as StatsGroupBy
      i += 1
    }
  }

  const rows = groupStats(readDebtRecords(), by)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  const label = by === 'author' ? 'reviewer' : by
  console.log(`${label}\ttotal\topen\tclaimed\tdone\twontfix\tdup\tfix%`)
  for (const r of rows) {
    const rate = r.fixRate === null ? '—' : `${Math.round(r.fixRate * 100)}%`
    console.log(`${r.key}\t${r.total}\t${r.open}\t${r.claimed}\t${r.done}\t${r.wontfix}\t${r.duplicate}\t${rate}`)
  }
  console.error(`debt stats: ${rows.length} ${label}(s)`)
}

// --- prs -------------------------------------------------------------------

function cmdPrs(argv: string[]): void {
  const positional: string[] = []
  let limit = 50
  let showAll = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--all') {
      showAll = true
      continue
    }
    if (arg === '--limit') {
      const value = readOption(argv, i)
      if (value !== null) {
        limit = Number(value)
        i += 1
      }
      continue
    }
    positional.push(arg)
  }
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const repo = rev.resolveRepo(positional)

  const prs = rev.mergedPrs(repo, { limit })
  const rows = prs
    .map((pr) => ({ pr, state: prDebtState(pr.labels) ?? 'none' }))
    .filter((row) => showAll || row.state === 'none')
  for (const { pr, state } of rows) {
    console.log(`${pr.number}\t${state}\t${pr.mergedAt}\t${pr.author}`)
  }
  const pending = prs.filter((pr) => prDebtState(pr.labels) === null).length
  console.error(`debt prs: ${pending} unprocessed of ${prs.length} merged PR(s)`)
}

// --- list ------------------------------------------------------------------

function rowMatchesFilters(
  row: DebtRecord,
  filters: Record<string, string | number | null>
): boolean {
  if (filters.status !== null && row.status !== filters.status) return false
  if (filters.area !== null && row.area !== filters.area) return false
  if (filters.author !== null && row.author !== filters.author) return false
  if (filters.priority !== null && row.priority !== filters.priority) return false
  if (filters.pr !== null && row.source_pr !== filters.pr) return false
  // legacy rows predate sources — they belong to review-threads
  if (filters.source !== null && (row.source ?? 'review-threads') !== filters.source)
    return false
  return true
}

function cmdList(argv: string[]): void {
  const filters: Record<string, string | number | null> = {
    status: 'open',
    area: null,
    author: null,
    priority: null,
    pr: null,
    source: null,
  }
  let limit = 50
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const value = readOption(argv, i)
    if (arg === '--limit') {
      if (value !== null) {
        limit = Number(value)
        i += 1
      }
      continue
    }
    const key = arg.replace(/^--/, '')
    if (key in filters && value !== null) {
      filters[key] = key === 'pr' ? Number(value) : value
      i += 1
    }
  }

  const rows = readDebtRecords()
    .filter((row) => rowMatchesFilters(row, filters))
    .slice(0, limit)
  for (const row of rows) {
    console.log(
      `${row.thread_id.slice(0, 12)}\t#${row.source_pr}\t${row.status}\t${row.priority}\t${row.area}\t${row.author}\t${row.body_preview}`
    )
  }
  console.error(`debt list: ${rows.length} row(s)`)
}

// --- mark ------------------------------------------------------------------

function cmdMark(argv: string[]): void {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const [prRaw, stateRaw, ...rest] = positional
  const pr = Number(prRaw)
  if (!Number.isFinite(pr) || !stateRaw) {
    console.error(`Usage: bro debt mark PR <${[...DEBT_STATES, 'none'].join('|')}> [OWNER REPO]`)
    process.exit(2)
  }
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const repo = rev.resolveRepo(rest)
  if (stateRaw === 'none') {
    clearDebtLabels(rev, { repo, pr })
    console.error(`debt mark: cleared debt:* labels on ${rev.prLink(repo, pr)}`)
    return
  }
  if (!(DEBT_STATES as readonly string[]).includes(stateRaw)) {
    console.error(`error: unknown state ${stateRaw}`)
    process.exit(2)
  }
  ensureDebtLabels(rev, repo)
  applyDebtLabel(rev, { repo, pr, state: stateRaw as DebtPrState })
  console.error(`debt mark: ${rev.prLink(repo, pr)} → debt:${stateRaw}`)
}

// --- set -------------------------------------------------------------------

type DebtRowStatus = DebtStatus

interface SetArgs {
  threadIds: string[]
  fixPr: number | null
  notes: string | null
}

function parseSetFlags(argv: string[]): SetArgs {
  const out: SetArgs = { threadIds: [], fixPr: null, notes: null }
  for (let i = 0; i < argv.length; i += 1) {
    const value = readOption(argv, i)
    if (argv[i] === '--thread-id' && value !== null) {
      out.threadIds.push(value)
      i += 1
    } else if (argv[i] === '--threads-file' && value !== null) {
      out.threadIds.push(
        ...readFileSync(value, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'))
      )
      i += 1
    } else if (argv[i] === '--fix-pr' && value !== null) {
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`error: --fix-pr must be a positive integer, got "${value}"`)
        process.exit(2)
      }
      out.fixPr = n
      i += 1
    } else if (argv[i] === '--notes' && value !== null) {
      out.notes = value
      i += 1
    }
  }
  return out
}

function cmdSet(argv: string[]): void {
  // Status is strictly the first positional — scanning all argv would let a
  // flag value like --notes "done" get picked up as the status.
  const status = argv[0] as DebtRowStatus | undefined
  const { threadIds, fixPr, notes } = parseSetFlags(argv.slice(1))

  if (!status || !(DEBT_ROW_STATUSES as readonly string[]).includes(status) || threadIds.length === 0) {
    console.error(
      `Usage: bro debt set <${DEBT_ROW_STATUSES.join('|')}> --thread-id ID… ` +
        '[--threads-file PATH] [--fix-pr N] [--notes T]'
    )
    process.exit(2)
  }

  applyVerdicts(
    [...new Set(threadIds)].map((thread_id) => ({
      thread_id,
      status,
      fix_pr: fixPr ?? undefined,
      notes: notes ?? undefined,
    }))
  )
}

/** Apply verdicts to the ledger — shared by `debt set` (argv → uniform
 *  verdicts) and the debt plan runner (`bro run debt.toml`). */
export function applyVerdicts(verdicts: DebtVerdict[]): void {
  const { applied, missing } = applyDebtVerdicts(verdicts)
  writeSummary(buildSummary(readDebtRecords()))
  console.error(`debt set: ${applied} row(s) updated`)
  if (missing.length > 0) {
    console.error(`warning: thread id(s) not in ledger: ${missing.join(', ')}`)
    process.exitCode = 1
  }
}

// --- next ------------------------------------------------------------------

const PRIORITY_RANK: Record<DebtRecord['priority'], number> = {
  blocking: 0,
  human: 1,
  nit: 2,
  scan: 3,
  noise: 4,
}

function cmdNext(argv: string[]): void {
  const json = argv.includes('--json')
  const claim = argv.includes('--claim')
  const filters: Record<string, string | null> = { area: null, author: null }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!.replace(/^--/, '')
    if (key in filters) {
      const value = readOption(argv, i)
      if (value !== null) {
        filters[key] = value
        i += 1
      }
    }
  }

  let row = readDebtRecords()
    .filter((r) => r.status === 'open')
    .filter((r) => (filters.area === null || r.area === filters.area))
    .filter((r) => (filters.author === null || r.author === filters.author))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.harvested_at.localeCompare(b.harvested_at)
    )[0]

  if (!row) {
    console.error('debt next: no open findings')
    process.exitCode = 1
    return
  }
  if (claim) {
    // Atomic compare-and-swap: the claim is written only if the row is
    // still open under the lock — a concurrent claimer loses and reruns.
    const claimed = claimDebtRecord(row.thread_id)
    if (!claimed) {
      // CAS lost — report the actual status, not just "claimed": the row
      // may have been marked done/wontfix/duplicate by another process.
      const current = readDebtRecords().find((r) => r.thread_id === row!.thread_id)
      console.error(
        `debt next: ${row.thread_id.slice(0, 12)} no longer open ` +
          `(status=${current?.status ?? 'gone'}) — rerun`
      )
      process.exitCode = 1
      return
    }
    row = claimed
    writeSummary(buildSummary(readDebtRecords()))
    console.error(`debt next: ${row.thread_id.slice(0, 12)} → claimed`)
  }
  if (json) {
    console.log(JSON.stringify(row))
    return
  }
  console.log(`${row.thread_id}\t#${row.source_pr}\t${row.priority}\t${row.area}\t${row.author}`)
  console.log(`${row.path}:${row.line ?? '?'}`)
  console.log(row.body)
  console.log(row.thread_url)
}

// --- watch -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function cmdWatch(argv: string[]): Promise<void> {
  let intervalSec = 300
  const collectArgv: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--interval') {
      const value = readOption(argv, i)
      const n = Number(value)
      // setTimeout overflows above 2^31-1 ms (~24.8 days) and fires
      // immediately — bound the interval below that.
      if (value === null || !Number.isSafeInteger(n) || n <= 0 || n * 1000 > 2_147_483_647) {
        console.error(`error: --interval must be a positive integer (seconds), got "${value}"`)
        process.exit(2)
      }
      intervalSec = n
      i += 1
      continue
    }
    collectArgv.push(argv[i]!)
  }
  console.error(`debt watch: collecting every ${intervalSec}s — Ctrl-C to stop`)
  for (;;) {
    try {
      await cmdCollect(collectArgv)
    } catch (err) {
      // A failed pass (network blip, gh outage) must not kill the loop.
      console.error(`debt watch: collect failed — ${err instanceof Error ? err.message : err}`)
    }
    await sleep(intervalSec * 1000)
  }
}

// --- sync ------------------------------------------------------------------

function cmdSync(argv: string[]): void {
  const dryRun = argv.includes('--dry-run')
  // The explicit jsonl opt-out must hold even for a manual sync — without
  // this gate `sync` would auto-init .beads and project anyway.
  if (!loadBroConfig().stores.includes('beads')) {
    console.error(
      'debt sync: beads is not in stores — drop the opt-out or set ' +
        '"stores": ["jsonl", "beads"] in bro.config.json'
    )
    process.exit(1)
  }
  const records = readDebtRecords()
  const res = syncDebtToBeads(records, { dryRun })
  const verb = dryRun ? '[dry-run] ' : ''
  console.error(
    `${verb}debt sync: ${records.length} record(s) — ${res.created} created, ` +
      `${res.closed} closed, ${res.reopened} reopened, ${res.updated} updated, ` +
      `${res.unchanged} unchanged, ${res.linked} linked`
  )
}

// --- entry -----------------------------------------------------------------

const COMMANDS: Record<string, (argv: string[]) => void | Promise<void>> = {
  collect: cmdCollect,
  status: cmdStatus,
  stats: cmdStats,
  prs: cmdPrs,
  list: cmdList,
  mark: cmdMark,
  set: cmdSet,
  sync: cmdSync,
  next: cmdNext,
  watch: cmdWatch,
}

const MUTATING = new Set(['collect', 'mark', 'set', 'sync', 'next'])

/** Best-effort data-ref sync after ledger mutations — gitref is opt-in;
 *  sync failures warn but never mask the command's own result. */
function maybeDataRefSync(): void {
  const cfg = loadBroConfig()
  if (!cfg.stores.includes('gitref')) {
    return
  }
  const root = dataRefRoot()
  if (root === null) {
    return
  }
  try {
    // mirror the store's own resolution — BRO_DEBT_DIR wins over config
    const dir = process.env.BRO_DEBT_DIR ?? cfg.debt.dir
    const rel = relative(root, join(process.cwd(), dir))
    const head = dataRefCommit(root, rel, 'bro debt: ledger update', cfg.sync.ref)
    if (head !== null) {
      dataRefPush(root, cfg.sync.remote, cfg.sync.ref)
    }
  } catch (err) {
    console.error(
      `warning: data ref sync failed — ${err instanceof Error ? err.message : err}`
    )
  }
}

export async function runDebtCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  // zero-arg magic: bare `bro debt` is the damage report
  if (!cmd) {
    cmdStatus()
    return
  }
  if (cmd === '--help' || cmd === '-h') {
    usage()
  }
  const handler = COMMANDS[cmd!]
  if (!handler) {
    console.error(`unknown command: ${cmd}`)
    usage()
  }
  await handler(rest)
  if (MUTATING.has(cmd)) {
    maybeDataRefSync()
  }
}

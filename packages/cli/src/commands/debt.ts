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
import { ensureGhAuth, loadConfig, resolveRepo } from '@bro/core'
import {
  applyCollectLabel,
  applyDebtLabel,
  applyLastN,
  buildSummary,
  clearDebtLabels,
  collectPr,
  DEBT_STATES,
  ensureDebtLabels,
  fetchMergedPrCandidates,
  fetchPrLabels,
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
  type DebtPrState,
  type DebtRecord,
  type HarvestPrFilters,
} from '@bro/debt'

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
  status                          Ledger summary + unprocessed merged PR count
  prs [--limit N] [--all]         Unprocessed merged PRs (--all: full matrix)
  list [filters]                  Ledger rows (--status, --area, --author,
                                  --priority, --pr, --limit)
  mark PR <state> [OWNER REPO]    Set debt label: ${[...DEBT_STATES, 'none'].join('|')}
  set <status> --thread-id ID…    Ledger status: open|claimed|done|wontfix|duplicate
        [--threads-file PATH] [--fix-pr N] [--notes T]
  sync [--dry-run]                Project the ledger into beads (bd) — idempotent`)
  process.exit(1)
}

// --- collect ---------------------------------------------------------------

interface CollectArgs {
  repo: string
  owner: string
  repoName: string
  filters: HarvestPrFilters
  threadAuthor: string | null
  runId: string
  dryRun: boolean
  listOnly: boolean
  reharvest: boolean
  noLabel: boolean
}

function parseCollectArgs(argv: string[]): CollectArgs {
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
  let dryRun = false
  let listOnly = false
  let reharvest = false
  let noLabel = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const value = readOption(argv, i)
    switch (arg) {
      case '--dry-run':
        dryRun = true
        break
      case '--list-only':
        listOnly = true
        break
      case '--reharvest':
        reharvest = true
        break
      case '--no-label':
        noLabel = true
        break
      case '--pr-ids':
      case '--merged-since':
      case '--merged-until':
      case '--last':
      case '--pr-author':
      case '--labels':
      case '--thread-author':
      case '--run-id':
        if (value === null) {
          break
        }
        i += 1
        if (arg === '--pr-ids') filters.prIds = parseCsvInts(value)
        else if (arg === '--merged-since') filters.mergedSince = value
        else if (arg === '--merged-until') filters.mergedUntil = value
        else if (arg === '--last') {
          const n = Number(value)
          if (!Number.isInteger(n) || n <= 0) {
            console.error(`error: --last must be a positive integer, got "${value}"`)
            process.exit(2)
          }
          filters.lastN = n
        } else if (arg === '--pr-author') filters.prAuthor = value
        else if (arg === '--labels') filters.labels = parseCsvStrings(value)
        else if (arg === '--thread-author') threadAuthor = value
        else if (arg === '--run-id') runId = value
        break
      default:
        positional.push(arg)
    }
  }

  const repo = resolveRepo(positional)
  const [owner, repoName] = repo.split('/')

  // No explicit selection → default queue: last 50 merged PRs.
  if (!hasHarvestSelection(filters)) {
    filters.lastN = 50
  }

  return {
    repo,
    owner: owner!,
    repoName: repoName!,
    filters,
    threadAuthor,
    runId,
    dryRun,
    listOnly,
    reharvest,
    noLabel,
  }
}

async function cmdCollect(argv: string[]): Promise<void> {
  const args = parseCollectArgs(argv)
  ensureGhAuth()

  // Fetch at least as many candidates as --last requests, or it silently caps.
  const listLimit = Math.max(args.filters.lastN ?? 0, 100)
  const matched = resolveHarvestPrs({
    owner: args.owner,
    repo: args.repoName,
    filters: args.filters,
    listLimit,
  })
  const { pending, processed } = partitionByProcessed(matched)

  // Review bots can comment AFTER merge+label. A labeled PR whose updatedAt
  // is newer than our scan timestamp goes back into the queue — except
  // `debt:skipped`, which is a human opt-out and is never rescanned.
  const processedAt = readProcessedAt()
  const now = new Date().toISOString()
  const stale = processed.filter((pr) => {
    if (prDebtState(pr.labels) === 'skipped') {
      return false
    }
    const at = processedAt.get(pr.number)
    // No timestamp = labeled before this feature existed (or manually) —
    // rescan once to backfill; the scan then writes the timestamp.
    // A future timestamp would suppress rescans forever — treat as stale.
    return (
      at === undefined ||
      at > now ||
      (pr.updatedAt !== null && pr.updatedAt > at)
    )
  })
  const targets = args.reharvest
    ? matched.filter((pr) => prDebtState(pr.labels) !== 'skipped')
    : [...pending, ...stale]

  console.error(
    `debt collect: ${matched.length} merged PR(s) matched, ` +
      `${processed.length - stale.length} already processed (debt:* label)` +
      (stale.length > 0 ? `, ${stale.length} stale (post-scan activity)` : '') +
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
    ensureDebtLabels(args.repo)
  }

  let totalRows = 0
  let labeled = 0
  for (const pr of targets) {
    // Captured before fetching threads: activity arriving mid-scan is then
    // newer than the recorded timestamp and gets picked up next run.
    const scannedAt = new Date().toISOString()
    let result
    try {
      result = await collectPr({
        owner: args.owner,
        repo: args.repoName,
        pr: pr.number,
        runId: args.runId,
        threadAuthor: args.threadAuthor,
      })
    } catch (err) {
      console.error(`warning: PR #${pr.number} skipped — ${err instanceof Error ? err.message : err}`)
      continue
    }
    console.error(`debt: PR #${pr.number} — ${result.incoming.length} thread(s)`)

    if (args.dryRun) {
      for (const row of result.incoming) {
        console.log(JSON.stringify(row))
      }
      continue
    }

    const state: DebtPrState = result.incoming.length > 0 ? 'collected' : 'clean'
    if (result.incoming.length > 0) {
      writeHarvestFile({
        pr: result.pr,
        runId: args.runId,
        harvestedAt: result.incoming[0]!.harvested_at,
        records: result.incoming,
      })
      totalRows += result.incoming.length
      // A reharvested thread that was marked done/wontfix is unresolved again
      // — the terminal overlay must not shadow the fresh open evidence.
      const overlays = readLedgerOverlays()
      const reopen = result.incoming.filter((r) => {
        const s = overlays.get(r.thread_id)?.status
        return s === 'done' || s === 'wontfix'
      })
      if (reopen.length > 0) {
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
    }
    // Never overwrite a human `debt:skipped` opt-out, even under --reharvest.
    // Re-fetch labels: the candidate snapshot predates this PR's collection,
    // and a human may have opted out while we were scanning.
    if (labelingEnabled) {
      const current = fetchPrLabels({ owner: args.owner, repo: args.repoName, pr: pr.number })
      if (prDebtState(current) !== 'skipped') {
        applyCollectLabel({ repo: args.repo, pr: pr.number, state })
        labeled += 1
      }
      // Only full scans earn a timestamp — a --thread-author partial scan
      // must not mask post-scan activity on a labeled PR.
      markProcessedAt([pr.number], scannedAt)
    }
  }

  if (!args.dryRun) {
    if (totalRows > 0) {
      writeSummary(buildSummary(readDebtRecords()))
    }
    const labeledMsg = labelingEnabled
      ? `labeled ${labeled} PR(s)`
      : 'labels disabled'
    console.error(`debt collect: wrote ${totalRows} row(s), ${labeledMsg}`)

    // store: beads|both → also project into bd. Collection results are
    // already durable; a sync failure is reported as its own error, not
    // allowed to mask them — but it still fails the run (no silent degrade).
    // Explicit values only — a typo like "beed" must fall back to jsonl,
    // not fail in bd after the ledger was already written.
    const store = loadConfig().store
    if (store === 'beads' || store === 'both') {
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
  // silently when no repo resolves (not in a clone, gh unreachable).
  try {
    const repo = resolveRepo([])
    const [owner, repoName] = repo.split('/')
    const merged = fetchMergedPrCandidates({
      owner: owner!,
      repo: repoName!,
      prAuthor: null,
      label: null,
      limit: 100,
    })
    const { pending } = partitionByProcessed(merged)
    console.log(`\nunprocessed merged PRs: ${pending.length} (of last ${merged.length})`)
  } catch {
    // no repo context — ledger stats above still stand on their own
  }
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
  const repo = resolveRepo(positional)
  const [owner, repoName] = repo.split('/')
  ensureGhAuth()

  const prs = fetchMergedPrCandidates({
    owner: owner!,
    repo: repoName!,
    prAuthor: null,
    label: null,
    limit,
  })
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
  return true
}

function cmdList(argv: string[]): void {
  const filters: Record<string, string | number | null> = {
    status: 'open',
    area: null,
    author: null,
    priority: null,
    pr: null,
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
  const repo = resolveRepo(rest)
  ensureGhAuth()
  if (stateRaw === 'none') {
    clearDebtLabels({ repo, pr })
    console.error(`debt mark: cleared debt:* labels on #${pr}`)
    return
  }
  if (!(DEBT_STATES as readonly string[]).includes(stateRaw)) {
    console.error(`error: unknown state ${stateRaw}`)
    process.exit(2)
  }
  ensureDebtLabels(repo)
  applyDebtLabel({ repo, pr, state: stateRaw as DebtPrState })
  console.error(`debt mark: #${pr} → debt:${stateRaw}`)
}

// --- set -------------------------------------------------------------------

const DEBT_ROW_STATUSES = ['open', 'claimed', 'done', 'wontfix', 'duplicate'] as const
type DebtRowStatus = (typeof DEBT_ROW_STATUSES)[number]

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

  const records = readDebtRecords()
  const byId = new Map(records.map((r) => [r.thread_id, r]))
  const ids = [...new Set(threadIds)]
  const missing = ids.filter((id) => !byId.has(id))
  const terminal = status === 'done' || status === 'wontfix'
  const now = new Date().toISOString()

  upsertLedgerOverlays(
    ids
      .filter((id) => byId.has(id))
      .map((thread_id) => ({
        thread_id,
        status,
        fix_pr: terminal ? (fixPr ?? byId.get(thread_id)!.fix_pr) : null,
        fixed_at: terminal ? now : null,
        notes: notes ?? byId.get(thread_id)!.notes,
      }))
  )
  writeSummary(buildSummary(readDebtRecords()))
  console.error(`debt set: ${ids.length - missing.length} row(s) → ${status}`)
  if (missing.length > 0) {
    console.error(`warning: thread id(s) not in ledger: ${missing.join(', ')}`)
    process.exitCode = 1
  }
}

// --- sync ------------------------------------------------------------------

function cmdSync(argv: string[]): void {
  const dryRun = argv.includes('--dry-run')
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
  prs: cmdPrs,
  list: cmdList,
  mark: cmdMark,
  set: cmdSet,
  sync: cmdSync,
}

export async function runDebtCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage()
  }
  const handler = COMMANDS[cmd!]
  if (!handler) {
    console.error(`unknown command: ${cmd}`)
    usage()
  }
  await handler(rest)
}

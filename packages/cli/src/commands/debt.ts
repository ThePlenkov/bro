/**
 * `bro debt <sub>` — review-debt pipeline commands.
 *
 *   collect [OWNER REPO] [filters]   collect findings from unprocessed merged PRs
 *   status                           ledger summary + unprocessed merged-PR count
 *   prs [--limit N] [--all]          unprocessed merged PRs (--all: full matrix)
 *   list [filters]                   ledger rows
 *   mark PR collected|clean|skipped|none
 */
import { ensureGhAuth, resolveRepo } from '@bro/core'
import {
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
  resolveHarvestPrs,
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
  mark PR <state> [OWNER REPO]    Set debt label: ${[...DEBT_STATES, 'none'].join('|')}`)
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
  const targets = args.reharvest ? matched : pending

  console.error(
    `debt collect: ${matched.length} merged PR(s) matched, ` +
      `${processed.length} already processed (debt:* label), scanning ${targets.length}`
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
  for (const pr of targets) {
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
    }
    // Never overwrite a human `debt:skipped` opt-out, even under --reharvest.
    // Re-fetch labels: the candidate snapshot predates this PR's collection,
    // and a human may have opted out while we were scanning.
    if (labelingEnabled) {
      const current = fetchPrLabels({ owner: args.owner, repo: args.repoName, pr: pr.number })
      if (prDebtState(current) !== 'skipped') {
        applyDebtLabel({ repo: args.repo, pr: pr.number, state })
      }
    }
  }

  if (!args.dryRun) {
    if (totalRows > 0) {
      writeSummary(buildSummary(readDebtRecords()))
    }
    console.error(`debt collect: wrote ${totalRows} row(s), labeled ${targets.length} PR(s)`)
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

// --- entry -----------------------------------------------------------------

const COMMANDS: Record<string, (argv: string[]) => void | Promise<void>> = {
  collect: cmdCollect,
  status: cmdStatus,
  prs: cmdPrs,
  list: cmdList,
  mark: cmdMark,
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

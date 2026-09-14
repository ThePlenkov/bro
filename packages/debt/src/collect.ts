/**
 * Collect unresolved review threads from a merged PR into DebtRecords.
 */
import type {
  AuthorPolicy,
  DebtNeeds,
  DebtPriority,
  DebtRecord,
  ReviewThreadNode,
} from './types.ts'
import { fetchPrMeta, fetchReviewThreads } from './github.ts'
import { loadAuthorPolicy } from './store.ts'
import { bodyPreview, deriveArea, fingerprint } from './text.ts'

export function classifyThread(opts: { author: string; config: AuthorPolicy }): {
  priority: DebtPriority
  needs: DebtNeeds
  harvest: boolean
} {
  const login = opts.author.toLowerCase()
  if (opts.config.excluded_authors.some((a) => a.toLowerCase() === login)) {
    return { priority: 'noise', needs: 'skip', harvest: false }
  }
  const isBot = login.endsWith('[bot]')
  if (!isBot) {
    return { priority: 'human', needs: 'code_change', harvest: true }
  }
  if (opts.config.non_actionable_authors.some((a) => a.toLowerCase() === login)) {
    return { priority: 'nit', needs: 'code_change', harvest: true }
  }
  return { priority: 'nit', needs: 'code_change', harvest: true }
}

export interface CollectPrResult {
  pr: number
  incoming: DebtRecord[]
  skipped: number
  skippedOutdated: number
  skippedThreadAuthor: number
}

type SkipReason = 'outdated' | 'thread_author' | 'config'
type ThreadAction =
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'harvest'; author: string; classification: ReturnType<typeof classifyThread> }

function authorMatchesFilter(author: string, threadAuthor: string | null): boolean {
  const needle = threadAuthor?.toLowerCase()
  return !needle || author.toLowerCase().includes(needle)
}

function classifyThreadAction(opts: {
  thread: ReviewThreadNode
  threadAuthor: string | null
  config: AuthorPolicy
}): ThreadAction | null {
  if (opts.thread.isResolved || opts.thread.isOutdated) {
    return opts.thread.isOutdated ? { kind: 'skip', reason: 'outdated' } : null
  }
  const author = opts.thread.comments.nodes[0]?.author?.login ?? 'unknown'
  if (!authorMatchesFilter(author, opts.threadAuthor)) {
    return { kind: 'skip', reason: 'thread_author' }
  }
  const classification = classifyThread({ author, config: opts.config })
  if (!classification.harvest) {
    return { kind: 'skip', reason: 'config' }
  }
  return { kind: 'harvest', author, classification }
}

function toDebtRecord(opts: {
  thread: ReviewThreadNode
  meta: ReturnType<typeof fetchPrMeta>
  pr: number
  runId: string
  harvestedAt: string
  classification: ReturnType<typeof classifyThread>
}): DebtRecord {
  const comment = opts.thread.comments.nodes[0] ?? {}
  const author = comment.author?.login ?? 'unknown'
  const path = comment.path ?? ''
  const body = comment.body ?? ''

  return {
    thread_id: opts.thread.id,
    thread_url: `${opts.meta.url}#${opts.thread.id}`,
    status: 'open',
    priority: opts.classification.priority,
    needs: opts.classification.needs,
    source_pr: opts.pr,
    source_pr_url: opts.meta.url,
    source_pr_title: opts.meta.title,
    merged_at: opts.meta.mergedAt,
    merged_sha: opts.meta.mergeSha,
    path,
    line: comment.line ?? null,
    author,
    body,
    body_preview: bodyPreview(body),
    fingerprint: fingerprint({ body, path }),
    area: deriveArea(path),
    harvested_at: opts.harvestedAt,
    harvest_run_id: opts.runId,
    times_seen: 1,
    fix_pr: null,
    fixed_at: null,
    notes: null,
  }
}

export async function collectPr(opts: {
  owner: string
  repo: string
  pr: number
  mergedSha?: string
  runId: string
  threadAuthor?: string | null
  cwd?: string
}): Promise<CollectPrResult> {
  const config = loadAuthorPolicy(opts.cwd)
  const meta = fetchPrMeta({
    owner: opts.owner,
    repo: opts.repo,
    pr: opts.pr,
    mergedSha: opts.mergedSha,
  })
  const harvestedAt = new Date().toISOString()
  const threads = await fetchReviewThreads({
    owner: opts.owner,
    repo: opts.repo,
    pr: opts.pr,
  })

  const incoming: DebtRecord[] = []
  let skipped = 0
  let skippedOutdated = 0
  let skippedThreadAuthor = 0

  for (const thread of threads) {
    const action = classifyThreadAction({
      thread,
      threadAuthor: opts.threadAuthor ?? null,
      config,
    })
    if (!action) {
      continue
    }
    if (action.kind === 'skip') {
      if (action.reason === 'outdated') {
        skippedOutdated += 1
      } else if (action.reason === 'thread_author') {
        skippedThreadAuthor += 1
      } else {
        skipped += 1
      }
      continue
    }
    incoming.push(
      toDebtRecord({
        thread,
        meta,
        pr: opts.pr,
        runId: opts.runId,
        harvestedAt,
        classification: action.classification,
      })
    )
  }

  return { pr: opts.pr, incoming, skipped, skippedOutdated, skippedThreadAuthor }
}

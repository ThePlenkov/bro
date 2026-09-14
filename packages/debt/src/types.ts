/**
 * Domain types for the review-debt ledger. Ported from the harvest skill's
 * review-debt-lib — same JSONL schema so existing ledgers keep working.
 */

export type DebtStatus = 'open' | 'claimed' | 'done' | 'wontfix' | 'duplicate'
export type DebtPriority = 'blocking' | 'human' | 'nit' | 'scan' | 'noise'
export type DebtNeeds = 'code_change' | 'reply_only' | 'skip'

export interface DebtRecord {
  thread_id: string
  thread_url: string
  status: DebtStatus
  priority: DebtPriority
  needs: DebtNeeds
  source_pr: number
  source_pr_url: string
  source_pr_title: string
  merged_at: string
  merged_sha: string
  path: string
  line: number | null
  author: string
  body: string
  body_preview: string
  fingerprint: string
  area: string
  harvested_at: string
  harvest_run_id: string
  times_seen: number
  fix_pr: number | null
  fixed_at: string | null
  notes: string | null
}

export interface LedgerOverlay {
  thread_id: string
  status: DebtStatus
  fix_pr: number | null
  fixed_at: string | null
  notes: string | null
}

export interface AuthorPolicy {
  excluded_authors: string[]
  non_actionable_authors: string[]
}

export interface ReviewThreadComment {
  author: { login?: string }
  path?: string
  line?: number | null
  body?: string
}

export interface ReviewThreadNode {
  id: string
  isResolved: boolean
  isOutdated: boolean
  comments: { nodes: ReviewThreadComment[] }
}

export interface DebtSummary {
  generated_at: string
  open_count: number
  by_area: Record<string, number>
  by_author: Record<string, number>
  duplicate_fingerprints: Array<{
    fingerprint: string
    count: number
    prs: number[]
  }>
  oldest_open: string | null
}

export interface MergedPrCandidate {
  number: number
  mergedAt: string
  updatedAt: string | null
  author: string
  labels: string[]
}

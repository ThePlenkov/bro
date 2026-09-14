/**
 * GitHub data access for the debt pipeline: review threads (GraphQL) and
 * merged-PR candidate resolution (gh pr list/view + filters).
 */
import { gh, ghJson } from '@bro/core'
import type { MergedPrCandidate, ReviewThreadNode } from './types.ts'

export interface HarvestPrFilters {
  prIds: number[]
  mergedSince: string | null
  mergedUntil: string | null
  lastN: number | null
  prAuthor: string | null
  labels: string[]
}

// --- review threads ---------------------------------------------------------

interface ThreadPage {
  nodes: ReviewThreadNode[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

function reviewThreadsQuery(afterClause: string): string {
  return `
    query($o: String!, $r: String!, $pr: Int!, $n: Int!) {
      repository(owner: $o, name: $r) {
        pullRequest(number: $pr) {
          reviewThreads(first: $n${afterClause}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              comments(first: 1) {
                nodes { author { login } path line body }
              }
            }
          }
        }
      }
    }`
}

function parseThreadPage(raw: string, pr: number): ThreadPage {
  const parsed = JSON.parse(raw) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: ThreadPage } } }
    errors?: unknown
  }
  if (parsed.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`)
  }
  const threads = parsed.data?.repository?.pullRequest?.reviewThreads
  if (!threads) {
    throw new Error(`pull request #${pr} not found`)
  }
  return threads
}

export async function fetchReviewThreads(target: {
  owner: string
  repo: string
  pr: number
}): Promise<ReviewThreadNode[]> {
  const nodes: ReviewThreadNode[] = []
  let cursor = ''
  for (;;) {
    const afterClause = cursor ? `, after: "${cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
    const raw = gh([
      'api',
      'graphql',
      '-f',
      `query=${reviewThreadsQuery(afterClause)}`,
      '-f',
      `o=${target.owner}`,
      '-f',
      `r=${target.repo}`,
      '-F',
      `pr=${target.pr}`,
      '-F',
      'n=100',
    ])
    const page = parseThreadPage(raw, target.pr)
    nodes.push(...page.nodes)
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      break
    }
    cursor = page.pageInfo.endCursor
  }
  return nodes
}

export function fetchPrMeta(opts: {
  owner: string
  repo: string
  pr: number
  mergedSha?: string
}): { title: string; url: string; mergedAt: string; mergeSha: string } {
  const viewed = ghJson<{
    title: string
    url: string
    mergedAt: string | null
    mergeCommit?: { oid: string }
    state: string
  }>([
    'pr',
    'view',
    String(opts.pr),
    '--repo',
    `${opts.owner}/${opts.repo}`,
    '--json',
    'title,url,mergedAt,mergeCommit,state',
  ])

  if (viewed.state !== 'MERGED') {
    throw new Error(`PR #${opts.pr} is not merged (state=${viewed.state})`)
  }
  return {
    title: viewed.title,
    url: viewed.url,
    mergedAt: viewed.mergedAt ?? new Date().toISOString(),
    mergeSha: opts.mergedSha || viewed.mergeCommit?.oid || '',
  }
}

// --- merged PR candidates ---------------------------------------------------

function parseCsvParts(value: string | null | undefined): string[] {
  if (!value?.trim()) {
    return []
  }
  return value.split(',').map((part) => part.trim())
}

function parseCsvMapped<T>(
  value: string | null | undefined,
  mapPart: (part: string) => T | null
): T[] {
  const out: T[] = []
  const seen = new Set<T>()
  for (const part of parseCsvParts(value)) {
    const mapped = mapPart(part)
    if (mapped === null || seen.has(mapped)) {
      continue
    }
    seen.add(mapped)
    out.push(mapped)
  }
  return out
}

export function parseCsvInts(value: string | null | undefined): number[] {
  return parseCsvMapped(value, (part) => {
    const n = Number(part)
    return Number.isFinite(n) && n > 0 ? n : null
  })
}

export function parseCsvStrings(value: string | null | undefined): string[] {
  return parseCsvMapped(value, (part) => (part.length > 0 ? part : null))
}

export function filterByMergedDate(
  prs: MergedPrCandidate[],
  since: string | null,
  until: string | null
): MergedPrCandidate[] {
  const sinceMs = since ? new Date(`${since}T00:00:00.000Z`).getTime() : null
  const untilMs = until ? new Date(`${until}T23:59:59.999Z`).getTime() : null
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid --merged-since date: ${since}`)
  }
  if (untilMs !== null && Number.isNaN(untilMs)) {
    throw new Error(`Invalid --merged-until date: ${until}`)
  }
  return prs.filter((pr) => {
    const mergedMs = new Date(pr.mergedAt).getTime()
    return (sinceMs === null || mergedMs >= sinceMs) && (untilMs === null || mergedMs <= untilMs)
  })
}

export function filterByLabels(
  prs: MergedPrCandidate[],
  required: string[]
): MergedPrCandidate[] {
  if (required.length === 0) {
    return prs
  }
  const wanted = required.map((l) => l.toLowerCase())
  return prs.filter((pr) => {
    const have = new Set(pr.labels.map((l) => l.toLowerCase()))
    return wanted.every((label) => have.has(label))
  })
}

export function applyLastN(
  prs: MergedPrCandidate[],
  lastN: number | null
): MergedPrCandidate[] {
  const sorted = [...prs].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
  if (lastN === null || !Number.isFinite(lastN) || lastN <= 0) {
    return sorted
  }
  return sorted.slice(0, lastN)
}

export function fetchMergedPrCandidates(opts: {
  owner: string
  repo: string
  prAuthor: string | null
  label: string | null
  limit: number
}): MergedPrCandidate[] {
  const args = [
    'pr',
    'list',
    '--repo',
    `${opts.owner}/${opts.repo}`,
    '--state',
    'merged',
    '--limit',
    String(opts.limit),
    '--json',
    'number,mergedAt,author,labels',
  ]
  if (opts.prAuthor) {
    args.push('--author', opts.prAuthor)
  }
  if (opts.label) {
    args.push('--label', opts.label)
  }

  const raw = ghJson<
    Array<{
      number: number
      mergedAt: string | null
      author?: { login?: string }
      labels?: Array<{ name: string }>
    }>
  >(args)

  return raw
    .filter((row) => row.mergedAt)
    .map((row) => ({
      number: row.number,
      mergedAt: row.mergedAt!,
      author: row.author?.login ?? 'unknown',
      labels: (row.labels ?? []).map((l) => l.name),
    }))
}

function fetchExplicitMergedPrs(opts: {
  owner: string
  repo: string
  prIds: number[]
}): MergedPrCandidate[] {
  const out: MergedPrCandidate[] = []
  for (const number of opts.prIds) {
    try {
      const viewed = ghJson<{
        number: number
        mergedAt: string | null
        state: string
        author?: { login?: string }
        labels?: Array<{ name: string }>
      }>([
        'pr',
        'view',
        String(number),
        '--repo',
        `${opts.owner}/${opts.repo}`,
        '--json',
        'number,mergedAt,author,labels,state',
      ])
      if (viewed.state !== 'MERGED' || !viewed.mergedAt) {
        console.error(`warning: PR #${number} is not merged — skipped`)
        continue
      }
      out.push({
        number: viewed.number,
        mergedAt: viewed.mergedAt,
        author: viewed.author?.login ?? 'unknown',
        labels: (viewed.labels ?? []).map((l) => l.name),
      })
    } catch {
      console.error(`warning: PR #${number} fetch failed — skipped`)
    }
  }
  return out
}

export function resolveHarvestPrs(opts: {
  owner: string
  repo: string
  filters: HarvestPrFilters
  listLimit?: number
}): MergedPrCandidate[] {
  const limit = opts.listLimit ?? 100

  let candidates: MergedPrCandidate[]
  if (opts.filters.prIds.length > 0) {
    candidates = fetchExplicitMergedPrs({
      owner: opts.owner,
      repo: opts.repo,
      prIds: opts.filters.prIds,
    })
  } else {
    candidates = fetchMergedPrCandidates({
      owner: opts.owner,
      repo: opts.repo,
      prAuthor: opts.filters.prAuthor,
      label: opts.filters.labels[0] ?? null,
      limit,
    })
    candidates = filterByLabels(candidates, opts.filters.labels)
  }

  candidates = filterByMergedDate(candidates, opts.filters.mergedSince, opts.filters.mergedUntil)
  return applyLastN(candidates, opts.filters.lastN)
}

export function hasHarvestSelection(filters: HarvestPrFilters): boolean {
  return (
    filters.prIds.length > 0 ||
    filters.mergedSince !== null ||
    filters.mergedUntil !== null ||
    (filters.lastN !== null && filters.lastN > 0) ||
    filters.prAuthor !== null ||
    filters.labels.length > 0
  )
}

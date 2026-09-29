/**
 * Harvest selection — merged-PR filters and candidate resolution. Pure
 * domain logic over ReviewFacade.mergedPrs; no host calls live here.
 */
import type { MergedPr, ReviewFacade } from '@broject/core'

export interface HarvestPrFilters {
  prIds: number[]
  mergedSince: string | null
  mergedUntil: string | null
  lastN: number | null
  prAuthor: string | null
  labels: string[]
}

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
  prs: MergedPr[],
  since: string | null,
  until: string | null
): MergedPr[] {
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

export function filterByLabels(prs: MergedPr[], required: string[]): MergedPr[] {
  if (required.length === 0) {
    return prs
  }
  const wanted = required.map((l) => l.toLowerCase())
  return prs.filter((pr) => {
    const have = new Set(pr.labels.map((l) => l.toLowerCase()))
    return wanted.every((label) => have.has(label))
  })
}

export function applyLastN(prs: MergedPr[], lastN: number | null): MergedPr[] {
  const sorted = [...prs].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
  if (lastN === null || !Number.isFinite(lastN) || lastN <= 0) {
    return sorted
  }
  return sorted.slice(0, lastN)
}

/** Merged-PR candidates for harvest — the connector answers the host
 *  query (explicit ids win over list filters); date/label/lastN shaping
 *  stays here, domain-side. */
export function resolveHarvestPrs(
  rev: ReviewFacade,
  opts: {
    repo: string
    filters: HarvestPrFilters
    listLimit?: number
  }
): MergedPr[] {
  const limit = opts.listLimit ?? 100

  let candidates: MergedPr[]
  if (opts.filters.prIds.length > 0) {
    candidates = rev.mergedPrs(opts.repo, { ids: opts.filters.prIds })
  } else {
    candidates = rev.mergedPrs(opts.repo, {
      author: opts.filters.prAuthor ?? undefined,
      label: opts.filters.labels[0],
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

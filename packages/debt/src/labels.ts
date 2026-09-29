/**
 * `debt:*` PR labels — the PR-level "was this merged PR processed?" marker.
 * Row-level dedup lives in store.ts (`thread_id` upsert); labels answer the
 * coarser question without rescanning. Host calls go through the injected
 * ReviewFacade.
 */
import type { ReviewFacade } from '@broject/core'

export const DEBT_STATES = ['collected', 'clean', 'skipped'] as const
export type DebtPrState = (typeof DEBT_STATES)[number]

export function debtLabel(state: DebtPrState): string {
  return `debt:${state}`
}

/**
 * Human opt-out (`skipped`) wins over machine states — a PR a human marked
 * stays skipped even if a stray `collected`/`clean` label is present.
 */
export function prDebtState(labels: string[]): DebtPrState | null {
  const have = new Set(labels.map((l) => l.toLowerCase()))
  for (const state of ['skipped', 'collected', 'clean'] as const) {
    if (have.has(debtLabel(state))) {
      return state
    }
  }
  return null
}

export function partitionByProcessed<T extends { labels: string[] }>(
  prs: T[]
): { pending: T[]; processed: T[] } {
  const pending: T[] = []
  const processed: T[] = []
  for (const pr of prs) {
    if (prDebtState(pr.labels) === null) {
      pending.push(pr)
    } else {
      processed.push(pr)
    }
  }
  return { pending, processed }
}

const LABEL_COLORS: Record<DebtPrState, string> = {
  collected: 'B60205',
  clean: '0E8A16',
  skipped: '8250DF',
}

/** Idempotent — createLabel upserts in place when the label exists. */
export function ensureDebtLabels(rev: ReviewFacade, repo: string): void {
  for (const state of DEBT_STATES) {
    rev.createLabel(repo, debtLabel(state), LABEL_COLORS[state])
  }
}

/**
 * Sets `debt:<state>` on the PR. Adds the target first, then removes the
 * others — hosts have no atomic multi-label write, and on a mid-removal
 * failure the precedence rule (`skipped` > machine states) keeps the
 * safer state.
 */
export function applyDebtLabel(
  rev: ReviewFacade,
  opts: { repo: string; pr: number; state: DebtPrState }
): void {
  const target = debtLabel(opts.state)
  rev.addLabel({ repo: opts.repo, pr: opts.pr }, target)
  for (const state of DEBT_STATES) {
    const label = debtLabel(state)
    if (label !== target) {
      rev.removeLabel({ repo: opts.repo, pr: opts.pr }, label)
    }
  }
}

/**
 * Collect-time variant of applyDebtLabel: sets the machine state but never
 * removes `debt:skipped`. The skipped check and this write are not atomic —
 * a human can opt out after the re-fetch, and this keeps that late opt-out
 * intact (precedence resolves it as `skipped` either way).
 */
export function applyCollectLabel(
  rev: ReviewFacade,
  opts: { repo: string; pr: number; state: DebtPrState }
): void {
  const target = debtLabel(opts.state)
  rev.addLabel({ repo: opts.repo, pr: opts.pr }, target)
  for (const state of DEBT_STATES) {
    if (state === 'skipped') {
      continue
    }
    const label = debtLabel(state)
    if (label !== target) {
      rev.removeLabel({ repo: opts.repo, pr: opts.pr }, label)
    }
  }
}

export function clearDebtLabels(
  rev: ReviewFacade,
  opts: { repo: string; pr: number }
): void {
  for (const state of DEBT_STATES) {
    rev.removeLabel({ repo: opts.repo, pr: opts.pr }, debtLabel(state))
  }
}

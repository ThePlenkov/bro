/**
 * `debt:*` PR labels — the PR-level "was this merged PR processed?" marker.
 * Row-level dedup lives in store.ts (`thread_id` upsert); labels answer the
 * coarser question without rescanning.
 */
import { gh } from '@bro/core'

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

/** Idempotent — `gh label create --force` updates in place when the label exists. */
export function ensureDebtLabels(repo: string): void {
  for (const state of DEBT_STATES) {
    gh(['label', 'create', debtLabel(state), '--repo', repo, '--color', LABEL_COLORS[state], '--force'])
  }
}

/** Sets `debt:<state>` on the PR, removing the other debt states first. */
export function applyDebtLabel(opts: { repo: string; pr: number; state: DebtPrState }): void {
  const target = debtLabel(opts.state)
  for (const state of DEBT_STATES) {
    const label = debtLabel(state)
    if (label === target) {
      continue
    }
    try {
      gh(['pr', 'edit', String(opts.pr), '--repo', opts.repo, '--remove-label', label])
    } catch {
      // label absent on this PR — fine
    }
  }
  gh(['pr', 'edit', String(opts.pr), '--repo', opts.repo, '--add-label', target])
}

export function clearDebtLabels(opts: { repo: string; pr: number }): void {
  for (const state of DEBT_STATES) {
    try {
      gh(['pr', 'edit', String(opts.pr), '--repo', opts.repo, '--remove-label', debtLabel(state)])
    } catch {
      // label absent — fine
    }
  }
}

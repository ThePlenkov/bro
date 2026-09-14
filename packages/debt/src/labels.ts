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

/** Suppress only confirmed absent-label errors; real gh failures propagate. */
function tryRemoveLabel(repo: string, pr: number, label: string): void {
  try {
    gh(['pr', 'edit', String(pr), '--repo', repo, '--remove-label', label])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Must name THIS label — "repository not found" must not be swallowed.
    if (msg.includes(label) && /not found|does not exist|no such label/i.test(msg)) {
      return
    }
    throw err
  }
}

/**
 * Sets `debt:<state>` on the PR. Adds the target first, then removes the
 * others — gh has no atomic multi-label write, and on a mid-removal failure
 * the precedence rule (`skipped` > machine states) keeps the safer state.
 */
export function applyDebtLabel(opts: { repo: string; pr: number; state: DebtPrState }): void {
  const target = debtLabel(opts.state)
  gh(['pr', 'edit', String(opts.pr), '--repo', opts.repo, '--add-label', target])
  for (const state of DEBT_STATES) {
    const label = debtLabel(state)
    if (label !== target) {
      tryRemoveLabel(opts.repo, opts.pr, label)
    }
  }
}

/**
 * Collect-time variant of applyDebtLabel: sets the machine state but never
 * removes `debt:skipped`. The skipped check and this write are not atomic —
 * a human can opt out after the re-fetch, and this keeps that late opt-out
 * intact (precedence resolves it as `skipped` either way).
 */
export function applyCollectLabel(opts: { repo: string; pr: number; state: DebtPrState }): void {
  const target = debtLabel(opts.state)
  gh(['pr', 'edit', String(opts.pr), '--repo', opts.repo, '--add-label', target])
  for (const state of DEBT_STATES) {
    if (state === 'skipped') {
      continue
    }
    const label = debtLabel(state)
    if (label !== target) {
      tryRemoveLabel(opts.repo, opts.pr, label)
    }
  }
}

export function clearDebtLabels(opts: { repo: string; pr: number }): void {
  for (const state of DEBT_STATES) {
    tryRemoveLabel(opts.repo, opts.pr, debtLabel(state))
  }
}

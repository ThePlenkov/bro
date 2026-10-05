/**
 * Open-PR state for the act loop — threads + checks + mergeability
 * aggregated into the PrActState the exit gate reads. Domain rules only;
 * every host call goes through the injected ReviewFacade.
 */
import {
  DEFAULT_CONFIG,
  DEFAULT_IGNORE_CONSECUTIVE_FAILURES,
  DEFAULT_IGNORE_THREAD_WINDOW_DAYS,
} from '@broject/core'
import type {
  CheckInfo,
  IgnoreCheckEntry,
  IgnoreCheckRule,
  PrTarget,
  ReviewFacade,
  ReviewThread,
} from '@broject/core'
import type { CheckHistory } from './check-history.ts'
import { docsOnlyPr, effectiveMaxRounds } from './docs.ts'
import type { PrActState } from './types.ts'

// Word boundaries: a check merely *containing* "kilo"/"gemini" (e.g.
// "kilometer-tests") is not an AI reviewer.
const AI_REVIEWER_RE = /\b(cubic|code\s*rabbit|amazon\s*q|qodo|chatgpt\s*codex|gemini|kilo|codeant)\b/i

const SAST_NAMES = [
  'sonarcloud',
  'sonarqube',
  'codacy',
  'codescene',
  'codeql',
  'semgrep',
  'opengrep',
  'trivy',
  'snyk',
  'skillspector',
  'gitguardian',
  'checkov',
  'kics',
  'tfsec',
  'gitleaks',
]

function isSast(name: string): boolean {
  const lower = name.toLowerCase()
  return SAST_NAMES.some((s) => lower.includes(s))
}

/** Failure-level SAST annotations → gate counts. A `null` annotation
 *  value means the run's annotations could not be fetched — unknown,
 *  and only counted for required checks (an optional SAST must not hold
 *  the gate; with no required checks configured at all, a flaky
 *  annotations endpoint stays infra noise). */
async function sastCounts(
  rev: ReviewFacade,
  target: PrTarget,
  checks: CheckInfo[],
  requiredNames: Set<string>,
  headSha: string
): Promise<{ pending: number; unknown: number }> {
  const out = { pending: 0, unknown: 0 }
  const sastChecks = checks.filter(
    (c) => isSast(c.name) && c.state !== 'SKIPPED' && c.state !== 'NEUTRAL'
  )
  if (sastChecks.length === 0) {
    return out
  }
  const annotations =
    rev.checkAnnotationsAsync === undefined
      ? rev.checkAnnotations(target.repo, headSha)
      : await rev.checkAnnotationsAsync(target.repo, headSha)
  for (const check of sastChecks) {
    if (!annotations.has(check.name)) {
      continue
    }
    const count = annotations.get(check.name)!
    if (count === null) {
      if (requiredNames.has(check.name)) {
        out.unknown += 1
      }
    } else {
      out.pending += count
    }
  }
  return out
}

/** Ignore entries reach here already normalized by the config schema —
 *  this second pass keeps direct callers (tests, embedders) on the same
 *  contract: a bare string is a rule with default thresholds. */
function ignoreRules(entries: IgnoreCheckEntry[]): IgnoreCheckRule[] {
  const rules: IgnoreCheckRule[] = []
  for (const e of entries) {
    const rule: IgnoreCheckRule =
      typeof e === 'string'
        ? {
            name: e,
            consecutiveFailures: DEFAULT_IGNORE_CONSECUTIVE_FAILURES,
            threadWindowDays: DEFAULT_IGNORE_THREAD_WINDOW_DAYS,
          }
        : e
    // an empty substring would match EVERY check name
    if (rule.name.trim() !== '') {
      rules.push(rule)
    }
  }
  return rules
}

/** Does this PR carry fresh thread output BY the ignored check's bot —
 *  the evidence that a failing reviewer is flaky-but-alive rather than
 *  down? Attribution is a name-stem match on the comment author
 *  (`kilo` covers `kilo-code[bot]`); human threads must not certify a
 *  silent reviewer. */
function hasFreshThreadActivity(
  threads: ReviewThread[],
  ruleName: string,
  windowDays: number
): boolean {
  const stem = ruleName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (stem === '') {
    return false
  }
  const cutoff = Date.now() - windowDays * 86_400_000
  return threads.some((t) => {
    const c = t.comment
    if (c === null) {
      return false
    }
    const author = c.author.toLowerCase().replace(/[^a-z0-9]/g, '')
    const ts = Date.parse(c.createdAt)
    return author.includes(stem) && Number.isFinite(ts) && ts >= cutoff
  })
}

/** Advisory checks (act.ignoreChecks) never gate — but a *failing* one
 *  earns the quiet ignore only with proof of life: `consecutiveFailures`
 *  failing head shas in a row AND fresh thread activity. Without it the
 *  check is still excluded from the gate and recorded as an alert — a
 *  downed reviewer must not read as a pass. The observation is recorded
 *  before the verdict so the current failure counts toward the streak. */
function advisoryFilter(
  c: CheckInfo,
  rules: IgnoreCheckRule[],
  history: CheckHistory | null,
  threads: ReviewThread[],
  target: PrTarget,
  headSha: string,
  alerts: string[]
): boolean {
  const rule = rules.find((r) => c.name.toLowerCase().includes(r.name.toLowerCase()))
  if (rule === undefined) {
    return true
  }
  history?.record({
    repo: target.repo,
    pr: target.pr,
    sha: headSha,
    name: c.name,
    bucket: c.bucket,
  })
  // only 'fail' is judged — pending/pass/cancel stay quietly ignored;
  // shielding a stuck pending state is the option's original purpose
  if (c.bucket !== 'fail') {
    return false
  }
  const streak = history?.consecutiveFailures(c.name) ?? 0
  const alive = hasFreshThreadActivity(threads, rule.name, rule.threadWindowDays)
  if (streak >= rule.consecutiveFailures && alive) {
    return false // proven flaky and still producing findings — quiet ignore
  }
  alerts.push(
    alive
      ? `advisory check "${c.name}" failing (${streak}/${rule.consecutiveFailures} consecutive) — not yet proven flaky`
      : `advisory check "${c.name}" failing with no thread activity in ${rule.threadWindowDays}d — the reviewer may be down`
  )
  return false
}

/** Resolve an async facade method, falling back to its sync twin when
 *  the host doesn't implement one — the sweep must not stall on a
 *  backend that only knows the spawnSync surface. */
const orSync = <T, A extends unknown[]>(
  asyncFn: ((...a: A) => Promise<T>) | undefined,
  syncFn: (...a: A) => T,
  ...args: A
): Promise<T> => (asyncFn === undefined ? Promise.resolve(syncFn(...args)) : asyncFn(...args))

/** Full open-PR state for the act loop — threads + checks + mergeability. */
export async function fetchPrActState(
  rev: ReviewFacade,
  target: PrTarget,
  opts?: {
    ignoreChecks?: IgnoreCheckEntry[]
    checkHistory?: CheckHistory | null
    maxRounds?: number
    docsPaths?: string[]
    docsMaxRounds?: number
  }
): Promise<PrActState> {
  // The reads are independent — overlap them. Inside a hook sweep each
  // sync variant would serialize AND block the probe-timeout timers.
  const checksP = (requiredOnly: boolean): Promise<CheckInfo[]> =>
    rev.checksAsync === undefined
      ? Promise.resolve(rev.checks(target, requiredOnly))
      : rev.checksAsync(target, requiredOnly)
  const [meta, threads, checksAll, required, shas] = await Promise.all([
    orSync(rev.prMetaAsync?.bind(rev), (t: PrTarget) => rev.prMeta(t), target),
    rev.reviewThreads(target),
    checksP(false),
    checksP(true),
    (rev.reviewedShasAsync === undefined
      ? Promise.resolve(rev.reviewedShas(target))
      : rev.reviewedShasAsync(target)
    ).catch((): string[] => []),
  ])
  const rules = ignoreRules(opts?.ignoreChecks ?? [])
  const alerts: string[] = []
  const history = opts?.checkHistory ?? null
  const checks = checksAll.filter((c) =>
    advisoryFilter(c, rules, history, threads, target, meta.headSha, alerts)
  )

  // "CI green" means every check — an optional check that fails is still
  // a red job on the PR. Required names are only kept to decide whether a
  // SAST annotation fetch failure counts as unknown below.
  const requiredNames = new Set(required.map((c) => c.name))
  // Pending and failing split here: pending is worth
  // waiting out (act wait), failing is a settled verdict to act on.
  const ciChecks = checks.filter(
    (c) =>
      c.bucket !== 'pass' &&
      c.state !== 'SKIPPED' &&
      c.state !== 'NEUTRAL' &&
      !AI_REVIEWER_RE.test(c.name)
  )
  const ciPending = ciChecks.filter((c) => c.bucket === 'pending').length
  const ciFailing = ciChecks.filter((c) => c.bucket === 'fail').length

  // A pending AI reviewer can still open threads — declaring the gate OK
  // while one is running invites exactly the "threads after OK" surprise.
  // A *failed* reviewer check is infra noise (crash/quota/outage) — real
  // findings arrive as threads regardless, so the count is reported for
  // visibility but the gate does not block on it.
  const reviewersPending = checks.filter(
    (c) => AI_REVIEWER_RE.test(c.name) && c.bucket === 'pending'
  ).length
  const reviewersFailing = checks.filter(
    (c) => AI_REVIEWER_RE.test(c.name) && c.bucket === 'fail'
  ).length

  // A SAST scan can report "success" while still carrying failure-level
  // annotations — inspect every non-skipped SAST check, not just pending.
  const sast = await sastCounts(rev, target, checks, requiredNames, meta.headSha)
  const sastPending = sast.pending
  const sastUnknown = sast.unknown

  // A "fix round" is a reviewed push after the first — counting distinct
  // reviewed head SHAs, not commits: one push can carry many commits, and
  // committer dates are commit-time, not push-time. The first reviewed
  // head is the baseline (the PR as submitted); every head reviewed after
  // it is one round of the fix loop. Reviews exist without threads
  // (approvals), so this isn't gated on threads. `shas` already carries
  // the reviews fetch — a flaky endpoint degraded to [] above.
  const fixRounds = Math.max(0, shas.length - 1)

  // A docs-only PR churns reviewer threads on every push — the tighter
  // docsMaxRounds cap moves the tail to debt sooner. The file list is
  // only probed while threads are open: that's the cap's sole consumer,
  // and it keeps a per-poll host call off a quiet PR.
  const isDocsOnly =
    threads.some((t) => !t.resolved) && (await docsOnlyPr(rev, target, opts))
  const maxRounds = effectiveMaxRounds(
    opts?.maxRounds ?? 0,
    isDocsOnly,
    opts?.docsMaxRounds ?? DEFAULT_CONFIG.act.docsMaxRounds
  )

  return {
    pr: target.pr,
    url: meta.url,
    headSha: meta.headSha,
    headRef: meta.headRef,
    state: meta.state,
    isDraft: meta.isDraft,
    mergeable: meta.mergeable,
    mergeState: meta.mergeState,
    openThreads: threads.filter((t) => !t.resolved).length,
    threads,
    ciPending,
    ciFailing,
    reviewersPending,
    reviewersFailing,
    sastPending,
    sastUnknown,
    fixRounds,
    maxRounds,
    docsOnly: isDocsOnly,
    alerts,
  }
}

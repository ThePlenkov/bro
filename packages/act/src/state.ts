/**
 * Open-PR state for the act loop — threads + checks + mergeability
 * aggregated into the PrActState the exit gate reads. Domain rules only;
 * every host call goes through the injected ReviewFacade.
 */
import { DEFAULT_CONFIG } from '@broject/core'
import type { PrTarget, ReviewFacade } from '@broject/core'
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

/** Full open-PR state for the act loop — threads + checks + mergeability. */
export async function fetchPrActState(
  rev: ReviewFacade,
  target: PrTarget,
  opts?: {
    ignoreChecks?: string[]
    maxRounds?: number
    docsPaths?: string[]
    docsMaxRounds?: number
  }
): Promise<PrActState> {
  const meta = rev.prMeta(target)
  const threads = await rev.reviewThreads(target)
  // Advisory checks (act.ignoreChecks) drop out of the gate entirely —
  // a flaky external reviewer must not hold merges hostage
  const ignored = (opts?.ignoreChecks ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
  const checks = rev
    .checks(target, false)
    .filter((c) => !ignored.some((i) => c.name.toLowerCase().includes(i)))

  // "CI green" means every check — an optional check that fails is still
  // a red job on the PR. Required names are only kept to decide whether a
  // SAST annotation fetch failure counts as unknown below.
  const required = rev.checks(target, true)
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
  const sastChecks = checks.filter(
    (c) => isSast(c.name) && c.state !== 'SKIPPED' && c.state !== 'NEUTRAL'
  )
  let sastPending = 0
  let sastUnknown = 0
  if (sastChecks.length > 0) {
    // null = the run exists but its annotations could not be fetched.
    // Absent key = a commit-status check with no annotations endpoint —
    // nothing is unknown about it. A fetch failure only counts as
    // unknown for required checks: an optional SAST must not hold the
    // gate — and with no required checks configured at all, nothing is
    // marked required, so a flaky annotations endpoint stays infra noise.
    const annotations = rev.checkAnnotations(target.repo, meta.headSha)
    for (const check of sastChecks) {
      const gates = requiredNames.has(check.name)
      if (!annotations.has(check.name)) {
        continue
      }
      const count = annotations.get(check.name)!
      if (count === null) {
        if (gates) {
          sastUnknown += 1
        }
      } else {
        sastPending += count
      }
    }
  }

  // A "fix round" is a reviewed push after the first — counting distinct
  // reviewed head SHAs, not commits: one push can carry many commits, and
  // committer dates are commit-time, not push-time. The first reviewed
  // head is the baseline (the PR as submitted); every head reviewed after
  // it is one round of the fix loop. Reviews exist without threads
  // (approvals), so this isn't gated on threads.
  let fixRounds = 0
  try {
    fixRounds = Math.max(0, rev.reviewedShas(target).length - 1)
  } catch {
    // best-effort — a flaky reviews endpoint must not break the gate
  }

  // A docs-only PR churns reviewer threads on every push — the tighter
  // docsMaxRounds cap moves the tail to debt sooner. The file list is
  // only probed while threads are open: that's the cap's sole consumer,
  // and it keeps a per-poll host call off a quiet PR.
  const isDocsOnly =
    threads.some((t) => !t.resolved) && docsOnlyPr(rev, target, opts)
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
  }
}

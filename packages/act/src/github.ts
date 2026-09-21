/**
 * GitHub access for the act loop: open-PR state (threads + checks + mergeable),
 * thread resolve/reply mutations. Ported from act's pr-state.ts /
 * review-resolve.ts / review-reply.ts — same semantics, node-native.
 */
import { ghJson, ghTry } from '@bro/core'
import { fetchReviewThreads } from '@bro/debt'
import type { PrActState, PrCheck } from './types.ts'

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

interface PrMeta {
  headRefOid: string
  headRefName: string
  mergeable: string
  mergeStateStatus: string
  state: string
  url: string
  isDraft: boolean
}

export function fetchPrMeta(target: { owner: string; repo: string; pr: number }): PrMeta {
  const pr = ghJson<{
    data?: { repository?: { pullRequest?: PrMeta } }
    errors?: unknown
  }>([
    'api',
    'graphql',
    '-f',
    `query=query($o:String!,$r:String!,$pr:Int!){repository(owner:$o,name:$r){pullRequest(number:$pr){headRefOid headRefName mergeable mergeStateStatus state url isDraft}}}`,
    '-f',
    `o=${target.owner}`,
    '-f',
    `r=${target.repo}`,
    '-F',
    `pr=${target.pr}`,
  ]).data?.repository?.pullRequest
  if (!pr) {
    throw new Error(`pull request #${target.pr} not found`)
  }
  return pr
}

function fetchChecks(
  target: { owner: string; repo: string; pr: number },
  required: boolean
): PrCheck[] {
  const args = [
    'pr',
    'checks',
    String(target.pr),
    '--repo',
    `${target.owner}/${target.repo}`,
    '--json',
    'name,state,bucket',
  ]
  if (required) {
    args.push('--required')
  }
  // `gh pr checks` exits 1 when any check is pending/failing — the JSON is
  // still on stdout, so a throwing call would lose exactly the data we need.
  const res = ghTry(args)
  if (res.out.trim().startsWith('[')) {
    return JSON.parse(res.out) as PrCheck[]
  }
  if (res.code !== 0 && /no (checks|required checks)/i.test(res.err)) {
    return []
  }
  if (res.code !== 0) {
    throw new Error(`gh pr checks failed: ${res.err}`)
  }
  return []
}

function checkRunIds(owner: string, repo: string, headSha: string): Map<string, number> {
  const ids = new Map<string, number>()
  for (let page = 1; ; page += 1) {
    const res = ghJson<{ check_runs: Array<{ id: number; name: string }> }>([
      'api',
      `repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    ])
    for (const run of res.check_runs ?? []) {
      ids.set(run.name, run.id)
    }
    if ((res.check_runs?.length ?? 0) < 100) {
      break
    }
  }
  return ids
}

function failureAnnotations(owner: string, repo: string, runId: number): number {
  // --paginate emits one JSON array per page — --slurp folds them into a
  // single array-of-arrays that JSON.parse can handle.
  const pages = ghJson<Array<Array<{ annotation_level?: string }>>>([
    'api',
    '--paginate',
    '--slurp',
    `repos/${owner}/${repo}/check-runs/${runId}/annotations?per_page=100`,
  ])
  return pages.flat().filter((a) => a.annotation_level === 'failure').length
}

/** Submitted reviews on the PR — each carries the head SHA it reviewed.
 *  Distinct reviewed SHAs ≈ pushes that entered the review loop. */
function fetchPrReviews(target: {
  owner: string
  repo: string
  pr: number
}): string[] {
  const shas = new Set<string>()
  for (let page = 1; ; page += 1) {
    const reviews = ghJson<Array<{ commit_id?: string }>>([
      'api',
      `repos/${target.owner}/${target.repo}/pulls/${target.pr}/reviews?per_page=100&page=${page}`,
    ])
    for (const r of reviews ?? []) {
      if (r.commit_id) {
        shas.add(r.commit_id)
      }
    }
    if ((reviews?.length ?? 0) < 100) {
      break
    }
  }
  return [...shas]
}

/** Full open-PR state for the act loop — threads + checks + mergeability. */
export async function fetchPrActState(
  target: {
    owner: string
    repo: string
    pr: number
  },
  opts?: { ignoreChecks?: string[]; maxRounds?: number }
): Promise<PrActState> {
  const meta = fetchPrMeta(target)
  const threads = await fetchReviewThreads(target)
  // Advisory checks (act.ignoreChecks) drop out of the gate entirely —
  // a flaky external reviewer must not hold merges hostage
  const ignored = (opts?.ignoreChecks ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
  const checks = fetchChecks(target, false).filter(
    (c) => !ignored.some((i) => c.name.toLowerCase().includes(i))
  )

  // "CI green" means every check — an optional check that fails is still
  // a red job on the PR. Required names are only kept to decide whether a
  // SAST annotation fetch failure counts as unknown below.
  const required = fetchChecks(target, true)
  const requiredNames = new Set(required.map((c) => c.name))
  const ciPending = checks.filter(
    (c) =>
      c.bucket !== 'pass' &&
      c.state !== 'SKIPPED' &&
      c.state !== 'NEUTRAL' &&
      !AI_REVIEWER_RE.test(c.name)
  ).length

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
  // annotations — inspect every non-skipped SAST check, not just pending ones.
  const sastChecks = checks.filter(
    (c) => isSast(c.name) && c.state !== 'SKIPPED' && c.state !== 'NEUTRAL'
  )
  let sastPending = 0
  let sastUnknown = 0
  if (sastChecks.length > 0) {
    const ids = checkRunIds(target.owner, target.repo, meta.headRefOid)
    for (const check of sastChecks) {
      // Checks reported via commit-status contexts (not check runs) have
      // no annotations endpoint — nothing is unknown about them. A fetch
      // failure only counts as unknown for required checks: an optional
      // SAST must not hold the gate.
      const gates = requiredNames.size === 0 || requiredNames.has(check.name)
      const runId = ids.get(check.name)
      if (!runId) {
        continue
      }
      try {
        sastPending += failureAnnotations(target.owner, target.repo, runId)
      } catch {
        if (gates) {
          sastUnknown += 1
        }
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
    fixRounds = Math.max(0, fetchPrReviews(target).length - 1)
  } catch {
    // best-effort — a flaky reviews endpoint must not break the gate
  }

  return {
    pr: target.pr,
    url: meta.url,
    headSha: meta.headRefOid,
    headRef: meta.headRefName,
    state: meta.state,
    isDraft: meta.isDraft,
    mergeable: (meta.mergeable || 'UNKNOWN').toUpperCase(),
    // normalize like mergeable — GraphQL emits uppercase enums, but a
    // lowercase source (e.g. REST mergeable_state) must not silently
    // disable the 'BEHIND' blocker downstream
    mergeState: (meta.mergeStateStatus || 'UNKNOWN').toUpperCase(),
    openThreads: threads.filter((t) => !t.isResolved).length,
    threads,
    ciPending,
    reviewersPending,
    reviewersFailing,
    sastPending,
    sastUnknown,
    fixRounds,
    maxRounds: opts?.maxRounds ?? 0,
  }
}

// --- mutations ---------------------------------------------------------------

function graphql(query: string, vars: Record<string, string>): void {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    args.push('-f', `${k}=${v}`)
  }
  const res = ghJson<{ errors?: unknown }>(args)
  if (res.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
  }
}

export function resolveReviewThread(threadId: string): void {
  graphql(
    'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}',
    { id: threadId }
  )
}

export function unresolveReviewThread(threadId: string): void {
  graphql(
    'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}',
    { id: threadId }
  )
}

export function replyToThread(threadId: string, body: string): void {
  graphql(
    'mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}',
    { t: threadId, b: body }
  )
}

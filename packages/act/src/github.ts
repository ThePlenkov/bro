/**
 * GitHub access for the act loop: open-PR state (threads + checks + mergeable),
 * thread resolve/reply mutations. Ported from act's pr-state.ts /
 * review-resolve.ts / review-reply.ts — same semantics, node-native.
 */
import { ghJson, ghTry } from '@bro/core'
import { fetchReviewThreads } from '@bro/debt'
import type { PrActState, PrCheck } from './types.ts'

const AI_REVIEWER_RE = /cubic|code\s*rabbit|amazon\s*q|qodo|chatgpt\s*codex|gemini|kilo|codeant/i

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

/** Full open-PR state for the act loop — threads + checks + mergeability. */
export async function fetchPrActState(target: {
  owner: string
  repo: string
  pr: number
}): Promise<PrActState> {
  const meta = fetchPrMeta(target)
  const threads = await fetchReviewThreads(target)
  const checks = fetchChecks(target, false)

  // Optional checks must not hold the gate. When the repo has required
  // checks configured, only those can block; without branch protection
  // gh --required fails and every non-AI check counts.
  const required = fetchChecks(target, true)
  const requiredNames = new Set(required.map((c) => c.name))
  const gatePool = required.length > 0 ? required : checks
  const ciPending = gatePool.filter(
    (c) =>
      c.bucket !== 'pass' &&
      c.state !== 'SKIPPED' &&
      c.state !== 'NEUTRAL' &&
      !AI_REVIEWER_RE.test(c.name)
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
      // Unknown annotation status can only block required checks — an
      // optional or not-yet-created run must not hold the gate forever.
      const gates = requiredNames.size === 0 || requiredNames.has(check.name)
      const runId = ids.get(check.name)
      if (!runId) {
        if (gates) {
          sastUnknown += 1
        }
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

  return {
    pr: target.pr,
    url: meta.url,
    headSha: meta.headRefOid,
    headRef: meta.headRefName,
    state: meta.state,
    isDraft: meta.isDraft,
    mergeable: (meta.mergeable || 'UNKNOWN').toUpperCase(),
    mergeState: meta.mergeStateStatus || 'UNKNOWN',
    openThreads: threads.filter((t) => !t.isResolved).length,
    threads,
    ciPending,
    sastPending,
    sastUnknown,
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

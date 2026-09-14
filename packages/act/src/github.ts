/**
 * GitHub access for the act loop: open-PR state (threads + checks + mergeable),
 * thread resolve/reply mutations. Ported from act's pr-state.ts /
 * review-resolve.ts / review-reply.ts — same semantics, node-native.
 */
import { gh, ghJson } from '@bro/core'
import { fetchReviewThreads, type ReviewThreadNode } from '@bro/debt'
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

function fetchChecks(target: { owner: string; repo: string; pr: number }): PrCheck[] {
  try {
    return ghJson<PrCheck[]>([
      'pr',
      'checks',
      String(target.pr),
      '--repo',
      `${target.owner}/${target.repo}`,
      '--json',
      'name,state,bucket',
    ])
  } catch (err) {
    if (/no checks reported/i.test(String(err))) {
      return []
    }
    throw err
  }
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
  const annotations = ghJson<Array<{ annotation_level?: string }>>([
    'api',
    '--paginate',
    `repos/${owner}/${repo}/check-runs/${runId}/annotations?per_page=100`,
  ])
  return annotations.filter((a) => a.annotation_level === 'failure').length
}

/** Full open-PR state for the act loop — threads + checks + mergeability. */
export async function fetchPrActState(target: {
  owner: string
  repo: string
  pr: number
}): Promise<PrActState> {
  const meta = fetchPrMeta(target)
  const threads = await fetchReviewThreads(target)
  const checks = fetchChecks(target)

  const ciPending = checks.filter(
    (c) =>
      c.bucket !== 'pass' &&
      c.state !== 'SKIPPED' &&
      c.state !== 'NEUTRAL' &&
      !AI_REVIEWER_RE.test(c.name)
  ).length

  let sastPending = 0
  let sastUnknown = 0
  if (ciPending > 0) {
    const ids = checkRunIds(target.owner, target.repo, meta.headRefOid)
    for (const check of checks) {
      if (check.bucket === 'pass' || check.state === 'SKIPPED' || check.state === 'NEUTRAL') {
        continue
      }
      if (!isSast(check.name)) {
        continue
      }
      const runId = ids.get(check.name)
      if (!runId) {
        continue
      }
      try {
        sastPending += failureAnnotations(target.owner, target.repo, runId)
      } catch {
        sastUnknown += 1
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

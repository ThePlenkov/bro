/**
 * GitHub ReviewFacade — the review-host capability implemented over the
 * `gh` CLI. Ported from act/github.ts and debt/github.ts — same calls,
 * same semantics, normalized onto the domain types in @bro/core/review.
 */
import { gh, ghJson, ghTry } from '@bro/core'
import type {
  CheckInfo,
  MergeOpts,
  MergedPr,
  MergedPrInfo,
  MergedPrQuery,
  PrMeta,
  PrTarget,
  ReviewFacade,
  ReviewThread,
} from '@bro/core'

// graphql/REST paths need owner+repo separately — split the facade's
// 'owner/name' string once at the boundary.
const parts = (repo: string): { owner: string; name: string } => {
  const [owner, name] = repo.split('/')
  return { owner: owner!, name: name! }
}

const prLinkStr = (repo: string, pr: number): string =>
  `[#${pr}](https://github.com/${repo}/pull/${pr})`

// --- PR state -----------------------------------------------------------------

function prMeta(t: PrTarget): PrMeta {
  const { owner, name } = parts(t.repo)
  const pr = ghJson<{
    data?: {
      repository?: {
        pullRequest?: {
          headRefOid: string
          headRefName: string
          mergeable: string
          mergeStateStatus: string
          state: string
          url: string
          isDraft: boolean
        }
      }
    }
    errors?: unknown
  }>([
    'api',
    'graphql',
    '-f',
    `query=query($o:String!,$r:String!,$pr:Int!){repository(owner:$o,name:$r){pullRequest(number:$pr){headRefOid headRefName mergeable mergeStateStatus state url isDraft}}}`,
    '-f',
    `o=${owner}`,
    '-f',
    `r=${name}`,
    '-F',
    `pr=${t.pr}`,
  ]).data?.repository?.pullRequest
  if (!pr) {
    throw new Error(`pull request #${t.pr} not found`)
  }
  return {
    state: (pr.state || 'UNKNOWN').toUpperCase(),
    isDraft: pr.isDraft,
    url: pr.url,
    headSha: pr.headRefOid,
    headRef: pr.headRefName,
    mergeable: (pr.mergeable || 'UNKNOWN').toUpperCase(),
    mergeState: (pr.mergeStateStatus || 'UNKNOWN').toUpperCase(),
  }
}

function checks(t: PrTarget, requiredOnly = false): CheckInfo[] {
  const args = [
    'pr',
    'checks',
    String(t.pr),
    '--repo',
    t.repo,
    '--json',
    'name,state,bucket',
  ]
  if (requiredOnly) {
    args.push('--required')
  }
  // `gh pr checks` exits 1 when any check is pending/failing — the JSON is
  // still on stdout, so a throwing call would lose exactly the data we need.
  const res = ghTry(args)
  if (res.out.trim().startsWith('[')) {
    return JSON.parse(res.out) as CheckInfo[]
  }
  if (res.code !== 0 && /no (checks|required checks)/i.test(res.err)) {
    return []
  }
  if (res.code !== 0) {
    throw new Error(`gh pr checks failed: ${res.err}`)
  }
  return []
}

function checkAnnotations(repo: string, headSha: string): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (let page = 1; ; page += 1) {
    const res = ghJson<{ check_runs: Array<{ id: number; name: string }> }>([
      'api',
      `repos/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    ])
    for (const run of res.check_runs ?? []) {
      // A re-run check reports one run per attempt — every attempt's
      // annotations count, not just the latest id's. A failed fetch
      // marks the name null (unknown), never a partial count.
      if (out.get(run.name) === null) {
        continue
      }
      try {
        // --paginate emits one JSON array per page — --slurp folds them
        // into a single array-of-arrays that JSON.parse can handle.
        const pages = ghJson<Array<Array<{ annotation_level?: string }>>>([
          'api',
          '--paginate',
          '--slurp',
          `repos/${repo}/check-runs/${run.id}/annotations?per_page=100`,
        ])
        const failures = pages.flat().filter((a) => a.annotation_level === 'failure').length
        out.set(run.name, (out.get(run.name) ?? 0) + failures)
      } catch {
        out.set(run.name, null)
      }
    }
    if ((res.check_runs?.length ?? 0) < 100) {
      break
    }
  }
  return out
}

/** Submitted reviews — each carries the head SHA it reviewed; distinct
 *  SHAs ≈ pushes that entered the review loop. */
function reviewedShas(t: PrTarget): string[] {
  const shas = new Set<string>()
  for (let page = 1; ; page += 1) {
    const reviews = ghJson<Array<{ commit_id?: string }>>([
      'api',
      `repos/${t.repo}/pulls/${t.pr}/reviews?per_page=100&page=${page}`,
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

// --- review threads -----------------------------------------------------------

interface ThreadPage {
  nodes: Array<{
    id: string
    isResolved: boolean
    isOutdated: boolean
    comments: {
      nodes: Array<{
        author?: { login?: string; __typename?: string }
        path?: string
        line?: number
        body?: string
        createdAt?: string
      }>
    }
  }>
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
                nodes { author { login __typename } path line body createdAt }
              }
            }
          }
        }
      }
    }`
}

function parseThreadPage(raw: string, repo: string, pr: number): ThreadPage {
  const parsed = JSON.parse(raw) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: ThreadPage } } }
    errors?: unknown
  }
  if (parsed.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`)
  }
  const threads = parsed.data?.repository?.pullRequest?.reviewThreads
  if (!threads) {
    throw new Error(`pull request ${prLinkStr(repo, pr)} not found`)
  }
  return threads
}

async function reviewThreads(t: PrTarget): Promise<ReviewThread[]> {
  const { owner, name } = parts(t.repo)
  const nodes: ReviewThread[] = []
  let cursor = ''
  for (;;) {
    const afterClause = cursor
      ? `, after: "${cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : ''
    const raw = gh([
      'api',
      'graphql',
      '-f',
      `query=${reviewThreadsQuery(afterClause)}`,
      '-f',
      `o=${owner}`,
      '-f',
      `r=${name}`,
      '-F',
      `pr=${t.pr}`,
      '-F',
      'n=100',
    ])
    const page = parseThreadPage(raw, t.repo, t.pr)
    for (const n of page.nodes) {
      const c = n.comments.nodes[0]
      nodes.push({
        id: n.id,
        resolved: n.isResolved,
        outdated: n.isOutdated,
        comment: c
          ? {
              author: c.author?.login ?? 'unknown',
              bot: c.author?.__typename === 'Bot',
              path: c.path ?? null,
              line: c.line ?? null,
              body: c.body ?? '',
              createdAt: c.createdAt ?? '',
            }
          : null,
      })
    }
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      break
    }
    cursor = page.pageInfo.endCursor
  }
  return nodes
}

// --- merged PRs ---------------------------------------------------------------

function mergedPrInfo(t: PrTarget, mergeSha?: string): MergedPrInfo {
  const viewed = ghJson<{
    title: string
    url: string
    mergedAt: string | null
    mergeCommit?: { oid: string }
    state: string
  }>([
    'pr',
    'view',
    String(t.pr),
    '--repo',
    t.repo,
    '--json',
    'title,url,mergedAt,mergeCommit,state',
  ])

  if (viewed.state !== 'MERGED') {
    throw new Error(`PR ${prLinkStr(t.repo, t.pr)} is not merged (state=${viewed.state})`)
  }
  return {
    title: viewed.title,
    url: viewed.url,
    mergedAt: viewed.mergedAt ?? new Date().toISOString(),
    mergeSha: mergeSha || viewed.mergeCommit?.oid || '',
  }
}

interface MergedPrRow {
  number: number
  mergedAt: string | null
  updatedAt: string | null
  state?: string
  author?: { login?: string }
  labels?: Array<{ name: string }>
  headRefName?: string
  headRefOid?: string
}

const toMergedPr = (row: MergedPrRow & { mergedAt: string }): MergedPr => ({
  number: row.number,
  mergedAt: row.mergedAt,
  updatedAt: row.updatedAt,
  author: row.author?.login ?? 'unknown',
  labels: (row.labels ?? []).map((l) => l.name),
  headRef: row.headRefName ?? '',
  headSha: row.headRefOid ?? '',
})

function listMergedPrs(repo: string, q: MergedPrQuery): MergedPr[] {
  const args = [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--limit',
    String(q.limit ?? 100),
    '--json',
    'number,mergedAt,updatedAt,author,labels,headRefName,headRefOid',
  ]
  if (q.author) {
    args.push('--author', q.author)
  }
  if (q.label) {
    args.push('--label', q.label)
  }
  return ghJson<MergedPrRow[]>(args)
    .filter((row): row is MergedPrRow & { mergedAt: string } => row.mergedAt !== null)
    .map(toMergedPr)
}

function explicitMergedPrs(repo: string, ids: number[]): MergedPr[] {
  const out: MergedPr[] = []
  for (const number of ids) {
    const link = prLinkStr(repo, number)
    try {
      const viewed = ghJson<MergedPrRow>([
        'pr',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'number,mergedAt,updatedAt,author,labels,state,headRefName,headRefOid',
      ])
      if (viewed.state !== 'MERGED' || !viewed.mergedAt) {
        console.error(`warning: PR ${link} is not merged — skipped`)
        continue
      }
      out.push(toMergedPr({ ...viewed, mergedAt: viewed.mergedAt }))
    } catch {
      console.error(`warning: PR ${link} fetch failed — skipped`)
    }
  }
  return out
}

function mergedPrs(repo: string, q: MergedPrQuery = {}): MergedPr[] {
  // `ids` present — even empty — is an explicit selection; only its
  // absence means "list merged PRs with the filters".
  if (q.ids !== undefined) {
    return explicitMergedPrs(repo, q.ids)
  }
  return listMergedPrs(repo, q)
}

// --- labels -------------------------------------------------------------------

function labels(t: PrTarget): string[] {
  const viewed = ghJson<{ labels?: Array<{ name: string }> }>([
    'pr',
    'view',
    String(t.pr),
    '--repo',
    t.repo,
    '--json',
    'labels',
  ])
  return (viewed.labels ?? []).map((l) => l.name)
}

function prUpdatedAt(t: PrTarget): string | null {
  const viewed = ghJson<{ updatedAt?: string }>([
    'pr',
    'view',
    String(t.pr),
    '--repo',
    t.repo,
    '--json',
    'updatedAt',
  ])
  return viewed.updatedAt ?? null
}

// --- mutations ----------------------------------------------------------------

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

/** The ReviewFacade bound to a dir — `gh repo view`/`gh pr view` run
 *  there so repo/PR detection follows the facade's repo, not cwd. */
export function githubReview(dir: string = process.cwd()): ReviewFacade {
  const resolvedRepo = (positional: string[] = []): string => {
    const [owner, repo] = positional
    if (owner && repo) {
      return `${owner}/${repo}`
    }
    const viewed = ghJson<{ owner: { login: string }; name: string }>(
      ['repo', 'view', '--json', 'owner,name'],
      dir
    )
    return `${viewed.owner.login}/${viewed.name}`
  }
  return {
    resolveRepo: resolvedRepo,
    prLink: prLinkStr,
    currentPr() {
      // `gh pr view` resolves the PR for the checked-out branch — `gh pr
      // list --limit 1` would grab an arbitrary open PR instead. It also
      // resolves CLOSED/MERGED PRs, so the caller must check state.
      const res = ghTry(['pr', 'view', '--json', 'number,state,url'], dir)
      if (res.code !== 0 || res.out.trim() === '') {
        return null
      }
      const view = JSON.parse(res.out) as { number: number; state: string; url: string }
      return { pr: view.number, state: view.state, url: view.url }
    },
    prsForBranch(branch) {
      // Explicit --repo: `gh pr list --head` would otherwise guess the
      // repo from the dir's remotes — a fork's `upstream` can answer
      // instead of the configured review host.
      return ghJson<Array<{ number: number }>>(
        [
          'pr', 'list', '--head', branch, '--state', 'open',
          '--repo', resolvedRepo(), '--json', 'number',
        ],
        dir
      ).map((p) => p.number)
    },
    prMeta,
    mergedPrInfo,
    mergedPrs,
    checks,
    checkAnnotations,
    reviewedShas,
    reviewThreads,
    labels,
    prUpdatedAt,
    createLabel(repo, name, color) {
      gh(['label', 'create', name, '--repo', repo, '--color', color, '--force'])
    },
    addLabel(t, label) {
      gh(['pr', 'edit', String(t.pr), '--repo', t.repo, '--add-label', label])
    },
    removeLabel(t, label) {
      // Ensure-absent: suppress only confirmed absent-label errors —
      // "repository not found" and other real failures propagate.
      try {
        gh(['pr', 'edit', String(t.pr), '--repo', t.repo, '--remove-label', label])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes(label) && /not found|does not exist|no such label/i.test(msg)) {
          return
        }
        throw err
      }
    },
    resolveThread(id, unresolve = false) {
      const m = unresolve ? 'unresolveReviewThread' : 'resolveReviewThread'
      graphql(`mutation($id:ID!){${m}(input:{threadId:$id}){thread{isResolved}}}`, { id })
    },
    replyThread(id, body) {
      graphql(
        'mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}',
        { t: id, b: body }
      )
    },
    updateBranch(t, expectedHeadSha) {
      const r = ghTry([
        'api',
        '-X',
        'PUT',
        `repos/${t.repo}/pulls/${t.pr}/update-branch`,
        '-f',
        `expected_head_sha=${expectedHeadSha}`,
      ])
      return r.code === 0
    },
    mergePr(t, opts) {
      const args = [
        'pr',
        'merge',
        String(t.pr),
        `--${opts.method}`,
        '--repo',
        t.repo,
        '--match-head-commit',
        opts.expectedHeadSha,
      ]
      if (opts.deleteBranch) {
        args.push('--delete-branch')
      }
      if (opts.admin) {
        args.push('--admin')
      }
      console.log(gh(args))
      // A merge queue accepts a PR without landing it — only the
      // authoritative state tells the caller what actually happened.
      const after = ghJson<{ state: string }>([
        'pr',
        'view',
        String(t.pr),
        '--repo',
        t.repo,
        '--json',
        'state',
      ])
      return (after.state || 'UNKNOWN').toUpperCase()
    },
  }
}

/**
 * GitHub ReviewFacade — the review-host capability implemented over the
 * `gh` CLI. Ported from act/github.ts and debt/github.ts — same calls,
 * same semantics, normalized onto the domain types in @broject/core/review.
 */
import {
  gh,
  ghAsync,
  ghJson,
  ghJsonAsync,
  ghTry,
  ghTryAsync,
  prLink,
  resolveRepo,
  resolveRepoAsync,
} from '@broject/core'
import type {
  CheckInfo,
  MergeOpts,
  MergedPr,
  MergedPrInfo,
  MergedPrQuery,
  MergedPrScan,
  PrLabelOp,
  PrMeta,
  PrTarget,
  ReviewFacade,
  ReviewThread,
  ScanOpts,
} from '@broject/core'

// graphql/REST paths need owner+repo separately — split the facade's
// 'owner/name' string once at the boundary.
const parts = (repo: string): { owner: string; name: string } => {
  const [owner, name] = repo.split('/')
  return { owner: owner!, name: name! }
}

// --- PR state -----------------------------------------------------------------

function prMeta(t: PrTarget): PrMeta {
  const { owner, name } = parts(t.repo)
  const pr = ghJson<{
    data?: {
      repository?: {
        pullRequest?: {
          headRefOid: string
          headRefName: string
          baseRefName: string
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
    `query=query($o:String!,$r:String!,$pr:Int!){repository(owner:$o,name:$r){pullRequest(number:$pr){headRefOid headRefName baseRefName mergeable mergeStateStatus state url isDraft}}}`,
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
    baseRef: pr.baseRefName,
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
        line?: number | null
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
    throw new Error(`pull request ${prLink(repo, pr)} not found`)
  }
  return threads
}

/** GraphQL thread nodes → domain threads — shared by the paginated
 *  per-PR fetch and the bulk scan's inlined first page. */
function toReviewThreads(nodes: ThreadPage['nodes']): ReviewThread[] {
  return nodes.map((n) => {
    const c = n.comments.nodes[0]
    return {
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
    }
  })
}

async function reviewThreads(t: PrTarget): Promise<ReviewThread[]> {
  const { owner, name } = parts(t.repo)
  const nodes: ReviewThread[] = []
  let cursor = ''
  for (;;) {
    const afterClause = cursor
      ? `, after: "${cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : ''
    const raw = await ghAsync([
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
    nodes.push(...toReviewThreads(page.nodes))
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
    throw new Error(`PR ${prLink(t.repo, t.pr)} is not merged (state=${viewed.state})`)
  }
  if (!viewed.mergedAt) {
    throw new Error(`PR ${prLink(t.repo, t.pr)} is MERGED but reports no mergedAt`)
  }
  return {
    title: viewed.title,
    url: viewed.url,
    mergedAt: viewed.mergedAt,
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
  if (q.mergedSince) {
    // server-side cutoff — the list caps by recency, so a mergedAt
    // filter applied after the cap would lose eligible PRs. The
    // merged: qualifier takes a YYYY-MM-DD date — slice the ISO stamp;
    // the over-inclusive day edge is fine, callers filter exactly.
    args.push('--search', `merged:>=${q.mergedSince.slice(0, 10)}`)
  }
  return ghJson<MergedPrRow[]>(args)
    .filter((row): row is MergedPrRow & { mergedAt: string } => row.mergedAt !== null)
    .map(toMergedPr)
}

function explicitMergedPrs(repo: string, ids: number[]): MergedPr[] {
  const out: MergedPr[] = []
  const failures: unknown[] = []
  // Dedup at the facade — the old pipeline's `parseCsvInts` deduplicated
  // upstream, and duplicate ids would produce duplicate rows that
  // double-count in consumer aggregations.
  const unique = [...new Set(ids)]
  for (const number of unique) {
    const link = prLink(repo, number)
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
    } catch (err) {
      failures.push(err)
      console.error(
        `warning: PR ${link} fetch failed — ${err instanceof Error ? err.message : err}`
      )
    }
  }
  // Every fetch failing is one outage (auth, network, repo gone, no gh on
  // PATH), not N unmerged PRs — an empty return would read as "all ids
  // unmerged" and silently empty the caller's selection.
  if (failures.length > 0 && failures.length === unique.length) {
    const first = failures[0]
    throw new Error(
      `all ${unique.length} PR fetch(es) failed: ` +
        (first instanceof Error ? first.message : String(first))
    )
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

/** Paths the PR's diff touches — one entry per file, paginated like the
 *  reviews fetch. */
function prFiles(t: PrTarget): string[] {
  const files: string[] = []
  for (let page = 1; ; page += 1) {
    // the endpoint truncates at 3,000 files — a 30th full page means the
    // list is silently incomplete, so throw: callers must treat an
    // unknown file scope as "not docs-only", not guess from a prefix
    if (page > 30) {
      throw new Error(`prFiles: ${prLink(t.repo, t.pr)} exceeds the 3,000-file API limit`)
    }
    const rows = ghJson<Array<{ filename?: string; previous_filename?: string }>>([
      'api',
      `repos/${t.repo}/pulls/${t.pr}/files?per_page=100&page=${page}`,
    ])
    for (const f of rows ?? []) {
      // a rename reports BOTH paths — a code→docs rename still counts as
      // touching code
      if (f.filename) {
        files.push(f.filename)
      }
      if (f.previous_filename) {
        files.push(f.previous_filename)
      }
    }
    if ((rows?.length ?? 0) < 100) {
      break
    }
  }
  return files
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

// --- async twins — the hook-probe read path -------------------------------------
//
// fetchPrActState awaits these inside a parallel connector sweep; the sync
// twins stay for command paths where one awaited call is the whole job.
// Same bodies, ghJsonAsync/ghTryAsync in place of the spawnSync forms —
// semantics identical, only the event loop notices.

async function prMetaAsync(t: PrTarget): Promise<PrMeta> {
  const { owner, name } = parts(t.repo)
  const pr = (
    await ghJsonAsync<{
      data?: {
        repository?: {
          pullRequest?: {
            headRefOid: string
            headRefName: string
            baseRefName: string
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
      `query=query($o:String!,$r:String!,$pr:Int!){repository(owner:$o,name:$r){pullRequest(number:$pr){headRefOid headRefName baseRefName mergeable mergeStateStatus state url isDraft}}}`,
      '-f',
      `o=${owner}`,
      '-f',
      `r=${name}`,
      '-F',
      `pr=${t.pr}`,
    ])
  ).data?.repository?.pullRequest
  if (!pr) {
    throw new Error(`pull request #${t.pr} not found`)
  }
  return {
    state: (pr.state || 'UNKNOWN').toUpperCase(),
    isDraft: pr.isDraft,
    url: pr.url,
    headSha: pr.headRefOid,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    mergeable: (pr.mergeable || 'UNKNOWN').toUpperCase(),
    mergeState: (pr.mergeStateStatus || 'UNKNOWN').toUpperCase(),
  }
}

async function checksAsync(t: PrTarget, requiredOnly = false): Promise<CheckInfo[]> {
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
  const res = await ghTryAsync(args)
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

async function checkAnnotationsAsync(
  repo: string,
  headSha: string
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  for (let page = 1; ; page += 1) {
    const res = await ghJsonAsync<{ check_runs: Array<{ id: number; name: string }> }>([
      'api',
      `repos/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    ])
    // a page's annotation fetches are independent — overlap them; each
    // run reports to its own slot first so a name shared by concurrent
    // runs can't let a success overwrite a sibling's failure
    const results = await Promise.all(
      (res.check_runs ?? []).map(async (run) => {
        try {
          const pages = await ghJsonAsync<Array<Array<{ annotation_level?: string }>>>([
            'api',
            '--paginate',
            '--slurp',
            `repos/${repo}/check-runs/${run.id}/annotations?per_page=100`,
          ])
          return {
            name: run.name,
            count: pages.flat().filter((a) => a.annotation_level === 'failure').length as
              | number
              | null,
          }
        } catch {
          return { name: run.name, count: null }
        }
      })
    )
    for (const r of results) {
      const prev = out.get(r.name)
      if (prev === null) {
        continue
      }
      out.set(r.name, r.count === null ? null : (prev ?? 0) + r.count)
    }
    if ((res.check_runs?.length ?? 0) < 100) {
      break
    }
  }
  return out
}

async function reviewedShasAsync(t: PrTarget): Promise<string[]> {
  const shas = new Set<string>()
  for (let page = 1; ; page += 1) {
    const reviews = await ghJsonAsync<Array<{ commit_id?: string }>>([
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

async function prFilesAsync(t: PrTarget): Promise<string[]> {
  const files: string[] = []
  for (let page = 1; ; page += 1) {
    if (page > 30) {
      throw new Error(`prFiles: ${prLink(t.repo, t.pr)} exceeds the 3,000-file API limit`)
    }
    const rows = await ghJsonAsync<Array<{ filename?: string; previous_filename?: string }>>([
      'api',
      `repos/${t.repo}/pulls/${t.pr}/files?per_page=100&page=${page}`,
    ])
    for (const f of rows ?? []) {
      if (f.filename) {
        files.push(f.filename)
      }
      if (f.previous_filename) {
        files.push(f.previous_filename)
      }
    }
    if ((rows?.length ?? 0) < 100) {
      break
    }
  }
  return files
}

// --- bulk probes ---------------------------------------------------------------
//
// `debt collect` pays several gh round-trips per merged PR when driven
// through the per-PR methods (~5-7 spawnSync each — a 100-PR scan reads
// as hung). Aliased GraphQL fields fold a whole chunk of PRs into one
// call; a small pool overlaps the chunks.

/** Run `fn` over `items` with at most `cap` in flight — a Promise pool,
 *  not a thread pool: the win is overlapping `gh` processes. A cap <= 0
 *  clamps to one serial worker — zero workers would silently process
 *  nothing. */
async function pooled<T>(items: T[], cap: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, async () => {
      while (next < items.length) {
        await fn(items[next++]!) // NOSONAR — serial within a worker; the workers overlap
      }
    })
  )
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

// --- stacked PRs: the asynchronous merge endpoint -------------------------------
//
// GitHub refuses both merge paths a stack member can take: the GraphQL
// `mergePullRequest` mutation (which `gh pr merge` is a client for) and
// the synchronous `PUT /pulls/{n}/merge` — "must be merged using the
// asynchronous merge REST API". The async endpoint is the only way in:
// PUT answers a uuid, GET reports the result until it settles.

interface StackProbe {
  /** Stack membership — absent on a PR that isn't in one. */
  stacked: boolean
  /** Base branch — undefined when the read failed; the merge action's
   *  queue decision needs it. */
  base?: string
}

/** Does this PR sit in a stack, and onto what? `GET /pulls/{n}` carries
 *  the `stack` object for members (base, size, position, number).
 *  Every failure — no field on an older API version, an auth or network
 *  error — reads as "not a stack": a probe must never block a merge the
 *  sync path can still do, and the reactive net in `mergePr` catches a
 *  stack the probe missed. */
function stackProbe(t: PrTarget): StackProbe {
  const res = ghTry(['api', `repos/${t.repo}/pulls/${t.pr}`])
  if (res.code !== 0) {
    return { stacked: false }
  }
  try {
    const body = JSON.parse(res.out) as { stack?: unknown; base?: { ref?: string } }
    return {
      stacked: body.stack !== undefined && body.stack !== null,
      base: body.base?.ref,
    }
  } catch {
    return { stacked: false }
  }
}

/** Does the base branch require a merge queue? GraphQL is the only
 *  surface that answers it (REST exposes no merge-queue state), so one
 *  `{mergeQueue(branch:){id}}` query. Any failure — GHES without the
 *  field, a permissions gap — reads as "no queue": the direct path
 *  keeps the caller's requested merge method, and a wrong guess fails
 *  loudly at the endpoint instead of silently picking a strategy. */
function queueRequired(repo: string, base: string): boolean {
  try {
    const { owner, name } = parts(repo)
    const res = ghJson<{ data?: { repository?: { mergeQueue?: { id?: number } | null } } }>([
      'api',
      'graphql',
      '-f',
      'query=query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){mergeQueue(branch:$b){id}}}',
      '-f',
      `o=${owner}`,
      '-f',
      `r=${name}`,
      '-f',
      `b=${base}`,
    ])
    return res.data?.repository?.mergeQueue != null
  } catch {
    return false
  }
}

interface AsyncMergeResult {
  status?: 'pending' | 'merged' | 'enqueued' | 'failed'
  uuid?: string
  message?: string
}

/** The merge-async body, read from whichever stream `gh api` used — it
 *  prints the JSON on stdout for a 2xx *and* for a 4xx (the `gh: … (HTTP
 *  4xx)` line goes to stderr, verified against gh 2.102), and the 409
 *  that means "a request for this PR is already pending" carries the
 *  uuid worth resuming — a re-run must not double-request the merge.
 *  Unparseable input reads as "no status", which the caller treats as
 *  unobservable rather than as a verdict. */
function readAsyncMerge(res: { out: string; err: string }): AsyncMergeResult {
  for (const text of [res.out, res.err]) {
    const start = text.indexOf('{')
    if (start < 0) {
      continue
    }
    try {
      const body = JSON.parse(text.slice(start)) as {
        status?: AsyncMergeResult['status']
        message?: string
        details?: { uuid?: string; message?: string }
      }
      return {
        status: body.status,
        uuid: body.details?.uuid,
        message: body.details?.message ?? body.message,
      }
    } catch {
      // not the merge body (gh's error prefix, a partial line) — try the
      // other stream before giving up
    }
  }
  return {}
}

export interface AsyncMergePoll {
  /** Gap between result reads while the request is pending. */
  intervalMs?: number
  /** Give up watching after this long — the merge keeps running on
   *  GitHub's side; re-running `bro act merge` resumes polling the same
   *  uuid. */
  deadlineMs?: number
  /** Injectable so the poll loop is testable without wall-clock waits. */
  sleep?: (ms: number) => void
}

/** Sync nap — the merge path is a command, not a hook probe, and
 *  `mergePr` is a sync facade method that cannot await a poll. Same
 *  primitive filelock uses to block on a lock. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** merge-async argv — the same pin --match-head-commit gives the sync
 *  path: a head that moved since the gate evaluated it fails closed
 *  instead of landing a commit the gate never saw. The queue owns the
 *  strategy — merge_method is rejected with it. */
function mergeAsyncArgs(t: PrTarget, opts: MergeOpts, queued: boolean): string[] {
  const args = [
    'api',
    '-X',
    'PUT',
    `repos/${t.repo}/pulls/${t.pr}/merge-async`,
    '-f',
    `sha=${opts.expectedHeadSha}`,
  ]
  if (queued) {
    args.push('-f', 'merge_action=merge_queue')
  } else {
    args.push('-f', 'merge_action=direct_merge', '-f', `merge_method=${opts.method}`)
  }
  if (opts.admin) {
    args.push('-F', 'bypass_rules=true')
  }
  return args
}

/** Poll the uuid while `pending`. Throws on a uuid-less pending, and on
 *  the watch deadline: the request keeps running on GitHub's side —
 *  re-running resumes polling the same uuid. The nap is clamped to the
 *  budget left so a gap can't carry the loop past the deadline (the
 *  remainder is positive — the guard threw on anything else). */
function pollAsyncMerge(
  t: PrTarget,
  result: AsyncMergeResult,
  intervalMs: number,
  deadlineMs: number,
  sleep: (ms: number) => void
): AsyncMergeResult {
  const started = Date.now()
  while (result.status === 'pending') {
    const uuid = result.uuid
    if (uuid === undefined) {
      throw new Error(
        `async merge of ${prLink(t.repo, t.pr)} reports pending with no uuid — nothing to poll`
      )
    }
    const elapsed = Date.now() - started
    if (elapsed >= deadlineMs) {
      throw new Error(
        `async merge ${uuid} of ${prLink(t.repo, t.pr)} still pending after ` +
          `${Math.round(elapsed / 1000)}s — the request keeps running on GitHub; ` +
          're-run to resume polling it'
      )
    }
    sleep(Math.min(intervalMs, deadlineMs - elapsed))
    result = readAsyncMerge(ghTry(['api', `repos/${t.repo}/pulls/${t.pr}/merge-async/${uuid}`]))
  }
  return result
}

/** `PUT /pulls/{n}/merge-async`, then poll its uuid until the request
 *  settles. `base` decides the merge action (undefined — the reactive
 *  fallback path after a probe failure — means "assume no queue").
 *  Throws on `failed`, on an unobservable status, and on a watch
 *  timeout: an unsettled merge is never reported as a landed one. */
export function mergeAsync(
  t: PrTarget,
  opts: MergeOpts,
  base?: string,
  poll: AsyncMergePoll = {}
): void {
  const queued = base !== undefined && queueRequired(t.repo, base)
  console.log(
    `merge: stack member — ${prLink(t.repo, t.pr)} via merge-async ` +
      `(${queued ? 'merge queue' : opts.method}, head branch kept: a layer above may be based on it)`
  )
  const result = pollAsyncMerge(
    t,
    readAsyncMerge(ghTry(mergeAsyncArgs(t, opts, queued))),
    poll.intervalMs ?? 2_000,
    poll.deadlineMs ?? 10 * 60_000,
    poll.sleep ?? sleepSync
  )

  if (result.status === 'failed') {
    throw new Error(
      `async merge of ${prLink(t.repo, t.pr)} failed — ${result.message ?? 'no reason reported'}`
    )
  }
  if (result.status === 'enqueued') {
    // final for the request, NOT for the PR: the queue merges later. The
    // caller's post-merge re-read reports the real state.
    console.log('merge: async merge accepted into the merge queue — not merged yet')
    return
  }
  if (result.status !== 'merged') {
    throw new Error(
      `async merge of ${prLink(t.repo, t.pr)} reported no observable status` +
        `${result.uuid === undefined ? '' : ` (uuid ${result.uuid})`}` +
        `${result.message === undefined ? '' : ` — ${result.message}`} — ` +
        'check the PR state; GitHub may have discarded the request'
    )
  }
}

/** pullRequest(number:N) under an alias — the building block for bulk
 *  probes and post-write updatedAt re-queries. */
function aliasedPrQuery(
  targets: PrTarget[],
  alias: string,
  fields: string
): string {
  const body = targets
    .map((t, i) => `${alias}${i}: pullRequest(number: ${t.pr}) { ${fields} }`)
    .join('\n')
  return `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ ${body} } }`
}

interface ScanNode {
  title?: string
  url?: string
  mergedAt?: string | null
  updatedAt?: string | null
  mergeCommit?: { oid?: string }
  labels?: { nodes?: Array<{ name?: string }> }
  reviewThreads?: {
    pageInfo?: { hasNextPage?: boolean }
    nodes?: ThreadPage['nodes']
  }
}

function parseAliasedPrs<T extends object>(
  raw: string,
  targets: PrTarget[],
  alias: string
): Array<T | null> {
  const parsed = JSON.parse(raw) as {
    data?: { repository?: Record<string, T | null> }
    errors?: unknown
  }
  if (parsed.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`)
  }
  const repo = parsed.data?.repository
  if (!repo) {
    throw new Error('bulk scan: no repository in response')
  }
  return targets.map((_, i) => repo[`${alias}${i}`] ?? null)
}

const SCAN_PR_FIELDS = `
  title url mergedAt updatedAt
  mergeCommit { oid }
  labels(first: 50) { nodes { name } }
  reviewThreads(first: 100) {
    pageInfo { hasNextPage }
    nodes { id isResolved isOutdated comments(first: 1) { nodes { author { login __typename } path line body createdAt } } }
  }`

/** Aliased-GraphQL probe: one `gh api graphql` call per ~15 PRs covers
 *  meta + threads + labels + updatedAt; chunks overlap under a small
 *  concurrency cap. Misses stay out of the map — the caller's serial
 *  per-PR path reports them properly. */
async function scanMergedPrs(
  targets: PrTarget[],
  opts?: ScanOpts
): Promise<Map<number, MergedPrScan>> {
  const out = new Map<number, MergedPrScan>()
  if (targets.length === 0) {
    return out
  }
  const { owner, name } = parts(targets[0]!.repo)
  let done = 0
  await pooled(chunks(targets, 15), opts?.concurrency ?? 4, async (chunk) => {
    let rows: Array<ScanNode | null>
    try {
      rows = parseAliasedPrs<ScanNode>(
        await ghAsync([
          'api',
          'graphql',
          '-f',
          `query=${aliasedPrQuery(chunk, 's', SCAN_PR_FIELDS)}`,
          '-f',
          `o=${owner}`,
          '-f',
          `r=${name}`,
        ]),
        chunk,
        's'
      )
    } catch (err) {
      console.error(
        `warning: bulk scan chunk (${chunk.length} PR(s)) failed — ` +
          `${err instanceof Error ? err.message : err}`
      )
      return
    }
    for (const [i, t] of chunk.entries()) {
      const node = rows[i]
      // Non-merged / missing PRs stay out — the serial fallback decides.
      if (!node?.mergedAt) {
        continue
      }
      let threads = toReviewThreads(node.reviewThreads?.nodes ?? [])
      // >100 threads on one PR is rare — full paginated fetch per-PR.
      if (node.reviewThreads?.pageInfo?.hasNextPage) {
        try {
          threads = await reviewThreads(t) // NOSONAR — rare per-PR fallback inside the chunk loop
        } catch {
          continue
        }
      }
      out.set(t.pr, {
        info: {
          title: node.title ?? '',
          url: node.url ?? `https://github.com/${t.repo}/pull/${t.pr}`,
          mergedAt: node.mergedAt,
          mergeSha: node.mergeCommit?.oid ?? '',
        },
        threads,
        labels: (node.labels?.nodes ?? []).map((l) => l.name ?? ''),
        updatedAt: node.updatedAt ?? null,
      })
    }
    done += chunk.length
    opts?.onProgress?.(done, targets.length)
  })
  return out
}

/** Post-write `updatedAt` for a set of PRs — one chunked aliased query,
 *  not a serial `pr view` per PR. Missing keys stay absent. */
async function updatedAtFor(targets: PrTarget[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (targets.length === 0) {
    return out
  }
  const { owner, name } = parts(targets[0]!.repo)
  await pooled(chunks(targets, 50), 4, async (chunk) => {
    let rows: Array<{ updatedAt?: string | null } | null>
    try {
      rows = parseAliasedPrs(
        await ghAsync([
          'api',
          'graphql',
          '-f',
          `query=${aliasedPrQuery(chunk, 'u', 'updatedAt')}`,
          '-f',
          `o=${owner}`,
          '-f',
          `r=${name}`,
        ]),
        chunk,
        'u'
      )
    } catch {
      return
    }
    for (const [i, t] of chunk.entries()) {
      const at = rows[i]?.updatedAt
      if (at) {
        out.set(t.pr, at)
      }
    }
  })
  return out
}

/** `gh pr edit` per PR overlapped under the pool — one call does the
 *  add + the removals; then a single chunked re-query hands the caller
 *  post-write updatedAt cursors without a serial `pr view` per PR. */
async function labelPrs(
  ops: PrLabelOp[],
  opts?: { concurrency?: number }
): Promise<Map<number, string | null>> {
  const applied: PrTarget[] = []
  await pooled(ops, opts?.concurrency ?? 4, async (op) => {
    if (op.add.length === 0 && op.remove.length === 0) {
      applied.push(op.t)
      return
    }
    const args = ['pr', 'edit', String(op.t.pr), '--repo', op.t.repo]
    if (op.add.length > 0) {
      args.push('--add-label', op.add.join(','))
    }
    if (op.remove.length > 0) {
      args.push('--remove-label', op.remove.join(','))
    }
    try {
      await ghAsync(args)
      applied.push(op.t)
    } catch (err) {
      // A failed write leaves the PR unlabeled — next collect rescans it.
      console.error(
        `warning: label write on ${prLink(op.t.repo, op.t.pr)} failed — ` +
          `${err instanceof Error ? err.message : err}`
      )
    }
  })
  const stamps = await updatedAtFor(applied)
  return new Map(applied.map((t) => [t.pr, stamps.get(t.pr) ?? null]))
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
  return {
    resolveRepo: (positional: string[] = []) => resolveRepo(positional, dir),
    resolveRepoAsync: (positional: string[] = []) => resolveRepoAsync(positional, dir),
    prLink,
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
    async currentPrAsync() {
      const res = await ghTryAsync(['pr', 'view', '--json', 'number,state,url'], dir)
      if (res.code !== 0 || res.out.trim() === '') {
        return null
      }
      const view = JSON.parse(res.out) as { number: number; state: string; url: string }
      return { pr: view.number, state: view.state, url: view.url }
    },
    prsForBranch(branch, state) {
      // Explicit --repo: `gh pr list --head` would otherwise guess the
      // repo from the dir's remotes — a fork's `upstream` can answer
      // instead of the configured review host.
      return ghJson<Array<{ number: number }>>(
        [
          'pr', 'list', '--head', branch, '--state', state === 'all' ? 'all' : 'open',
          '--repo', resolveRepo([], dir), '--json', 'number',
        ],
        dir
      ).map((p) => p.number)
    },
    parsePrRef(text) {
      const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(text)
      return m ? { repo: `${m[1]}/${m[2]}`, pr: Number(m[3]) } : null
    },
    prMeta,
    mergedPrInfo,
    mergedPrs,
    scanMergedPrs,
    labelPrs,
    checks,
    checkAnnotations,
    reviewedShas,

    prMetaAsync,
    checksAsync,
    checkAnnotationsAsync,
    reviewedShasAsync,
    prFilesAsync,

    prFiles,
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
    retargetPr(t, base) {
      return ghTry(['pr', 'edit', String(t.pr), '--repo', t.repo, '--base', base]).code === 0
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
      // A stack member can only merge through the async endpoint, and the
      // sync client below (GraphQL `mergePullRequest`) is rejected for one.
      // The probe decides first — a clean path, no doomed attempt — and the
      // reactive net covers a stack the probe could not see (an API version
      // without the `stack` field answers no question either way).
      const probe = stackProbe(t)
      if (probe.stacked) {
        mergeAsync(t, opts, probe.base)
        return postMergeState(t)
      }
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
      try {
        console.log(gh(args))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/asynchronous merge/i.test(msg)) {
          throw err
        }
        console.error(`merge: sync merge refused — ${msg.trim()}`)
        mergeAsync(t, opts, probe.base)
      }
      // A merge queue accepts a PR without landing it — only the
      // authoritative state tells the caller what actually happened.
      return postMergeState(t)
    },
  }
}

/** The PR's post-merge state, authoritative — a queue hold or a stack
 *  merge that landed nothing reads here, never in the merge call's own
 *  answer. */
function postMergeState(t: PrTarget): string {
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
}

/**
 * GitLab ReviewFacade — the review-host capability implemented over the
 * `glab` CLI's REST passthrough (`glab api`, the `gh api` analog). The
 * domain mapping: MR discussions are threads, head-pipeline jobs+bridges
 * are checks, diff versions are reviewed SHAs.
 */
import { gitTry } from '@broject/core'
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
import { glab, glabJson, glabJsonAsync, glabPaged, glabPagedAsync, glabTry } from './glab.ts'

// `repo` is a project path — GitLab nests (group/sub/project), so it is
// opaque here and URL-encoded once at the API boundary.
const api = (repo: string, path: string): string =>
  `projects/${encodeURIComponent(repo)}/${path}`

// --- repo / host ------------------------------------------------------------

function remoteUrl(dir: string): string | undefined {
  const r = gitTry(['-C', dir, 'remote', 'get-url', 'origin'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : undefined
}

/** host + path split for GitLab remotes — https, ssh:// and scp-style
 *  `git@host:path.git`. Nested groups keep their slashes; the port, when
 *  present, stays on the host so self-hosted URLs still build. */
function remoteParts(url: string): { host: string; path: string } | null {
  const m =
    /^(?:https?|ssh):\/\/([^/]+)\/(.+?)\/?$/i.exec(url) ??
    /^[^@\s]+@([^:/]+):(.+?)\/?$/.exec(url)
  if (!m) {
    return null
  }
  return { host: m[1]!.toLowerCase(), path: m[2]!.replace(/\.git$/, '') }
}

/** The GitLab host a dir points at — the origin remote's authority,
 *  gitlab.com when there is none. */
export function hostFor(dir: string): string {
  const url = remoteUrl(dir)
  const parts = url === undefined ? null : remoteParts(url)
  return parts?.host ?? 'gitlab.com'
}

// --- MR rows -----------------------------------------------------------------

interface MrRow {
  iid: number
  state?: string // opened | locked | merged | closed
  draft?: boolean
  work_in_progress?: boolean
  title?: string
  web_url?: string
  sha?: string // head sha
  source_branch?: string
  merge_status?: string // pre-15.6 compute flag
  detailed_merge_status?: string // 15.6+ verdict
  labels?: string[]
  updated_at?: string | null
  merged_at?: string | null
  merge_commit_sha?: string | null
  squash_commit_sha?: string | null
  author?: { username?: string }
}

const toState = (s: string | undefined): string =>
  s === 'opened' || s === 'locked' ? 'OPEN' : (s ?? 'unknown').toUpperCase()

/** `detailed_merge_status` conflates conflicts with workflow blocks (CI
 *  pending, missing approvals, unresolved discussions). The facade's
 *  `mergeable` only answers "does it conflict" — the rest gate via their
 *  own signals — so anything non-conflict that finished computing maps
 *  to MERGEABLE. */
function toMergeable(mr: MrRow): string {
  const d = mr.detailed_merge_status
  if (d) {
    if (d === 'conflict') {
      return 'CONFLICTING'
    }
    if (d === 'checking' || d === 'unchecked' || d === 'broken_status') {
      return 'UNKNOWN'
    }
    return 'MERGEABLE'
  }
  // legacy merge_status — the pre-detailed_compute flag
  const legacy = mr.merge_status ?? ''
  if (legacy === 'can_be_merged') {
    return 'MERGEABLE'
  }
  if (legacy === 'cannot_be_merged') {
    return 'CONFLICTING'
  }
  return 'UNKNOWN'
}

/** `mergeState`'s only read is BEHIND (act wait's update-branch path) —
 *  `need_rebase` is GitLab's BEHIND; `mergeable` reports as CLEAN like
 *  GitHub, everything else passes through uppercased. */
function toMergeState(mr: MrRow): string {
  const d = mr.detailed_merge_status
  if (d === 'need_rebase') {
    return 'BEHIND'
  }
  if (d === 'mergeable') {
    return 'CLEAN'
  }
  return (d || 'unknown').toUpperCase()
}

const isDraft = (mr: MrRow): boolean =>
  mr.draft === true || mr.work_in_progress === true || /^draft:/i.test(mr.title ?? '')

const toMergedPr = (row: MrRow & { merged_at: string }): MergedPr => ({
  number: row.iid,
  mergedAt: row.merged_at,
  updatedAt: row.updated_at ?? null,
  author: row.author?.username ?? 'unknown',
  labels: row.labels ?? [],
  headRef: row.source_branch ?? '',
  headSha: row.sha ?? '',
})

// --- threads: discussions -----------------------------------------------------

interface GlNote {
  id?: number
  body?: string
  type?: string | null
  resolvable?: boolean
  resolved?: boolean
  system?: boolean
  /** false on diff notes whose line left the diff — GitLab's "outdated". */
  active?: boolean
  created_at?: string
  author?: { username?: string; name?: string }
  position?: {
    new_path?: string
    old_path?: string
    new_line?: number | null
    old_line?: number | null
  } | null
}

interface GlDiscussion {
  id: string
  individual_note?: boolean
  notes?: GlNote[]
}

/** Project/group bot usernames are `project_<id>_bot_<suffix>` /
 *  `group_<id>_bot_<suffix>`; GitHub-style `[bot]` names show up on
 *  mirrored apps too. */
const isBotName = (username: string): boolean =>
  /^(?:project|group)_\d+_bot(?:_|$)/.test(username) || /\[bot\]$/.test(username)

/** Thread ids are COMPOSITE — `repo/iid/discussion-id`. GitHub's node ids
 *  are globally addressable; a GitLab discussion needs its project and MR
 *  to resolve, so the opaque-id contract carries the context. */
function toThreads(discussions: GlDiscussion[], t: PrTarget): ReviewThread[] {
  const out: ReviewThread[] = []
  for (const d of discussions) {
    const notes = (d.notes ?? []).filter((n) => n.system !== true)
    const first = notes[0]
    // a resolvable discussion is a review thread; individual notes and
    // unresolvable discussions are MR comments — not threads
    if (d.individual_note === true || first?.resolvable !== true) {
      continue
    }
    out.push({
      id: `${t.repo}/${t.pr}/${d.id}`,
      resolved: notes.every((n) => n.resolvable !== true || n.resolved === true),
      outdated: first.active === false,
      comment: {
        author: first.author?.username ?? 'unknown',
        bot: isBotName(first.author?.username ?? ''),
        path: first.position?.new_path ?? first.position?.old_path ?? null,
        line: first.position?.new_line ?? first.position?.old_line ?? null,
        body: first.body ?? '',
        createdAt: first.created_at ?? '',
      },
    })
  }
  return out
}

function parseThreadId(id: string): { repo: string; iid: number; did: string } {
  const m = /^(.+)\/(\d+)\/([\w-]+)$/.exec(id)
  if (!m) {
    throw new Error(`bad thread id "${id}" — expected repo/iid/discussion-id`)
  }
  return { repo: m[1]!, iid: Number(m[2]), did: m[3]! }
}

// --- checks: pipelines ---------------------------------------------------------

interface PipelineRow {
  id?: number
  sha?: string
  status?: string
}

interface JobRow {
  id?: number
  name?: string
  status?: string
}

const BUCKET: Record<string, string> = {
  success: 'pass',
  failed: 'fail',
  canceled: 'cancel',
  skipped: 'skipping',
  manual: 'skipping',
}
// created | waiting_for_resource | preparing | pending | running |
// scheduled → pending (default)

/** Run `fn` over `items` with at most `cap` in flight — a Promise pool:
 *  the win is overlapping `glab` processes. */
async function pooled<T>(items: T[], cap: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(cap, items.length) }, async () => {
      while (next < items.length) {
        await fn(items[next++]!) // NOSONAR — serial within a worker; the workers overlap
      }
    })
  )
}

/** The ReviewFacade bound to a dir — `glab api` runs there so host and
 *  project resolution follow the facade's repo, not cwd. */
export function gitlabReview(dir: string = process.cwd()): ReviewFacade {
  let host: string | undefined
  const hostOnce = (): string => (host ??= hostFor(dir))
  const link = (repo: string, pr: number): string =>
    `[#${pr}](https://${hostOnce()}/${repo}/-/merge_requests/${pr})`

  function getMr(t: PrTarget): MrRow {
    try {
      return glabJson<MrRow>(['api', api(t.repo, `merge_requests/${t.pr}`)], dir)
    } catch (err) {
      throw new Error(
        `merge request ${link(t.repo, t.pr)}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  function resolveRepo(positional: string[] = []): string {
    if (positional.length > 0) {
      // positionals join — a nested path arrives as either 'a/b/c' or
      // `a b c`, both mean the same project
      return positional.join('/')
    }
    const url = remoteUrl(dir)
    const path = url === undefined ? null : remoteParts(url)?.path
    if (!path) {
      throw new Error('no GitLab remote — pass GROUP/PROJECT or add an origin remote')
    }
    return path
  }

  function prMeta(t: PrTarget): PrMeta {
    const mr = getMr(t)
    return {
      state: toState(mr.state),
      isDraft: isDraft(mr),
      url: mr.web_url ?? '',
      headSha: mr.sha ?? '',
      headRef: mr.source_branch ?? '',
      mergeable: toMergeable(mr),
      mergeState: toMergeState(mr),
    }
  }

  function checks(t: PrTarget, _requiredOnly = false): CheckInfo[] {
    // requiredOnly can't narrow: GitLab requiredness is project-level
    // ("pipeline must succeed"), not per-job — every job counts.
    const head = getMr(t).sha ?? ''
    const pipes = glabPaged<PipelineRow>(api(t.repo, `merge_requests/${t.pr}/pipelines`), dir)
    const pipe = pipes.find((p) => p.sha === head) ?? pipes[0]
    if (!pipe?.id) {
      return []
    }
    const jobs = glabPaged<JobRow>(`projects/${encodeURIComponent(t.repo)}/pipelines/${pipe.id}/jobs`, dir)
    const bridges = glabPaged<JobRow>(
      `projects/${encodeURIComponent(t.repo)}/pipelines/${pipe.id}/bridges`,
      dir
    )
    return [...jobs, ...bridges].map((j) => ({
      name: j.name ?? `job-${j.id ?? '?'}`,
      state: (j.status ?? 'unknown').toUpperCase(),
      bucket: BUCKET[j.status ?? ''] ?? 'pending',
    }))
  }

  function reviewedShas(t: PrTarget): string[] {
    // MR diff versions — one per push that entered review
    const shas = new Set<string>()
    for (const v of glabPaged<{ head_commit_sha?: string }>(
      api(t.repo, `merge_requests/${t.pr}/versions`),
      dir
    )) {
      if (v.head_commit_sha) {
        shas.add(v.head_commit_sha)
      }
    }
    return [...shas]
  }

  async function reviewThreads(t: PrTarget): Promise<ReviewThread[]> {
    const discussions = await glabPagedAsync<GlDiscussion>(
      api(t.repo, `merge_requests/${t.pr}/discussions`),
      dir
    )
    return toThreads(discussions, t)
  }

  // --- merged MRs ---------------------------------------------------------------

  function mergedPrInfo(t: PrTarget, mergeSha?: string): MergedPrInfo {
    const mr = getMr(t)
    if (mr.state !== 'merged') {
      throw new Error(`MR ${link(t.repo, t.pr)} is not merged (state=${mr.state})`)
    }
    if (!mr.merged_at) {
      throw new Error(`MR ${link(t.repo, t.pr)} is merged but reports no merged_at`)
    }
    return {
      title: mr.title ?? '',
      url: mr.web_url ?? `https://${hostOnce()}/${t.repo}/-/merge_requests/${t.pr}`,
      mergedAt: mr.merged_at,
      mergeSha: mergeSha || mr.merge_commit_sha || mr.squash_commit_sha || '',
    }
  }

  function listMergedPrs(repo: string, q: MergedPrQuery): MergedPr[] {
    let endpoint = api(repo, 'merge_requests?state=merged&order_by=updated_at')
    if (q.author) {
      endpoint += `&author_username=${encodeURIComponent(q.author)}`
    }
    if (q.label) {
      endpoint += `&labels=${encodeURIComponent(q.label)}`
    }
    return glabPaged<MrRow>(endpoint, dir, q.limit ?? 100)
      .filter((row): row is MrRow & { merged_at: string } => row.merged_at != null)
      .map(toMergedPr)
  }

  function explicitMergedPrs(repo: string, ids: number[]): MergedPr[] {
    const out: MergedPr[] = []
    const failures: unknown[] = []
    // Dedup at the facade — duplicate ids would produce duplicate rows
    // that double-count in consumer aggregations.
    const unique = [...new Set(ids)]
    for (const number of unique) {
      try {
        const mr = getMr({ repo, pr: number })
        if (mr.state !== 'merged' || !mr.merged_at) {
          console.error(`warning: MR ${link(repo, number)} is not merged — skipped`)
          continue
        }
        out.push(toMergedPr({ ...mr, merged_at: mr.merged_at }))
      } catch (err) {
        failures.push(err)
        console.error(
          `warning: MR ${link(repo, number)} fetch failed — ` +
            `${err instanceof Error ? err.message : err}`
        )
      }
    }
    // Every fetch failing is one outage (auth, network, repo gone, no
    // glab on PATH), not N unmerged MRs — an empty return would read as
    // "all ids unmerged" and silently empty the caller's selection.
    if (failures.length > 0 && failures.length === unique.length) {
      const first = failures[0]
      throw new Error(
        `all ${unique.length} MR fetch(es) failed: ` +
          (first instanceof Error ? first.message : String(first))
      )
    }
    return out
  }

  function mergedPrs(repo: string, q: MergedPrQuery = {}): MergedPr[] {
    if (q.ids !== undefined) {
      return explicitMergedPrs(repo, q.ids)
    }
    return listMergedPrs(repo, q)
  }

  // --- bulk probes ----------------------------------------------------------------

  /** Pooled REST probe — GitLab has no aliased bulk query, but the pool
   *  still overlaps each MR's meta+discussions pair. Misses stay out of
   *  the map — the caller's serial per-MR path reports them properly. */
  async function scanMergedPrs(
    targets: PrTarget[],
    opts?: ScanOpts
  ): Promise<Map<number, MergedPrScan>> {
    const out = new Map<number, MergedPrScan>()
    let done = 0
    await pooled(targets, opts?.concurrency ?? 4, async (t) => {
      try {
        const mr = await glabJsonAsync<MrRow>(['api', api(t.repo, `merge_requests/${t.pr}`)], dir)
        // non-merged/missing MRs stay out — the serial fallback decides
        if (mr.state !== 'merged' || !mr.merged_at) {
          return
        }
        const threads = toThreads(
          await glabPagedAsync<GlDiscussion>(
            api(t.repo, `merge_requests/${t.pr}/discussions`),
            dir
          ),
          t
        )
        out.set(t.pr, {
          info: {
            title: mr.title ?? '',
            url: mr.web_url ?? `https://${hostOnce()}/${t.repo}/-/merge_requests/${t.pr}`,
            mergedAt: mr.merged_at,
            mergeSha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? '',
          },
          threads,
          labels: mr.labels ?? [],
          updatedAt: mr.updated_at ?? null,
        })
      } catch (err) {
        console.error(
          `warning: bulk scan of ${link(t.repo, t.pr)} failed — ` +
            `${err instanceof Error ? err.message : err}`
        )
      } finally {
        done += 1
        opts?.onProgress?.(done, targets.length)
      }
    })
    return out
  }

  /** Pooled label writes — one PUT does add+remove and its response IS
   *  the MR, so post-write `updated_at` needs no re-query. Missing keys
   *  are failed writes. */
  async function labelPrs(
    ops: PrLabelOp[],
    opts?: { concurrency?: number }
  ): Promise<Map<number, string | null>> {
    const out = new Map<number, string | null>()
    await pooled(ops, opts?.concurrency ?? 4, async (op) => {
      const args = ['api', '-X', 'PUT', api(op.t.repo, `merge_requests/${op.t.pr}`)]
      if (op.add.length > 0) {
        args.push('-f', `add_labels=${op.add.join(',')}`)
      }
      if (op.remove.length > 0) {
        args.push('-f', `remove_labels=${op.remove.join(',')}`)
      }
      try {
        const mr = await glabJsonAsync<MrRow>(args, dir)
        out.set(op.t.pr, mr.updated_at ?? null)
      } catch (err) {
        // a failed write leaves the MR unlabeled — next collect rescans it
        console.error(
          `warning: label write on ${link(op.t.repo, op.t.pr)} failed — ` +
            `${err instanceof Error ? err.message : err}`
        )
      }
    })
    return out
  }

  return {
    resolveRepo,
    prLink: link,
    currentPr() {
      // GitLab allows at most one open MR per source→target pair; the
      // most recently updated open MR for the checked-out branch is the
      // answer, else the latest in any state (callers check state).
      try {
        const b = gitTry(['-C', dir, 'branch', '--show-current'])
        const branch = b.code === 0 ? b.out.trim() : ''
        if (branch === '') {
          return null
        }
        const repo = resolveRepo([])
        const enc = encodeURIComponent(branch)
        const open = glabJson<MrRow[]>(
          [
            'api',
            api(
              repo,
              `merge_requests?source_branch=${enc}&state=opened&order_by=updated_at&per_page=1`
            ),
          ],
          dir
        )
        const mr =
          open[0] ??
          glabJson<MrRow[]>(
            ['api', api(repo, `merge_requests?source_branch=${enc}&order_by=updated_at&per_page=1`)],
            dir
          )[0]
        if (!mr) {
          return null
        }
        return { pr: mr.iid, state: toState(mr.state), url: mr.web_url ?? '' }
      } catch {
        return null
      }
    },
    prsForBranch(branch) {
      return glabPaged<MrRow>(
        api(
          resolveRepo([]),
          `merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`
        ),
        dir
      ).map((m) => m.iid)
    },
    parsePrRef(text) {
      const host = hostOnce().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp(`${host}/([\\w./-]+?)/-/merge_requests/(\\d+)`, 'i').exec(text)
      return m ? { repo: m[1]!, pr: Number(m[2]) } : null
    },
    prMeta,
    mergedPrInfo,
    mergedPrs,
    scanMergedPrs,
    labelPrs,
    checks,
    checkAnnotations() {
      // GitLab jobs have no annotations endpoint — an absent key already
      // means exactly that in the contract, so the map stays empty.
      return new Map<string, number | null>()
    },
    reviewedShas,
    reviewThreads,
    labels(t) {
      return getMr(t).labels ?? []
    },
    prUpdatedAt(t) {
      return getMr(t).updated_at ?? null
    },
    createLabel(repo, name, color) {
      const res = glabTry(
        ['api', '-X', 'POST', api(repo, 'labels'), '-f', `name=${name}`, '-f', `color=${color}`],
        dir
      )
      if (res.code === 0) {
        return
      }
      // idempotent — "already exists" updates in place; a real failure
      // surfaces through the PUT's own error
      if (/already|409|taken/i.test(`${res.err} ${res.out}`)) {
        glab(
          ['api', '-X', 'PUT', api(repo, 'labels'), '-f', `name=${name}`, '-f', `color=${color}`],
          dir
        )
        return
      }
      throw new Error(`glab api failed: ${res.err}`)
    },
    addLabel(t, label) {
      glab(['api', '-X', 'PUT', api(t.repo, `merge_requests/${t.pr}`), '-f', `add_labels=${label}`], dir)
    },
    removeLabel(t, label) {
      // ensure-absent — remove_labels on an MR without it is a no-op
      glab(
        ['api', '-X', 'PUT', api(t.repo, `merge_requests/${t.pr}`), '-f', `remove_labels=${label}`],
        dir
      )
    },
    resolveThread(id, unresolve = false) {
      const t = parseThreadId(id)
      glab(
        [
          'api',
          '-X',
          'PUT',
          api(t.repo, `merge_requests/${t.iid}/discussions/${t.did}`),
          '-f',
          `resolved=${unresolve ? 'false' : 'true'}`,
        ],
        dir
      )
    },
    replyThread(id, body) {
      const t = parseThreadId(id)
      glab(
        [
          'api',
          '-X',
          'POST',
          api(t.repo, `merge_requests/${t.iid}/discussions/${t.did}/notes`),
          '-f',
          `body=${body}`,
        ],
        dir
      )
    },
    updateBranch(t, expectedHeadSha) {
      // the rebase endpoint takes no expected-sha param — check the head
      // first; a moved head is a refusal. The rebase itself is accepted
      // async (202): the caller re-polls state either way.
      try {
        if ((getMr(t).sha ?? '') !== expectedHeadSha) {
          return false
        }
      } catch {
        return false
      }
      return glabTry(['api', '-X', 'PUT', api(t.repo, `merge_requests/${t.pr}/rebase`)], dir)
        .code === 0
    },
    mergePr(t, opts) {
      const args = [
        'api',
        '-X',
        'PUT',
        api(t.repo, `merge_requests/${t.pr}/merge`),
        '-f',
        `sha=${opts.expectedHeadSha}`, // moved head → 406, fails closed
      ]
      if (opts.method === 'squash') {
        args.push('-f', 'squash=true', '-f', 'merge_method=merge')
      } else {
        args.push('-f', `merge_method=${opts.method === 'rebase' ? 'rebase_merge' : 'merge'}`)
      }
      if (opts.deleteBranch) {
        args.push('-f', 'should_remove_source_branch=true')
      }
      // no admin analog — GitLab's merge API applies project rules
      console.log(glab(args, dir))
      // auto-merge accepts an MR without landing it — only the
      // authoritative state tells the caller what actually happened
      const after = getMr(t)
      return toState(after.state)
    },
  }
}

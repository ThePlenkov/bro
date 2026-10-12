/**
 * Codacy debt source — the repo's current issues via the Codacy API v3
 * issues search (spec: specs/bro-huy5o.5.md).
 *
 * Transport is `curl` POST like the sonarcloud collector's GET — the
 * collectors are synchronous and no official codacy CLI exists. The
 * credential header rides a 0600 file (`-H @file`), never argv: every
 * local user can `ps`. Auth is `api-token: <CODACY_API_TOKEN>` (account
 * token) or `project-token: <CODACY_PROJECT_TOKEN>` (repo-scoped).
 *
 * `thread_id` is `codacy:<issueId>` — stable across runs, so the
 * ledger's thread_id upsert dedups re-collects.
 */
import {
  assertTokenSafeHost,
  baseRecord,
  curlJson,
  dedupeByThreads,
  SourceSkipped,
  stripSlashes,
  type CollectCtx,
  type DedupeDupe,
} from './collectors.ts'
import type { DebtPriority, DebtRecord } from './types.ts'

export const CODACY_HOST = 'https://api.codacy.com'
export const CODACY_UI_HOST = 'https://app.codacy.com'
const PAGE_SIZE = 500
/** Cursor pagination — past the cap the fetch throws rather than return
 *  a partial list the caller would treat as complete (omitted live
 *  issues would be swept as resolved). */
const MAX_PAGES = 20

export interface CodacyRepo {
  provider: string
  org: string
  repo: string
  host: string
  uiHost: string
}

/** API coordinates — `ctx.repo` (`owner/name`) splits at the LAST slash
 *  so GitLab subgroups keep their full group path; `provider` and `host`
 *  come from `debt.sourceConfig.codacy` (default `gh` + api.codacy.com).
 *  A custom host is trusted — it comes from bro config, the same layer
 *  that drives agent command templates; the UI host follows the API host
 *  for self-hosted installs, app.codacy.com for the cloud default. */
export function resolveCodacyRepo(
  repoSlug: string,
  cfg?: Record<string, unknown>
): CodacyRepo {
  const slash = repoSlug.lastIndexOf('/')
  const provider =
    typeof cfg?.provider === 'string' && cfg.provider !== '' ? cfg.provider : 'gh'
  const host = stripSlashes(
    typeof cfg?.host === 'string' && cfg.host !== '' ? cfg.host : CODACY_HOST
  )
  return {
    provider,
    org: slash === -1 ? repoSlug : repoSlug.slice(0, slash),
    repo: slash === -1 ? repoSlug : repoSlug.slice(slash + 1),
    host,
    uiHost: host === CODACY_HOST ? CODACY_UI_HOST : host,
  }
}

/** `CODACY_API_TOKEN` (account token → `api-token:` header) wins;
 *  `CODACY_PROJECT_TOKEN` (repo-scoped → `project-token:`) is the
 *  fallback. Missing both skips the source. */
export function codacyToken(): { header: string; value: string } {
  const api = process.env['CODACY_API_TOKEN']?.trim()
  if (api !== undefined && api !== '') {
    return { header: 'api-token', value: api }
  }
  const proj = process.env['CODACY_PROJECT_TOKEN']?.trim()
  if (proj !== undefined && proj !== '') {
    return { header: 'project-token', value: proj }
  }
  throw new SourceSkipped(
    'neither CODACY_API_TOKEN nor CODACY_PROJECT_TOKEN set — ' +
      'create one at app.codacy.com → account → API tokens (or the repo\u2019s Project Settings → Integrations → Project API)'
  )
}

function curlPost(url: string, body: string): unknown {
  const t = codacyToken()
  return curlJson(url, [`${t.header}: ${t.value}`, 'Content-Type: application/json'], {
    label: 'codacy',
    method: 'POST',
    body,
  })
}

interface CodacyIssue {
  issueId?: string
  commitIssue?: {
    patternInfo?: {
      id?: string
      level?: string
      severityLevel?: string
      title?: string
      category?: string
    }
    toolInfo?: { name?: string }
    filePath?: string
    lineNumber?: number
    message?: string
    commitInfo?: { timestamp?: string }
  }
}

/** Every page of the issues search — `pagination.cursor` is the next
 *  page's cursor, absent at the end. Truncating would drop real findings
 *  and falsely resolve ledger rows that still exist upstream. */
function codacySearchAll(url: string, body: string): CodacyIssue[] {
  const items: CodacyIssue[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor !== undefined) {
      qs.set('cursor', cursor)
    }
    const resp = curlPost(`${url}?${qs.toString()}`, body) as {
      data?: CodacyIssue[]
      pagination?: { cursor?: string }
    }
    const batch = resp.data ?? []
    items.push(...batch)
    const next = resp.pagination?.cursor
    if (next === undefined || next === '' || batch.length === 0 || seen.has(next)) {
      return items
    }
    seen.add(next)
    cursor = next
  }
  // The window ran out with results still unfetched — returning the
  // partial list as success would let the upstream-resolve sweep mark
  // the omitted live issues done. Fail the source; the ledger is untouched.
  throw new Error(
    `codacy: results exceed the ${MAX_PAGES * PAGE_SIZE}-row window at ${url} — ` +
      'refusing a partial fetch'
  )
}

function issuePriority(level: string | undefined): DebtPriority {
  switch (level) {
    case 'Error':
    case 'Critical':
      return 'blocking'
    case 'Info':
    case 'Minor':
      return 'nit'
    default:
      return 'scan' // Warning/Major or absent
  }
}

/** The repo's current issues — Codacy keeps only the latest analysis's
 *  set, so this IS the on-new-code issue list. `opts.cfg` is
 *  `debt.sourceConfig.codacy` from bro.config. */
export function collectCodacy(
  ctx: CollectCtx,
  opts: { cfg?: Record<string, unknown> } = {}
): DebtRecord[] {
  codacyToken() // fail-fast before any request — a skipped source sweeps nothing
  const target = resolveCodacyRepo(ctx.repo, opts.cfg)
  assertTokenSafeHost(target.host, 'codacy')
  const base =
    `${target.host}/api/v3/analysis/organizations/${encodeURIComponent(target.provider)}` +
    `/${encodeURIComponent(target.org)}/repositories/${encodeURIComponent(target.repo)}/issues/search`
  const issues = codacySearchAll(base, '{}')
  const issuesUrl = `${target.uiHost}/${target.provider}/${target.org}/${target.repo}/issues`
  const out: DebtRecord[] = []
  for (const i of issues) {
    const id = i.issueId
    if (id === undefined || id === '') {
      continue // an unkeyed issue can't dedup across collects — skip it
    }
    const ci = i.commitIssue ?? {}
    const level = ci.patternInfo?.level ?? ci.patternInfo?.severityLevel
    const tool = ci.toolInfo?.name ?? 'codacy'
    out.push(
      baseRecord(ctx, {
        threadId: `codacy:${id}`,
        url: issuesUrl,
        priority: issuePriority(level),
        path: ci.filePath ?? '',
        line: typeof ci.lineNumber === 'number' ? ci.lineNumber : null,
        author: 'codacy',
        body: `[${level ?? 'Warning'}] ${tool}: ${ci.patternInfo?.title ?? ci.message ?? 'codacy issue'}`,
        createdAt: ci.commitInfo?.timestamp ?? ctx.harvestedAt,
        source: 'codacy',
      })
    )
  }
  return out
}

/** The issue id a codacy thread_id carries — `codacy:<issueId>`. */
export function codacyKeyOf(threadId: string): string {
  return threadId.replace(/^codacy:/, '')
}

/** Coverage needs an actual link back — the issue id as a whole token
 *  after `issueId=`/`issues=` in a `?`/`&` query param. A bare token
 *  match lets any prose or code mention of the id suppress a live
 *  finding. */
function bodyMentionsKey(body: string, key: string): boolean {
  if (key === '') return false
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`[?&](?:issueId|issues)=${k}(?![A-Za-z0-9_-])`).test(body)
}

/** Review-thread dedupe (spec: specs/bro-huy5o.5.md). Codacy's GitHub
 *  integration posts inline comments — a fresh codacy record is dropped
 *  when an OPEN review-thread row covers it: same path+line, or the
 *  comment body links back with the issue id. */
export function dedupeCodacyThreads(
  records: DebtRecord[],
  existing: DebtRecord[]
): { kept: DebtRecord[]; duped: DedupeDupe[] } {
  return dedupeByThreads(records, existing, (rec, thread) => {
    return (
      (rec.path !== '' &&
        thread.path === rec.path &&
        thread.line !== null &&
        thread.line === rec.line) ||
      bodyMentionsKey(thread.body, codacyKeyOf(rec.thread_id))
    )
  })
}

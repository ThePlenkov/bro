/**
 * CodeScene debt source — code-health delta-analysis findings via the
 * CodeScene cloud API v2 (spec: specs/bro-huy5o.5.md).
 *
 * The API is read-only: delta analyses are produced by CodeScene's own
 * Git-provider PR integration and read back — `GET
 * /v2/projects/{id}/delta-analyses` pages the history, `/{deltaId}`
 * carries the detail (file_results is detail-only). Transport is `curl`
 * like the other HTTP sources; `CODESCENE_TOKEN` rides a 0600 header
 * file as `Authorization: Bearer`, never argv.
 *
 * `thread_id`s embed the analysis id — `codescene:<id>:gate:<gate>` /
 * `codescene:<id>:file:<path>` — a delta verdict is immutable history,
 * so rows persist until a fix verdict; the upstream-resolve sweep only
 * fires if CodeScene stops returning the analysis.
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
import type { DebtRecord } from './types.ts'

export const CODESCENE_HOST = 'https://api.codescene.io'
export const CODESCENE_UI_HOST = 'https://codescene.io'
/** `max_pages` follow — past the cap the fetch throws rather than return
 *  a partial list the caller would treat as complete (analyses omitted
 *  upstream would be swept as resolved). */
const MAX_PAGES = 20

export interface CodesceneProject {
  projectId: string
  host: string
  uiHost: string
  via: 'config' | 'env'
}

/** `debt.sourceConfig.codescene.project_id` (number or string) wins,
 *  then `CODESCENE_PROJECT_ID` — the env convention CodeScene's own CI
 *  docs use. A custom `host` is trusted (bro config is the trust layer);
 *  the UI host follows it for self-hosted installs, codescene.io for the
 *  cloud default. Null when nothing resolves — callers decide between
 *  skip (collect) and warn (doctor). */
export function resolveCodesceneProject(
  cfg?: Record<string, unknown>
): CodesceneProject | null {
  const host = stripSlashes(
    typeof cfg?.host === 'string' && cfg.host !== '' ? cfg.host : CODESCENE_HOST
  )
  const uiHost = host === CODESCENE_HOST ? CODESCENE_UI_HOST : host
  const cfgId = cfg?.project_id
  if (typeof cfgId === 'number' && Number.isFinite(cfgId)) {
    return { projectId: String(cfgId), host, uiHost, via: 'config' }
  }
  if (typeof cfgId === 'string' && cfgId.trim() !== '') {
    return { projectId: cfgId.trim(), host, uiHost, via: 'config' }
  }
  const envId = process.env['CODESCENE_PROJECT_ID']?.trim()
  if (envId !== undefined && envId !== '') {
    return { projectId: envId, host, uiHost, via: 'env' }
  }
  return null
}

export function codesceneToken(): string {
  const t = process.env['CODESCENE_TOKEN']?.trim()
  if (t === undefined || t === '') {
    throw new SourceSkipped(
      'CODESCENE_TOKEN not set — create one at codescene.io → Account → API tokens'
    )
  }
  return t
}

function curlGet(url: string): unknown {
  return curlJson(url, [`Authorization: Bearer ${codesceneToken()}`], {
    label: 'codescene',
  })
}

interface CsFileResult {
  file?: string
  loc?: number
  'old-loc'?: number
  code_health?: number
  old_code_health?: number
}

interface CsDelta {
  id?: number | string
  repository?: string
  base_ref?: string
  delta_branch_head?: string
  commits?: string[]
  authors?: string[]
  analysistime?: number | string
  code_health?: number
  old_code_health?: number
  failed_gates?: unknown
  external_review_id?: string | number
  file_results?: CsFileResult[]
}

/** Every page of the delta-analyses list — `page`/`max_pages` follow.
 *  Truncating would drop real findings and falsely resolve ledger rows
 *  whose analyses are still upstream. */
function codesceneDeltaAll(project: CodesceneProject): CsDelta[] {
  const base = `${project.host}/v2/projects/${encodeURIComponent(project.projectId)}/delta-analyses`
  const items: CsDelta[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const resp = curlGet(`${base}?page=${page}`) as {
      page?: number
      max_pages?: number
      delta_analyses?: CsDelta[]
    }
    items.push(...(resp.delta_analyses ?? []))
    const maxPages = resp.max_pages ?? 1
    if ((resp.page ?? page) >= maxPages) {
      return items
    }
  }
  throw new Error(
    `codescene: delta analyses exceed the ${MAX_PAGES}-page window — ` +
      'refusing a partial fetch'
  )
}

/** `failed_gates` is loosely typed upstream — an object
 *  `{<gate>: true|details}` normally, tolerated as array or string. */
export function failedGates(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === false) {
    return []
  }
  if (typeof raw === 'string') {
    return raw === '' ? [] : [raw]
  }
  if (Array.isArray(raw)) {
    return raw
      .flatMap((g) => (typeof g === 'object' && g !== null ? failedGates(g) : [String(g)]))
      .filter((g) => g !== '')
  }
  if (typeof raw === 'object') {
    return Object.entries(raw)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k)
  }
  return []
}

/** `analysistime` arrives as epoch seconds, epoch milliseconds, or an
 *  ISO string depending on deployment — normalize to ISO, harvest time
 *  as the fallback. */
export function parseAnalysisTime(raw: unknown, fallback: string): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw > 1e12 ? raw : raw * 1000).toISOString()
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') {
      return fallback
    }
    const n = Number(s)
    if (Number.isFinite(n)) {
      return parseAnalysisTime(n, fallback)
    }
    const t = Date.parse(s)
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString()
    }
  }
  return fallback
}

function healthDeclined(a: {
  code_health?: number
  old_code_health?: number
}): boolean {
  return (
    typeof a.code_health === 'number' &&
    typeof a.old_code_health === 'number' &&
    a.code_health < a.old_code_health
  )
}

/** Findings from the project's stored delta analyses. An analysis is
 *  interesting when `failed_gates` is non-empty or its code health
 *  declined — only those get the detail fetch that carries
 *  `file_results`. `opts.cfg` is `debt.sourceConfig.codescene` from
 *  bro.config. */
export function collectCodescene(
  ctx: CollectCtx,
  opts: { cfg?: Record<string, unknown> } = {}
): DebtRecord[] {
  codesceneToken() // fail-fast before any request — a skipped source sweeps nothing
  const project = resolveCodesceneProject(opts.cfg)
  if (project === null) {
    throw new SourceSkipped(
      'no project id — set debt.sourceConfig.codescene.project_id or CODESCENE_PROJECT_ID ' +
        '(the number in codescene.io/projects/<id>)'
    )
  }
  assertTokenSafeHost(project.host, 'codescene')
  const analyses = codesceneDeltaAll(project)
  const out: DebtRecord[] = []
  for (const a of analyses) {
    const id = a.id
    if (id === undefined || id === null || id === '') {
      continue // an unkeyed analysis can't dedup across collects
    }
    const gates = failedGates(a.failed_gates)
    if (gates.length === 0 && !healthDeclined(a)) {
      continue
    }
    const detail = curlGet(
      `${project.host}/v2/projects/${encodeURIComponent(project.projectId)}` +
        `/delta-analyses/${encodeURIComponent(String(id))}`
    ) as CsDelta
    const merged: CsDelta = { ...a, ...detail }
    const createdAt = parseAnalysisTime(merged.analysistime, ctx.harvestedAt)
    const author = merged.authors?.[0] ?? 'codescene'
    const url = `${project.uiHost}/projects/${encodeURIComponent(project.projectId)}` +
      `/delta-analysis/${encodeURIComponent(String(id))}`
    const delta =
      merged.code_health !== undefined || merged.old_code_health !== undefined
        ? ` — code health ${merged.old_code_health ?? '?'} → ${merged.code_health ?? '?'}`
        : ''
    for (const gate of gates) {
      out.push(
        baseRecord(ctx, {
          threadId: `codescene:${id}:gate:${gate}`,
          url,
          priority: 'blocking',
          path: '',
          author,
          body: `failed gate ${gate}${delta}${merged.repository ? ` on ${merged.repository}` : ''}`,
          createdAt,
          source: 'codescene',
        })
      )
    }
    for (const f of merged.file_results ?? []) {
      if (!healthDeclined(f) || f.file === undefined || f.file === '') {
        continue
      }
      out.push(
        baseRecord(ctx, {
          threadId: `codescene:${id}:file:${f.file}`,
          url,
          priority: 'scan',
          path: f.file,
          author,
          body: `code health declined ${f.old_code_health} → ${f.code_health}`,
          createdAt,
          source: 'codescene',
        })
      )
    }
  }
  return out
}

/** The delta analysis id a codescene thread_id carries —
 *  `codescene:<id>:gate|file:<rest>`. */
export function codesceneDeltaIdOf(threadId: string): string {
  const m = /^codescene:([^:]+):/.exec(threadId)
  return m?.[1] ?? ''
}

/** Coverage needs an actual link back — the analysis id right after a
 *  `delta-analysis/`/`delta-analyses/` path segment in the thread body.
 *  A bare id match lets any prose or code mention suppress a live
 *  finding. */
function bodyMentionsDelta(body: string, id: string): boolean {
  if (id === '') return false
  const k = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`delta-analys(?:is|es)/${k}(?![0-9A-Za-z_-])`).test(body)
}

/** Review-thread dedupe (spec: specs/bro-huy5o.5.md). CodeScene's PR
 *  integration posts its Code Review verdict — a fresh codescene record
 *  is dropped when an OPEN review-thread row links back to the same
 *  delta analysis. Path-only matching is deliberately absent: file-level
 *  findings carry no line, so a human comment on the same file must not
 *  suppress the finding. */
export function dedupeCodesceneThreads(
  records: DebtRecord[],
  existing: DebtRecord[]
): { kept: DebtRecord[]; duped: DedupeDupe[] } {
  return dedupeByThreads(records, existing, (rec, thread) =>
    bodyMentionsDelta(thread.body, codesceneDeltaIdOf(rec.thread_id))
  )
}

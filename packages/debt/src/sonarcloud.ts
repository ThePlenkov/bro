/**
 * SonarCloud debt source — open issues + security hotspots on new code
 * via the Sonar Web API (spec: specs/bro-huy5o.4.md).
 *
 * Transport is `curl` GET like the linear connector's sync path — the
 * collectors are synchronous and no official sonar CLI exists. The
 * Authorization header rides a 0600 file (`-H @file`), never argv:
 * every local user can `ps`. Auth is `Basic base64(<SONAR_TOKEN>:)` —
 * Sonar's token-as-username convention.
 *
 * `thread_id` is `sonarcloud:<issueKey>` / `sonarcloud:hotspot:<key>` —
 * stable across runs, so the ledger's thread_id upsert dedups re-collects.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseRecord, SourceSkipped, type CollectCtx } from './collectors.ts'
import type { DebtPriority, DebtRecord } from './types.ts'

export const SONAR_HOST = 'https://sonarcloud.io'
const TIMEOUT_MS = 30_000
const PAGE_SIZE = 500
/** issues/search refuses offsets past 10_000 — a leak period that deep
 *  is a misconfigured project, not debt to harvest. */
const MAX_PAGES = 20

export interface SonarProject {
  projectKey: string
  host: string
  /** where the key came from — reported by doctor's detail line */
  via: 'config' | 'properties'
}

/** `sonar-project.properties` — flat `key=value`, `#`/`!` comments.
 *  Only the two keys bro needs are read. */
export function parseSonarProperties(text: string): {
  projectKey?: string
  host?: string
} {
  const out: { projectKey?: string; host?: string } = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) {
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'sonar.projectKey' && value !== '') {
      out.projectKey = value
    } else if (key === 'sonar.host.url' && value !== '') {
      out.host = value.replace(/\/+$/, '')
    }
  }
  return out
}

/** Both properties conventions: `sonar-project.properties` (scanner
 *  config) and `.sonarcloud.properties` (Automatic Analysis) — the
 *  former wins when a repo carries both. */
const PROPERTIES_FILES = ['sonar-project.properties', '.sonarcloud.properties']

/** Project key + host — `debt.sonarcloud.{project_key,host}` in config
 *  wins, then the properties file at the checkout root; host falls back
 *  to sonarcloud.io so SonarQube Server works via `sonar.host.url`
 *  (same API). Null when no key resolves — callers decide between skip
 *  (collect) and warn (doctor). */
export function resolveSonarProject(
  dir: string,
  cfg?: { project_key?: string; host?: string }
): SonarProject | null {
  let propsFile: { projectKey?: string; host?: string } = {}
  for (const name of PROPERTIES_FILES) {
    try {
      const p = parseSonarProperties(readFileSync(join(dir, name), 'utf8'))
      // the earlier convention wins per key; the later one fills gaps
      propsFile = {
        projectKey: propsFile.projectKey ?? p.projectKey,
        host: propsFile.host ?? p.host,
      }
    } catch {
      // absent or unreadable — try the next convention
    }
  }
  const cfgKey =
    typeof cfg?.project_key === 'string' && cfg.project_key !== ''
      ? cfg.project_key
      : undefined
  const fromConfig = cfgKey !== undefined
  const projectKey = cfgKey ?? propsFile.projectKey
  if (projectKey === undefined || projectKey === '') {
    return null
  }
  return {
    projectKey,
    host: (cfg?.host ?? propsFile.host ?? SONAR_HOST).replace(/\/+$/, ''),
    via: fromConfig ? 'config' : 'properties',
  }
}

export function sonarToken(): string {
  const t = process.env['SONAR_TOKEN']?.trim()
  if (t === undefined || t === '') {
    throw new SourceSkipped(
      'SONAR_TOKEN not set — create one at sonarcloud.io → My Account → Security → Generate Tokens'
    )
  }
  return t
}

function curlGet(url: string): unknown {
  // Token never rides argv — every local user can `ps`: the header is a
  // 0600 file in a private tmpdir that lives only for the spawn.
  const dir = mkdtempSync(join(tmpdir(), 'bro-sonar-hdr-'))
  try {
    const hdr = join(dir, 'auth')
    const basic = Buffer.from(`${sonarToken()}:`).toString('base64')
    writeFileSync(hdr, `Authorization: Basic ${basic}\n`, { mode: 0o600 })
    const res = spawnSync(
      'curl', // NOSONAR — PATH lookup is the contract (curl like gh/glab/bd)
      [
        '-sS',
        '--fail-with-body',
        '--max-time',
        String(Math.ceil(TIMEOUT_MS / 1000)),
        '-H',
        `@${hdr}`,
        url,
      ],
      { encoding: 'utf8', timeout: TIMEOUT_MS + 15_000, maxBuffer: 64 * 1024 * 1024 }
    )
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code
      throw new Error(
        code === 'ENOENT'
          ? 'sonarcloud: curl not found — the sync transport needs curl on PATH'
          : `sonarcloud: curl failed — ${res.error.message}`
      )
    }
    if (res.status !== 0) {
      const detail = res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(0, 300)
      throw new Error(
        `sonarcloud: request failed — ${detail !== '' ? detail : `curl exited ${res.status}`}`
      )
    }
    try {
      return JSON.parse(res.stdout)
    } catch {
      throw new Error(`sonarcloud: non-JSON response — ${res.stdout.slice(0, 200)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface SonarComponent {
  key: string
  path?: string
}

interface Paged {
  paging?: { total?: number }
  components?: SonarComponent[]
}

/** Every page of a paged endpoint — truncating at page 1 would drop real
 *  findings and falsely resolve ledger rows that still exist upstream.
 *  `components` carry component key → file path across all pages. */
function sonarGetAll<T extends { key: string }>(
  base: string,
  params: Record<string, string>,
  pick: (r: Paged) => T[] | undefined
): { items: T[]; components: Map<string, string> } {
  const items: T[] = []
  const components = new Map<string, string>()
  for (let p = 1; p <= MAX_PAGES; p += 1) {
    const qs = new URLSearchParams({ ...params, ps: String(PAGE_SIZE), p: String(p) })
    const resp = curlGet(`${base}?${qs.toString()}`) as Paged
    for (const c of resp.components ?? []) {
      if (typeof c.path === 'string') {
        components.set(c.key, c.path)
      }
    }
    const page = pick(resp) ?? []
    items.push(...page)
    const total = resp.paging?.total ?? page.length
    if (items.length >= total || page.length === 0) {
      break
    }
  }
  return { items, components }
}

interface SonarIssue {
  key: string
  rule?: string
  severity?: string
  component?: string
  line?: number
  message?: string
  creationDate?: string
}

interface SonarHotspot {
  key: string
  component?: string
  line?: number
  message?: string
  vulnerabilityProbability?: string
  creationDate?: string
}

/** component keys are `<projectKey>:<path>` — the `components` array
 *  carries the real path; the prefix strip is the fallback. */
function componentPath(
  component: string | undefined,
  byKey: Map<string, string>,
  projectKey: string
): string {
  if (component === undefined) {
    return ''
  }
  const known = byKey.get(component)
  if (known !== undefined) {
    return known
  }
  const prefix = `${projectKey}:`
  return component.startsWith(prefix) ? component.slice(prefix.length) : component
}

function issuePriority(severity: string | undefined): DebtPriority {
  switch (severity) {
    case 'BLOCKER':
    case 'CRITICAL':
      return 'blocking'
    case 'MINOR':
    case 'INFO':
      return 'nit'
    default:
      return 'scan' // MAJOR or absent
  }
}

function hotspotPriority(probability: string | undefined): DebtPriority {
  switch (probability) {
    case 'HIGH':
      return 'blocking'
    case 'LOW':
      return 'nit'
    default:
      return 'scan' // MEDIUM or absent
  }
}

/** The serving project's open findings on new code — issues plus
 *  TO_REVIEW security hotspots, both `sinceLeakPeriod=true` so the
 *  ledger tracks what merged work introduced, not the project's whole
 *  backlog. `opts.cfg` is `debt.sonarcloud` from bro.config; `opts.dir`
 *  is the checkout root for `sonar-project.properties`. */
export function collectSonarcloud(
  ctx: CollectCtx,
  opts: { dir?: string; cfg?: { project_key?: string; host?: string } } = {}
): DebtRecord[] {
  const project = resolveSonarProject(opts.dir ?? process.cwd(), opts.cfg)
  if (project === null) {
    throw new SourceSkipped(
      'no project key — set debt.sonarcloud.project_key in bro.config or sonar.projectKey in sonar-project.properties / .sonarcloud.properties'
    )
  }
  sonarToken() // fail-fast before any request — a skipped source sweeps nothing
  const base = `${project.host}/api`
  const issues = sonarGetAll<SonarIssue>(
    `${base}/issues/search`,
    { componentKeys: project.projectKey, resolved: 'false', sinceLeakPeriod: 'true' },
    (r) => (r as { issues?: SonarIssue[] }).issues
  )
  const hotspots = sonarGetAll<SonarHotspot>(
    `${base}/hotspots/search`,
    { projectKey: project.projectKey, status: 'TO_REVIEW', sinceLeakPeriod: 'true' },
    (r) => (r as { hotspots?: SonarHotspot[] }).hotspots
  )
  const out: DebtRecord[] = []
  for (const i of issues.items) {
    out.push(
      baseRecord(ctx, {
        threadId: `sonarcloud:${i.key}`,
        url: `${project.host}/project/issues?id=${encodeURIComponent(project.projectKey)}&open=${encodeURIComponent(i.key)}`,
        priority: issuePriority(i.severity),
        path: componentPath(i.component, issues.components, project.projectKey),
        line: typeof i.line === 'number' ? i.line : null,
        author: 'sonarcloud',
        body: `[${i.severity ?? 'MAJOR'}] ${i.rule ?? 'unknown'}: ${i.message ?? 'sonar issue'}`,
        createdAt: i.creationDate ?? ctx.harvestedAt,
        source: 'sonarcloud',
      })
    )
  }
  for (const h of hotspots.items) {
    out.push(
      baseRecord(ctx, {
        threadId: `sonarcloud:hotspot:${h.key}`,
        url: `${project.host}/project/security_hotspots?id=${encodeURIComponent(project.projectKey)}&hotspots=${encodeURIComponent(h.key)}`,
        priority: hotspotPriority(h.vulnerabilityProbability),
        path: componentPath(h.component, hotspots.components, project.projectKey),
        line: typeof h.line === 'number' ? h.line : null,
        author: 'sonarcloud',
        body: `[hotspot ${h.vulnerabilityProbability ?? 'MEDIUM'}] ${h.message ?? 'security hotspot'}`,
        createdAt: h.creationDate ?? ctx.harvestedAt,
        source: 'sonarcloud',
      })
    )
  }
  return out
}

/** One dropped sonarcloud record plus the open row that covers it. */
export interface SonarDupe {
  record: DebtRecord
  coveredBy: string
}

/** The issue key a sonarcloud thread_id carries —
 *  `sonarcloud:KEY` / `sonarcloud:hotspot:KEY`. */
export function sonarKeyOf(threadId: string): string {
  return threadId.replace(/^sonarcloud:(hotspot:)?/, '')
}

/** Review-thread dedupe (spec: specs/bro-huy5o.4.md). A fresh sonarcloud
 *  record is dropped when an OPEN review-thread row — `source` absent —
 *  already carries the finding: same path+line, or the comment body
 *  links the issue key (`issues=<key>`, `hotspots=<key>`, `open=<key>`). */
export function dedupeReviewThreads(
  records: DebtRecord[],
  existing: DebtRecord[]
): { kept: DebtRecord[]; duped: SonarDupe[] } {
  const threads = existing.filter(
    (r) => r.status === 'open' && (r.source === undefined || r.source === 'review-threads')
  )
  const kept: DebtRecord[] = []
  const duped: SonarDupe[] = []
  for (const rec of records) {
    const key = sonarKeyOf(rec.thread_id)
    const cover = threads.find(
      (t) =>
        (rec.path !== '' && t.path === rec.path && t.line !== null && t.line === rec.line) ||
        t.body.includes(key)
    )
    if (cover !== undefined) {
      duped.push({ record: rec, coveredBy: cover.thread_id })
    } else {
      kept.push(rec)
    }
  }
  return { kept, duped }
}

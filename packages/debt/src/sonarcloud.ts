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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

export const SONAR_HOST = 'https://sonarcloud.io'
const PAGE_SIZE = 500
/** issues/search refuses offsets past 10_000 — past the window the
 *  fetch throws rather than return a partial list the caller would
 *  treat as complete (omitted live issues would be swept as resolved). */
const MAX_PAGES = 20

export interface SonarProject {
  projectKey: string
  host: string
  /** where the key came from — reported by doctor's detail line */
  via: 'config' | 'properties'
  /** who asserted the host — a properties-file host is ambient repo
   *  content and never carries the token (see assertSonarHostTrusted). */
  hostVia: 'config' | 'properties' | 'default'
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
      out.host = stripSlashes(value)
    }
  }
  return out
}

/** Both properties conventions: `sonar-project.properties` (scanner
 *  config) and `.sonarcloud.properties` (Automatic Analysis) — the
 *  former wins when a repo carries both. */
const PROPERTIES_FILES = ['sonar-project.properties', '.sonarcloud.properties']

/** Project key + host — `debt.sourceConfig.sonarcloud.{project_key,host}`
 *  in config wins, then the properties file at the checkout root; host
 *  falls back to sonarcloud.io so SonarQube Server works via
 *  `sonar.host.url` (same API). Null when no key resolves — callers
 *  decide between skip (collect) and warn (doctor). The cfg bag arrives
 *  untyped from `debt.sourceConfig` — field checks happen here. */
export function resolveSonarProject(
  dir: string,
  cfg?: Record<string, unknown>
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
  const cfgHost =
    typeof cfg?.host === 'string' && cfg.host !== '' ? cfg.host : undefined
  const fromConfig = cfgKey !== undefined
  const projectKey = cfgKey ?? propsFile.projectKey
  if (projectKey === undefined || projectKey === '') {
    return null
  }
  return {
    projectKey,
    host: stripSlashes(cfgHost ?? propsFile.host ?? SONAR_HOST),
    via: fromConfig ? 'config' : 'properties',
    hostVia: cfgHost !== undefined ? 'config' : propsFile.host !== undefined ? 'properties' : 'default',
  }
}

/** `SONAR_TOKEN` may only cross the wire to a host the operator opted
 *  into. `sonar.host.url` in a properties file is ambient repo content —
 *  a merged PR can point it at any server — so it never carries the
 *  token unless it names the default host or loopback; any other target
 *  must come from `debt.sourceConfig.sonarcloud.host` in bro config (the same trust
 *  layer that already drives agent command templates). Plain http is
 *  refused except loopback — cleartext transit leaks the token to every
 *  hop. */
export function assertSonarHostTrusted(project: SonarProject): void {
  const url = assertTokenSafeHost(project.host, 'sonar')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    project.hostVia === 'properties' &&
    url.host !== new URL(SONAR_HOST).host &&
    !loopback
  ) {
    throw new SourceSkipped(
      `sonar.host.url ${url.host} comes from a committed properties file — ` +
        `set debt.sourceConfig.sonarcloud.host in bro.config to send SONAR_TOKEN to a non-default host`
    )
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
  // Token never rides argv — every local user can `ps`: the header file
  // in curlJson is 0600 for the spawn's lifetime only.
  const basic = Buffer.from(`${sonarToken()}:`).toString('base64')
  return curlJson(url, [`Authorization: Basic ${basic}`], { label: 'sonarcloud' })
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
  let total = 0
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
    total = resp.paging?.total ?? page.length
    if (items.length >= total || page.length === 0) {
      return { items, components }
    }
  }
  // The API window ran out with results still unfetched — returning the
  // partial list as success would let the upstream-resolve sweep mark
  // the omitted live issues done. Fail the source; the ledger is untouched.
  throw new Error(
    `sonarcloud: ${total} result(s) exceed the API's ${MAX_PAGES * PAGE_SIZE}-row ` +
      `window at ${base} — refusing a partial fetch`
  )
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
 *  backlog. `opts.cfg` is `debt.sourceConfig.sonarcloud` from
 *  bro.config; `opts.dir` is the checkout root for
 *  `sonar-project.properties`. */
export function collectSonarcloud(
  ctx: CollectCtx,
  opts: { dir?: string; cfg?: Record<string, unknown> } = {}
): DebtRecord[] {
  const project = resolveSonarProject(opts.dir ?? process.cwd(), opts.cfg)
  if (project === null) {
    throw new SourceSkipped(
      'no project key — set debt.sourceConfig.sonarcloud.project_key in bro.config or sonar.projectKey in sonar-project.properties / .sonarcloud.properties'
    )
  }
  sonarToken() // fail-fast before any request — a skipped source sweeps nothing
  assertSonarHostTrusted(project)
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
export type SonarDupe = DedupeDupe

/** The issue key a sonarcloud thread_id carries —
 *  `sonarcloud:KEY` / `sonarcloud:hotspot:KEY`. */
export function sonarKeyOf(threadId: string): string {
  return threadId.replace(/^sonarcloud:(hotspot:)?/, '')
}

/** Key coverage needs an actual link back — the key as a whole token
 *  after `issues=`/`hotspots=`/`open=` in a `?`/`&` query param. A bare
 *  token match lets any prose or code mention of the key suppress a live
 *  finding. Token chars are the sonar key alphabet plus `-`/`_` so `K5`
 *  can't claim `K55`/`K5-9`. */
function bodyMentionsKey(body: string, key: string): boolean {
  if (key === '') return false
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`[?&](?:issues|hotspots|open)=${k}(?![A-Za-z0-9_-])`).test(body)
}

/** Review-thread dedupe (spec: specs/bro-huy5o.4.md). A fresh sonarcloud
 *  record is dropped when an OPEN review-thread row — `source` absent —
 *  already carries the finding: same path+line, or the comment body
 *  links back with the key in `issues=`/`hotspots=`/`open=`. */
export function dedupeReviewThreads(
  records: DebtRecord[],
  existing: DebtRecord[]
): { kept: DebtRecord[]; duped: SonarDupe[] } {
  return dedupeByThreads(records, existing, (rec, t) => {
    const key = sonarKeyOf(rec.thread_id)
    return (
      (rec.path !== '' && t.path === rec.path && t.line !== null && t.line === rec.line) ||
      bodyMentionsKey(t.body, key)
    )
  })
}

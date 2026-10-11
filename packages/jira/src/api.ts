/**
 * Jira transport — `atlassian api <METHOD> <endpoint> [-d <json>] --json`,
 * the CLI's raw REST passthrough (specs specs/bro-huy5o.3.md cloud,
 * specs/bro-b8eom.md DC). One uniform verb reaches the whole Jira
 * surface: JQL search, issue links, transitions, assignee, comments.
 * Credentials stay the CLI's own (`atlassian auth login`,
 * ATLASSIAN_TOKEN) — the connector spawns, never reads tokens.
 *
 * Two deployment surfaces ride the same plumbing — `makeApi` binds
 * one: 'cloud' is Jira Cloud's v3 REST (accountId users, ADF bodies,
 * /search/jql with nextPageToken), 'dc' is Data Center/Server's v2
 * REST (name-keyed users, string bodies, /search paged on startAt,
 * projects listed via /project). The mapping layer consumes a bound
 * `JiraApi`, never the deployment enum.
 *
 * Endpoint families cover the site shapes: a configured site `baseUrl`
 * takes plain `/rest/api/<v>/…` paths; the default api.atlassian.com
 * gateway wants `/ex/jira/<cloudId>/rest/api/3/…` (Cloud only — DC
 * never prefixes). `JIRA_BASE_URL` pins a site base explicitly
 * (`JIRA_DC_BASE_URL` wins for the dc surface so a rig can carry
 * both) — it is asserted https: before it can ride `--url`, same
 * rule as the queries facade's ATLASSIAN_API_URL guard. DC PAT auth:
 * `atlassian api` sends `Authorization: Bearer <ATLASSIAN_TOKEN>`
 * whenever its own config isn't token-mode — a DC operator's PAT is
 * that Bearer token; there is no PAT flag and never will be (the
 * connector still reads no credentials).
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 30_000

/** The REST line a site speaks: 'cloud' = Jira Cloud v3, 'dc' = Data
 *  Center/Server v2. Not an auth method — the CLI owns auth — only
 *  endpoint + body + user-shape selection. */
export type Surface = 'cloud' | 'dc'

const tag = (s: Surface): string => (s === 'dc' ? 'jira-dc' : 'jira')

// --- wire shapes ---------------------------------------------------------------

export interface JiraStatus {
  name?: string
  statusCategory?: { key?: string; name?: string }
}

export interface JiraIssueRef {
  id?: string
  key?: string
  fields?: { status?: JiraStatus; summary?: string }
}

/** An issuelinks entry names the COUNTERPART by its own side in the
 *  link: `inwardIssue` present means this issue is the outward side
 *  ("this issue blocks inwardIssue" for Blocks) — the counterpart
 *  depends on this one. `outwardIssue` present means this issue is the
 *  inward side ("is blocked by") — this one depends on it. */
export interface JiraLink {
  id?: string
  type?: { name?: string; inward?: string; outward?: string }
  inwardIssue?: JiraIssueRef
  outwardIssue?: JiraIssueRef
}

/** A Jira user in either identity regime — Cloud keys on accountId,
 *  Data Center on name (key is its older alias). The viewer probe,
 *  assignee reads, and assignable-search rows all share this shape. */
export interface JiraViewer {
  accountId?: string
  name?: string
  key?: string
  displayName?: string
  emailAddress?: string
}

export interface JiraFields {
  summary?: string
  description?: unknown
  status?: JiraStatus
  issuetype?: { name?: string }
  priority?: { name?: string } | null
  assignee?: JiraViewer | null
  labels?: string[]
  issuelinks?: JiraLink[]
  subtasks?: JiraIssueRef[]
  parent?: JiraIssueRef
  resolution?: { name?: string } | null
  created?: string
  resolutiondate?: string | null
}

export interface JiraIssue {
  id?: string
  key?: string
  self?: string
  fields?: JiraFields
}

/** The field list every issue read asks for — identical names across
 *  the v3 and v2 surfaces. */
export const FIELDS =
  'summary,description,status,issuetype,priority,assignee,labels,' +
  'issuelinks,subtasks,parent,resolution,created,resolutiondate'

const PAGE = 100

// --- ADF ↔ text -------------------------------------------------------------------
// Cloud v3 descriptions/comments are Atlassian Document Format; v2
// speaks plain strings. adfText already degrades a v2 string body to
// itself, so reads share one helper — only writes branch on `doc`.

interface AdfNode {
  type?: string
  text?: string
  content?: AdfNode[]
}

/** Plain text out of an ADF description — text nodes verbatim,
 *  hardBreaks → \n, a paragraph gap between block children. The bro
 *  trailer rides a plain paragraph, so it survives verbatim. A
 *  v2-era string description passes through as-is. */
export function adfText(doc: unknown): string {
  if (typeof doc === 'string') {
    return doc
  }
  if (typeof doc !== 'object' || doc === null) {
    return ''
  }
  const out: string[] = []
  const walk = (n: AdfNode): void => {
    if (n.type === 'text' && typeof n.text === 'string') {
      out.push(n.text)
      return
    }
    if (n.type === 'hardBreak') {
      out.push('\n')
      return
    }
    for (const c of n.content ?? []) {
      walk(c)
    }
    if (n.type !== undefined && n.type !== 'doc' && n.type !== 'text') {
      out.push('\n')
    }
  }
  walk(doc as AdfNode)
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

/** Text → a minimal ADF doc — paragraphs split on blank lines, single
 *  newlines become hardBreaks. */
export function adfDoc(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== '')
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i): AdfNode[] => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        { type: 'text', text: line },
      ]),
    })),
  }
}

// --- endpoint resolution --------------------------------------------------------

/** Operator-pinned site base — wins over the CLI's config and rides
 *  every call as `--url`. Asserted https: — `atlassian api` sends its
 *  Authorization header to whatever endpoint this names. The dc
 *  surface reads JIRA_DC_BASE_URL first so a rig carrying both
 *  connectors can pin two sites; JIRA_BASE_URL stays the shared pin. */
function jiraBaseUrl(s: Surface): string | undefined {
  const v = (
    (s === 'dc' ? process.env['JIRA_DC_BASE_URL'] : undefined) ??
    process.env['JIRA_BASE_URL'] ??
    process.env['ATLASSIAN_BASE_URL']
  )?.trim()
  return v === '' ? undefined : v
}

function assertHttps(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`jira: base URL is not a URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `jira: base URL must be https: — got ${parsed.protocol} (${url}); ` +
        `the CLI sends its Authorization header to this endpoint`
    )
  }
}

interface CliConfig {
  baseUrl?: string
  cloudId?: string
}

let cliConfigCache: CliConfig | undefined

/** The CLI's own ~/.atlassian-tools/config.json — endpoint resolution
 *  only (baseUrl/cloudId); credentials are never read. A missing or
 *  malformed file degrades to {} — the CLI's own errors stay the
 *  honest surface. */
function cliConfig(): CliConfig {
  if (cliConfigCache === undefined) {
    cliConfigCache = {}
    try {
      const raw = JSON.parse(
        readFileSync(join(homedir(), '.atlassian-tools', 'config.json'), 'utf8')
      ) as CliConfig
      if (typeof raw.baseUrl === 'string') cliConfigCache.baseUrl = raw.baseUrl
      if (typeof raw.cloudId === 'string') cliConfigCache.cloudId = raw.cloudId
    } catch {
      // no config file — the CLI's defaults apply
    }
  }
  return cliConfigCache
}

/** REST path → the endpoint the CLI should prefix. Site bases (env
 *  pin or CLI config) take the plain path; the api.atlassian.com
 *  gateway needs the cloudId-scoped /ex/jira/ prefix (Cloud only —
 *  a DC site is always a base). dc with NO resolved site throws:
 *  letting /rest/api/2 fall through to the api.atlassian.com default
 *  would answer Cloud v2 — a live surface for the wrong deployment. */
function endpoint(s: Surface, path: string): string {
  if (jiraBaseUrl(s) !== undefined || cliConfig().baseUrl !== undefined) {
    return `/rest/api/${s === 'dc' ? '2' : '3'}${path}`
  }
  if (s === 'dc') {
    throw new Error(
      `jira-dc: no site base — pin JIRA_DC_BASE_URL/JIRA_BASE_URL or the ` +
        `CLI's config baseUrl; the v2 surface never defaults to api.atlassian.com`
    )
  }
  const cloud =
    process.env['JIRA_CLOUD_ID']?.trim() ||
    process.env['ATLASSIAN_CLOUD_ID']?.trim() ||
    cliConfig().cloudId
  return cloud !== undefined && cloud !== ''
    ? `/ex/jira/${encodeURIComponent(cloud)}/rest/api/3${path}`
    : `/rest/api/3${path}`
}

// --- argv + spawn plumbing --------------------------------------------------------

function apiArgs(s: Surface, method: string, path: string, body?: unknown): string[] {
  const args = ['api', method]
  const base = jiraBaseUrl(s)
  if (base !== undefined) {
    assertHttps(base)
    args.push('--url', base)
  }
  args.push(endpoint(s, path))
  if (body !== undefined) {
    args.push('-d', JSON.stringify(body))
  }
  args.push('--json')
  return args
}

interface AtlResult {
  code: number
  out: string
  err: string
}

const cliFail = (s: Surface, what: string, code: number, err: string): Error => {
  const why = err !== '' ? err : `exit ${code}`
  return new Error(`${tag(s)}: ${what} failed — ${why}`)
}

export function atlTry(args: string[], timeoutMs = TIMEOUT_MS): AtlResult {
  const proc = spawnSync('atlassian', args, { // NOSONAR — PATH lookup is the contract (same as gh/glab)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // the 1 MiB default kills whole JQL pages; a stalled CLI must die
    // with the caller, not hang it — same contract as core/bd.ts
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  const err = `${(proc.stderr ?? '').trim()} ${proc.error?.message ?? ''}`.trim()
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err }
}

export function atl(args: string[]): string {
  const { code, out, err } = atlTry(args)
  if (code !== 0) {
    throw cliFail('cloud', `atlassian ${args[0]} ${args[1] ?? ''}`, code, err)
  }
  return out
}

export function atlJson<T>(args: string[]): T {
  const out = atl(args)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`jira: atlassian api returned non-JSON — ${out.slice(0, 200)}`)
  }
}

/** Async twin — probe paths must not serialize through the event loop. */
function atlAsyncRaw(args: string[]): Promise<AtlResult> {
  return new Promise((resolve) => {
    const proc = spawn('atlassian', args, { // NOSONAR — PATH lookup is the contract (same as gh/glab)
      stdio: ['ignore', 'pipe', 'pipe'],
      // no deadline → a stalled CLI keeps async reads pending forever
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    proc.on('error', (error) => resolve({ code: 1, out, err: error.message }))
    proc.on('close', (code, signal) => {
      const timedOut = signal === 'SIGKILL' ? ` jira: timed out after ${TIMEOUT_MS}ms` : ''
      resolve({ code: code ?? 1, out, err: `${err.trim()}${timedOut}`.trim() })
    })
  })
}

async function atlAsync(args: string[]): Promise<string> {
  const { code, out, err } = await atlAsyncRaw(args)
  if (code !== 0) {
    throw cliFail('cloud', `atlassian ${args[0]} ${args[1] ?? ''}`, code, err)
  }
  return out
}

async function atlJsonAsync<T>(args: string[]): Promise<T> {
  const out = await atlAsync(args)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`jira: atlassian api returned non-JSON — ${out.slice(0, 200)}`)
  }
}

// --- the REST verbs --------------------------------------------------------------

/** A CLI failure whose stderr carries an HTTP status — the not-found
 *  check reads it; anything else is a real error. */
const notFound = (err: string): boolean => /\b404\b|Not Found/i.test(err)

/** Mutation call — a non-zero exit is the verdict; bodies aren't read. */
function api(s: Surface, method: string, path: string, body?: unknown): void {
  const { code, err } = atlTry(apiArgs(s, method, path, body))
  if (code !== 0) {
    throw cliFail(s, `${method} ${path}`, code, err)
  }
}

/** Read — parses the JSON body; throws on transport errors. */
function apiJson<T>(s: Surface, method: string, path: string, body?: unknown): T {
  return atlJson<T>(apiArgs(s, method, path, body))
}

/** Read that may not exist — a 404 answers undefined; every other
 *  failure throws (a dead CLI is not "absent", it is broken). */
function apiGet<T>(s: Surface, path: string): T | undefined {
  const { code, out, err } = atlTry(apiArgs(s, 'GET', path))
  if (code !== 0) {
    if (notFound(err)) {
      return undefined
    }
    throw cliFail(s, `GET ${path}`, code, err)
  }
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`jira: atlassian api returned non-JSON — ${out.slice(0, 200)}`)
  }
}

async function apiJsonAsync<T>(s: Surface, method: string, path: string, body?: unknown): Promise<T> {
  return atlJsonAsync<T>(apiArgs(s, method, path, body))
}

async function apiGetAsync<T>(s: Surface, path: string): Promise<T | undefined> {
  const { code, out, err } = await atlAsyncRaw(apiArgs(s, 'GET', path))
  if (code !== 0) {
    if (notFound(err)) {
      return undefined
    }
    throw cliFail(s, `GET ${path}`, code, err)
  }
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`jira: atlassian api returned non-JSON — ${out.slice(0, 200)}`)
  }
}

// --- JQL search — the one verb whose shape moved between surfaces -----------------

/** A normalized JQL page: rows plus the opaque cursor a next call
 *  takes — nextPageToken on v3, a startAt offset on v2. Absent next =
 *  last page. */
export interface SearchResult {
  issues?: JiraIssue[]
  next?: string
}

interface V3SearchPage {
  issues?: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
}

const v3HasMore = (p: V3SearchPage): boolean =>
  p.nextPageToken !== undefined && p.nextPageToken !== '' && p.isLast !== true

const v3SearchBody = (jql: string, token: string | undefined): Record<string, unknown> => ({
  jql,
  fields: FIELDS.split(','),
  maxResults: PAGE,
  ...(token !== undefined ? { nextPageToken: token } : {}),
})

const v3SearchGetPath = (jql: string, token: string | undefined): string =>
  `/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(FIELDS)}` +
  `&maxResults=${PAGE}` +
  (token !== undefined ? `&nextPageToken=${encodeURIComponent(token)}` : '')

const endpointGone = (err: unknown): boolean => /\b(404|405)\b/.test(String(err))

/** POST /search/jql — the current Cloud JQL endpoint. A 404/405-class
 *  answer (a site that only kept GET) retries the GET form once —
 *  endpoint drift is absorbed here, never silently. */
function v3SearchPage(jql: string, cursor: string | undefined): SearchResult {
  try {
    const p = apiJson<V3SearchPage>('cloud', 'POST', '/search/jql', v3SearchBody(jql, cursor))
    return { issues: p.issues, ...(v3HasMore(p) ? { next: p.nextPageToken } : {}) }
  } catch (err) {
    if (!endpointGone(err)) {
      throw err
    }
    const p = apiGet<V3SearchPage>('cloud', v3SearchGetPath(jql, cursor))
    if (p === undefined) {
      throw err
    }
    return { issues: p.issues, ...(v3HasMore(p) ? { next: p.nextPageToken } : {}) }
  }
}

async function v3SearchPageAsync(jql: string, cursor: string | undefined): Promise<SearchResult> {
  try {
    const p = await apiJsonAsync<V3SearchPage>(
      'cloud',
      'POST',
      '/search/jql',
      v3SearchBody(jql, cursor)
    )
    return { issues: p.issues, ...(v3HasMore(p) ? { next: p.nextPageToken } : {}) }
  } catch (err) {
    if (!endpointGone(err)) {
      throw err
    }
    const p = await apiGetAsync<V3SearchPage>('cloud', v3SearchGetPath(jql, cursor))
    if (p === undefined) {
      throw err
    }
    return { issues: p.issues, ...(v3HasMore(p) ? { next: p.nextPageToken } : {}) }
  }
}

interface V2SearchPage {
  issues?: JiraIssue[]
  startAt?: number
  maxResults?: number
  total?: number
}

/** v2 paging — the cursor is a startAt offset carried as a string.
 *  An empty/absent issues page or a missing total ends the walk:
 *  a truncated read must never loop forever on a weird body. */
const v2Next = (p: V2SearchPage): string | undefined => {
  const got = (p.startAt ?? 0) + (p.issues?.length ?? 0)
  return p.total !== undefined && got < p.total && (p.issues?.length ?? 0) > 0
    ? String(got)
    : undefined
}

/** POST /search — the v2 JQL endpoint. No GET fallback: /search is the
 *  stable v2 verb, not the moving target /search/jql was on Cloud. */
function v2SearchPage(jql: string, cursor: string | undefined): SearchResult {
  const p = apiJson<V2SearchPage>('dc', 'POST', '/search', {
    jql,
    fields: FIELDS.split(','),
    maxResults: PAGE,
    startAt: cursor === undefined ? 0 : Number(cursor),
  })
  return { issues: p.issues, ...(v2Next(p) !== undefined ? { next: v2Next(p) } : {}) }
}

async function v2SearchPageAsync(jql: string, cursor: string | undefined): Promise<SearchResult> {
  const p = await apiJsonAsync<V2SearchPage>('dc', 'POST', '/search', {
    jql,
    fields: FIELDS.split(','),
    maxResults: PAGE,
    startAt: cursor === undefined ? 0 : Number(cursor),
  })
  return { issues: p.issues, ...(v2Next(p) !== undefined ? { next: v2Next(p) } : {}) }
}

// --- cached probes --------------------------------------------------------------

export interface JiraProject {
  id: string
  key: string
  name?: string
}

export interface JiraLinkType {
  id: string
  name: string
  inward?: string
  outward?: string
}

// Caches key on the resolution inputs — a test that swaps env/config
// must never inherit a stale pick. The surface rides the key too:
// cloud and dc connectors probed in one process never share rows.
const viewerCache = new Map<string, JiraViewer>()
const projectCache = new Map<string, JiraProject>()
const prioritiesCache = new Map<string, string[]>()
const issueTypesCache = new Map<string, string[]>()
const linkTypesCache = new Map<string, JiraLinkType[]>()

const wantProject = (): string =>
  (process.env['JIRA_PROJECT'] ?? process.env['ATLASSIAN_PROJECT'])?.trim() ?? ''

/** The identity this surface assigns users by — Cloud's accountId,
 *  DC's name (key is the pre-rename alias older Servers still emit). */
const userKeyOf = (s: Surface, u: JiraViewer | null | undefined): string | undefined => {
  if (u == null) {
    return undefined
  }
  const id = s === 'dc' ? (u.name ?? u.key) : u.accountId
  return id === '' ? undefined : id
}

/** GET /myself — the auth probe AND the claim identity in one. */
function viewer(s: Surface, timeoutMs = TIMEOUT_MS): JiraViewer {
  const ck = `${s}:${timeoutMs}:${jiraBaseUrl(s) ?? ''}`
  let v = viewerCache.get(ck)
  if (v === undefined) {
    const r = atlTry(apiArgs(s, 'GET', '/myself'), timeoutMs)
    if (r.code !== 0) {
      throw new Error(r.err || `atlassian api exited ${r.code}`)
    }
    v = JSON.parse(r.out) as JiraViewer
    if (userKeyOf(s, v) === undefined) {
      throw new Error(
        `${tag(s)}: /myself returned no ${s === 'dc' ? 'name/key' : 'accountId'} — is the CLI authenticated?`
      )
    }
    viewerCache.set(ck, v)
  }
  return v
}

/** Async /myself — probe paths must not serialize through spawnSync. */
async function viewerAsync(s: Surface): Promise<JiraViewer> {
  const ck = `${s}:async:${jiraBaseUrl(s) ?? ''}`
  let v = viewerCache.get(ck)
  if (v === undefined) {
    v = await apiJsonAsync<JiraViewer>(s, 'GET', '/myself')
    if (userKeyOf(s, v) === undefined) {
      throw new Error(
        `${tag(s)}: /myself returned no ${s === 'dc' ? 'name/key' : 'accountId'} — is the CLI authenticated?`
      )
    }
    viewerCache.set(ck, v)
  }
  return v
}

interface ProjectSearch {
  values?: JiraProject[]
}

function resolveProject(s: Surface, projects: JiraProject[]): JiraProject {
  const want = wantProject()
  if (want !== '') {
    const hit = projects.find((p) => p.key.toLowerCase() === want.toLowerCase())
    if (hit === undefined) {
      throw new Error(
        `${tag(s)}: JIRA_PROJECT "${want}" matches no project — ` +
          `visible: ${projects.map((p) => p.key).join(', ') || '(none)'}`
      )
    }
    return hit
  }
  if (projects.length === 1) {
    return projects[0]!
  }
  throw new Error(
    projects.length === 0
      ? `${tag(s)}: the CLI sees no projects`
      : `${tag(s)}: JIRA_PROJECT required — projects: ${projects.map((p) => p.key).join(', ')}`
  )
}

/** The listing each surface's project fallback reads — Cloud pages
 *  /project/search; DC's /project answers the whole visible set in
 *  one array (v2 has no paged search verb to mirror). */
function listProjects(s: Surface): JiraProject[] {
  return s === 'dc'
    ? apiJson<JiraProject[]>(s, 'GET', '/project')
    : (apiJson<ProjectSearch>(s, 'GET', '/project/search?maxResults=100').values ?? [])
}

async function listProjectsAsync(s: Surface): Promise<JiraProject[]> {
  return s === 'dc'
    ? await apiJsonAsync<JiraProject[]>(s, 'GET', '/project')
    : ((await apiJsonAsync<ProjectSearch>(s, 'GET', '/project/search?maxResults=100'))
        .values ?? [])
}

/** The serving project — `JIRA_PROJECT`/`ATLASSIAN_PROJECT` resolves by
 *  direct key read: a keyed read can't miss page-2+ projects the way a
 *  paged listing can. Unset → the site's single visible project (the
 *  LINEAR_TEAM rule); a key miss still rides the listing for the
 *  "visible: …" error. */
function project(s: Surface): JiraProject {
  const ck = `${s}:${wantProject()}${jiraBaseUrl(s) ?? ''}`
  let p = projectCache.get(ck)
  if (p === undefined) {
    const want = wantProject()
    const hit =
      want === ''
        ? undefined
        : apiGet<JiraProject>(s, `/project/${encodeURIComponent(want)}`)
    p = hit?.key !== undefined ? hit : resolveProject(s, listProjects(s))
    projectCache.set(ck, p)
  }
  return p
}

async function projectAsync(s: Surface): Promise<JiraProject> {
  const ck = `${s}:${wantProject()}${jiraBaseUrl(s) ?? ''}`
  let p = projectCache.get(ck)
  if (p === undefined) {
    const want = wantProject()
    const hit =
      want === ''
        ? undefined
        : await apiGetAsync<JiraProject>(s, `/project/${encodeURIComponent(want)}`)
    p = hit?.key !== undefined ? hit : resolveProject(s, await listProjectsAsync(s))
    projectCache.set(ck, p)
  }
  return p
}

interface PriorityRow {
  name?: string
}

/** The site's ordered priority names — positional mapping onto bd's
 *  0-4 lower-is-urgent scale (Highest→0 … Lowest→4 on the default
 *  scheme; a custom scheme maps by position, no names hardcoded). */
function priorities(s: Surface): string[] {
  const ck = `${s}:${jiraBaseUrl(s) ?? ''}`
  let ps = prioritiesCache.get(ck)
  if (ps === undefined) {
    const rows = apiJson<PriorityRow[]>(s, 'GET', '/priority')
    ps = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && n !== '')
    prioritiesCache.set(ck, ps)
  }
  return ps
}

async function prioritiesAsync(s: Surface): Promise<string[]> {
  const ck = `${s}:${jiraBaseUrl(s) ?? ''}`
  let ps = prioritiesCache.get(ck)
  if (ps === undefined) {
    const rows = await apiJsonAsync<PriorityRow[]>(s, 'GET', '/priority')
    ps = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && n !== '')
    prioritiesCache.set(ck, ps)
  }
  return ps
}

// A dead /priority endpoint degrades the read plane to [] — and must
// stay degraded: an uncached failure re-spawns the failing CLI once
// per mapped row. Keyed on the site base like the success cache.
const prioritiesDownCache = new Set<string>()

/** priorities() that converts a dead endpoint into "no names known" —
 *  the read-plane variant; write paths keep the honest throw. */
function prioritiesOrEmpty(s: Surface): string[] {
  const ck = `${s}:${jiraBaseUrl(s) ?? ''}`
  if (prioritiesDownCache.has(ck)) {
    return []
  }
  try {
    return priorities(s)
  } catch {
    prioritiesDownCache.add(ck)
    return []
  }
}

async function prioritiesOrEmptyAsync(s: Surface): Promise<string[]> {
  const ck = `${s}:${jiraBaseUrl(s) ?? ''}`
  if (prioritiesDownCache.has(ck)) {
    return []
  }
  try {
    return await prioritiesAsync(s)
  } catch {
    prioritiesDownCache.add(ck)
    return []
  }
}

interface IssueTypeRow {
  name?: string
}

/** The site's issue-type names — create resolves a requested type
 *  case-insensitively against this list. */
function issueTypes(s: Surface): string[] {
  const ck = `${s}:${jiraBaseUrl(s) ?? ''}`
  let ts = issueTypesCache.get(ck)
  if (ts === undefined) {
    const rows = apiJson<IssueTypeRow[]>(s, 'GET', '/issuetype')
    ts = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && n !== '')
    issueTypesCache.set(ck, ts)
  }
  return ts
}

interface LinkTypes {
  issueLinkTypes?: JiraLinkType[]
}

function linkTypes(s: Surface): JiraLinkType[] {
  const ck = `${s}:${jiraBaseUrl(s) ?? ''}`
  let ts = linkTypesCache.get(ck)
  if (ts === undefined) {
    ts = apiJson<LinkTypes>(s, 'GET', '/issueLinkType').issueLinkTypes ?? []
    linkTypesCache.set(ck, ts)
  }
  return ts
}

/** Resolve a generic rel to a site link-type name: 'blocks' → the
 *  Blocks-ish type, 'related' → the relates-ish type, anything else →
 *  an exact (case-insensitive) site name. Throws when nothing matches —
 *  a rel that can't wire must fail before the write, never fake. */
function linkTypeName(s: Surface, rel: string): string {
  const ts = linkTypes(s)
  if (rel === 'blocks') {
    const hit = ts.find((t) => t.name === 'Blocks') ?? ts.find((t) => /block/i.test(t.name))
    if (hit !== undefined) {
      return hit.name
    }
  } else if (rel === 'related') {
    const hit = ts.find((t) => t.name === 'Relates') ?? ts.find((t) => /relat/i.test(t.name))
    if (hit !== undefined) {
      return hit.name
    }
  } else {
    const hit = ts.find((t) => t.name.toLowerCase() === rel.toLowerCase())
    if (hit !== undefined) {
      return hit.name
    }
  }
  throw new Error(`${tag(s)} tasks: link rel '${rel}' matches no issue-link type on this site`)
}

// --- the bound surface -----------------------------------------------------------

/** One deployment's REST surface — the verbs and probes the task
 *  mapping consumes, already surface-bound. `doc` shapes a text body
 *  for writes (ADF doc vs plain string), `userKey` reads the surface's
 *  user identity, `assigneeBody` shapes the assignee write payload,
 *  `userQueryParam` names /user/assignable/search's query param
 *  ('query' on v3, 'username' on v2), and `searchPage` walks JQL with
 *  the surface's own pagination behind one normalized cursor. `tag`
 *  is the connector's name for error prefixes. */
export interface JiraApi {
  tag: string
  api: (method: string, path: string, body?: unknown) => void
  apiJson: <T>(method: string, path: string, body?: unknown) => T
  apiGet: <T>(path: string) => T | undefined
  apiJsonAsync: <T>(method: string, path: string, body?: unknown) => Promise<T>
  apiGetAsync: <T>(path: string) => Promise<T | undefined>
  viewer: (timeoutMs?: number) => JiraViewer
  viewerAsync: () => Promise<JiraViewer>
  project: () => JiraProject
  projectAsync: () => Promise<JiraProject>
  priorities: () => string[]
  prioritiesAsync: () => Promise<string[]>
  prioritiesOrEmpty: () => string[]
  prioritiesOrEmptyAsync: () => Promise<string[]>
  issueTypes: () => string[]
  linkTypeName: (rel: string) => string
  doc: (text: string) => unknown
  userKey: (u: JiraViewer | null | undefined) => string | undefined
  assigneeBody: (id: string) => Record<string, unknown>
  userQueryParam: 'query' | 'username'
  searchPage: (jql: string, cursor: string | undefined) => SearchResult
  searchPageAsync: (jql: string, cursor: string | undefined) => Promise<SearchResult>
}

/** Bind a deployment surface to the mapping layer — one object per
 *  surface per process (the probes' caches are module-level and key
 *  on the surface, so sharing the bound object is the point). */
export function makeApi(s: Surface): JiraApi {
  return {
    tag: tag(s),
    api: (method, path, body) => api(s, method, path, body),
    apiJson: <T>(method: string, path: string, body?: unknown) => apiJson<T>(s, method, path, body),
    apiGet: <T>(path: string) => apiGet<T>(s, path),
    apiJsonAsync: <T>(method: string, path: string, body?: unknown) =>
      apiJsonAsync<T>(s, method, path, body),
    apiGetAsync: <T>(path: string) => apiGetAsync<T>(s, path),
    viewer: (timeoutMs) => viewer(s, timeoutMs),
    viewerAsync: () => viewerAsync(s),
    project: () => project(s),
    projectAsync: () => projectAsync(s),
    priorities: () => priorities(s),
    prioritiesAsync: () => prioritiesAsync(s),
    prioritiesOrEmpty: () => prioritiesOrEmpty(s),
    prioritiesOrEmptyAsync: () => prioritiesOrEmptyAsync(s),
    issueTypes: () => issueTypes(s),
    linkTypeName: (rel) => linkTypeName(s, rel),
    doc:
      s === 'dc'
        ? (text) => text
        : (text) => adfDoc(text),
    userKey: (u) => userKeyOf(s, u),
    assigneeBody: (id) => (s === 'dc' ? { name: id } : { accountId: id }),
    userQueryParam: s === 'dc' ? 'username' : 'query',
    searchPage: (jql, cursor) => (s === 'dc' ? v2SearchPage(jql, cursor) : v3SearchPage(jql, cursor)),
    searchPageAsync: (jql, cursor) =>
      s === 'dc' ? v2SearchPageAsync(jql, cursor) : v3SearchPageAsync(jql, cursor),
  }
}

let cloudBound: JiraApi | undefined
let dcBound: JiraApi | undefined

/** The Cloud v3 surface — `jira`'s bound api. */
export function cloudApi(): JiraApi {
  return (cloudBound ??= makeApi('cloud'))
}

/** The Data Center/Server v2 surface — `jira-dc`'s bound api. */
export function dcApi(): JiraApi {
  return (dcBound ??= makeApi('dc'))
}

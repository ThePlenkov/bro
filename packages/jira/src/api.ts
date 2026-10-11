/**
 * Jira transport — `atlassian api <METHOD> <endpoint> [-d <json>] --json`,
 * the CLI's raw REST passthrough (spec specs/bro-huy5o.3.md). One uniform
 * verb reaches the whole Jira Cloud surface: JQL search, issue links,
 * transitions, assignee, comments. Credentials stay the CLI's own
 * (`atlassian auth login`, ATLASSIAN_TOKEN) — the connector spawns,
 * never reads tokens.
 *
 * Endpoint families cover both site shapes: a configured site `baseUrl`
 * takes plain `/rest/api/3/…` paths; the default api.atlassian.com
 * gateway wants `/ex/jira/<cloudId>/rest/api/3/…`. `JIRA_BASE_URL` pins
 * a site explicitly (self-hosted / Data Center too) — it is asserted
 * https: before it can ride `--url`, same rule as the queries facade's
 * ATLASSIAN_API_URL guard.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 30_000

// --- endpoint resolution --------------------------------------------------------

/** Operator-pinned site base — wins over the CLI's config and rides
 *  every call as `--url`. Asserted https: — `atlassian api` sends its
 *  Authorization header to whatever endpoint this names. */
function jiraBaseUrl(): string | undefined {
  const v = (process.env['JIRA_BASE_URL'] ?? process.env['ATLASSIAN_BASE_URL'])?.trim()
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

/** `rest/api/3` path → the endpoint the CLI should prefix. Site bases
 *  (env pin or CLI config) take the plain path; the api.atlassian.com
 *  gateway needs the cloudId-scoped /ex/jira/ prefix. */
function endpoint(path: string): string {
  if (jiraBaseUrl() !== undefined || cliConfig().baseUrl !== undefined) {
    return `/rest/api/3${path}`
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

function apiArgs(method: string, path: string, body?: unknown): string[] {
  const args = ['api', method]
  const base = jiraBaseUrl()
  if (base !== undefined) {
    assertHttps(base)
    args.push('--url', base)
  }
  args.push(endpoint(path))
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

export function atlTry(args: string[], timeoutMs?: number): AtlResult {
  const proc = spawnSync('atlassian', args, { // NOSONAR — PATH lookup is the contract (same as gh/glab)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  })
  const err = `${(proc.stderr ?? '').trim()} ${proc.error?.message ?? ''}`.trim()
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err }
}

export function atl(args: string[]): string {
  const { code, out, err } = atlTry(args)
  if (code !== 0) {
    throw new Error(`jira: atlassian ${args[0]} ${args[1] ?? ''} failed — ${err || `exit ${code}`}`)
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
    })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    proc.on('error', (error) => resolve({ code: 1, out, err: error.message }))
    proc.on('close', (code) => resolve({ code: code ?? 1, out, err: err.trim() }))
  })
}

async function atlAsync(args: string[]): Promise<string> {
  const { code, out, err } = await atlAsyncRaw(args)
  if (code !== 0) {
    throw new Error(`jira: atlassian ${args[0]} ${args[1] ?? ''} failed — ${err || `exit ${code}`}`)
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
export function api(method: string, path: string, body?: unknown): void {
  const { code, err } = atlTry(apiArgs(method, path, body))
  if (code !== 0) {
    throw new Error(`jira: ${method} ${path} failed — ${err || `exit ${code}`}`)
  }
}

/** Read — parses the JSON body; throws on transport errors. */
export function apiJson<T>(method: string, path: string, body?: unknown): T {
  return atlJson<T>(apiArgs(method, path, body))
}

/** Read that may not exist — a 404 answers undefined; every other
 *  failure throws (a dead CLI is not "absent", it is broken). */
export function apiGet<T>(path: string): T | undefined {
  const { code, out, err } = atlTry(apiArgs('GET', path))
  if (code !== 0) {
    if (notFound(err)) {
      return undefined
    }
    throw new Error(`jira: GET ${path} failed — ${err || `exit ${code}`}`)
  }
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`jira: atlassian api returned non-JSON — ${out.slice(0, 200)}`)
  }
}

export async function apiJsonAsync<T>(method: string, path: string, body?: unknown): Promise<T> {
  return atlJsonAsync<T>(apiArgs(method, path, body))
}

export async function apiGetAsync<T>(path: string): Promise<T | undefined> {
  const { code, out, err } = await atlAsyncRaw(apiArgs('GET', path))
  if (code !== 0) {
    if (notFound(err)) {
      return undefined
    }
    throw new Error(`jira: GET ${path} failed — ${err || `exit ${code}`}`)
  }
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`jira: atlassian api returned non-JSON — ${out.slice(0, 200)}`)
  }
}

// --- cached probes --------------------------------------------------------------

export interface JiraViewer {
  accountId: string
  displayName?: string
  emailAddress?: string
}

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
// must never inherit a stale pick.
const viewerCache = new Map<string, JiraViewer>()
const projectCache = new Map<string, JiraProject>()
const prioritiesCache = new Map<string, string[]>()
const issueTypesCache = new Map<string, string[]>()
const linkTypesCache = new Map<string, JiraLinkType[]>()

const wantProject = (): string =>
  (process.env['JIRA_PROJECT'] ?? process.env['ATLASSIAN_PROJECT'])?.trim() ?? ''

/** GET /myself — the auth probe AND the claim identity in one. */
export function viewer(timeoutMs = TIMEOUT_MS): JiraViewer {
  const ck = `${timeoutMs}:${jiraBaseUrl() ?? ''}`
  let v = viewerCache.get(ck)
  if (v === undefined) {
    const r = atlTry(apiArgs('GET', '/myself'), timeoutMs)
    if (r.code !== 0) {
      throw new Error(r.err || `atlassian api exited ${r.code}`)
    }
    v = JSON.parse(r.out) as JiraViewer
    if (typeof v.accountId !== 'string' || v.accountId === '') {
      throw new Error('jira: /myself returned no accountId — is the CLI authenticated?')
    }
    viewerCache.set(ck, v)
  }
  return v
}

/** Async /myself — probe paths must not serialize through spawnSync. */
export async function viewerAsync(): Promise<JiraViewer> {
  const ck = `async:${jiraBaseUrl() ?? ''}`
  let v = viewerCache.get(ck)
  if (v === undefined) {
    v = await apiJsonAsync<JiraViewer>('GET', '/myself')
    if (typeof v.accountId !== 'string' || v.accountId === '') {
      throw new Error('jira: /myself returned no accountId — is the CLI authenticated?')
    }
    viewerCache.set(ck, v)
  }
  return v
}

interface ProjectSearch {
  values?: JiraProject[]
}

function resolveProject(projects: JiraProject[]): JiraProject {
  const want = wantProject()
  if (want !== '') {
    const hit = projects.find((p) => p.key.toLowerCase() === want.toLowerCase())
    if (hit === undefined) {
      throw new Error(
        `jira: JIRA_PROJECT "${want}" matches no project — ` +
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
      ? 'jira: the CLI sees no projects'
      : `jira: JIRA_PROJECT required — projects: ${projects.map((p) => p.key).join(', ')}`
  )
}

/** The serving project — `JIRA_PROJECT`/`ATLASSIAN_PROJECT`, else the
 *  site's single visible project (the LINEAR_TEAM rule). */
export function project(): JiraProject {
  const ck = `${wantProject()}${jiraBaseUrl() ?? ''}`
  let p = projectCache.get(ck)
  if (p === undefined) {
    const res = apiJson<ProjectSearch>('GET', '/project/search?maxResults=100')
    p = resolveProject(res.values ?? [])
    projectCache.set(ck, p)
  }
  return p
}

export async function projectAsync(): Promise<JiraProject> {
  const ck = `${wantProject()}${jiraBaseUrl() ?? ''}`
  let p = projectCache.get(ck)
  if (p === undefined) {
    const res = await apiJsonAsync<ProjectSearch>(
      'GET',
      '/project/search?maxResults=100'
    )
    p = resolveProject(res.values ?? [])
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
export function priorities(): string[] {
  const ck = jiraBaseUrl() ?? ''
  let ps = prioritiesCache.get(ck)
  if (ps === undefined) {
    const rows = apiJson<PriorityRow[]>('GET', '/priority')
    ps = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && n !== '')
    prioritiesCache.set(ck, ps)
  }
  return ps
}

export async function prioritiesAsync(): Promise<string[]> {
  const ck = jiraBaseUrl() ?? ''
  let ps = prioritiesCache.get(ck)
  if (ps === undefined) {
    const rows = await apiJsonAsync<PriorityRow[]>('GET', '/priority')
    ps = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && n !== '')
    prioritiesCache.set(ck, ps)
  }
  return ps
}

interface IssueTypeRow {
  name?: string
}

/** The site's issue-type names — create resolves a requested type
 *  case-insensitively against this list. */
export function issueTypes(): string[] {
  const ck = jiraBaseUrl() ?? ''
  let ts = issueTypesCache.get(ck)
  if (ts === undefined) {
    const rows = apiJson<IssueTypeRow[]>('GET', '/issuetype')
    ts = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && n !== '')
    issueTypesCache.set(ck, ts)
  }
  return ts
}

interface LinkTypes {
  issueLinkTypes?: JiraLinkType[]
}

export function linkTypes(): JiraLinkType[] {
  const ck = jiraBaseUrl() ?? ''
  let ts = linkTypesCache.get(ck)
  if (ts === undefined) {
    ts = apiJson<LinkTypes>('GET', '/issueLinkType').issueLinkTypes ?? []
    linkTypesCache.set(ck, ts)
  }
  return ts
}

/** Resolve a generic rel to a site link-type name: 'blocks' → the
 *  Blocks-ish type, 'related' → the relates-ish type, anything else →
 *  an exact (case-insensitive) site name. Throws when nothing matches —
 *  a rel that can't wire must fail before the write, never fake. */
export function linkTypeName(rel: string): string {
  const ts = linkTypes()
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
  throw new Error(`jira tasks: link rel '${rel}' matches no issue-link type on this site`)
}

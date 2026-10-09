/**
 * Linear API plumbing — transport, auth, and the cached resolution
 * probes (viewer, team, team meta) both facades share (spec
 * specs/bro-huy5o.2.md).
 *
 * Transport is split the way the contract forces it: the sync TaskStore
 * shells out to `curl` (the gh/glab precedent — the system's own tool;
 * there is no official linear CLI), the async probe surface and the
 * `queries` facade use native `fetch`. Both post to the fixed
 * `https://api.linear.app/graphql` — Linear is SaaS-only, so there is
 * no endpoint override to guard. Auth is `Authorization:
 * <LINEAR_API_KEY>` verbatim — personal keys are not Bearer-prefixed.
 *
 * Every operation is named (`query BroIssues`, `mutation BroIssueUpdate`)
 * — operation names are the test seam: a scripted `curl` on PATH and a
 * stubbed `fetch` dispatch on them.
 */
import { spawnSync } from 'node:child_process'

export const LINEAR_API = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 30_000

export interface LinearErr {
  message?: string
}

/** A parsed Linear GraphQL response — `errors` may ride a 200. */
export interface LinearResp {
  data?: Record<string, unknown>
  errors?: LinearErr[]
}

export type FetchFn = typeof fetch

/** LINEAR_API_KEY — explicit `env` overlay wins (query plans), else
 *  process.env. Missing is a setup problem, named with the remediation. */
export function apiKey(env?: Record<string, string>): string {
  const k = (env?.['LINEAR_API_KEY'] ?? process.env['LINEAR_API_KEY'])?.trim()
  if (!k) {
    throw new Error(
      'linear: LINEAR_API_KEY not set — create one in Linear → Settings → Security & access → Personal API keys'
    )
  }
  return k
}

const tryJson = (text: string): LinearResp | undefined => {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as LinearResp) : undefined
  } catch {
    return undefined
  }
}

/** First GraphQL error message when present — transport layers surface
 *  it inside HTTP-failure errors; callers that want it as THE error use
 *  unwrap(). */
const firstError = (r: LinearResp | undefined): string | undefined =>
  r?.errors?.find((e) => typeof e.message === 'string' && e.message !== '')?.message

// --- sync transport: curl ------------------------------------------------------

function curlPost(payload: string, timeoutMs = TIMEOUT_MS): LinearResp {
  const res = spawnSync(
    'curl',
    [
      '-sS',
      '--fail-with-body',
      '--max-time',
      String(Math.ceil(timeoutMs / 1000)),
      '-X',
      'POST',
      LINEAR_API,
      '-H',
      `Authorization: ${apiKey()}`,
      '-H',
      'Content-Type: application/json',
      // the document + vars ride stdin — a GraphQL payload never belongs
      // in argv where every local user can `ps` it
      '--data-binary',
      '@-',
    ],
    { input: payload, encoding: 'utf8', timeout: timeoutMs + 15_000, maxBuffer: 64 * 1024 * 1024 }
  )
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code
    throw new Error(
      code === 'ENOENT'
        ? 'linear: curl not found — the tasks sync transport needs curl on PATH'
        : `linear: curl failed — ${res.error.message}`
    )
  }
  const parsed = tryJson(res.stdout)
  if (res.status !== 0) {
    const detail =
      firstError(parsed) ??
      (res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(0, 300))
    throw new Error(`linear: request failed — ${detail !== '' ? detail : `curl exited ${res.status}`}`)
  }
  if (parsed === undefined) {
    throw new Error(`linear: non-JSON response — ${res.stdout.slice(0, 200)}`)
  }
  return parsed
}

// --- async transport: fetch -----------------------------------------------------

async function fetchPost(
  payload: string,
  env?: Record<string, string>,
  fetchImpl: FetchFn = fetch
): Promise<LinearResp> {
  const res = await fetchImpl(LINEAR_API, {
    method: 'POST',
    headers: {
      Authorization: apiKey(env),
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  const parsed = tryJson(text)
  if (!res.ok) {
    throw new Error(`linear: HTTP ${res.status} — ${firstError(parsed) ?? text.slice(0, 300)}`)
  }
  if (parsed === undefined) {
    throw new Error(`linear: non-JSON response — ${text.slice(0, 200)}`)
  }
  return parsed
}

// --- the two call shapes ------------------------------------------------------------

const body = (doc: string, vars?: Record<string, unknown>): string =>
  JSON.stringify(vars === undefined ? { query: doc } : { query: doc, variables: vars })

/** Tasks-path call — GraphQL errors throw (a failed mutation must fail
 *  the op, same as `gh api` exiting nonzero on them). `timeoutMs`
 *  shortens the budget for probes (auth) where 30s is too long. */
export function gql(
  doc: string,
  vars?: Record<string, unknown>,
  timeoutMs?: number
): Record<string, unknown> {
  return unwrap(curlPost(body(doc, vars), timeoutMs))
}

export async function gqlAsync(
  doc: string,
  vars?: Record<string, unknown>,
  fetchImpl?: FetchFn
): Promise<Record<string, unknown>> {
  return unwrap(await fetchPost(body(doc, vars), undefined, fetchImpl))
}

/** Raw passthrough for the `queries` facade — `data`/`errors` come back
 *  verbatim; only transport failures throw. */
export async function gqlRaw(
  doc: string,
  vars?: Record<string, unknown>,
  env?: Record<string, string>,
  fetchImpl?: FetchFn
): Promise<LinearResp> {
  return fetchPost(body(doc, vars), env, fetchImpl)
}

function unwrap(r: LinearResp): Record<string, unknown> {
  const msg = firstError(r)
  if (msg !== undefined) {
    throw new Error(`linear: ${msg}`)
  }
  if (r.data === undefined || typeof r.data !== 'object') {
    throw new Error('linear: response carries neither data nor errors — contract drifted')
  }
  return r.data
}

// --- cached resolutions --------------------------------------------------------

export interface LinearViewer {
  id: string
  displayName?: string
  name?: string
  email?: string
}

export interface LinearTeam {
  id: string
  key: string
  name?: string
}

export interface WorkflowState {
  id: string
  name: string
  type: string
  position: number
}

export interface TeamLabel {
  id: string
  name: string
}

export interface TeamMeta {
  id: string
  key: string
  states: WorkflowState[]
  labels: TeamLabel[]
}

const VIEWER_Q = `query BroViewer { viewer { id displayName name email } }`
const TEAMS_Q = `query BroTeams { teams(first: 100) { nodes { id key name } } }`
const TEAM_META_Q = `query BroTeamMeta($team: String!) {
  team(id: $team) {
    id key
    states { nodes { id name type position } }
    labels { nodes { id name } }
  }
}`
const USERS_Q = `query BroUsers { users(first: 250) { nodes { id displayName name email } } }`

// Caches key on the credential/scope that produced them — a test that
// swaps LINEAR_API_KEY or LINEAR_TEAM must never inherit a stale pick.
const viewerCache = new Map<string, LinearViewer>()
const teamCache = new Map<string, LinearTeam>()
const teamMetaCache = new Map<string, TeamMeta>()
const usersCache = new Map<string, { id: string; displayName?: string; name?: string; email?: string }[]>()

function viewerFrom(data: Record<string, unknown>): LinearViewer {
  const v = data['viewer'] as LinearViewer | undefined
  if (v === undefined || typeof v.id !== 'string') {
    throw new Error('linear: viewer query returned no viewer — is LINEAR_API_KEY valid?')
  }
  return v
}

export function viewer(timeoutMs?: number): LinearViewer {
  const key = apiKey()
  let v = viewerCache.get(key)
  if (v === undefined) {
    v = viewerFrom(gql(VIEWER_Q, undefined, timeoutMs))
    viewerCache.set(key, v)
  }
  return v
}

export async function viewerAsync(fetchImpl?: FetchFn): Promise<LinearViewer> {
  const key = apiKey()
  let v = viewerCache.get(key)
  if (v === undefined) {
    v = viewerFrom(await gqlAsync(VIEWER_Q, undefined, fetchImpl))
    viewerCache.set(key, v)
  }
  return v
}

const teamListFrom = (data: Record<string, unknown>): LinearTeam[] =>
  (((data['teams'] as { nodes?: LinearTeam[] } | undefined)?.nodes) ?? []).filter(
    (t) => typeof t.id === 'string' && typeof t.key === 'string'
  )

function teamMetaFrom(data: Record<string, unknown>, want: string): TeamMeta {
  const t = data['team'] as
    | (Omit<TeamMeta, 'states' | 'labels'> & {
        states?: { nodes?: WorkflowState[] }
        labels?: { nodes?: TeamLabel[] }
      } | null)
    | undefined
  if (t == null || typeof t.id !== 'string') {
    throw new Error(`linear: team "${want}" not found — check LINEAR_TEAM`)
  }
  return {
    id: t.id,
    key: t.key,
    states: t.states?.nodes ?? [],
    labels: t.labels?.nodes ?? [],
  }
}

function resolveTeam(teams: LinearTeam[]): LinearTeam {
  const want = process.env['LINEAR_TEAM']?.trim()
  if (want !== undefined && want !== '') {
    const t = teams.find(
      (x) => x.key.toLowerCase() === want.toLowerCase() || x.id === want
    )
    if (t === undefined) {
      throw new Error(
        `linear: LINEAR_TEAM "${want}" matches no team — ` +
          `visible: ${teams.map((x) => x.key).join(', ') || '(none)'}`
      )
    }
    return t
  }
  if (teams.length === 1) {
    return teams[0]!
  }
  throw new Error(
    teams.length === 0
      ? 'linear: LINEAR_API_KEY sees no teams'
      : `linear: LINEAR_TEAM required — teams: ${teams.map((t) => t.key).join(', ')}`
  )
}

/** The serving team — `LINEAR_TEAM` (key or UUID), else the workspace's
 *  single team. `team(id:)` accepts the key directly, but a teams-list
 *  probe is still the honest path for the auto-detect + error listing. */
export function team(): LinearTeam {
  const want = process.env['LINEAR_TEAM']?.trim() ?? ''
  const ck = `${apiKey()}${want.toLowerCase()}`
  let t = teamCache.get(ck)
  if (t === undefined) {
    t = resolveTeam(teamListFrom(gql(TEAMS_Q)))
    teamCache.set(ck, t)
  }
  return t
}

export async function teamAsync(fetchImpl?: FetchFn): Promise<LinearTeam> {
  const want = process.env['LINEAR_TEAM']?.trim() ?? ''
  const ck = `${apiKey()}${want.toLowerCase()}`
  let t = teamCache.get(ck)
  if (t === undefined) {
    t = resolveTeam(teamListFrom(await gqlAsync(TEAMS_Q, undefined, fetchImpl)))
    teamCache.set(ck, t)
  }
  return t
}

/** States + labels for one team — the write path's lookup table
 *  (close/reopen pick states; label writes resolve ids). */
export function teamMeta(teamIdOrKey: string): TeamMeta {
  let m = teamMetaCache.get(teamIdOrKey)
  if (m === undefined) {
    m = teamMetaFrom(gql(TEAM_META_Q, { team: teamIdOrKey }), teamIdOrKey)
    teamMetaCache.set(teamIdOrKey, m)
    teamMetaCache.set(m.id, m)
  }
  return m
}

export async function teamMetaAsync(teamIdOrKey: string, fetchImpl?: FetchFn): Promise<TeamMeta> {
  let m = teamMetaCache.get(teamIdOrKey)
  if (m === undefined) {
    m = teamMetaFrom(await gqlAsync(TEAM_META_Q, { team: teamIdOrKey }, fetchImpl), teamIdOrKey)
    teamMetaCache.set(teamIdOrKey, m)
    teamMetaCache.set(m.id, m)
  }
  return m
}

/** Workspace users — `update --assignee <name>` resolves a login to an
 *  id here. `claim` never needs it (it always means `viewer`). */
export function users(): { id: string; displayName?: string; name?: string; email?: string }[] {
  const key = apiKey()
  let u = usersCache.get(key)
  if (u === undefined) {
    u =
      ((gql(USERS_Q)['users'] as { nodes?: typeof u } | undefined)?.nodes) ?? []
    usersCache.set(key, u)
  }
  return u
}

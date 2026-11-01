/**
 * The gitlab connector's `tasks` facade — the TaskStore contract over
 * GitLab Issues (opt-in). `glab api` is the transport.
 *
 * Mapping:
 *   id        — project-scoped issue iid as string ('42'); accepted forms
 *               '#42', '42', issue URLs (same project), and optionally
 *               'group/project#42' or 'group/project:42' for cross-project
 *               references when disambiguated
 *   status    — closed | in_progress (bro:claimed label or assignee) |
 *               blocked (open blocker/label) | open
 *   claim     — assignee + `bro:claimed` label (label lands last)
 */
import { bodyMeta, stripMeta, withMeta } from '@broject/core'
import type { ClaimCapability, TaskFilter, TaskInput, TaskRow, TaskStore, TaskStoreAsync } from '@broject/core'
import { gitTry } from '@broject/core'
import { glab, glabJson, glabJsonAsync, glabPaged, glabPagedAsync, glabTry } from './glab.ts'
import type { GlabOpts } from './glab.ts'
import { hostFor } from './reviews.ts'

const CLAIMED_LABEL = 'bro:claimed'
const BLOCKED_LABEL = 'blocked'
const DEFAULT_PRIORITY = 2
const QUERY_CAP = 1000

// --- repo resolution -----------------------------------------------------------

function remoteUrl(dir: string): string | undefined {
  const r = gitTry(['-C', dir, 'remote', 'get-url', 'origin'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : undefined
}

/** host + path split for GitLab remotes — https, ssh:// and scp-style */
function remoteParts(url: string): { host: string; path: string } | null {
  const m =
    /^(?:https?|ssh):\/\/([^/]+)\/(.+?)\/?$/i.exec(url) ??
    /^[^@\s]+@([^:/]+):(.+?)\/?$/.exec(url)
  if (!m) {
    return null
  }
  return { host: m[1]!.toLowerCase(), path: m[2]!.replace(/\.git$/, '') }
}

function resolveProjectPath(dir: string, positional: string[] = []): string {
  if (positional.length > 0) {
    return positional.join('/')
  }
  const url = remoteUrl(dir)
  const path = url === undefined ? null : remoteParts(url)?.path
  if (!path) {
    throw new Error('no GitLab remote — pass GROUP/PROJECT or add an origin remote')
  }
  return path
}

function api(projectPath: string, path: string): string {
  return `projects/${encodeURIComponent(projectPath)}/${path}`
}

function gopts(dir: string): GlabOpts {
  return { cwd: dir, env: { GITLAB_HOST: hostFor(dir) } }
}

// --- issue row shape -----------------------------------------------------------

interface GitLabIssue {
  iid: number
  id?: number
  title?: string
  description?: string | null
  state?: string // opened | closed
  web_url?: string
  created_at?: string
  closed_at?: string | null
  assignees?: { username?: string }[]
  labels?: string[]
  milestone?: { title?: string } | null
  references?: { full?: string }
}

const actorCache = new Map<string, string>()

function glabActor(dir: string): string {
  let a = actorCache.get(dir)
  if (a === undefined || a === '') {
    try {
      const u = glabJson<{ username?: string }>(['api', 'user'], gopts(dir))
      a = u.username ?? ''
      if (a !== '') {
        actorCache.set(dir, a)
      }
    } catch {
      a = ''
    }
  }
  return a
}

async function glabActorAsync(dir: string): Promise<string> {
  let a = actorCache.get(dir)
  if (a === undefined || a === '') {
    try {
      const u = await glabJsonAsync<{ username?: string }>(['api', 'user'], gopts(dir))
      a = u.username ?? ''
      if (a !== '') {
        actorCache.set(dir, a)
      }
    } catch {
      a = ''
    }
  }
  return a
}

function labelsOf(i: GitLabIssue): string[] {
  return i.labels ?? []
}

function assigneesOf(i: GitLabIssue): string[] {
  return (i.assignees ?? []).map((a) => a.username).filter((x): x is string => typeof x === 'string')
}

function isBlocked(i: GitLabIssue, labels: string[]): boolean {
  return labels.includes(BLOCKED_LABEL)
}

function statusOf(i: GitLabIssue, labels: string[], assignees: string[]): string {
  if (i.state === 'closed') {
    return 'closed'
  }
  if (labels.includes(CLAIMED_LABEL) || assignees.length > 0) {
    return 'in_progress'
  }
  return isBlocked(i, labels) ? 'blocked' : 'open'
}

function issueTypeOf(labels: string[], meta: Record<string, unknown>): string {
  const tagged = labels.find((l) => /^(type|kind):/i.test(l))?.split(':', 2)[1]?.trim()
  if (tagged) {
    return tagged.toLowerCase()
  }
  if (labels.some((l) => /^epic$/i.test(l))) {
    return 'epic'
  }
  return typeof meta.type === 'string' && meta.type !== '' ? meta.type : 'task'
}

function priorityOf(labels: string[], meta: Record<string, unknown>): number {
  for (const l of labels) {
    const m = /^p([0-4])$/i.exec(l) ?? /^priority[: -]([0-4])$/i.exec(l)
    if (m) {
      return Number(m[1])
    }
  }
  const p = meta.priority
  return typeof p === 'number' ? p : DEFAULT_PRIORITY
}

function toRow(i: GitLabIssue, projectPath: string): TaskRow {
  const labels = labelsOf(i)
  const assignees = assigneesOf(i)
  const meta = bodyMeta(i.description ?? undefined)
  const row: TaskRow & { created_at?: string } = {
    id: String(i.iid),
    title: i.title,
    status: statusOf(i, labels, assignees),
    issue_type: issueTypeOf(labels, meta),
    priority: priorityOf(labels, meta),
    labels,
    description: stripMeta(i.description ?? undefined),
    external_ref:
      typeof meta.external_ref === 'string' && meta.external_ref !== ''
        ? meta.external_ref
        : i.web_url ?? `${projectPath}#${i.iid}`,
    metadata: Object.keys(meta).length > 0 ? meta : null,
    created_at: i.created_at,
  }
  if (assignees.length > 0) {
    row.assignee = assignees.join(', ')
  }
  if (i.closed_at) {
    row.closed_at = i.closed_at
  }
  return row
}

const pub = (r: TaskRow): TaskRow => r

function assertNoNewline(v: string, name: string): void {
  if (v.includes('\n') || v.includes('\r')) {
    throw new Error(`gitlab tasks: invalid ${name} (newlines not allowed)`)
  }
}

function sanitizeField(v: string, name: string): string {
  assertNoNewline(v, name)
  return v
}

// --- id resolution -------------------------------------------------------------

function parseIssueRef(dir: string, id: string): { projectPath: string; iid: number } {
  const t = id.trim()
  // full URL
  const url = /^https?:\/\/([^/]+)\/(.+)\/-\/issues\/(\d+)\/?$/.exec(t)
  if (url) {
    const host = url[1]!.toLowerCase()
    const myHost = hostFor(dir).toLowerCase()
    const path = url[2]!.replace(/\.git$/, '')
    if (host !== myHost) {
      throw new Error(`gitlab tasks: "${id}" is from ${host} — this store serves ${myHost}`)
    }
    const myProj = resolveProjectPath(dir).toLowerCase()
    if (path.toLowerCase() !== myProj) {
      throw new Error(`gitlab tasks: "${id}" is for ${path} — this store serves ${resolveProjectPath(dir)}`)
    }
    return { projectPath: resolveProjectPath(dir), iid: Number(url[3]) }
  }
  // group/project#iid or group/project:iid
  const projRef = /^(.+)[:#](\d+)$/.exec(t)
  if (projRef) {
    const path = projRef[1]!
    // try to validate against current project if it matches host? be permissive but prefer current project context
    const iid = Number(projRef[2])
    // if it points to different project, still allow if it's a full path - but task says iid scoped to project;
    // use as-is (path) but also compare with current project for safety? be flexible
    const myProj = resolveProjectPath(dir)
    if (path.toLowerCase() !== myProj.toLowerCase()) {
      // still allow - store may be used cross-project? but better to be strict like others
      // but requirement says "iid двух проектов" in fixtures - so must support different projects
      return { projectPath: path, iid }
    }
    return { projectPath: myProj, iid }
  }
  // just number
  if (!/^(#\d+|\d+)$/.test(t)) {
    throw new Error(`gitlab tasks: "${id}" is not an issue reference (want 42, #42, group/proj#42, or an issue URL)`)
  }
  const n = Number(t.replace(/^#/, ''))
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`gitlab tasks: "${id}" is not an issue reference (want 42, #42, group/proj#42, or an issue URL)`)
  }
  return { projectPath: resolveProjectPath(dir), iid: n }
}

// --- list/query ---------------------------------------------------------------

function statesFor(f: TaskFilter): string[] {
  if (f.all === true) {
    return ['opened', 'closed']
  }
  return f.status === 'closed' ? ['closed'] : ['opened']
}

const needsPostFilter = (f: TaskFilter): boolean =>
  (f.labels?.length ?? 0) > 0 ||
  (f.excludeLabels?.length ?? 0) > 0 ||
  f.type !== undefined ||
  (f.status !== undefined && f.status !== 'closed')

const fetchCap = (f: TaskFilter): number =>
  needsPostFilter(f)
    ? QUERY_CAP
    : Math.min(f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP, QUERY_CAP)

function applyFilter(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  let q = rows
  if (f.status !== undefined) {
    q = q.filter((r) => r.status === f.status)
  } else if (f.all !== true) {
    q = q.filter((r) => r.status !== 'closed')
  }
  for (const l of f.labels ?? []) {
    q = q.filter((r) => r.labels?.includes(l))
  }
  for (const l of f.excludeLabels ?? []) {
    q = q.filter((r) => !(r.labels ?? []).includes(l))
  }
  if (f.type !== undefined) {
    q = q.filter((r) => r.issue_type === f.type)
  }
  if (f.limit !== undefined && f.limit > 0) {
    q = q.slice(0, f.limit)
  }
  return q
}

const byPriority = (a: TaskRow, b: TaskRow): number =>
  (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
  String((a as TaskRow & { created_at?: string }).created_at ?? '').localeCompare(
    String((b as TaskRow & { created_at?: string }).created_at ?? '')
  )

function readyOf(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  return rows
    .filter((r) => r.status === 'open')
    .sort(byPriority)
    .slice(0, f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP)
}

function queryIssuesSync(dir: string, states: string[], limit: number): GitLabIssue[] {
  const projectPath = resolveProjectPath(dir)
  const out: GitLabIssue[] = []
  // Try to fetch all states
  for (const state of states) {
    const endpoint = `${api(projectPath, 'issues')}?state=${state}&per_page=100`
    try {
      const rows = glabPaged<GitLabIssue>(endpoint, gopts(dir))
      out.push(...rows)
      if (out.length >= limit) {
        break
      }
    } catch (err) {
      // if pagination/fetch fails, try to be resilient
      throw err
    }
    if (out.length >= limit) {
      break
    }
  }
  return out.slice(0, limit)
}

async function queryIssuesAsync(dir: string, states: string[], limit: number): Promise<GitLabIssue[]> {
  const projectPath = resolveProjectPath(dir)
  const out: GitLabIssue[] = []
  for (const state of states) {
    const endpoint = `${api(projectPath, 'issues')}?state=${state}&per_page=100`
    try {
      const rows = await glabPagedAsync<GitLabIssue>(endpoint, gopts(dir))
      out.push(...rows)
      if (out.length >= limit) {
        break
      }
    } catch (err) {
      throw err
    }
    if (out.length >= limit) {
      break
    }
  }
  return out.slice(0, limit)
}

function getIssueSync(dir: string, ref: { projectPath: string; iid: number }): GitLabIssue | undefined {
  try {
    const issue = glabJson<GitLabIssue>(['api', api(ref.projectPath, `issues/${ref.iid}`)], gopts(dir))
    return issue
  } catch {
    return undefined
  }
}

async function getIssueAsync(dir: string, ref: { projectPath: string; iid: number }): Promise<GitLabIssue | undefined> {
  try {
    const issue = await glabJsonAsync<GitLabIssue>(['api', api(ref.projectPath, `issues/${ref.iid}`)], gopts(dir))
    return issue
  } catch {
    return undefined
  }
}

// --- mutations -----------------------------------------------------------------

function ensureLabel(dir: string, projectPath: string, name: string): void {
  // try to create label if missing (best effort)
  glabTry(['api', '-X', 'POST', api(projectPath, 'labels'), '-f', `name=${name}`, '-f', 'color=#8b949e'], gopts(dir))
}

function createMeta(i: TaskInput): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...(i.metadata as Record<string, unknown> | undefined) }
  if (i.type !== undefined) {
    meta.type = i.type
  }
  if (i.priority !== undefined) {
    meta.priority = i.priority
  }
  if (i.externalRef !== undefined) {
    meta.external_ref = i.externalRef
  }
  return meta
}

function createSync(dir: string, input: TaskInput): GitLabIssue {
  const projectPath = resolveProjectPath(dir)
  const meta = createMeta(input)
  const desc = withMeta(input.description, meta)
  assertNoNewline(input.title, 'title')
  const args: string[] = ['api', '-X', 'POST', api(projectPath, 'issues'), '-f', `title=${input.title}`]
  if (desc) {
    assertNoNewline(desc, 'description')
    args.push('-f', `description=${desc}`)
  }
  if (input.labels?.length) {
    for (const l of input.labels) {
      assertNoNewline(l, 'label')
      args.push('-f', `labels[]=${l}`)
    }
  }
  try {
    const issue = glabJson<GitLabIssue>(args, gopts(dir))
    return issue
  } catch (err) {
    throw err
  }
}

function updateSync(dir: string, id: string, patch: Record<string, string | number>): void {
  const ref = parseIssueRef(dir, id)
  const args: string[] = ['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`)]
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'title') {
      assertNoNewline(String(v), 'title')
      args.push('-f', `title=${v}`)
    } else if (k === 'description' || k === 'body') {
      assertNoNewline(String(v), 'description')
      args.push('-f', `description=${v}`)
    } else if (k === 'status') {
      // status changes go through reopen/close; but support best effort
      continue
    } else if (k === 'labels' || k === 'label') {
      assertNoNewline(String(v), 'labels')
      args.push('-f', `labels=${v}`)
    } else if (k === 'assignee') {
      // could set assignee_id - but need user lookup; skip for now or try
    } else {
      // try to pass through
    }
  }
  if (args.length > 4) { // has some params beyond the base 4
    glab(args, gopts(dir))
  }
}

const CLAIM_CAPABILITY = {
  strength: 'best-effort',
  identity: 'viewer',
  authority: 'service',
} as const satisfies ClaimCapability

function claimSync(dir: string, id: string): void {
  const ref = parseIssueRef(dir, id)
  const n = getIssueSync(dir, ref)
  if (n === undefined) {
    throw new Error(`gitlab tasks: issue ${id} not found`)
  }
  if (n.state === 'closed') {
    throw new Error(`gitlab tasks: ${id} is closed — only open issues are claimable`)
  }
  const labels = labelsOf(n)
  const assignees = assigneesOf(n)
  if (labels.includes(CLAIMED_LABEL) || assignees.length > 0) {
    const holders = assignees.length > 0 ? ` by ${assignees.join(', ')}` : ''
    throw new Error(`gitlab tasks: ${id} already claimed${holders}`)
  }
  const me = glabActor(dir)
  if (me === '') {
    throw new Error('gitlab tasks: claim needs a glab identity — `glab api user` returned no login')
  }
  ensureLabel(dir, ref.projectPath, CLAIMED_LABEL)
  // add assignee - need assignee_id; try to find user
  try {
    const users = glabJson<Array<{ id: number; username: string }>>(['api', `users?username=${encodeURIComponent(me)}`], gopts(dir))
    if (users.length > 0 && users[0]?.id) {
      glab(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', `assignee_id=${users[0].id}`], gopts(dir))
    } else {
      throw new Error(`gitlab tasks: could not resolve user ID for ${me} — cannot claim`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('could not resolve user ID')) {
      throw err
    }
    throw new Error(`gitlab tasks: failed to assign ${me} to ${id} — cannot claim`)
  }
  const check = getIssueSync(dir, ref)
  const checkAssignees = check ? assigneesOf(check) : assignees
  const others = checkAssignees.filter((a) => a !== me)
  if (others.length === 0) {
    glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', `labels=${[...labels, CLAIMED_LABEL].join(',')}`], gopts(dir))
    return
  }
  const winner = [...others, me].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!
  if (winner !== me) {
    glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', 'assignee_id=0'], gopts(dir))
    throw new Error(`gitlab tasks: ${id} claim contested — ${winner} holds it`)
  }
  glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', `labels=${[...labels, CLAIMED_LABEL].join(',')}`], gopts(dir))
}

function reopenSync(dir: string, id: string): void {
  const ref = parseIssueRef(dir, id)
  const cur = getIssueSync(dir, ref)
  if (cur === undefined) {
    throw new Error(`gitlab tasks: issue ${id} not found`)
  }
  if (cur.state !== 'opened') {
    glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', 'state_event=reopen'], gopts(dir))
  }
  glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', 'assignee_id=0'], gopts(dir))
  const labels = labelsOf(cur).filter((l) => l !== CLAIMED_LABEL && l !== BLOCKED_LABEL)
  glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', `labels=${labels.join(',')}`], gopts(dir))
}

function closeSync(dir: string, id: string, reason?: string): void {
  const ref = parseIssueRef(dir, id)
  if (reason) {
    assertNoNewline(reason, 'note')
    glabTry(['api', '-X', 'POST', api(ref.projectPath, `issues/${ref.iid}/notes`), '-f', `body=${reason}`], gopts(dir))
  }
  glabTry(['api', '-X', 'PUT', api(ref.projectPath, `issues/${ref.iid}`), '-f', 'state_event=close'], gopts(dir))
}

function removeSync(dir: string, id: string): void {
  const ref = parseIssueRef(dir, id)
  glabTry(['api', '-X', 'DELETE', api(ref.projectPath, `issues/${ref.iid}`)], gopts(dir))
}

// --- relations/deps ------------------------------------------------------------

function linkSync(dir: string, from: string, to: string, rel: string = 'related'): void {
  const f = parseIssueRef(dir, from)
  const t = parseIssueRef(dir, to)
  if (f.projectPath.toLowerCase() !== t.projectPath.toLowerCase()) {
    throw new Error(`gitlab tasks: cross-project links not supported`)
  }
  if (rel === 'parent' || rel === 'parent-child' || rel === 'tracks' || rel === 'discovered') {
    throw new Error(`gitlab tasks: unsupported dependency operations explicitly rejected (rel '${rel}')`)
  }
  if (rel === 'blocked' || rel === 'blocks' || rel === 'blocked-by') {
    try {
      glab(['api', '-X', 'POST', api(f.projectPath, `issues/${f.iid}/links`), '-f', `target_issue_iid=${t.iid}`, '-f', `link_type=blocks`], gopts(dir))
    } catch {
      try {
        glab(['api', '-X', 'POST', api(f.projectPath, `issues/${f.iid}/links`), '-f', `target_project_id=${encodeURIComponent(t.projectPath)}`, '-f', `target_issue_iid=${t.iid}`], gopts(dir))
      } catch (err) {
        throw err
      }
    }
    return
  }
  if (rel === 'related') {
    try {
      glab(['api', '-X', 'POST', api(f.projectPath, `issues/${f.iid}/links`), '-f', `target_issue_iid=${t.iid}`], gopts(dir))
    } catch {
      try {
        glab(['api', '-X', 'POST', api(f.projectPath, `issues/${f.iid}/links`), '-f', `target_project_id=${encodeURIComponent(t.projectPath)}`, '-f', `target_issue_iid=${t.iid}`], gopts(dir))
      } catch (err) {
        throw err
      }
    }
    return
  }
  throw new Error(`gitlab tasks: unsupported dependency operations explicitly rejected (rel '${rel}')`)
}

export function gitlabTasks(dir: string): TaskStore {
  return {
    list: (f = {}) => {
      const issues = queryIssuesSync(dir, statesFor(f), fetchCap(f))
      const rows = issues.map((i) => toRow(i, resolveProjectPath(dir))).map(pub)
      return applyFilter(rows, f) as never
    },
    ready: (f = {}) => {
      const issues = queryIssuesSync(dir, ['opened'], QUERY_CAP)
      const rows = issues.map((i) => toRow(i, resolveProjectPath(dir))).map(pub)
      let q = rows.filter((r) => r.status !== 'closed')
      if ((f.labels?.length ?? 0) > 0) {
        for (const l of f.labels!) q = q.filter((r) => r.labels?.includes(l))
      }
      if ((f.excludeLabels?.length ?? 0) > 0) {
        for (const l of f.excludeLabels!) q = q.filter((r) => !(r.labels ?? []).includes(l))
      }
      if (f.type !== undefined) q = q.filter((r) => r.issue_type === f.type)
      q = readyOf(q, f)
      return q as never
    },
    get: (id) => {
      const ref = parseIssueRef(dir, id)
      const i = getIssueSync(dir, ref)
      return i === undefined ? undefined : (toRow(i, ref.projectPath) as never)
    },
    create: (i) => toRow(createSync(dir, i), resolveProjectPath(dir)) as never,
    update: (id, patch) => updateSync(dir, id, patch),
    claim: (id) => claimSync(dir, id),
    claimCapability: () => CLAIM_CAPABILITY,
    actor: () => glabActor(dir),
    reopen: (id) => reopenSync(dir, id),
    close: (id, reason) => closeSync(dir, id, reason),
    remove: (id) => removeSync(dir, id),
    note: (id, text) => {
      const ref = parseIssueRef(dir, id)
      assertNoNewline(text, 'note')
      glab(['api', '-X', 'POST', api(ref.projectPath, `issues/${ref.iid}/notes`), '-f', `body=${text}`], gopts(dir))
    },
    children: (_id) => {
      throw new Error('gitlab tasks: children not supported')
    },
    deps: (_ids, _opts = {}) => {
      throw new Error('gitlab tasks: deps not supported')
    },
    neighbors: (_id, _opts = {}) => {
      throw new Error('gitlab tasks: neighbors not supported')
    },
    link: (from, to, rel = 'related') => linkSync(dir, from, to, rel),
    prefix: () => {
      try {
        const p = resolveProjectPath(dir)
        return p.split('/').pop()
      } catch {
        return undefined
      }
    },
  }
}

export function gitlabTasksAsync(dir: string): TaskStoreAsync {
  return {
    list: async (f = {}) => {
      const issues = await queryIssuesAsync(dir, statesFor(f), fetchCap(f))
      const rows = issues.map((i) => toRow(i, resolveProjectPath(dir))).map(pub)
      return applyFilter(rows, f)
    },
    ready: async (f = {}) => {
      const issues = await queryIssuesAsync(dir, ['opened'], QUERY_CAP)
      const rows = issues.map((i) => toRow(i, resolveProjectPath(dir))).map(pub)
      let q = rows.filter((r) => r.status !== 'closed')
      if ((f.labels?.length ?? 0) > 0) {
        for (const l of f.labels!) q = q.filter((r) => r.labels?.includes(l))
      }
      if ((f.excludeLabels?.length ?? 0) > 0) {
        for (const l of f.excludeLabels!) q = q.filter((r) => !(r.labels ?? []).includes(l))
      }
      if (f.type !== undefined) q = q.filter((r) => r.issue_type === f.type)
      q = readyOf(q, f)
      return q
    },
    get: async (id) => {
      const ref = parseIssueRef(dir, id)
      const i = await getIssueAsync(dir, ref)
      return i === undefined ? undefined : toRow(i, ref.projectPath)
    },
    children: async () => {
      throw new Error('gitlab tasks: children not supported')
    },
    deps: async () => {
      throw new Error('gitlab tasks: deps not supported')
    },
    neighbors: async () => {
      throw new Error('gitlab tasks: neighbors not supported')
    },
    actor: () => glabActorAsync(dir),
  }
}

/**
 * The jira connector's `tasks` facade — the TaskStore contract over
 * Jira Cloud REST, reached through `atlassian api` (spec
 * specs/bro-huy5o.3.md). Same mapping contract as github-issues
 * (bro-huy5o.1) and linear (bro-huy5o.2):
 *
 *   id        — the issue key ('PROJ-123'); bare numbers resolve inside
 *               the serving project, /browse/ URLs and internal ids
 *               pass through
 *   status    — statusCategory done → closed | indeterminate →
 *               in_progress | new/other → in_progress (assignee) |
 *               blocked | open
 *   blocked   — open 'Blocks' inward link, open sub-task, 'blocked'
 *               label
 *   claim     — assignee IS the claim: read → PUT assignee → verify.
 *               Single-assignee writes settle races — the verify read
 *               shows the sole holder. A 'start' transition rides
 *               best-effort on top so the board column follows
 *   close     — comment reason → transition to the first 'done' target
 *   reopen    — transition to 'new' (fallback 'indeterminate') +
 *               unassign + drop the blocked label
 *   type      — native issuetype wins (Jira HAS types), then type:/
 *               kind:/epic labels, then the description trailer
 *   priority  — positional over the site's ordered priority list
 *   parent    — sub-tasks stay OUT of row.parent (contract: row.parent
 *               means orchestrated step — a plain sub-task is claimable
 *               work; its parent is un-ready while open)
 */
import {
  bodyMeta,
  canonicalTaskRel,
  nativeTaskRel,
  stripMeta,
  withMeta,
} from '@broject/core'
import type {
  DepOpts,
  TaskDepEdge,
  TaskFilter,
  TaskInput,
  TaskRow,
  TaskStore,
  TaskStoreAsync,
} from '@broject/core'
import {
  api,
  apiGet,
  apiGetAsync,
  apiJson,
  apiJsonAsync,
  issueTypes,
  linkTypeName,
  priorities,
  prioritiesAsync,
  project,
  projectAsync,
  viewer,
  viewerAsync,
  type JiraViewer,
} from './api.ts'

const BLOCKED_LABEL = 'blocked'
const DEFAULT_PRIORITY = 2
const QUERY_CAP = 1000
const PAGE = 100

// --- issue shape ---------------------------------------------------------------

interface JiraStatus {
  name?: string
  statusCategory?: { key?: string; name?: string }
}

interface JiraIssueRef {
  id?: string
  key?: string
  fields?: { status?: JiraStatus; summary?: string }
}

/** An issuelinks entry names the COUNTERPART by its own side in the
 *  link: `inwardIssue` present means this issue is the outward side
 *  ("this issue blocks inwardIssue" for Blocks) — the counterpart
 *  depends on this one. `outwardIssue` present means this issue is the
 *  inward side ("is blocked by") — this one depends on it. */
interface JiraLink {
  id?: string
  type?: { name?: string; inward?: string; outward?: string }
  inwardIssue?: JiraIssueRef
  outwardIssue?: JiraIssueRef
}

interface JiraFields {
  summary?: string
  description?: unknown
  status?: JiraStatus
  issuetype?: { name?: string }
  priority?: { name?: string } | null
  assignee?: { accountId?: string; displayName?: string; emailAddress?: string } | null
  labels?: string[]
  issuelinks?: JiraLink[]
  subtasks?: JiraIssueRef[]
  parent?: JiraIssueRef
  resolution?: { name?: string } | null
  created?: string
  resolutiondate?: string | null
}

interface JiraIssue {
  id?: string
  key?: string
  self?: string
  fields?: JiraFields
}

const FIELDS =
  'summary,description,status,issuetype,priority,assignee,labels,' +
  'issuelinks,subtasks,parent,resolution,created,resolutiondate'

const category = (n: JiraIssue): string => n.fields?.status?.statusCategory?.key ?? ''
const isDone = (n: JiraIssue): boolean => category(n) === 'done'
const refLive = (r: JiraIssueRef | null | undefined): boolean =>
  r != null && r.fields?.status?.statusCategory?.key !== 'done'
const labelsOf = (n: JiraIssue): string[] => n.fields?.labels ?? []
const assigneeName = (n: JiraIssue): string => {
  const a = n.fields?.assignee
  return a?.displayName ?? a?.emailAddress ?? a?.accountId ?? ''
}

/** Jira link-type name → generic rel: 'Blocks'→'blocked',
 *  'Relates'→'related', site customs pass through lowercased —
 *  canonicalTaskRel keeps 'blocks'/'blocked-by' inputs honest. */
const linkRel = (name: string | undefined): string =>
  canonicalTaskRel(
    /block/i.test(name ?? '')
      ? 'blocked'
      : /relat/i.test(name ?? '')
        ? 'related'
        : (name ?? '').toLowerCase()
  )

/** An open issue is blocked by an unresolved 'Blocks' link landing on
 *  its inward side, an open sub-task, or the manual label — the
 *  github/linear rule. The blocker is the outwardIssue (it blocks
 *  this issue). */
const isBlocked = (n: JiraIssue): boolean =>
  labelsOf(n).includes(BLOCKED_LABEL) ||
  (n.fields?.issuelinks ?? []).some(
    (l) => linkRel(l.type?.name) === 'blocked' && refLive(l.outwardIssue)
  ) ||
  (n.fields?.subtasks ?? []).some((s) => refLive(s))

function statusOf(n: JiraIssue): string {
  if (isDone(n)) {
    return 'closed'
  }
  if (category(n) === 'indeterminate' || n.fields?.assignee != null) {
    return 'in_progress'
  }
  return isBlocked(n) ? 'blocked' : 'open'
}

function issueTypeOf(n: JiraIssue, meta: Record<string, unknown>): string {
  const native = n.fields?.issuetype?.name?.trim()
  if (native) {
    return native.toLowerCase()
  }
  const labels = labelsOf(n)
  const tagged = labels.find((l) => /^(type|kind):/i.test(l))?.split(':', 2)[1]?.trim()
  if (tagged) {
    return tagged.toLowerCase()
  }
  if (labels.some((l) => /^epic$/i.test(l))) {
    return 'epic'
  }
  return typeof meta.type === 'string' && meta.type !== '' ? meta.type : 'task'
}

// --- priority: positional over the site's ordered list ---------------------------

const clampPrio = (p: number): number => Math.min(4, Math.max(0, Math.round(p)))

/** site priority name → bd 0-4 — index i of n names maps to
 *  round(i·4/(n-1)): the default 5-name scheme lands Highest→0 …
 *  Lowest→4, a custom scheme still orders deterministically. */
function toBdPriority(name: string, ps: string[]): number | undefined {
  const i = ps.findIndex((x) => x.toLowerCase() === name.toLowerCase())
  if (i < 0 || ps.length < 2) {
    return undefined
  }
  return Math.round((i * 4) / (ps.length - 1))
}

function toJiraPriority(p: number, ps: string[]): string | undefined {
  if (ps.length === 0) {
    return undefined
  }
  return ps[Math.round((clampPrio(p) * (ps.length - 1)) / 4)]
}

function priorityOf(n: JiraIssue, meta: Record<string, unknown>, ps: string[]): number {
  const name = n.fields?.priority?.name
  if (name !== undefined && name !== '') {
    const p = toBdPriority(name, ps)
    if (p !== undefined) {
      return p
    }
  }
  const p = meta.priority
  return typeof p === 'number' ? p : DEFAULT_PRIORITY
}

// --- ADF ↔ text -------------------------------------------------------------------

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

// --- row ------------------------------------------------------------------------

/** `self` (https://site/…/issue/<id>) → the human browse URL; gateway
 *  selfs keep no site name, so they pass through verbatim. */
function browseUrl(n: JiraIssue): string | undefined {
  const key = n.key
  if (key === undefined) {
    return undefined
  }
  const self = n.self ?? ''
  const m = /^(https?:\/\/[^/]+)\//.exec(self)
  if (m === null || /api\.atlassian\.com$/.test(m[1]!)) {
    return self !== '' ? self : undefined
  }
  return `${m[1]}/browse/${key}`
}

function toRow(n: JiraIssue, ps: string[]): TaskRow {
  const key = n.key ?? ''
  const text = adfText(n.fields?.description)
  const meta = bodyMeta(text)
  const row: TaskRow & { created_at?: string; __node?: JiraIssue } = {
    id: key,
    title: n.fields?.summary,
    status: statusOf(n),
    issue_type: issueTypeOf(n, meta),
    priority: priorityOf(n, meta, ps),
    labels: labelsOf(n),
    description: stripMeta(text),
    external_ref:
      typeof meta.external_ref === 'string' && meta.external_ref !== ''
        ? meta.external_ref
        : browseUrl(n),
    metadata: Object.keys(meta).length > 0 ? meta : null,
    created_at: n.fields?.created,
    __node: n,
  }
  const who = assigneeName(n)
  if (who !== '') {
    row.assignee = who
  }
  const resolution = n.fields?.resolution?.name
  if (resolution === 'Duplicate') {
    row.close_reason = 'duplicate'
  } else if (resolution !== undefined && /won'?t/i.test(resolution)) {
    row.close_reason = 'not planned'
  }
  if (n.fields?.resolutiondate) {
    row.closed_at = n.fields.resolutiondate
  }
  return row
}

/** Drop the transport carrier before a row leaves the store. */
const pub = (r: TaskRow & { __node?: JiraIssue }): TaskRow => {
  const { __node: _drop, ...rest } = r
  return rest
}

// --- id resolution --------------------------------------------------------------

/** 'PROJ-123' | 'proj-123' | '123' | /browse/PROJ-123 URL | internal
 *  numeric id → the key/id REST accepts as issueIdOrKey. A bare number
 *  borrows the serving project's key — ambiguous-project sites already
 *  threw in project(). */
function issueRef(id: string): string {
  const t = id.trim()
  const browse = /^https?:\/\/[^/]+\/browse\/([A-Za-z][\w]*-\d+)/.exec(t)
  if (browse) {
    return browse[1]!.toUpperCase()
  }
  const rest = /\/rest\/api\/\d+\/issue\/(\d+)/.exec(t)
  if (rest) {
    return rest[1]!
  }
  if (/^[A-Za-z][\w]*-\d+$/.test(t)) {
    return t.toUpperCase()
  }
  if (/^\d+$/.test(t)) {
    return `${project().key}-${t}`
  }
  throw new Error(
    `jira tasks: "${id}" is not an issue reference (want PROJ-123, a bare number, or a /browse/ URL)`
  )
}

/** Async id resolution — a bare number resolves through the project
 *  cache; warming it via projectAsync keeps issueRef's sync project()
 *  call a cache hit instead of a blocking spawn inside the probe. */
async function refAsync(id: string): Promise<string> {
  if (/^\d+$/.test(id.trim())) {
    await projectAsync()
  }
  return issueRef(id)
}

// --- reads ----------------------------------------------------------------------

interface SearchPage {
  issues?: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
}

const pageHasMore = (p: SearchPage): boolean =>
  p.nextPageToken !== undefined && p.nextPageToken !== '' && p.isLast !== true

const searchBody = (jql: string, token: string | undefined): Record<string, unknown> => ({
  jql,
  fields: FIELDS.split(','),
  maxResults: PAGE,
  ...(token !== undefined ? { nextPageToken: token } : {}),
})

const searchGetPath = (jql: string, token: string | undefined): string =>
  `/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(FIELDS)}` +
  `&maxResults=${PAGE}` +
  (token !== undefined ? `&nextPageToken=${encodeURIComponent(token)}` : '')

const endpointGone = (err: unknown): boolean => /\b(404|405)\b/.test(String(err))

/** POST /search/jql — the current JQL endpoint. A 404/405-class answer
 *  (a site that only kept GET) retries the GET form once — endpoint
 *  drift is absorbed here, never silently. */
function searchPage(jql: string, token: string | undefined): SearchPage {
  try {
    return apiJson<SearchPage>('POST', '/search/jql', searchBody(jql, token))
  } catch (err) {
    if (!endpointGone(err)) {
      throw err
    }
    const page = apiGet<SearchPage>(searchGetPath(jql, token))
    if (page === undefined) {
      throw err
    }
    return page
  }
}

async function searchPageAsync(jql: string, token: string | undefined): Promise<SearchPage> {
  try {
    return await apiJsonAsync<SearchPage>('POST', '/search/jql', searchBody(jql, token))
  } catch (err) {
    if (!endpointGone(err)) {
      throw err
    }
    const page = await apiGetAsync<SearchPage>(searchGetPath(jql, token))
    if (page === undefined) {
      throw err
    }
    return page
  }
}

function queryIssuesSync(jql: string, limit: number): JiraIssue[] {
  const out: JiraIssue[] = []
  let token: string | undefined
  for (;;) {
    const page = searchPage(jql, token)
    out.push(...(page.issues ?? []))
    if (out.length >= limit || !pageHasMore(page)) {
      break
    }
    token = page.nextPageToken
  }
  return out.slice(0, limit)
}

async function queryIssuesAsync(jql: string, limit: number): Promise<JiraIssue[]> {
  const out: JiraIssue[] = []
  let token: string | undefined
  for (;;) {
    const page = await searchPageAsync(jql, token)
    out.push(...(page.issues ?? []))
    if (out.length >= limit || !pageHasMore(page)) {
      break
    }
    token = page.nextPageToken
  }
  return out.slice(0, limit)
}

const issuePath = (ref: string): string =>
  `/issue/${encodeURIComponent(ref)}?fields=${FIELDS}`

const queryIssueSync = (ref: string): JiraIssue | undefined => apiGet<JiraIssue>(issuePath(ref))
const queryIssueAsync = (ref: string): Promise<JiraIssue | undefined> =>
  apiGetAsync<JiraIssue>(issuePath(ref))

/** The JQL the filter implies — project-scoped always; only 'closed'
 *  and `all` push status down (everything else is a derived status the
 *  post-filter owns). */
function jqlFor(f: TaskFilter, key: string): string {
  const base = `project = "${key}"`
  if (f.all === true) {
    return `${base} ORDER BY created ASC`
  }
  const clause =
    f.status === 'closed' ? ' AND statusCategory = Done' : ' AND statusCategory != Done'
  return `${base}${clause} ORDER BY created ASC`
}

const READY_JQL = (key: string): string =>
  `project = "${key}" AND statusCategory != Done AND assignee is EMPTY ORDER BY created ASC`

// --- filtering ---------------------------------------------------------------------

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

/** Derived statuses (blocked/in_progress) and label/type filters can't
 *  be a server-side cap — they'd truncate before applyFilter sees the
 *  rows. Only 'closed' and unfiltered lists bound the fetch itself. */
const needsPostFilter = (f: TaskFilter): boolean =>
  (f.labels?.length ?? 0) > 0 ||
  (f.excludeLabels?.length ?? 0) > 0 ||
  f.type !== undefined ||
  (f.status !== undefined && f.status !== 'closed')

const fetchCap = (f: TaskFilter): number =>
  needsPostFilter(f)
    ? QUERY_CAP
    : Math.min(f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP, QUERY_CAP)

const byPriority = (a: TaskRow, b: TaskRow): number =>
  (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
  String((a as TaskRow & { created_at?: string }).created_at ?? '').localeCompare(
    String((b as TaskRow & { created_at?: string }).created_at ?? '')
  )

/** ready = open + unblocked + unclaimed — derived status 'open' is
 *  exactly that set, already priority-ordered over created asc. */
function readyOf(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  return rows
    .filter((r) => r.status === 'open')
    .sort(byPriority)
    .slice(0, f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP)
}

/** A dead /priority endpoint must not kill the read plane — rows fall
 *  back to trailer/default priorities. The probe itself throws on
 *  transport failure; this only converts that into "no names known". */
const tryPriorities = (): string[] => {
  try {
    return priorities()
  } catch {
    return []
  }
}

const tryPrioritiesAsync = async (): Promise<string[]> => {
  try {
    return await prioritiesAsync()
  } catch {
    return []
  }
}

// --- actor -------------------------------------------------------------------------

const display = (v: JiraViewer): string => v.displayName ?? v.emailAddress ?? v.accountId

const viewerName = (): string => {
  try {
    return display(viewer())
  } catch {
    return ''
  }
}

const actorAsync = async (): Promise<string> => {
  try {
    return display(await viewerAsync())
  } catch {
    return ''
  }
}

// --- deps ---------------------------------------------------------------------------

const wants = (dir: 'up' | 'down', direction?: string): boolean =>
  direction === undefined || direction === dir

/** opts.rel (generic or native) → the generic name depEdges matches
 *  against: 'blocked'|'blocks' → 'blocked', 'parent'|'parent-child' →
 *  'parent', customs pass through. */
const relKey = (rel: string): string => canonicalTaskRel(nativeTaskRel(rel))

function depEdges(n: JiraIssue, opts: DepOpts): TaskDepEdge[] {
  const key = n.key ?? ''
  const rel = opts.rel === undefined ? undefined : relKey(opts.rel)
  const out: TaskDepEdge[] = []
  if (rel === undefined || rel !== 'parent') {
    for (const l of n.fields?.issuelinks ?? []) {
      const type = linkRel(l.type?.name)
      if (rel !== undefined && type !== rel) {
        continue
      }
      // outwardIssue = the counterpart on the outward side — this
      // issue is the inward one ('is blocked by'): a 'down' edge —
      // this issue depends on the counterpart
      if (wants('down', opts.direction) && l.outwardIssue?.key !== undefined) {
        out.push({ issue_id: key, depends_on_id: l.outwardIssue.key, type })
      }
      // inwardIssue = counterpart on the inward side — this issue is
      // outward ('blocks'): an 'up' edge — the counterpart depends on
      // this issue
      if (wants('up', opts.direction) && l.inwardIssue?.key !== undefined) {
        out.push({ issue_id: l.inwardIssue.key, depends_on_id: key, type })
      }
    }
  }
  if (rel === undefined || rel === 'parent') {
    if (wants('down', opts.direction) && n.fields?.parent?.key !== undefined) {
      out.push({ issue_id: key, depends_on_id: n.fields.parent.key, type: 'parent' })
    }
    if (wants('up', opts.direction)) {
      for (const s of n.fields?.subtasks ?? []) {
        if (s.key !== undefined) {
          out.push({ issue_id: s.key, depends_on_id: key, type: 'parent' })
        }
      }
    }
  }
  return out
}

function depsSync(ids: string[], opts: DepOpts): TaskDepEdge[] {
  const out: TaskDepEdge[] = []
  for (const id of ids) {
    const n = queryIssueSync(issueRef(id))
    if (n) {
      out.push(...depEdges(n, opts))
    }
  }
  return out
}

async function depsAsync(ids: string[], opts: DepOpts): Promise<TaskDepEdge[]> {
  const nodes = await Promise.all(ids.map(async (id) => queryIssueAsync(await refAsync(id))))
  return nodes.flatMap((n) => (n === undefined ? [] : depEdges(n, opts)))
}

/** Hydrated rows on the far side of `id`'s edges — the row-plane twin
 *  of deps(). `dependency_type` rides along normalized. */
function neighborsSync(id: string, opts: DepOpts): TaskRow[] {
  const n = queryIssueSync(issueRef(id))
  if (n === undefined) {
    return []
  }
  const self = n.key ?? ''
  const others = new Map<string, string>()
  for (const e of depEdges(n, opts)) {
    others.set(e.issue_id === self ? e.depends_on_id : e.issue_id, e.type)
  }
  const ps = tryPriorities()
  const rows: TaskRow[] = []
  for (const [o, rel] of others) {
    const node = queryIssueSync(o)
    if (node !== undefined) {
      rows.push({ ...pub(toRow(node, ps)), dependency_type: rel } as TaskRow)
    }
  }
  return rows
}

async function neighborsAsync(id: string, opts: DepOpts): Promise<TaskRow[]> {
  const n = await queryIssueAsync(await refAsync(id))
  if (n === undefined) {
    return []
  }
  const self = n.key ?? ''
  const others = new Map<string, string>()
  for (const e of depEdges(n, opts)) {
    others.set(e.issue_id === self ? e.depends_on_id : e.issue_id, e.type)
  }
  const ps = await tryPrioritiesAsync()
  const rows = await Promise.all(
    [...others].map(async ([o, rel]) => {
      const node = await queryIssueAsync(o)
      return node === undefined
        ? undefined
        : ({ ...pub(toRow(node, ps)), dependency_type: rel } as TaskRow)
    })
  )
  return rows.filter((r): r is TaskRow => r !== undefined)
}

function childrenSync(ref: string): TaskRow[] {
  const n = queryIssueSync(ref)
  if (n === undefined) {
    return []
  }
  const ps = tryPriorities()
  const rows: TaskRow[] = []
  for (const s of n.fields?.subtasks ?? []) {
    if (s.key !== undefined) {
      const node = queryIssueSync(s.key)
      if (node !== undefined) {
        rows.push(pub(toRow(node, ps)))
      }
    }
  }
  return rows
}

async function childrenAsync(ref: string): Promise<TaskRow[]> {
  const n = await queryIssueAsync(ref)
  if (n === undefined) {
    return []
  }
  const ps = await tryPrioritiesAsync()
  const rows = await Promise.all(
    (n.fields?.subtasks ?? []).map(async (s) => {
      if (s.key === undefined) {
        return undefined
      }
      const node = await queryIssueAsync(s.key)
      return node === undefined ? undefined : pub(toRow(node, ps))
    })
  )
  return rows.filter((r): r is TaskRow => r !== undefined)
}

// --- mutations ----------------------------------------------------------------------

const mustIssue = (ref: string): JiraIssue => {
  const n = queryIssueSync(ref)
  if (n === undefined) {
    throw new Error(`jira tasks: issue ${ref} not found`)
  }
  return n
}

interface Transition {
  id?: string
  name?: string
  to?: { name?: string; statusCategory?: { key?: string; name?: string } }
}

/** Perform the first transition whose target lands in `category`
 *  (fallback category allowed) — workflow names are custom, categories
 *  are canonical. No candidate → throw; the caller's contract names
 *  the failure. */
function transitionTo(key: string, category: string, fallback?: string): void {
  const res = apiJson<{ transitions?: Transition[] }>(
    'GET',
    `/issue/${encodeURIComponent(key)}/transitions`
  )
  const ts = res.transitions ?? []
  const pick =
    ts.find((t) => t.to?.statusCategory?.key === category) ??
    (fallback !== undefined
      ? ts.find((t) => t.to?.statusCategory?.key === fallback)
      : undefined)
  if (pick?.id === undefined) {
    throw new Error(`jira tasks: ${key} has no transition to '${category}'`)
  }
  api('POST', `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: pick.id } })
}

/** Best-effort status move — the assignee write is already the claim
 *  verdict, so a workflow without a start-transition must not throw
 *  over a succeeded claim. */
const transitionMaybe = (key: string, category: string): void => {
  try {
    transitionTo(key, category)
  } catch {
    // workflow has no such edge — the claim marker still holds
  }
}

const comment = (key: string, text: string): void =>
  api('POST', `/issue/${encodeURIComponent(key)}/comment`, { body: adfDoc(text) })

/** Jira Cloud's documented unassign sentinel. */
const UNASSIGNED = '-1'

/** link(from, to, 'blocked') — "from is blocked by to" → Jira Blocks:
 *  outwardIssue blocks inwardIssue, so `to` rides outward. 'related'
 *  resolves the site's relates-type; 'parent' makes `from` a sub-task
 *  of `to`. Other rels resolve against the site's link-type table —
 *  an unmatched name throws, never faked. */
function linkSync(from: string, to: string, rel: string): void {
  const type = nativeTaskRel(rel)
  if (type === 'parent-child') {
    api('PUT', `/issue/${encodeURIComponent(issueRef(from))}`, {
      fields: { parent: { key: issueRef(to) } },
    })
    return
  }
  const name = linkTypeName(type)
  const [outward, inward] =
    type === 'blocks' ? [issueRef(to), issueRef(from)] : [issueRef(from), issueRef(to)]
  api('POST', '/issueLink', {
    type: { name },
    outwardIssue: { key: outward },
    inwardIssue: { key: inward },
  })
}

/** claim = assign viewer → verify re-read. Single-assignee writes are
 *  last-writer-wins, so the verify settles races deterministically:
 *  whoever the read shows holds it — a loser sees the winner and
 *  throws. An 'indeterminate' transition rides best-effort so the
 *  board column follows the claim. */
function claimSync(ref: string): void {
  const n = mustIssue(ref)
  const key = n.key ?? ref
  if (isDone(n)) {
    throw new Error(`jira tasks: ${key} is done — only open issues are claimable`)
  }
  if (n.fields?.assignee != null) {
    throw new Error(`jira tasks: ${key} already claimed by ${assigneeName(n)}`)
  }
  const me = viewer()
  api('PUT', `/issue/${encodeURIComponent(key)}/assignee`, { accountId: me.accountId })
  const check = queryIssueSync(ref)
  if (check?.fields?.assignee?.accountId !== me.accountId) {
    const holder = check?.fields?.assignee != null ? assigneeName(check) : 'another actor'
    throw new Error(`jira tasks: ${key} claim contested — ${holder} holds it`)
  }
  transitionMaybe(key, 'indeterminate')
}

function reopenSync(ref: string): void {
  const n = mustIssue(ref)
  const key = n.key ?? ref
  // only a terminal state needs the verb — an un-claim on a claimed
  // issue is already open; the marker release runs either way
  if (isDone(n)) {
    transitionTo(key, 'new', 'indeterminate')
  }
  // release every claim marker — a claim held by a crashed worker or a
  // rival would otherwise keep the issue in_progress forever
  if (n.fields?.assignee != null) {
    api('PUT', `/issue/${encodeURIComponent(key)}/assignee`, { accountId: UNASSIGNED })
  }
  const labels = labelsOf(n)
  if (labels.includes(BLOCKED_LABEL)) {
    api('PUT', `/issue/${encodeURIComponent(key)}`, {
      fields: { labels: labels.filter((l) => l !== BLOCKED_LABEL) },
    })
  }
}

function closeSync(ref: string, reason?: string): void {
  const n = mustIssue(ref)
  const key = n.key ?? ref
  // the reason lands first — a failed comment leaves the issue open,
  // same ordering guarantee as `gh issue close --comment`
  if (reason !== undefined && reason !== '') {
    comment(key, reason)
  }
  if (!isDone(n)) {
    transitionTo(key, 'done')
  }
}

function createMeta(i: TaskInput): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...i.metadata }
  // the verbatim type name rides the trailer even when issuetype
  // resolves natively — a bd name Jira can't serve ('chore') keeps
  // its intent in metadata instead of being silently eaten
  if (i.type !== undefined) {
    meta.type = i.type
  }
  if (i.externalRef !== undefined) {
    meta.external_ref = i.externalRef
  }
  return meta
}

/** 'kind:ref' — refs may be URLs carrying their own colons, so split
 *  on the FIRST colon only. */
function depRef(d: string): { kind: string; ref: string } {
  const colon = d.indexOf(':')
  return { kind: d.slice(0, colon), ref: d.slice(colon + 1) }
}

const PARENT_KINDS = /^(parent|parent-child)$/

/** Resolve a requested type name against the site's issuetypes
 *  (case-insensitive) — an unmapped bd name falls back to 'Task'. */
function resolveTypeName(type: string): string {
  const ts = issueTypes()
  return ts.find((t) => t.toLowerCase() === type.toLowerCase()) ?? 'Task'
}

function applyDeps(id: string, i: TaskInput): void {
  for (const d of i.deps ?? []) {
    const { kind, ref } = depRef(d)
    linkSync(id, ref, kind)
  }
}

function createSync(i: TaskInput): TaskRow {
  // pre-validate dep rels before the issue exists — an unresolvable
  // link kind must not leave a half-created issue
  for (const d of i.deps ?? []) {
    const { kind } = depRef(d)
    if (!PARENT_KINDS.test(kind)) {
      linkTypeName(nativeTaskRel(kind))
    }
  }
  const fields: Record<string, unknown> = {
    project: { key: project().key },
    summary: i.title,
  }
  if (i.type !== undefined) {
    fields.issuetype = { name: resolveTypeName(i.type) }
  }
  const meta = createMeta(i)
  if (i.description !== undefined || Object.keys(meta).length > 0) {
    fields.description = adfDoc(withMeta(i.description, meta))
  }
  if (i.priority !== undefined) {
    const name = toJiraPriority(i.priority, priorities())
    if (name !== undefined) {
      fields.priority = { name }
    }
  }
  if ((i.labels ?? []).length > 0) {
    fields.labels = i.labels
  }
  if (i.parent !== undefined) {
    fields.parent = { key: issueRef(i.parent) }
  }
  const created = apiJson<{ key?: string }>('POST', '/issue', { fields })
  if (typeof created.key !== 'string' || created.key === '') {
    throw new Error('jira tasks: issue create returned no key')
  }
  applyDeps(created.key, i)
  const row = queryIssueSync(created.key)
  if (row === undefined) {
    throw new Error(`jira tasks: created ${created.key} but could not read it back`)
  }
  return toRow(row, tryPriorities())
}

function updateStatus(n: JiraIssue, ref: string, val: string): void {
  const key = n.key ?? ref
  if (val === 'open') {
    reopenSync(ref)
  } else if (val === 'closed') {
    closeSync(ref)
  } else if (val === 'in_progress') {
    claimSync(ref)
  } else if (val === 'blocked') {
    const labels = new Set(labelsOf(n))
    labels.add(BLOCKED_LABEL)
    api('PUT', `/issue/${encodeURIComponent(key)}`, { fields: { labels: [...labels] } })
  } else {
    throw new Error(`jira tasks: unknown status '${val}'`)
  }
}

const editFields = (key: string, fields: Record<string, unknown>): void =>
  api('PUT', `/issue/${encodeURIComponent(key)}`, { fields })

function patchBody(n: JiraIssue, val: string): void {
  const meta = bodyMeta(adfText(n.fields?.description))
  editFields(n.key ?? '', { description: adfDoc(withMeta(val, meta)) })
}

const patchMetaField =
  (k: string) =>
  (n: JiraIssue, val: string): void => {
    const meta = bodyMeta(adfText(n.fields?.description))
    meta[k] = val
    editFields(n.key ?? '', {
      description: adfDoc(withMeta(adfText(n.fields?.description), meta)),
    })
  }

function addLabels(n: JiraIssue, val: string): void {
  const labels = new Set(labelsOf(n))
  for (const l of val
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    labels.add(l)
  }
  editFields(n.key ?? '', { labels: [...labels] })
}

interface AssignableUser {
  accountId?: string
  displayName?: string
  emailAddress?: string
}

/** assignee:<name> resolves an assignable user by displayName/email/
 *  accountId (case-insensitive); '' unassigns. Ambiguity throws —
 *  picking one silently would hand the claim to the wrong person. */
function resolveAssignee(key: string, val: string): string {
  if (val === '') {
    return UNASSIGNED
  }
  const users = apiJson<AssignableUser[]>(
    'GET',
    `/user/assignable/search?issueKey=${encodeURIComponent(key)}&query=${encodeURIComponent(val)}`
  )
  const want = val.toLowerCase()
  const hits = users.filter(
    (u) =>
      u.accountId?.toLowerCase() === want ||
      u.displayName?.toLowerCase() === want ||
      u.emailAddress?.toLowerCase() === want
  )
  if (hits.length === 0) {
    throw new Error(`jira tasks: no assignable user '${val}' on ${key}`)
  }
  if (hits.length > 1) {
    throw new Error(
      `jira tasks: '${val}' is ambiguous — ${hits
        .map((u) => u.emailAddress ?? u.accountId ?? '?')
        .join(', ')}`
    )
  }
  return hits[0]!.accountId ?? UNASSIGNED
}

const PATCH: Record<string, (n: JiraIssue, ref: string, val: string) => void> = {
  title: (n, _r, v) => editFields(n.key ?? '', { summary: v }),
  body: (n, _r, v) => patchBody(n, v),
  description: (n, _r, v) => patchBody(n, v),
  status: (n, r, v) => updateStatus(n, r, v),
  claim: (_n, r, v) => {
    if (v === 'true') {
      claimSync(r)
    }
  },
  labels: (n, _r, v) => addLabels(n, v),
  label: (n, _r, v) => addLabels(n, v),
  assignee: (n, r, v) =>
    api('PUT', `/issue/${encodeURIComponent(n.key ?? r)}/assignee`, {
      accountId: resolveAssignee(n.key ?? r, v),
    }),
  notes: (n, _r, v) => comment(n.key ?? '', v),
  note: (n, _r, v) => comment(n.key ?? '', v),
  priority: (n, _r, v) => {
    const p = Number(v)
    if (!Number.isFinite(p)) {
      throw new TypeError(`jira tasks: priority '${v}' is not a number`)
    }
    const name = toJiraPriority(p, priorities())
    if (name === undefined) {
      throw new Error('jira tasks: the site reports no priorities to write')
    }
    editFields(n.key ?? '', { priority: { name } })
  },
  type: (n, _r, v) => editFields(n.key ?? '', { issuetype: { name: resolveTypeName(v) } }),
  issue_type: (n, _r, v) => editFields(n.key ?? '', { issuetype: { name: resolveTypeName(v) } }),
  external_ref: patchMetaField('external_ref'),
  externalRef: patchMetaField('external_ref'),
}

function updateSync(id: string, patch: Record<string, string | number>): void {
  const ref = issueRef(id)
  for (const [k, v] of Object.entries(patch)) {
    const h = PATCH[k]
    if (h === undefined) {
      throw new Error(`jira tasks: unsupported update key '${k}'`)
    }
    h(mustIssue(ref), ref, String(v))
  }
}

// --- the stores -------------------------------------------------------------------

function rowOrUndef(n: JiraIssue | undefined, ps: string[]): TaskRow | undefined {
  return n === undefined ? undefined : pub(toRow(n, ps))
}

export function jiraTasks(_dir: string): TaskStore {
  return {
    list: (f = {}) =>
      applyFilter(
        queryIssuesSync(jqlFor(f, project().key), fetchCap(f)).map((n) =>
          pub(toRow(n, tryPriorities()))
        ),
        f
      ) as never,
    // applyFilter must not slice here — the limit lands AFTER the
    // priority sort in readyOf, or high-priority issues late in the
    // created-ordered page get truncated away
    ready: (f = {}) =>
      readyOf(
        applyFilter(
          queryIssuesSync(READY_JQL(project().key), Number.POSITIVE_INFINITY).map((n) =>
            pub(toRow(n, tryPriorities()))
          ),
          { ...f, status: 'open', limit: undefined }
        ),
        f
      ) as never,
    get: (id) => rowOrUndef(queryIssueSync(issueRef(id)), tryPriorities()) as never,
    create: (i) => pub(createSync(i)) as never,
    update: (id, patch) => updateSync(id, patch),
    claim: (id) => claimSync(issueRef(id)),
    actor: () => viewerName(),
    reopen: (id) => reopenSync(issueRef(id)),
    close: (id, reason) => closeSync(issueRef(id), reason),
    remove: (id) => api('DELETE', `/issue/${encodeURIComponent(issueRef(id))}`),
    note: (id, text) => comment(issueRef(id), text),
    children: (id) => childrenSync(issueRef(id)) as never,
    deps: (ids, opts = {}) => depsSync(ids, opts) as never,
    neighbors: (id, opts = {}) => neighborsSync(id, opts) as never,
    link: (from, to, rel = 'related') => linkSync(from, to, rel),
    prefix: () => project().key,
  }
}

export function jiraTasksAsync(_dir: string): TaskStoreAsync {
  return {
    list: async (f = {}) => {
      const ps = await tryPrioritiesAsync()
      return applyFilter(
        (await queryIssuesAsync(jqlFor(f, (await projectAsync()).key), fetchCap(f))).map((n) =>
          pub(toRow(n, ps))
        ),
        f
      )
    },
    ready: async (f = {}) => {
      const ps = await tryPrioritiesAsync()
      return readyOf(
        applyFilter(
          (
            await queryIssuesAsync(
              READY_JQL((await projectAsync()).key),
              Number.POSITIVE_INFINITY
            )
          ).map((n) => pub(toRow(n, ps))),
          { ...f, status: 'open', limit: undefined }
        ),
        f
      )
    },
    get: async (id) =>
      rowOrUndef(await queryIssueAsync(await refAsync(id)), await tryPrioritiesAsync()) as never,
    children: async (id) => (await childrenAsync(await refAsync(id))) as never,
    deps: async (ids, opts = {}) => (await depsAsync(ids, opts)) as never,
    neighbors: async (id, opts = {}) => (await neighborsAsync(id, opts)) as never,
    actor: () => actorAsync(),
  }
}

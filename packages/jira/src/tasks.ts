/**
 * The jira connectors' `tasks` facade — the TaskStore contract over
 * Jira REST, reached through `atlassian api` (cloud: spec
 * specs/bro-huy5o.3.md; Data Center/Server: specs/bro-b8eom.md). The
 * mapping is deployment-blind — `buildTasks` binds a `JiraApi`
 * surface (v3 Cloud or v2 DC) and every transport-bound verb closes
 * over it. Same mapping contract as github-issues (bro-huy5o.1) and
 * linear (bro-huy5o.2):
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
  adfText,
  cloudApi,
  dcApi,
  FIELDS,
  type JiraApi,
  type JiraIssue,
  type JiraIssueRef,
  type JiraViewer,
} from './api.ts'

export { adfDoc, adfText } from './api.ts'

const BLOCKED_LABEL = 'blocked'
const DEFAULT_PRIORITY = 2
const QUERY_CAP = 1000

// --- row mapping — deployment-blind ------------------------------------------------

const category = (n: JiraIssue): string => n.fields?.status?.statusCategory?.key ?? ''
const isDone = (n: JiraIssue): boolean => category(n) === 'done'
const refLive = (r: JiraIssueRef | null | undefined): boolean =>
  r != null && r.fields?.status?.statusCategory?.key !== 'done'
const labelsOf = (n: JiraIssue): string[] => n.fields?.labels ?? []
const assigneeName = (n: JiraIssue): string => {
  const a = n.fields?.assignee
  return a?.displayName || a?.emailAddress || a?.name || a?.key || a?.accountId || ''
}

/** Jira link-type name → generic rel: 'Blocks'→'blocked',
 *  'Relates'→'related', site customs pass through lowercased —
 *  canonicalTaskRel keeps 'blocks'/'blocked-by' inputs honest. */
function linkRel(name: string | undefined): string {
  const n = name ?? ''
  let generic = n.toLowerCase()
  if (/block/i.test(n)) {
    generic = 'blocked'
  } else if (/relat/i.test(n)) {
    generic = 'related'
  }
  return canonicalTaskRel(generic)
}

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

// --- row ------------------------------------------------------------------------

/** url base → hostname or '' — a base that won't parse lands on the
 *  browse path, same as a site. */
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}

/** `self` (https://site/…/issue/<id>) → the human browse URL; gateway
 *  selfs keep no site name, so they pass through verbatim. */
function browseUrl(n: JiraIssue): string | undefined {
  const key = n.key
  if (key === undefined) {
    return undefined
  }
  const self = n.self ?? ''
  const m = /^(https?:\/\/[^/]+)\//.exec(self)
  if (m === null || hostOf(m[1]!) === 'api.atlassian.com') {
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

// --- the JQL the filter implies ------------------------------------------------------

/** The JQL the filter implies — project-scoped always; only 'closed'
 *  and `all` push status down (everything else is a derived status the
 *  post-filter owns). Identical JQL on both surfaces. */
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

const fetchCap = (f: TaskFilter): number => {
  const limit = f.limit !== undefined && f.limit > 0 ? f.limit : QUERY_CAP
  return needsPostFilter(f) ? QUERY_CAP : Math.min(limit, QUERY_CAP)
}

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

// --- deps — edge mapping is deployment-blind -----------------------------------------

const wants = (dir: 'up' | 'down', direction?: string): boolean =>
  direction === undefined || direction === dir

/** opts.rel (generic or native) → the generic name depEdges matches
 *  against: 'blocked'|'blocks' → 'blocked', 'parent'|'parent-child' →
 *  'parent', customs pass through. */
const relKey = (rel: string): string => canonicalTaskRel(nativeTaskRel(rel))

/** issuelinks → edges. outwardIssue = the counterpart on the outward
 *  side — this issue is the inward one ('is blocked by'): a 'down'
 *  edge — this issue depends on the counterpart. inwardIssue = the
 *  counterpart on the inward side — this issue is outward ('blocks'):
 *  an 'up' edge — the counterpart depends on this issue. */
function linkEdges(
  n: JiraIssue,
  rel: string | undefined,
  direction: string | undefined
): TaskDepEdge[] {
  const key = n.key ?? ''
  const out: TaskDepEdge[] = []
  for (const l of n.fields?.issuelinks ?? []) {
    const type = linkRel(l.type?.name)
    if (rel !== undefined && type !== rel) {
      continue
    }
    if (wants('down', direction) && l.outwardIssue?.key !== undefined) {
      out.push({ issue_id: key, depends_on_id: l.outwardIssue.key, type })
    }
    if (wants('up', direction) && l.inwardIssue?.key !== undefined) {
      out.push({ issue_id: l.inwardIssue.key, depends_on_id: key, type })
    }
  }
  return out
}

/** parent + subtasks → 'parent' edges in both directions. */
function parentEdges(n: JiraIssue, direction: string | undefined): TaskDepEdge[] {
  const key = n.key ?? ''
  const out: TaskDepEdge[] = []
  if (wants('down', direction) && n.fields?.parent?.key !== undefined) {
    out.push({ issue_id: key, depends_on_id: n.fields.parent.key, type: 'parent' })
  }
  if (wants('up', direction)) {
    for (const s of n.fields?.subtasks ?? []) {
      if (s.key !== undefined) {
        out.push({ issue_id: s.key, depends_on_id: key, type: 'parent' })
      }
    }
  }
  return out
}

function depEdges(n: JiraIssue, opts: DepOpts): TaskDepEdge[] {
  const rel = opts.rel === undefined ? undefined : relKey(opts.rel)
  const out: TaskDepEdge[] = []
  if (rel !== 'parent') {
    out.push(...linkEdges(n, rel, opts.direction))
  }
  if (rel === undefined || rel === 'parent') {
    out.push(...parentEdges(n, opts.direction))
  }
  return out
}

// --- create-time helpers — deployment-blind -------------------------------------------

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

function rowOrUndef(n: JiraIssue | undefined, ps: string[]): TaskRow | undefined {
  return n === undefined ? undefined : pub(toRow(n, ps))
}

// --- the bound store --------------------------------------------------------------

/** Bind a deployment surface — the returned tasks/tasksAsync are the
 *  same TaskStore contract the `jira` and `jira-dc` connectors serve;
 *  every REST verb below closes over S, so Cloud (v3) and Data Center
 *  (v2) share the whole mapping layer. */
export function buildTasks(S: JiraApi): {
  tasks: (dir: string) => TaskStore
  tasksAsync: (dir: string) => TaskStoreAsync
} {
  const {
    api,
    apiGet,
    apiJson,
    apiGetAsync,
    issueTypes,
    linkTypeName,
    priorities,
    prioritiesOrEmpty,
    prioritiesOrEmptyAsync,
    project,
    projectAsync,
    viewer,
    viewerAsync,
  } = S
  const T = S.tag

  /** A dead /priority endpoint must not kill the read plane — rows
   *  fall back to trailer/default priorities. The OrEmpty twins cache
   *  the failure per site, so a dead endpoint costs one spawn, not
   *  one per row; the probe itself keeps throwing for write paths. */
  const tryPriorities = (): string[] => prioritiesOrEmpty()

  const tryPrioritiesAsync = async (): Promise<string[]> => prioritiesOrEmptyAsync()

  // --- actor -------------------------------------------------------------------------

  const display = (v: JiraViewer): string =>
    v.displayName ?? v.emailAddress ?? v.name ?? v.accountId ?? ''

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

  // --- id resolution --------------------------------------------------------------

  /** 'PROJ-123' | 'proj-123' | '123' | /browse/PROJ-123 URL | internal
   *  numeric id → the key/id REST accepts as issueIdOrKey. A bare
   *  number borrows the serving project's key — ambiguous-project
   *  sites already threw in project(). */
  function issueRef(id: string): string {
    const t = id.trim()
    const browse = /^https?:\/\/[^/]+\/browse\/([A-Za-z]\w*-\d+)/.exec(t)
    if (browse) {
      return browse[1]!.toUpperCase()
    }
    const rest = /\/rest\/api\/\d+\/issue\/(\d+)/.exec(t)
    if (rest) {
      return rest[1]!
    }
    if (/^[A-Za-z]\w*-\d+$/.test(t)) {
      return t.toUpperCase()
    }
    if (/^\d+$/.test(t)) {
      return `${project().key}-${t}`
    }
    throw new Error(
      `${T} tasks: "${id}" is not an issue reference (want PROJ-123, a bare number, or a /browse/ URL)`
    )
  }

  /** Async id resolution — a bare number resolves through the project
   *  cache; warming it via projectAsync keeps issueRef's sync
   *  project() call a cache hit instead of a blocking spawn inside
   *  the probe. */
  async function refAsync(id: string): Promise<string> {
    if (/^\d+$/.test(id.trim())) {
      await projectAsync()
    }
    return issueRef(id)
  }

  // --- reads ----------------------------------------------------------------------

  function queryIssuesSync(jql: string, limit: number): JiraIssue[] {
    const out: JiraIssue[] = []
    let cursor: string | undefined
    for (;;) {
      const page = S.searchPage(jql, cursor)
      out.push(...(page.issues ?? []))
      if (out.length >= limit || page.next === undefined) {
        break
      }
      cursor = page.next
    }
    return out.slice(0, limit)
  }

  async function queryIssuesAsync(jql: string, limit: number): Promise<JiraIssue[]> {
    const out: JiraIssue[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await S.searchPageAsync(jql, cursor)
      out.push(...(page.issues ?? []))
      if (out.length >= limit || page.next === undefined) {
        break
      }
      cursor = page.next
    }
    return out.slice(0, limit)
  }

  const issuePath = (ref: string): string =>
    `/issue/${encodeURIComponent(ref)}?fields=${FIELDS}`

  const queryIssueSync = (ref: string): JiraIssue | undefined =>
    apiGet<JiraIssue>(issuePath(ref))
  const queryIssueAsync = (ref: string): Promise<JiraIssue | undefined> =>
    apiGetAsync<JiraIssue>(issuePath(ref))

  // --- deps fetch ------------------------------------------------------------------

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
    const nodes = await Promise.all(
      ids.map(async (id) => queryIssueAsync(await refAsync(id)))
    )
    return nodes.flatMap((n) => (n === undefined ? [] : depEdges(n, opts)))
  }

  /** Hydrated rows on the far side of `id`'s edges — the row-plane
   *  twin of deps(). `dependency_type` rides along normalized. */
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
      throw new Error(`${T} tasks: issue ${ref} not found`)
    }
    return n
  }

  interface Transition {
    id?: string
    name?: string
    to?: { name?: string; statusCategory?: { key?: string; name?: string } }
  }

  /** Perform the first transition whose target lands in `category`
   *  (fallback category allowed) — workflow names are custom,
   *  categories are canonical. No candidate → throw; the caller's
   *  contract names the failure. */
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
      throw new Error(`${T} tasks: ${key} has no transition to '${category}'`)
    }
    api('POST', `/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: pick.id },
    })
  }

  /** Best-effort status move — the assignee write is already the
   *  claim verdict, so a workflow without a start-transition must
   *  not throw over a succeeded claim. */
  const transitionMaybe = (key: string, category: string): void => {
    try {
      transitionTo(key, category)
    } catch {
      // workflow has no such edge — the claim marker still holds
    }
  }

  const comment = (key: string, text: string): void =>
    api('POST', `/issue/${encodeURIComponent(key)}/comment`, { body: S.doc(text) })

  /** Jira's documented unassign sentinel — `accountId: '-1'` on
   *  Cloud, `name: '-1'` on Data Center; assigneeBody carries the
   *  surface's key name. */
  const UNASSIGNED = '-1'

  /** link(from, to, 'blocked') — "from is blocked by to" → Jira
   *  Blocks: outwardIssue blocks inwardIssue, so `to` rides outward.
   *  'related' resolves the site's relates-type; 'parent' makes `from`
   *  a sub-task of `to`. Other rels resolve against the site's
   *  link-type table — an unmatched name throws, never faked. */
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

  /** claim = assign viewer → verify re-read. The assignee write has
   *  no compare-and-set — last writer wins — so the verify is the
   *  strongest settlement the API allows: a loser whose re-read lands
   *  after the winner's write sees the winner and throws. A loser's
   *  re-read can still land BEFORE the winner's write — that residual
   *  window is inherent to the API, no client-side ordering closes
   *  it. An 'indeterminate' transition rides best-effort so the board
   *  column follows the claim. */
  function claimSync(ref: string): void {
    const n = mustIssue(ref)
    const key = n.key ?? ref
    if (isDone(n)) {
      throw new Error(`${T} tasks: ${key} is done — only open issues are claimable`)
    }
    if (n.fields?.assignee != null) {
      throw new Error(`${T} tasks: ${key} already claimed by ${assigneeName(n)}`)
    }
    const me = viewer()
    // viewer() already threw when the surface identity was absent —
    // a missing key never reaches the write as an empty name
    const mine = S.userKey(me)!
    api('PUT', `/issue/${encodeURIComponent(key)}/assignee`, S.assigneeBody(mine))
    const check = queryIssueSync(ref)
    if (S.userKey(check?.fields?.assignee) !== mine) {
      const holder = check?.fields?.assignee != null ? assigneeName(check) : 'another actor'
      throw new Error(`${T} tasks: ${key} claim contested — ${holder} holds it`)
    }
    transitionMaybe(key, 'indeterminate')
  }

  function reopenSync(ref: string): void {
    const n = mustIssue(ref)
    const key = n.key ?? ref
    // a terminal state needs the verb; 'indeterminate' needs it too —
    // unassigning alone leaves statusCategory untouched, so the row
    // keeps reading in_progress. Best-effort below 'new': custom
    // workflows may lack a backward edge — the unassign is the real
    // un-claim and runs either way
    if (isDone(n)) {
      transitionTo(key, 'new', 'indeterminate')
    } else if (category(n) === 'indeterminate') {
      transitionMaybe(key, 'new')
    }
    // release every claim marker — a claim held by a crashed worker or
    // a rival would otherwise keep the issue in_progress forever
    if (n.fields?.assignee != null) {
      api('PUT', `/issue/${encodeURIComponent(key)}/assignee`, S.assigneeBody(UNASSIGNED))
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
      // issuetype is REQUIRED on create — an absent type resolves to
      // the site's 'Task', never an omitted field
      issuetype: { name: resolveTypeName(i.type ?? 'task') },
    }
    const meta = createMeta(i)
    if (i.description !== undefined || Object.keys(meta).length > 0) {
      fields.description = S.doc(withMeta(i.description, meta))
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
      throw new Error(`${T} tasks: issue create returned no key`)
    }
    applyDeps(created.key, i)
    const row = queryIssueSync(created.key)
    if (row === undefined) {
      throw new Error(`${T} tasks: created ${created.key} but could not read it back`)
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
      throw new Error(`${T} tasks: unknown status '${val}'`)
    }
  }

  const editFields = (key: string, fields: Record<string, unknown>): void =>
    api('PUT', `/issue/${encodeURIComponent(key)}`, { fields })

  function patchBody(n: JiraIssue, val: string): void {
    const meta = bodyMeta(adfText(n.fields?.description))
    editFields(n.key ?? '', { description: S.doc(withMeta(val, meta)) })
  }

  const patchMetaField =
    (k: string) =>
    (n: JiraIssue, val: string): void => {
      const meta = bodyMeta(adfText(n.fields?.description))
      meta[k] = val
      editFields(n.key ?? '', {
        description: S.doc(withMeta(adfText(n.fields?.description), meta)),
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

  /** assignee:<name> resolves an assignable user by the surface's
   *  identity fields (displayName/email + accountId on Cloud, name/key
   *  on DC; case-insensitive); '' unassigns. Ambiguity throws —
   *  picking one silently would hand the claim to the wrong person. */
  function resolveAssignee(key: string, val: string): string {
    if (val === '') {
      return UNASSIGNED
    }
    const users = apiJson<JiraViewer[]>(
      'GET',
      `/user/assignable/search?issueKey=${encodeURIComponent(key)}` +
        `&${S.userQueryParam}=${encodeURIComponent(val)}`
    )
    const want = val.toLowerCase()
    const hits = users.filter(
      (u) =>
        u.accountId?.toLowerCase() === want ||
        u.name?.toLowerCase() === want ||
        u.key?.toLowerCase() === want ||
        u.displayName?.toLowerCase() === want ||
        u.emailAddress?.toLowerCase() === want
    )
    if (hits.length === 0) {
      throw new Error(`${T} tasks: no assignable user '${val}' on ${key}`)
    }
    if (hits.length > 1) {
      throw new Error(
        `${T} tasks: '${val}' is ambiguous — ${hits
          .map((u) => u.emailAddress ?? u.name ?? u.accountId ?? '?')
          .join(', ')}`
      )
    }
    return S.userKey(hits[0]) ?? UNASSIGNED
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
      api(
        'PUT',
        `/issue/${encodeURIComponent(n.key ?? r)}/assignee`,
        S.assigneeBody(resolveAssignee(n.key ?? r, v))
      ),
    notes: (n, _r, v) => comment(n.key ?? '', v),
    note: (n, _r, v) => comment(n.key ?? '', v),
    priority: (n, _r, v) => {
      const p = Number(v)
      if (!Number.isFinite(p)) {
        throw new TypeError(`${T} tasks: priority '${v}' is not a number`)
      }
      const name = toJiraPriority(p, priorities())
      if (name === undefined) {
        throw new Error(`${T} tasks: the site reports no priorities to write`)
      }
      editFields(n.key ?? '', { priority: { name } })
    },
    type: (n, _r, v) => editFields(n.key ?? '', { issuetype: { name: resolveTypeName(v) } }),
    issue_type: (n, _r, v) =>
      editFields(n.key ?? '', { issuetype: { name: resolveTypeName(v) } }),
    external_ref: patchMetaField('external_ref'),
    externalRef: patchMetaField('external_ref'),
  }

  function updateSync(id: string, patch: Record<string, string | number>): void {
    const ref = issueRef(id)
    for (const [k, v] of Object.entries(patch)) {
      const h = PATCH[k]
      if (h === undefined) {
        throw new Error(`${T} tasks: unsupported update key '${k}'`)
      }
      h(mustIssue(ref), ref, String(v))
    }
  }

  // --- the stores -------------------------------------------------------------------

  function jiraTasks(_dir: string): TaskStore {
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

  function jiraTasksAsync(_dir: string): TaskStoreAsync {
    return {
      list: async (f = {}) => {
        const ps = await tryPrioritiesAsync()
        return applyFilter(
          (await queryIssuesAsync(jqlFor(f, (await projectAsync()).key), fetchCap(f))).map(
            (n) => pub(toRow(n, ps))
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
        rowOrUndef(
          await queryIssueAsync(await refAsync(id)),
          await tryPrioritiesAsync()
        ) as never,
      children: async (id) => (await childrenAsync(await refAsync(id))) as never,
      deps: async (ids, opts = {}) => (await depsAsync(ids, opts)) as never,
      neighbors: async (id, opts = {}) => (await neighborsAsync(id, opts)) as never,
      actor: () => actorAsync(),
    }
  }

  return { tasks: jiraTasks, tasksAsync: jiraTasksAsync }
}

// --- the two bound surfaces ----------------------------------------------------------

const cloud = buildTasks(cloudApi())
const dc = buildTasks(dcApi())

/** `jira` — the Jira Cloud v3 tasks store. */
export const jiraTasks = cloud.tasks
export const jiraTasksAsync = cloud.tasksAsync

/** `jira-dc` — the Jira Data Center/Server v2 tasks store. */
export const jiraDcTasks = dc.tasks
export const jiraDcTasksAsync = dc.tasksAsync

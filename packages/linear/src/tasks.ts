/**
 * The linear connector's `tasks` facade — the TaskStore contract over
 * Linear issues (spec specs/bro-huy5o.2.md). Transport: `curl` POSTs to
 * the fixed GraphQL endpoint for the sync store, `fetch` for the async
 * read surface — auth is `Authorization: $LINEAR_API_KEY` verbatim.
 *
 * Mapping (same settlement as github-issues, bro-huy5o.1):
 *   id        — the issue identifier ('ENG-123'); bare numbers resolve
 *               inside the LINEAR_TEAM/auto-detected team, URLs and
 *               UUIDs pass through
 *   status    — closed (completed/canceled/archived) | in_progress
 *               (started or assigned) | blocked (triage, open blocker,
 *               open sub-issue, 'blocked' label) | open
 *   claim     — assignee IS the claim: read → assign viewer → verify.
 *               Single-assignee writes settle races deterministically —
 *               the verify read shows the sole holder
 *   type/prio — labels type:/kind:/epic then the `<!-- bro: {...} -->`
 *               description trailer for type; the NATIVE priority field
 *               name-mapped onto bd's 0-4 scale (urgent→0 … none→4)
 *   parent    — Linear sub-issues stay OUT of row.parent (contract:
 *               row.parent means orchestrated step — a plain sub-issue
 *               is claimable work; its parent is un-ready while open)
 *
 * Relations are directional: `issue` blocks `relatedIssue`. An issue's
 * blockers live in `inverseRelations(type=blocks)` (counterpart field
 * `issue`), what it blocks lives in `relations` (counterpart
 * `relatedIssue`).
 */
import type { TaskFilter, TaskInput, TaskRow, TaskStore, TaskStoreAsync } from '@broject/core'
import { bodyMeta, stripMeta, withMeta } from '@broject/core'
import type { FetchFn } from './api.ts'
import { gql, gqlAsync, team, teamAsync, teamMeta, users, viewer, viewerAsync } from './api.ts'

const BLOCKED_LABEL = 'blocked'
const DEFAULT_PRIORITY = 2
const QUERY_CAP = 1000

// --- issue node shape ---------------------------------------------------------

interface StateRef {
  id: string
  name: string
  type: string
  position?: number
}

interface RelIssue {
  identifier?: string
  state?: { type?: string } | null
}

interface Relation {
  type?: string
  /** outgoing edge counterpart — on `relations`, this is the target. */
  relatedIssue?: RelIssue | null
  /** incoming edge counterpart — on `inverseRelations`, the blocker. */
  issue?: RelIssue | null
}

interface IssueNode {
  id: string
  identifier: string
  title?: string
  description?: string | null
  url?: string
  priority?: number | null
  state?: StateRef | null
  assignee?: { id?: string; displayName?: string; email?: string } | null
  labels?: { nodes?: { id: string; name: string }[] }
  parent?: { id: string; identifier?: string } | null
  team?: { id: string; key?: string } | null
  children?: { nodes?: RelIssue[] }
  relations?: { nodes?: Relation[] }
  inverseRelations?: { nodes?: Relation[] }
  createdAt?: string
  completedAt?: string | null
  canceledAt?: string | null
  archivedAt?: string | null
}

const NODE_FIELDS = `
  identifier id title description url priority createdAt completedAt canceledAt archivedAt
  state { id name type position }
  assignee { id displayName email }
  labels(first: 50) { nodes { id name } }
  parent { id identifier }
  team { id key }
  children(first: 50) { nodes { identifier state { type } } }
  relations(first: 25) { nodes { type relatedIssue { identifier state { type } } } }
  inverseRelations(first: 25) { nodes { type issue { identifier state { type } } } }
`

// --- row derivation -----------------------------------------------------------

const TERMINAL = new Set(['completed', 'canceled'])

const labelsOf = (n: IssueNode): string[] => (n.labels?.nodes ?? []).map((l) => l.name)
const stateType = (n: IssueNode): string => n.state?.type ?? ''
const isTerminal = (n: IssueNode): boolean => TERMINAL.has(stateType(n)) || n.archivedAt != null
const relOpen = (r: RelIssue | null | undefined): boolean =>
  r != null && !TERMINAL.has(r.state?.type ?? '')

/** An open issue is blocked by an unresolved blocker relation, an open
 *  sub-issue, triage, or the manual label — same rule as github-issues
 *  plus the `triage` state type, which is Linear's "not yet approved". */
const isBlocked = (n: IssueNode, labels: string[]): boolean =>
  labels.includes(BLOCKED_LABEL) ||
  stateType(n) === 'triage' ||
  (n.inverseRelations?.nodes ?? []).some((r) => r.type === 'blocks' && relOpen(r.issue)) ||
  (n.children?.nodes ?? []).some((c) => relOpen(c))

function statusOf(n: IssueNode, labels: string[]): string {
  if (isTerminal(n)) {
    return 'closed'
  }
  if (stateType(n) === 'started' || n.assignee != null) {
    return 'in_progress'
  }
  return isBlocked(n, labels) ? 'blocked' : 'open'
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

/** Linear 0=none 1=urgent 2=high 3=medium 4=low → bd 0..4 lower-is-urgent.
 *  Name-mapped: urgent→0, high→1, medium→2, low→3, none→4 — verbatim
 *  numbers would push unprioritized issues to the head of the queue. */
const LIN_TO_BD: Record<number, number> = { 0: 4, 1: 0, 2: 1, 3: 2, 4: 3 }
const BD_TO_LIN: Record<number, number> = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 0 }

const clampPrio = (p: number): number => Math.min(4, Math.max(0, Math.round(p)))

const toBdPriority = (p: number): number => LIN_TO_BD[clampPrio(p)] ?? DEFAULT_PRIORITY
const toLinearPriority = (p: number): number => BD_TO_LIN[clampPrio(p)] ?? 0

function priorityOf(n: IssueNode, meta: Record<string, unknown>): number {
  if (typeof n.priority === 'number') {
    return toBdPriority(n.priority)
  }
  const p = meta.priority
  return typeof p === 'number' ? p : DEFAULT_PRIORITY
}

function toRow(n: IssueNode): TaskRow {
  const labels = labelsOf(n)
  const meta = bodyMeta(n.description ?? undefined)
  const row: TaskRow & { created_at?: string; __node?: IssueNode } = {
    id: n.identifier,
    title: n.title,
    status: statusOf(n, labels),
    issue_type: issueTypeOf(labels, meta),
    priority: priorityOf(n, meta),
    labels,
    description: stripMeta(n.description ?? ''),
    external_ref:
      typeof meta.external_ref === 'string' && meta.external_ref !== ''
        ? meta.external_ref
        : n.url,
    metadata: Object.keys(meta).length > 0 ? meta : null,
    created_at: n.createdAt,
    __node: n,
  }
  const who = n.assignee?.displayName ?? n.assignee?.email
  if (who !== undefined && who !== '') {
    row.assignee = who
  }
  const st = stateType(n)
  if (st === 'canceled') {
    row.close_reason = 'canceled'
  } else if (n.archivedAt != null) {
    row.close_reason = 'archived'
  }
  const closedAt = n.completedAt ?? n.canceledAt
  if (closedAt) {
    row.closed_at = closedAt
  }
  return row
}

/** Drop the transport carrier before a row leaves the store — node
 *  internals are mutation inputs, not contract. */
const pub = (r: TaskRow & { __node?: IssueNode }): TaskRow => {
  const { __node: _drop, ...rest } = r
  return rest
}

// --- id resolution --------------------------------------------------------------

/** 'ENG-123' | 'eng-123' | '123' | issue URL | UUID → identifier/UUID.
 *  Linear accepts identifiers and UUIDs wherever an issue id is wanted,
 *  so the resolved form is what goes on the wire. A bare number borrows
 *  the serving team's key — ambiguous-team workspaces already threw in
 *  team() before we get here. */
function issueRef(id: string): string {
  const t = id.trim()
  const url = /^https?:\/\/[^/]*linear\.app\/[^/]+\/issue\/([a-z]+-\d+)/i.exec(t)
  if (url) {
    return url[1]!.toUpperCase()
  }
  if (/^[A-Za-z]+-\d+$/.test(t)) {
    return t.toUpperCase()
  }
  if (/^\d+$/.test(t)) {
    return `${team().key}-${t}`
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return t
  }
  throw new Error(
    `linear tasks: "${id}" is not an issue reference (want ENG-123, a bare number, a URL, or a UUID)`
  )
}

// --- queries ------------------------------------------------------------------

const ISSUES_Q = `query BroIssues($team: String!, $cursor: String, $filter: IssueFilter) {
  team(id: $team) {
    issues(first: 100, after: $cursor, filter: $filter) {
      nodes { ${NODE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const ISSUE_Q = `query BroIssue($id: String!) { issue(id: $id) { ${NODE_FIELDS} } }`

const CHILDREN_Q = `query BroChildren($id: String!) {
  issue(id: $id) { children(first: 50) { nodes { ${NODE_FIELDS} } } }
}`

const CREATE_M = `mutation BroIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${NODE_FIELDS} } }
}`

const UPDATE_M = `mutation BroIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`

const DELETE_M = `mutation BroIssueDelete($id: String!) {
  issueDelete(id: $id) { success }
}`

const RELATION_M = `mutation BroRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`

const COMMENT_M = `mutation BroCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`

const LABEL_M = `mutation BroLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { issueLabel { id name } }
}`

interface IssueConn {
  nodes?: IssueNode[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string }
}

/** Linear payloads carry `success: false` without GraphQL errors for a
 *  few mutation misses (e.g. deleting a gone issue) — that would land
 *  as a silent no-op, so assert it. */
function mutOk(data: Record<string, unknown>, name: string): void {
  const p = data[name] as { success?: boolean } | undefined
  if (p?.success === false) {
    throw new Error(`linear tasks: ${name} returned success=false`)
  }
}

/** Non-terminal issues are the working set; 'all' drops the filter,
 *  status:'closed' inverts it. Every other derived status post-filters. */
function stateFilter(f: TaskFilter): Record<string, unknown> | undefined {
  if (f.all === true) {
    return undefined
  }
  const types = [...TERMINAL]
  return f.status === 'closed'
    ? { state: { type: { in: types } } }
    : { state: { type: { nin: types } } }
}

function queryIssuesSync(filter: Record<string, unknown> | undefined, limit: number): IssueNode[] {
  const t = team()
  const out: IssueNode[] = []
  let cursor: string | undefined
  for (;;) {
    const data = gql(ISSUES_Q, { team: t.id, cursor: cursor ?? null, filter: filter ?? null })
    const conn = (data['team'] as { issues?: IssueConn } | null | undefined)?.issues
    out.push(...(conn?.nodes ?? []))
    if (out.length >= limit) {
      break
    }
    const pi = conn?.pageInfo
    cursor = pi?.hasNextPage === true && pi.endCursor ? pi.endCursor : undefined
    if (cursor === undefined) {
      break
    }
  }
  return out.slice(0, limit)
}

async function queryIssuesAsync(
  filter: Record<string, unknown> | undefined,
  limit: number,
  fetchImpl?: FetchFn
): Promise<IssueNode[]> {
  const t = await teamAsync(fetchImpl)
  const out: IssueNode[] = []
  let cursor: string | undefined
  for (;;) {
    const data = await gqlAsync(
      ISSUES_Q,
      { team: t.id, cursor: cursor ?? null, filter: filter ?? null },
      fetchImpl
    )
    const conn = (data['team'] as { issues?: IssueConn } | null | undefined)?.issues
    out.push(...(conn?.nodes ?? []))
    if (out.length >= limit) {
      break
    }
    const pi = conn?.pageInfo
    cursor = pi?.hasNextPage === true && pi.endCursor ? pi.endCursor : undefined
    if (cursor === undefined) {
      break
    }
  }
  return out.slice(0, limit)
}

const issueFrom = (data: Record<string, unknown>): IssueNode | undefined =>
  (data['issue'] as IssueNode | null | undefined) ?? undefined

function queryIssueSync(ref: string): IssueNode | undefined {
  return issueFrom(gql(ISSUE_Q, { id: ref }))
}

/** Async id resolution — a bare number resolves through the team cache;
 *  warming it via teamAsync keeps issueRef's sync team() call a cache
 *  hit instead of a blocking curl spawn inside the probe path. */
async function refAsync(id: string, fetchImpl?: FetchFn): Promise<string> {
  if (/^\d+$/.test(id.trim())) {
    await teamAsync(fetchImpl)
  }
  return issueRef(id)
}

async function queryIssueAsync(ref: string, fetchImpl?: FetchFn): Promise<IssueNode | undefined> {
  return issueFrom(await gqlAsync(ISSUE_Q, { id: ref }, fetchImpl))
}

function queryChildrenSync(ref: string): IssueNode[] {
  const data = gql(CHILDREN_Q, { id: ref })
  const issue = data['issue'] as { children?: { nodes?: IssueNode[] } } | null | undefined
  return issue?.children?.nodes ?? []
}

async function queryChildrenAsync(ref: string, fetchImpl?: FetchFn): Promise<IssueNode[]> {
  const data = await gqlAsync(CHILDREN_Q, { id: ref }, fetchImpl)
  const issue = data['issue'] as { children?: { nodes?: IssueNode[] } } | null | undefined
  return issue?.children?.nodes ?? []
}

// --- filtering ------------------------------------------------------------------

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
  if (f.limit !== undefined) {
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
  needsPostFilter(f) ? QUERY_CAP : Math.min(f.limit ?? QUERY_CAP, QUERY_CAP)

const byPriority = (a: TaskRow, b: TaskRow): number =>
  (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
  String((a as TaskRow & { created_at?: string }).created_at ?? '').localeCompare(
    String((b as TaskRow & { created_at?: string }).created_at ?? '')
  )

/** ready = open + unblocked + unclaimed — derived status 'open' is
 *  exactly that set, already priority-ordered over created asc. */
function readyOf(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  return rows.filter((r) => r.status === 'open').sort(byPriority).slice(0, f.limit ?? QUERY_CAP)
}

// --- actor --------------------------------------------------------------------

const display = (u: { displayName?: string; email?: string } | null | undefined): string =>
  u?.displayName ?? u?.email ?? ''

/** viewer identity for row.assignee comparisons — '' when the probe
 *  can't answer (hook surfaces must fail open, never throw). */
const actor = (): string => {
  try {
    return display(viewer())
  } catch {
    return ''
  }
}

const actorAsync = async (fetchImpl?: FetchFn): Promise<string> => {
  try {
    return display(await viewerAsync(fetchImpl))
  } catch {
    return ''
  }
}

// --- labels + states ------------------------------------------------------------

/** label name → id inside the team, creating the label when absent —
 *  issueLabelCreate is idempotent-ish for the caller (a create race is
 *  fine: the later update reports any real failure). */
function ensureLabelId(teamIdOrKey: string, name: string): string {
  const meta = teamMeta(teamIdOrKey)
  const found = meta.labels.find((l) => l.name.toLowerCase() === name.toLowerCase())
  if (found) {
    return found.id
  }
  const data = gql(LABEL_M, { input: { teamId: meta.id, name } })
  mutOk(data, 'issueLabelCreate')
  const created = (data['issueLabelCreate'] as { issueLabel?: { id?: string } } | undefined)
    ?.issueLabel?.id
  if (typeof created !== 'string' || created === '') {
    throw new Error(`linear tasks: label '${name}' — issueLabelCreate returned no id`)
  }
  meta.labels.push({ id: created, name })
  return created
}

function labelIdsFor(teamIdOrKey: string, names: string[]): string[] {
  return names.map((n) => ensureLabelId(teamIdOrKey, n))
}

/** First workflow state of `type` by position — completed for close,
 *  unstarted (then backlog) for reopen. `fallback` applies only to the
 *  reopen path where unstarted might not exist. */
function pickState(teamIdOrKey: string, type: string, fallback?: string): string {
  const states = teamMeta(teamIdOrKey).states
  const sorted = (t: string) =>
    states.filter((s) => s.type === t).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const hit = sorted(type)[0]?.id ?? (fallback !== undefined ? sorted(fallback)[0]?.id : undefined)
  if (hit === undefined) {
    throw new Error(`linear tasks: team has no '${type}' workflow state`)
  }
  return hit
}

// --- deps ---------------------------------------------------------------------------

interface DepEdge {
  issue_id: string
  depends_on_id: string
  type: string
}

const wants = (dir: 'up' | 'down', direction?: string): boolean =>
  direction === undefined || direction === dir

/** X depends-on Y — X's blockers read inverseRelations('blocks')'s
 *  `issue` (the blocker), X's downstream reads relations('blocks')'s
 *  `relatedIssue` (the blocked). */
function blockEdges(n: IssueNode, direction?: string): DepEdge[] {
  const id = n.identifier
  const out: DepEdge[] = []
  if (wants('up', direction)) {
    for (const r of n.inverseRelations?.nodes ?? []) {
      if (r.type === 'blocks' && r.issue?.identifier !== undefined) {
        out.push({ issue_id: id, depends_on_id: r.issue.identifier, type: 'blocks' })
      }
    }
  }
  if (wants('down', direction)) {
    for (const r of n.relations?.nodes ?? []) {
      if (r.type === 'blocks' && r.relatedIssue?.identifier !== undefined) {
        out.push({ issue_id: r.relatedIssue.identifier, depends_on_id: id, type: 'blocks' })
      }
    }
  }
  return out
}

/** parent reads 'up' (this issue depends on its parent), children 'down'. */
function parentEdges(n: IssueNode, direction?: string): DepEdge[] {
  const id = n.identifier
  const out: DepEdge[] = []
  if (wants('up', direction) && n.parent?.identifier !== undefined) {
    out.push({ issue_id: id, depends_on_id: n.parent.identifier!, type: 'parent-child' })
  }
  if (wants('down', direction)) {
    for (const c of n.children?.nodes ?? []) {
      if (c.identifier !== undefined) {
        out.push({ issue_id: c.identifier, depends_on_id: id, type: 'parent-child' })
      }
    }
  }
  return out
}

function depEdges(n: IssueNode, opts: { type?: string; direction?: string }): DepEdge[] {
  return [
    ...(opts.type === undefined || opts.type === 'blocks' ? blockEdges(n, opts.direction) : []),
    ...(opts.type === undefined || opts.type === 'parent-child' ? parentEdges(n, opts.direction) : []),
  ]
}

function depsSync(ids: string[], opts: { type?: string; direction?: string }): DepEdge[] {
  const out: DepEdge[] = []
  for (const id of ids) {
    const n = queryIssueSync(issueRef(id))
    if (n) {
      out.push(...depEdges(n, opts))
    }
  }
  return out
}

async function depsAsync(
  ids: string[],
  opts: { type?: string; direction?: string },
  fetchImpl?: FetchFn
): Promise<DepEdge[]> {
  const nodes = await Promise.all(ids.map(async (id) => queryIssueAsync(await refAsync(id, fetchImpl), fetchImpl)))
  return nodes.flatMap((n) => (n === undefined ? [] : depEdges(n, opts)))
}

// --- sync mutations -----------------------------------------------------------------

/** link(from, to, 'blocks') — "from is blocked by to", bd dep
 *  semantics → Linear: issue=to blocks relatedIssue=from.
 *  'parent-child' makes `from` a sub-issue of `to`. Other types have no
 *  Linear analogue — thrown, never faked as comments. */
function linkSync(from: string, to: string, type: string): void {
  if (type === 'blocks' || type === 'blocked-by') {
    mutOk(
      gql(RELATION_M, {
        input: { issueId: issueRef(to), relatedIssueId: issueRef(from), type: 'blocks' },
      }),
      'issueRelationCreate'
    )
    return
  }
  if (type === 'parent-child') {
    const parent = queryIssueSync(issueRef(to))
    if (parent === undefined) {
      throw new Error(`linear tasks: cannot resolve ${to} to an issue`)
    }
    mutOk(gql(UPDATE_M, { id: issueRef(from), input: { parentId: parent.id } }), 'issueUpdate')
    return
  }
  throw new Error(
    `linear tasks: link type '${type}' has no Linear analogue (blocks | blocked-by | parent-child)`
  )
}

/** claim = assign viewer → verify re-read. Single-assignee writes are
 *  last-writer-wins, so the verify settles races deterministically:
 *  whoever the read shows holds it — a loser sees the winner and
 *  throws. No label commit flag is needed (github needed one only
 *  because assignees are a *set* there). A `started`-but-unassigned
 *  issue is claimable — the assignee is the claim, and an abandoned
 *  start must not wedge the issue forever. */
function claimSync(ref: string): void {
  const n = queryIssueSync(ref)
  if (n === undefined) {
    throw new Error(`linear tasks: issue ${ref} not found`)
  }
  if (isTerminal(n)) {
    throw new Error(`linear tasks: ${n.identifier} is ${stateType(n)} — only open issues are claimable`)
  }
  if (n.assignee != null) {
    throw new Error(`linear tasks: ${n.identifier} already claimed by ${display(n.assignee)}`)
  }
  const me = viewer()
  mutOk(gql(UPDATE_M, { id: n.id, input: { assigneeId: me.id } }), 'issueUpdate')
  const check = queryIssueSync(ref)
  if (check?.assignee?.id !== me.id) {
    const holder = check?.assignee ? display(check.assignee) : 'another actor'
    throw new Error(`linear tasks: ${n.identifier} claim contested — ${holder} holds it`)
  }
}

function reopenSync(ref: string): void {
  const n = queryIssueSync(ref)
  if (n === undefined) {
    throw new Error(`linear tasks: issue ${ref} not found`)
  }
  // only a terminal state needs the verb — an un-claim on a claimed
  // issue is already open; the marker release runs either way
  if (isTerminal(n)) {
    if (n.team?.id === undefined) {
      throw new Error(`linear tasks: ${n.identifier} carries no team — cannot resolve a reopen state`)
    }
    mutOk(
      gql(UPDATE_M, {
        id: n.id,
        input: { stateId: pickState(n.team.id, 'unstarted', 'backlog') },
      }),
      'issueUpdate'
    )
  }
  // release every claim marker — a claim held by a crashed worker or a
  // rival would otherwise keep the issue in_progress forever
  if (n.assignee != null) {
    mutOk(gql(UPDATE_M, { id: n.id, input: { assigneeId: null } }), 'issueUpdate')
  }
  const labels = n.labels?.nodes ?? []
  const blocked = labels.find((l) => l.name === BLOCKED_LABEL)
  if (blocked !== undefined && n.team?.id !== undefined) {
    mutOk(
      gql(UPDATE_M, {
        id: n.id,
        input: { labelIds: labels.filter((l) => l.id !== blocked.id).map((l) => l.id) },
      }),
      'issueUpdate'
    )
  }
}

function closeSync(ref: string, reason?: string): void {
  const n = queryIssueSync(ref)
  if (n === undefined) {
    throw new Error(`linear tasks: issue ${ref} not found`)
  }
  // the reason lands first — a failed comment leaves the issue open,
  // same ordering guarantee as `gh issue close --comment`
  if (reason !== undefined && reason !== '') {
    mutOk(gql(COMMENT_M, { input: { issueId: n.id, body: reason } }), 'commentCreate')
  }
  if (!isTerminal(n)) {
    if (n.team?.id === undefined) {
      throw new Error(`linear tasks: ${n.identifier} carries no team — cannot resolve a 'completed' state`)
    }
    mutOk(
      gql(UPDATE_M, { id: n.id, input: { stateId: pickState(n.team.id, 'completed') } }),
      'issueUpdate'
    )
  }
}

function createMeta(i: TaskInput): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...i.metadata }
  if (i.type !== undefined) {
    meta.type = i.type
  }
  if (i.externalRef !== undefined) {
    meta.external_ref = i.externalRef
  }
  return meta
}

/** 'kind:ref' — refs may be URLs carrying their own colons, so split on
 *  the FIRST colon only. */
function depRef(d: string): { kind: string; ref: string } {
  const colon = d.indexOf(':')
  return { kind: d.slice(0, colon), ref: d.slice(colon + 1) }
}

function applyDeps(id: string, i: TaskInput): void {
  for (const d of i.deps ?? []) {
    const { kind, ref } = depRef(d)
    linkSync(id, ref, kind === 'blocked-by' ? 'blocks' : kind)
  }
}

function createSync(i: TaskInput): TaskRow {
  // pre-validate deps before the issue exists — an unsupported dep type
  // must not leave a half-created issue
  for (const d of i.deps ?? []) {
    const { kind } = depRef(d)
    if (!/^(blocks|blocked-by|parent-child)$/.test(kind)) {
      throw new Error(`linear tasks: dep type '${kind}' unsupported (blocks | blocked-by | parent-child)`)
    }
  }
  const t = team()
  const input: Record<string, unknown> = { teamId: t.id, title: i.title }
  if (
    i.description !== undefined ||
    i.metadata !== undefined ||
    i.type !== undefined ||
    i.externalRef !== undefined
  ) {
    input.description = withMeta(i.description, createMeta(i))
  }
  if (i.priority !== undefined) {
    input.priority = toLinearPriority(i.priority)
  }
  if ((i.labels ?? []).length > 0) {
    input.labelIds = labelIdsFor(t.id, i.labels!)
  }
  if (i.parent !== undefined) {
    const parent = queryIssueSync(issueRef(i.parent))
    if (parent === undefined) {
      throw new Error(`linear tasks: cannot resolve parent ${i.parent} to an issue`)
    }
    input.parentId = parent.id
  }
  const data = gql(CREATE_M, { input })
  mutOk(data, 'issueCreate')
  const created = (data['issueCreate'] as { issue?: IssueNode } | undefined)?.issue
  if (created === undefined) {
    throw new Error('linear tasks: issueCreate returned no issue')
  }
  applyDeps(created.identifier, i)
  return toRow(created)
}

function updateStatus(n: IssueNode, val: string): void {
  if (val === 'open') {
    reopenSync(n.identifier)
  } else if (val === 'closed') {
    closeSync(n.identifier)
  } else if (val === 'in_progress') {
    claimSync(n.identifier)
  } else if (val === 'blocked') {
    if (n.team?.id === undefined) {
      throw new Error(`linear tasks: ${n.identifier} carries no team — cannot add the 'blocked' label`)
    }
    const id = ensureLabelId(n.team.id, BLOCKED_LABEL)
    const ids = [...new Set([...(n.labels?.nodes ?? []).map((l) => l.id), id])]
    mutOk(gql(UPDATE_M, { id: n.id, input: { labelIds: ids } }), 'issueUpdate')
  } else {
    throw new Error(`linear tasks: unknown status '${val}'`)
  }
}

const issueUpdate = (id: string, input: Record<string, unknown>): void =>
  mutOk(gql(UPDATE_M, { id, input }), 'issueUpdate')

function updateMetaField(n: IssueNode, k: string, val: string): void {
  const meta = bodyMeta(n.description ?? undefined)
  meta[k] = val
  issueUpdate(n.id, { description: withMeta(n.description ?? '', meta) })
}

function addLabels(n: IssueNode, val: string): void {
  if (n.team?.id === undefined) {
    throw new Error(`linear tasks: ${n.identifier} carries no team — cannot add labels`)
  }
  const names = val
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const ids = new Set((n.labels?.nodes ?? []).map((l) => l.id))
  for (const id of labelIdsFor(n.team.id, names)) {
    ids.add(id)
  }
  mutOk(gql(UPDATE_M, { id: n.id, input: { labelIds: [...ids] } }), 'issueUpdate')
}

/** assignee:<name> resolves a workspace user by displayName/name/email
 *  (case-insensitive); '' unassigns. An ambiguous name throws — picking
 *  one silently would hand the claim to the wrong person. */
function resolveAssignee(val: string): string | null {
  if (val === '') {
    return null
  }
  const want = val.toLowerCase()
  const hits = users().filter(
    (u) =>
      u.displayName?.toLowerCase() === want ||
      u.name?.toLowerCase() === want ||
      u.email?.toLowerCase() === want
  )
  if (hits.length === 0) {
    throw new Error(`linear tasks: no user '${val}'`)
  }
  if (hits.length > 1) {
    throw new Error(
      `linear tasks: '${val}' is ambiguous — ${hits.map((u) => u.email ?? u.id).join(', ')}`
    )
  }
  return hits[0]!.id
}

interface PatchCtx {
  id: string
  ref: string
}

/** the live issue or throw — read-before-write verbs merge against the
 *  current state (label id sets, description trailer, team for states). */
function mustIssue(c: PatchCtx): IssueNode {
  const n = queryIssueSync(c.ref)
  if (n === undefined) {
    throw new Error(`linear tasks: issue ${c.id} not found`)
  }
  return n
}

function patchBody(c: PatchCtx, val: string): void {
  const cur = queryIssueSync(c.ref)
  issueUpdate(c.ref, { description: withMeta(val, bodyMeta(cur?.description ?? undefined)) })
}

function patchPriority(c: PatchCtx, val: string): void {
  const p = Number(val)
  if (!Number.isFinite(p)) {
    throw new TypeError(`linear tasks: priority '${val}' is not a number`)
  }
  issueUpdate(c.ref, { priority: toLinearPriority(p) })
}

const patchComment = (c: PatchCtx, val: string): void =>
  mutOk(gql(COMMENT_M, { input: { issueId: c.ref, body: val } }), 'commentCreate')

const patchMeta =
  (k: string) =>
  (c: PatchCtx, val: string): void =>
    updateMetaField(mustIssue(c), k, val)

/** patch key → write — a table, not a chain: one entry per verb keeps
 *  each writer flat (S3776). Aliases resolve here, not inside helpers. */
const PATCH: Record<string, (c: PatchCtx, val: string) => void> = {
  title: (c, v) => issueUpdate(c.ref, { title: v }),
  body: patchBody,
  description: patchBody,
  status: (c, v) => updateStatus(mustIssue(c), v),
  claim: (c, v) => {
    if (v === 'true') {
      claimSync(c.ref)
    }
  },
  labels: (c, v) => addLabels(mustIssue(c), v),
  label: (c, v) => addLabels(mustIssue(c), v),
  assignee: (c, v) => issueUpdate(c.ref, { assigneeId: resolveAssignee(v) }),
  notes: patchComment,
  note: patchComment,
  priority: patchPriority,
  type: patchMeta('type'),
  issue_type: patchMeta('type'),
  external_ref: patchMeta('external_ref'),
  externalRef: patchMeta('external_ref'),
}

function updateSync(id: string, patch: Record<string, string | number>): void {
  const c: PatchCtx = { id, ref: issueRef(id) }
  for (const [k, v] of Object.entries(patch)) {
    const h = PATCH[k]
    if (h === undefined) {
      throw new Error(`linear tasks: unsupported update key '${k}'`)
    }
    h(c, String(v))
  }
}

// --- the stores -------------------------------------------------------------------

function rowOrUndef(n: IssueNode | undefined): TaskRow | undefined {
  return n === undefined ? undefined : pub(toRow(n))
}

export function linearTasks(_dir: string): TaskStore {
  return {
    list: (f = {}) => applyFilter(queryIssuesSync(stateFilter(f), fetchCap(f)).map(toRow).map(pub), f) as never,
    // applyFilter must not slice here — the limit lands AFTER the
    // priority sort in readyOf, or high-priority issues late in the
    // created-ordered page get truncated away
    ready: (f = {}) =>
      readyOf(
        applyFilter(
          queryIssuesSync({ state: { type: { nin: [...TERMINAL] } } }, QUERY_CAP).map(toRow).map(pub),
          { ...f, status: 'open', limit: undefined }
        ),
        f
      ) as never,
    get: (id) => rowOrUndef(queryIssueSync(issueRef(id))) as never,
    create: (i) => pub(createSync(i)) as never,
    update: (id, patch) => updateSync(id, patch),
    claim: (id) => claimSync(issueRef(id)),
    actor: () => actor(),
    reopen: (id) => reopenSync(issueRef(id)),
    close: (id, reason) => closeSync(issueRef(id), reason),
    remove: (id) => {
      mutOk(gql(DELETE_M, { id: issueRef(id) }), 'issueDelete')
    },
    note: (id, text) => {
      mutOk(gql(COMMENT_M, { input: { issueId: issueRef(id), body: text } }), 'commentCreate')
    },
    children: (id) => queryChildrenSync(issueRef(id)).map(toRow).map(pub) as never,
    deps: (ids, opts = {}) => depsSync(ids, opts) as never,
    link: (from, to, type = 'related') => linkSync(from, to, type),
    prefix: () => team().key,
  }
}

/** `fetch` is injectable for tests; the real transport defaults to the
 *  global fetch against the fixed endpoint (same seam as
 *  @broject/providers' FetchFn). */
export function linearTasksAsync(_dir: string, opts?: { fetch?: FetchFn }): TaskStoreAsync {
  const fetchImpl = opts?.fetch
  return {
    list: async (f = {}) =>
      applyFilter(
        (await queryIssuesAsync(stateFilter(f), fetchCap(f), fetchImpl)).map(toRow).map(pub),
        f
      ),
    ready: async (f = {}) =>
      readyOf(
        applyFilter(
          (await queryIssuesAsync({ state: { type: { nin: [...TERMINAL] } } }, QUERY_CAP, fetchImpl)).map(
            toRow
          ).map(pub),
          { ...f, status: 'open', limit: undefined }
        ),
        f
      ),
    get: async (id) =>
      rowOrUndef(await queryIssueAsync(await refAsync(id, fetchImpl), fetchImpl)) as never,
    children: async (id) =>
      (await queryChildrenAsync(await refAsync(id, fetchImpl), fetchImpl)).map(toRow).map(pub) as never,
    deps: async (ids, opts = {}) => (await depsAsync(ids, opts, fetchImpl)) as never,
    actor: () => actorAsync(fetchImpl),
  }
}

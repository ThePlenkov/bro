/**
 * The github connector's `tasks` facade — the TaskStore contract over
 * Issues (spec specs/bro-huy5o.1.md). `gh` is the transport: GraphQL
 * for reads, `gh issue` verbs for mutations.
 *
 * Mapping:
 *   id        — the bare issue number ('42'); '#42' and URLs accepted
 *   status    — closed | in_progress (bro:claimed label or assignee) |
 *               blocked (open blocker) | open
 *   blocked   — open `blockedBy` dependency, open sub-issue (decomposed
 *               work is not itself ready), or a manual 'blocked' label
 *   claim     — assignee + `bro:claimed` label (label lands last, after
 *               the assignee verifies — it is the commit flag)
 *   type/prio — native issueType wins, then type:/kind:/epic labels,
 *               then the `<!-- bro: {...} -->` body trailer; p<N> and
 *               priority:<N> labels, then the trailer, default 2
 *
 * GitHub has no transaction to claim through: the protocol is
 * read → addAssignees → re-read. A contested assignee set resolves to
 * the lowest login; the loser unassigns and throws. The residual
 * micro-window (a loser's verify landing before the winner's write)
 * stays visible — the issue shows both assignees — never faked.
 *
 * GHES fallback: `blockedBy`/`subIssues`/`parent`/`issueType` are
 * github.com schema additions. A schema error on them retries without
 * relation fields — relationships degrade to "none known", declared
 * absent rather than faked.
 */
import {
  gh,
  ghJson,
  ghTry,
  ghJsonAsync,
  resolveRepo,
  resolveRepoAsync,
} from '@broject/core'
import type { TaskFilter, TaskInput, TaskRow, TaskStore, TaskStoreAsync } from '@broject/core'

const CLAIMED_LABEL = 'bro:claimed'
const BLOCKED_LABEL = 'blocked'
const DEFAULT_PRIORITY = 2
const QUERY_CAP = 1000

// --- issue node shape ---------------------------------------------------------

interface Ref {
  number: number
  state: string
}

interface IssueNode {
  number: number
  /** GraphQL node id — mutations that take issueId want this. */
  id: string
  /** REST databaseId — dependencies/sub-issues endpoints want this. */
  databaseId?: number
  title: string
  body?: string
  url: string
  state: string
  stateReason?: string | null
  createdAt: string
  closedAt?: string | null
  issueType?: { name: string } | null
  labels?: { nodes: { name: string }[] }
  assignees?: { nodes: { login: string }[] }
  parent?: { number: number } | null
  blockedBy?: { nodes: Ref[] }
  blocking?: { nodes: Ref[] }
  subIssues?: { nodes: Ref[] }
}

const CORE_FIELDS = `
  number id databaseId title body url state stateReason createdAt closedAt
  labels(first: 50) { nodes { name } }
  assignees(first: 20) { nodes { login } }
`

const REL_FIELDS = `
  parent { number }
  issueType { name }
  blockedBy(first: 25) { nodes { number state } }
  blocking(first: 25) { nodes { number state } }
  subIssues(first: 50) { nodes { number state } }
`

const nodeFields = (rel: boolean): string => (rel ? CORE_FIELDS + REL_FIELDS : CORE_FIELDS)

/** Schema-drift marker: github.com fields a GHES schema lacks. */
const DRIFT_FIELD = /blockedBy|blocking|subIssues|issueType|parent\b/
const DRIFT_MSG = /Cannot query field|does not exist|Field .* doesn't exist/i
const isDriftError = (err: unknown): boolean =>
  DRIFT_FIELD.test(String(err)) && DRIFT_MSG.test(String(err))

// --- row derivation -----------------------------------------------------------

const labelsOf = (n: IssueNode): string[] => (n.labels?.nodes ?? []).map((l) => l.name)
const assigneesOf = (n: IssueNode): string[] => (n.assignees?.nodes ?? []).map((a) => a.login)
const anyOpen = (refs: Ref[] | undefined): boolean => (refs ?? []).some((r) => r.state === 'OPEN')

const META_INNER = /^\s*bro:\s*(\{[\s\S]*\})\s*$/

/** The `<!-- bro: {...} -->` trailer's JSON + span — located by comment
 *  delimiters, not a body-wide regex. A `/<!--\s*bro:...-->/` pattern
 *  re-scans the body at every `<!--` start position, which is quadratic
 *  on hostile bodies (CodeQL polynomial-regex). indexOf + an anchored
 *  inner check keeps each comment span parsed once — linear total. */
function broTrailer(body: string): { json: string; start: number; end: number } | null {
  let i = 0
  for (;;) {
    const s = body.indexOf('<!--', i)
    if (s === -1) {
      return null
    }
    const e = body.indexOf('-->', s + 4)
    if (e === -1) {
      return null
    }
    const m = META_INNER.exec(body.slice(s + 4, e))
    if (m) {
      return { json: m[1]!, start: s, end: e + 3 }
    }
    i = e + 3
  }
}

/** The `<!-- bro: {...} -->` body trailer — type/priority/external_ref
 *  GitHub has no fields for. Malformed JSON degrades to absent. */
function bodyMeta(body: string | undefined): Record<string, unknown> {
  const t = broTrailer(body ?? '')
  if (t === null) {
    return {}
  }
  try {
    const v: unknown = JSON.parse(t.json)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Body without the bro trailer — description is the human text. */
const stripMeta = (body: string | undefined): string => {
  const b = body ?? ''
  const t = broTrailer(b)
  return (t === null ? b : b.slice(0, t.start) + b.slice(t.end)).trimEnd()
}

function issueTypeOf(n: IssueNode, labels: string[], meta: Record<string, unknown>): string {
  const native = n.issueType?.name?.trim()
  if (native) {
    return native.toLowerCase()
  }
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

/** An open issue is blocked when a dependency, a sub-issue, or the
 *  manual label says so. Without relation fields (GHES fallback) only
 *  the label survives — absent, not faked. */
const isBlocked = (n: IssueNode, labels: string[]): boolean =>
  labels.includes(BLOCKED_LABEL) || anyOpen(n.blockedBy?.nodes) || anyOpen(n.subIssues?.nodes)

function statusOf(n: IssueNode, labels: string[], assignees: string[]): string {
  if (n.state !== 'OPEN') {
    return 'closed'
  }
  if (labels.includes(CLAIMED_LABEL) || assignees.length > 0) {
    return 'in_progress'
  }
  return isBlocked(n, labels) ? 'blocked' : 'open'
}

function toRow(n: IssueNode): TaskRow {
  const labels = labelsOf(n)
  const assignees = assigneesOf(n)
  const meta = bodyMeta(n.body)
  const row: TaskRow & { created_at?: string; __node?: IssueNode } = {
    id: String(n.number),
    title: n.title,
    status: statusOf(n, labels, assignees),
    issue_type: issueTypeOf(n, labels, meta),
    priority: priorityOf(labels, meta),
    labels,
    description: stripMeta(n.body),
    // a caller-supplied external ref (create/update stores it in the
    // trailer) beats the issue's own URL — losing it silently turns
    // writes into data the row can't return
    external_ref:
      typeof meta.external_ref === 'string' && meta.external_ref !== ''
        ? meta.external_ref
        : n.url,
    metadata: Object.keys(meta).length > 0 ? meta : null,
    created_at: n.createdAt,
    __node: n,
  }
  if (assignees.length > 0) {
    row.assignee = assignees.join(', ')
  }
  // `parent` is NOT mapped onto the row — in the TaskStore contract a
  // row.parent means "step of an orchestrated parent" (molecule step /
  // epic child), and `bro next` gates such rows out of the claimable
  // queue. A GitHub sub-issue has no orchestrator — it is ordinary
  // decomposed work that must stay claimable (its parent is already
  // blocked by the open-sub-issues rule). The parent edge is still
  // available through deps()/children() for callers that need it.
  if (n.stateReason === 'NOT_PLANNED' || n.stateReason === 'DUPLICATE') {
    row.close_reason = n.stateReason === 'NOT_PLANNED' ? 'not planned' : 'duplicate'
  }
  if (n.closedAt) {
    row.closed_at = n.closedAt
  }
  return row
}

/** Drop the transport carrier before a row leaves the store — node
 *  internals are mutation inputs, not contract. */
const pub = (r: TaskRow & { __node?: IssueNode }): TaskRow => {
  const { __node: _drop, ...rest } = r
  return rest
}

// --- id + repo resolution -----------------------------------------------------

/** '42' | '#42' | this repo's issue URL → 42. Anything else is a usage
 *  error — a foreign ref must not silently target a wrong number: a URL
 *  naming another repo would mutate that repo's issue NUMBER against
 *  this one. */
function issueNumber(dir: string, id: string): number {
  const t = id.trim()
  const url = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(t)
  if (url) {
    const slug = `${url[1]}/${url[2]}`.toLowerCase()
    const mine = repoOf(dir).toLowerCase()
    if (slug !== mine) {
      throw new Error(`github tasks: "${id}" is a ${slug} issue — this store serves ${mine}`)
    }
    return Number(url[3])
  }
  if (!/^(#\d+|\d+)$/.test(t)) {
    throw new Error(`github tasks: "${id}" is not an issue reference (want 42, #42, or an issue URL)`)
  }
  const n = Number(t.replace(/^#/, ''))
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`github tasks: "${id}" is not an issue reference (want 42, #42, or an issue URL)`)
  }
  return n
}

const repoCache = new Map<string, string>()

function repoOf(dir: string): string {
  let r = repoCache.get(dir)
  if (r === undefined) {
    r = resolveRepo([], dir)
    repoCache.set(dir, r)
  }
  return r
}

async function repoOfAsync(dir: string): Promise<string> {
  let r = repoCache.get(dir)
  if (r === undefined) {
    r = await resolveRepoAsync([], dir)
    repoCache.set(dir, r)
  }
  return r
}

const splitRepo = (repo: string): { o: string; r: string } => {
  const [o, r] = repo.split('/')
  return { o: o!, r: r! }
}

// --- graphql read path --------------------------------------------------------

const ISSUES_QUERY = (rel: boolean): string => `
query($o:String!,$r:String!,$states:[IssueState!]!,$cursor:String){
  repository(owner:$o,name:$r){
    issues(first:100,after:$cursor,states:$states,orderBy:{field:CREATED_AT,direction:ASC}){
      nodes{${nodeFields(rel)}}
      pageInfo{hasNextPage endCursor}
    }
  }
}`

const ISSUE_QUERY = (rel: boolean): string => `
query($o:String!,$r:String!,$n:Int!){
  repository(owner:$o,name:$r){ issue(number:$n){${nodeFields(rel)}} }
}`

const SUBISSUES_QUERY = (rel: boolean): string => `
query($o:String!,$r:String!,$n:Int!){
  repository(owner:$o,name:$r){ issue(number:$n){ subIssues(first:50){nodes{${nodeFields(rel)}}} } }
}`

interface IssuePage {
  data?: {
    repository?: {
      issues?: { nodes?: IssueNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
    }
  }
}

function stateVars(states: string[], cursor: string | undefined): string[] {
  return [
    ...states.flatMap((s) => ['-f', `states=${s}`]),
    '-f',
    `cursor=${cursor ?? ''}`,
  ]
}

function queryIssuesSync(dir: string, states: string[], limit: number): IssueNode[] {
  const { o, r } = splitRepo(repoOf(dir))
  const out: IssueNode[] = []
  let cursor: string | undefined
  for (;;) {
    const args = (rel: boolean) => [
      'api', 'graphql', '-f', `query=${ISSUES_QUERY(rel)}`, '-f', `o=${o}`, '-f', `r=${r}`,
      ...stateVars(states, cursor),
    ]
    let page: IssuePage
    try {
      page = ghJson<IssuePage>(args(true), dir)
    } catch (err) {
      if (!isDriftError(err)) {
        throw err
      }
      page = ghJson<IssuePage>(args(false), dir)
    }
    const conn = page.data?.repository?.issues
    out.push(...(conn?.nodes ?? []))
    if (out.length >= limit || conn?.pageInfo?.hasNextPage !== true || !conn.pageInfo.endCursor) {
      break
    }
    cursor = conn.pageInfo.endCursor
  }
  return out.slice(0, limit)
}

async function queryIssuesAsync(dir: string, states: string[], limit: number): Promise<IssueNode[]> {
  const { o, r } = splitRepo(await repoOfAsync(dir))
  const out: IssueNode[] = []
  let cursor: string | undefined
  for (;;) {
    const args = (rel: boolean) => [
      'api', 'graphql', '-f', `query=${ISSUES_QUERY(rel)}`, '-f', `o=${o}`, '-f', `r=${r}`,
      ...stateVars(states, cursor),
    ]
    let page: IssuePage
    try {
      page = await ghJsonAsync<IssuePage>(args(true), dir)
    } catch (err) {
      if (!isDriftError(err)) {
        throw err
      }
      page = await ghJsonAsync<IssuePage>(args(false), dir)
    }
    const conn = page.data?.repository?.issues
    out.push(...(conn?.nodes ?? []))
    if (out.length >= limit || conn?.pageInfo?.hasNextPage !== true || !conn.pageInfo.endCursor) {
      break
    }
    cursor = conn.pageInfo.endCursor
  }
  return out.slice(0, limit)
}

function queryIssueSync(dir: string, n: number): IssueNode | undefined {
  const { o, r } = splitRepo(repoOf(dir))
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`]
  const run = (rel: boolean) =>
    ghJson<{ data?: { repository?: { issue?: IssueNode | null } } }>(
      ['api', 'graphql', '-f', `query=${ISSUE_QUERY(rel)}`, ...vars],
      dir
    ).data?.repository?.issue ?? undefined
  try {
    return run(true)
  } catch (err) {
    if (!isDriftError(err)) {
      throw err
    }
    return run(false)
  }
}

async function queryIssueAsync(dir: string, n: number): Promise<IssueNode | undefined> {
  const { o, r } = splitRepo(await repoOfAsync(dir))
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`]
  const run = async (rel: boolean) =>
    (await ghJsonAsync<{ data?: { repository?: { issue?: IssueNode | null } } }>(
      ['api', 'graphql', '-f', `query=${ISSUE_QUERY(rel)}`, ...vars],
      dir
    )).data?.repository?.issue ?? undefined
  try {
    return await run(true)
  } catch (err) {
    if (!isDriftError(err)) {
      throw err
    }
    return run(false)
  }
}

function querySubIssuesSync(dir: string, n: number): IssueNode[] {
  const { o, r } = splitRepo(repoOf(dir))
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`]
  const run = (rel: boolean) =>
    ghJson<{ data?: { repository?: { issue?: { subIssues?: { nodes?: IssueNode[] } } | null } } }>(
      ['api', 'graphql', '-f', `query=${SUBISSUES_QUERY(rel)}`, ...vars],
      dir
    ).data?.repository?.issue?.subIssues?.nodes ?? []
  try {
    return run(true)
  } catch (err) {
    if (!isDriftError(err)) {
      throw err
    }
    return [] // GHES: declared absent
  }
}

async function querySubIssuesAsync(dir: string, n: number): Promise<IssueNode[]> {
  const { o, r } = splitRepo(await repoOfAsync(dir))
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`]
  const run = async (rel: boolean) =>
    (await ghJsonAsync<{ data?: { repository?: { issue?: { subIssues?: { nodes?: IssueNode[] } } | null } } }>(
      ['api', 'graphql', '-f', `query=${SUBISSUES_QUERY(rel)}`, ...vars],
      dir
    )).data?.repository?.issue?.subIssues?.nodes ?? []
  try {
    return await run(true)
  } catch (err) {
    if (!isDriftError(err)) {
      throw err
    }
    return [] // GHES: declared absent
  }
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

function statesFor(f: TaskFilter): string[] {
  if (f.all === true) {
    return ['OPEN', 'CLOSED']
  }
  return f.status === 'closed' ? ['CLOSED'] : ['OPEN']
}

/** Client-side filters still drop fetched rows — a query-level cap
 *  would truncate before labels/type/status get their say, hiding
 *  matches later in the page. Only a filter-free list may bound the
 *  fetch itself ('closed' maps 1:1 onto the state filter — nothing
 *  applyFilter could remove). */
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

// --- actor + mutation helpers -----------------------------------------------------

const actorCache = new Map<string, string>()

function ghActor(dir: string): string {
  let a = actorCache.get(dir)
  if (a === undefined) {
    a = ghJson<{ login?: string }>(['api', 'user'], dir).login ?? ''
    actorCache.set(dir, a)
  }
  return a
}

async function ghActorAsync(dir: string): Promise<string> {
  let a = actorCache.get(dir)
  if (a === undefined) {
    a = (await ghJsonAsync<{ login?: string }>(['api', 'user'], dir)).login ?? ''
    actorCache.set(dir, a)
  }
  return a
}

/** `gh label create --force` is idempotent — a create failure is fine
 *  (the label may exist; the later add reports the real error). */
function ensureLabel(dir: string, name: string): void {
  ghTry(['label', 'create', name, '--force', '--color', '8b949e', '--description', 'bro-managed'], dir)
}

/** Rebuild the body with a fresh metadata trailer — preserves any text
 *  the caller didn't touch. */
function withMeta(body: string | undefined, meta: Record<string, unknown>): string {
  const base = stripMeta(body)
  if (Object.keys(meta).length === 0) {
    return base
  }
  const trailer = `<!-- bro: ${JSON.stringify(meta)} -->`
  return base === '' ? trailer : `${base}\n\n${trailer}`
}

// --- deps ---------------------------------------------------------------------------

interface DepEdge {
  issue_id: string
  depends_on_id: string
  type: string
}

/** blockedBy → `type: 'blocks'` edges (X depends-on Y); parent/subIssue
 *  → `parent-child`. bd's dep-list shape is the contract. */
function depEdges(n: IssueNode, opts: { type?: string; direction?: string }): DepEdge[] {
  const out: DepEdge[] = []
  const id = String(n.number)
  if (opts.type === undefined || opts.type === 'blocks') {
    if (opts.direction === undefined || opts.direction === 'up') {
      for (const b of n.blockedBy?.nodes ?? []) {
        out.push({ issue_id: id, depends_on_id: String(b.number), type: 'blocks' })
      }
    }
    if (opts.direction === undefined || opts.direction === 'down') {
      for (const b of n.blocking?.nodes ?? []) {
        out.push({ issue_id: String(b.number), depends_on_id: id, type: 'blocks' })
      }
    }
  }
  if (opts.type === undefined || opts.type === 'parent-child') {
    if ((opts.direction === undefined || opts.direction === 'up') && n.parent) {
      out.push({ issue_id: id, depends_on_id: String(n.parent.number), type: 'parent-child' })
    }
    if (opts.direction === undefined || opts.direction === 'down') {
      for (const c of n.subIssues?.nodes ?? []) {
        out.push({ issue_id: String(c.number), depends_on_id: id, type: 'parent-child' })
      }
    }
  }
  return out
}

function depsSync(dir: string, ids: string[], opts: { type?: string; direction?: string }): DepEdge[] {
  const out: DepEdge[] = []
  for (const id of ids) {
    const n = queryIssueSync(dir, issueNumber(dir, id))
    if (n) {
      out.push(...depEdges(n, opts))
    }
  }
  return out
}

async function depsAsync(
  dir: string,
  ids: string[],
  opts: { type?: string; direction?: string }
): Promise<DepEdge[]> {
  const out: DepEdge[] = []
  for (const id of ids) {
    const n = await queryIssueAsync(dir, issueNumber(dir, id))
    if (n) {
      out.push(...depEdges(n, opts))
    }
  }
  return out
}

// --- sync mutations -----------------------------------------------------------------

/** link(from, to, 'blocks') — "from is blocked by to", bd dep
 *  semantics. 'parent-child' makes `from` a sub-issue of `to`. Other
 *  types have no GitHub analogue — thrown, never faked as comments. */
function linkSync(dir: string, from: string, to: string, type: string): void {
  if (type === 'blocks' || type === 'blocked-by') {
    const blocker = queryIssueSync(dir, issueNumber(dir, to))
    if (blocker?.databaseId === undefined) {
      throw new Error(`github tasks: cannot resolve ${to} to an issue id`)
    }
    gh(
      ['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${issueNumber(dir, from)}/dependencies/blocked_by`, '-f', `issue_id=${blocker.databaseId}`],
      dir
    )
    return
  }
  if (type === 'parent-child') {
    const child = queryIssueSync(dir, issueNumber(dir, from))
    if (child?.databaseId === undefined) {
      throw new Error(`github tasks: cannot resolve ${from} to an issue id`)
    }
    gh(
      ['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${issueNumber(dir, to)}/sub_issues`, '-f', `sub_issue_id=${child.databaseId}`],
      dir
    )
    return
  }
  throw new Error(`github tasks: link type '${type}' has no GitHub analogue (blocks | blocked-by | parent-child)`)
}

/** claim = addAssignees(me) → verify → bro:claimed label. The label is
 *  the commit flag: it lands only after the assignee verified. A
 *  contested assignee set resolves to the lowest login — the loser
 *  unassigns and throws. */
function claimSync(dir: string, id: string): void {
  const n = queryIssueSync(dir, issueNumber(dir, id))
  if (n === undefined) {
    throw new Error(`github tasks: issue ${id} not found`)
  }
  if (n.state !== 'OPEN') {
    throw new Error(`github tasks: ${id} is ${n.state.toLowerCase()} — only open issues are claimable`)
  }
  const labels = labelsOf(n)
  const assignees = assigneesOf(n)
  if (labels.includes(CLAIMED_LABEL) || assignees.length > 0) {
    throw new Error(
      `github tasks: ${id} already claimed${assignees.length > 0 ? ` by ${assignees.join(', ')}` : ''}`
    )
  }
  const me = ghActor(dir)
  if (me === '') {
    throw new Error('github tasks: claim needs a gh identity — `gh api user` returned no login')
  }
  ensureLabel(dir, CLAIMED_LABEL)
  gh(['issue', 'edit', String(n.number), '--add-assignee', me], dir)
  const check = assigneesOf(queryIssueSync(dir, n.number) ?? n)
  const others = check.filter((a) => a !== me)
  if (others.length === 0) {
    gh(['issue', 'edit', String(n.number), '--add-label', CLAIMED_LABEL], dir)
    return
  }
  const winner = [...others, me].sort()[0]!
  if (winner !== me) {
    ghTry(['issue', 'edit', String(n.number), '--remove-assignee', me], dir)
    throw new Error(`github tasks: ${id} claim contested — ${winner} holds it`)
  }
  // winner path: the loser removes itself asynchronously; label now.
  gh(['issue', 'edit', String(n.number), '--add-label', CLAIMED_LABEL], dir)
}

function reopenSync(dir: string, id: string): void {
  const n = issueNumber(dir, id)
  // `gh issue reopen` errors on an already-open issue — and most
  // reopens ARE already open (an un-claim on a claimed issue). Only a
  // closed state needs the verb; the marker release runs either way.
  const cur = queryIssueSync(dir, n)
  if (cur?.state !== 'OPEN') {
    gh(['issue', 'reopen', String(n)], dir)
  }
  // release every claim marker — the pre-read names all assignees, not
  // just ours: a claim held by a crashed worker or a rival would
  // otherwise keep the issue in_progress forever, never re-queuing.
  // The blocked marker goes too — reopen means "back to the queue", and
  // real blockers (open deps/sub-issues) still hold via isBlocked.
  // Best-effort: the reopen already landed, a stale marker is cosmetic.
  for (const a of cur === undefined ? [] : assigneesOf(cur)) {
    ghTry(['issue', 'edit', String(n), '--remove-assignee', a], dir)
  }
  ghTry(['issue', 'edit', String(n), '--remove-label', CLAIMED_LABEL], dir)
  ghTry(['issue', 'edit', String(n), '--remove-label', BLOCKED_LABEL], dir)
}

function createSync(dir: string, i: TaskInput): TaskRow {
  // pre-validate deps before the issue exists — an unsupported dep type
  // must not leave a half-created issue
  for (const d of i.deps ?? []) {
    const kind = d.slice(0, d.indexOf(':'))
    if (!/^(blocks|blocked-by|parent-child)$/.test(kind)) {
      throw new Error(`github tasks: dep type '${kind}' unsupported (blocks | blocked-by | parent-child)`)
    }
  }
  const args = ['issue', 'create', '--title', i.title]
  // every trailer-carried field must trip the guard — a lone `priority`
  // or `externalRef` otherwise writes no body and reads back a default
  if (i.description || i.metadata || i.type !== undefined || i.priority !== undefined || i.externalRef !== undefined) {
    const meta: Record<string, unknown> = { ...(i.metadata ?? {}) }
    if (i.type !== undefined) {
      meta.type = i.type
    }
    if (i.priority !== undefined) {
      meta.priority = i.priority
    }
    if (i.externalRef !== undefined) {
      meta.external_ref = i.externalRef
    }
    args.push('--body', withMeta(i.description, meta))
  }
  for (const l of i.labels ?? []) {
    ensureLabel(dir, l)
    args.push('--label', l)
  }
  const url = gh(args, dir).trim()
  const num = /(\d+)\s*$/.exec(url)?.[1]
  if (num === undefined) {
    throw new Error(`github tasks: gh issue create returned no issue URL — got: ${url}`)
  }
  const id = String(Number(num))
  if (i.parent !== undefined) {
    linkSync(dir, id, i.parent, 'parent-child')
  }
  for (const d of i.deps ?? []) {
    // 'kind:ref' — refs may be issue URLs carrying their own colons,
    // so split on the FIRST colon only
    const colon = d.indexOf(':')
    const kind = d.slice(0, colon)
    const ref = d.slice(colon + 1)
    linkSync(dir, id, ref, kind === 'blocked-by' ? 'blocks' : kind)
  }
  const row = queryIssueSync(dir, Number(id))
  if (row === undefined) {
    // the issue exists (the URL proved it) — a read miss is the
    // backend's problem, not a reason to fake a row
    throw new Error(`github tasks: created issue ${id} but could not read it back`)
  }
  return toRow(row)
}

function updateSync(dir: string, id: string, patch: Record<string, string | number>): void {
  const n = issueNumber(dir, id)
  for (const [k, v] of Object.entries(patch)) {
    const val = String(v)
    switch (k) {
      case 'title':
        gh(['issue', 'edit', String(n), '--title', val], dir)
        break
      case 'body':
      case 'description': {
        const cur = queryIssueSync(dir, n)
        gh(['issue', 'edit', String(n), '--body', withMeta(val, bodyMeta(cur?.body))], dir)
        break
      }
      case 'status':
        if (val === 'open') {
          reopenSync(dir, id)
        } else if (val === 'closed') {
          gh(['issue', 'close', String(n)], dir)
        } else if (val === 'in_progress') {
          claimSync(dir, id)
        } else if (val === 'blocked') {
          ensureLabel(dir, BLOCKED_LABEL)
          gh(['issue', 'edit', String(n), '--add-label', BLOCKED_LABEL], dir)
        } else {
          throw new Error(`github tasks: unknown status '${val}'`)
        }
        break
      case 'claim':
        if (v === 'true' || val === 'true') {
          claimSync(dir, id)
        }
        break
      case 'labels':
      case 'label':
        for (const l of val.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
          ensureLabel(dir, l)
          gh(['issue', 'edit', String(n), '--add-label', l], dir)
        }
        break
      case 'assignee':
        gh(['issue', 'edit', String(n), '--add-assignee', val], dir)
        break
      case 'notes':
      case 'note':
        gh(['issue', 'comment', String(n), '--body', val], dir)
        break
      case 'type':
      case 'issue_type':
      case 'priority':
      case 'external_ref':
      case 'externalRef': {
        const cur = queryIssueSync(dir, n)
        const meta = bodyMeta(cur?.body)
        meta[k === 'issue_type' ? 'type' : k === 'externalRef' ? 'external_ref' : k] =
          k === 'priority' ? Number(val) : val
        gh(['issue', 'edit', String(n), '--body', withMeta(cur?.body, meta)], dir)
        break
      }
      default:
        throw new Error(`github tasks: unsupported update key '${k}'`)
    }
  }
}

function removeSync(dir: string, id: string): void {
  const n = queryIssueSync(dir, issueNumber(dir, id))
  if (n === undefined) {
    throw new Error(`github tasks: issue ${id} not found`)
  }
  ghJson(
    [
      'api',
      'graphql',
      '-f',
      'query=mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}',
      '-f',
      `id=${n.id}`,
    ],
    dir
  )
}

// --- the stores -------------------------------------------------------------------

function rowOrUndef(n: IssueNode | undefined): TaskRow | undefined {
  return n === undefined ? undefined : pub(toRow(n))
}

export function githubTasks(dir: string): TaskStore {
  return {
    list: (f = {}) => applyFilter(queryIssuesSync(dir, statesFor(f), fetchCap(f)).map(toRow).map(pub), f) as never,
    // applyFilter must not slice here — the limit lands AFTER the
    // priority sort in readyOf, or high-priority issues late in the
    // creation-ordered page get truncated away
    ready: (f = {}) =>
      readyOf(
        applyFilter(
          queryIssuesSync(dir, ['OPEN'], QUERY_CAP).map(toRow).map(pub),
          { ...f, status: 'open', limit: undefined }
        ),
        f
      ) as never,
    get: (id) => rowOrUndef(queryIssueSync(dir, issueNumber(dir, id))) as never,
    create: (i) => pub(createSync(dir, i)) as never,
    update: (id, patch) => updateSync(dir, id, patch),
    claim: (id) => claimSync(dir, id),
    actor: () => ghActor(dir),
    reopen: (id) => reopenSync(dir, id),
    close: (id, reason) => {
      gh(['issue', 'close', String(issueNumber(dir, id)), ...(reason ? ['--comment', reason] : [])], dir)
    },
    remove: (id) => removeSync(dir, id),
    note: (id, text) => {
      gh(['issue', 'comment', String(issueNumber(dir, id)), '--body', text], dir)
    },
    children: (id) => querySubIssuesSync(dir, issueNumber(dir, id)).map(toRow).map(pub) as never,
    deps: (ids, opts = {}) => depsSync(dir, ids, opts) as never,
    link: (from, to, type = 'related') => linkSync(dir, from, to, type),
    prefix: () => {
      // the repo IS the scope — no prefix. The probe still runs: an
      // unresolvable remote fails closed, same contract as beads.
      resolveRepo([], dir)
      return undefined
    },
  }
}

export function githubTasksAsync(dir: string): TaskStoreAsync {
  return {
    list: async (f = {}) =>
      applyFilter((await queryIssuesAsync(dir, statesFor(f), fetchCap(f))).map(toRow).map(pub), f),
    ready: async (f = {}) =>
      readyOf(
        applyFilter((await queryIssuesAsync(dir, ['OPEN'], QUERY_CAP)).map(toRow).map(pub), {
          ...f,
          status: 'open',
          limit: undefined,
        }),
        f
      ),
    get: async (id) => rowOrUndef(await queryIssueAsync(dir, issueNumber(dir, id))) as never,
    children: async (id) => (await querySubIssuesAsync(dir, issueNumber(dir, id))).map(toRow).map(pub) as never,
    deps: async (ids, opts = {}) => (await depsAsync(dir, ids, opts)) as never,
    actor: () => ghActorAsync(dir),
  }
}

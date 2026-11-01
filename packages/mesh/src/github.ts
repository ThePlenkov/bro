/**
 * github-issue transport — the no-checkout plane
 * (specs/cross-repo/bro-kim1e). The issue body is human prose; every
 * mesh record is a fenced ```json block in a COMMENT — the only
 * append-only authenticated surface GitHub offers a pull-only reader.
 * Provenance is the authenticated comment author, compared against the
 * peer binding's `login`; the advisory `from` is never trusted.
 *
 * Labels are a query index only — GitHub caps names at 50 chars, and
 * an overlong candidate drops, never truncates (a truncated
 * `mesh:to:` is a different string that matches nothing). Delivery
 * posts via `gh api` REST because the `labels[]` field auto-creates
 * missing labels — `gh issue create --label` hard-fails on a repo
 * that has never carried a mesh issue.
 */
import { spawnSync } from 'node:child_process'
import { envelopeLabels, priorityTerm, toEnvelope, validateEnvelope, MESH_VERSION, type MeshEnvelope, type MeshRef } from './envelope.ts'

export const GITHUB_LABEL_MAX = 50

export interface GithubRepo {
  owner: string
  repo: string
}

/** remote → {owner, repo} when it names a github.com repository —
 *  https/ssh/git@ forms, `.git` suffix and trailing slash tolerated.
 *  Other hosts and non-URL remotes return null: the caller reports
 *  the gap, never guesses. */
export function parseGithubRemote(input: { remote: string }): GithubRepo | null {
  let rest = input.remote.trim()
  while (rest.endsWith('/')) {
    rest = rest.slice(0, -1)
  }
  if (rest.endsWith('.git')) {
    rest = rest.slice(0, -'.git'.length)
  }
  const hp = splitHostPath({ rest })
  if (hp === null || hp.host !== 'github.com') {
    return null
  }
  const parts = hp.path.split('/').filter((p) => p !== '')
  return parts.length === 2
    ? { owner: parts[0].toLowerCase(), repo: parts[1].toLowerCase() }
    : null
}

/** url-shaped and git@ remotes → {host, path}; everything else null.
 *  String ops only — an uncontrolled-input regex here is a ReDoS
 *  surface the scanners flag. */
function splitHostPath(input: { rest: string }): { host: string; path: string } | null {
  return input.rest.startsWith('git@') ? scpHostPath(input) : urlHostPath(input)
}

/** `scheme://` → the tail after it — http(s) and ssh only. */
function schemeTail(input: { rest: string }): string | null {
  const sep = input.rest.indexOf('://')
  const scheme = sep === -1 ? '' : input.rest.slice(0, sep)
  return ['http', 'https', 'ssh'].includes(scheme) ? input.rest.slice(sep + '://'.length) : null
}

/** an @ is userinfo only before the first slash — inside the path
 *  it's just a character. */
function stripUserInfo(input: { after: string }): string {
  const at = input.after.indexOf('@')
  const slash = input.after.indexOf('/')
  return at !== -1 && at < slash ? input.after.slice(at + 1) : input.after
}

/** `host[:port]` + path → the pair; the port splits off here, not on
 *  the caller's slice. */
function hostPathOf(input: { after: string }): { host: string; path: string } | null {
  const hostPath = stripUserInfo(input)
  const slash = hostPath.indexOf('/')
  if (slash === -1) {
    return null
  }
  const hostPort = hostPath.slice(0, slash)
  const port = hostPort.indexOf(':')
  return {
    host: (port === -1 ? hostPort : hostPort.slice(0, port)).toLowerCase(),
    path: hostPath.slice(slash + 1),
  }
}

/** `scheme://[userinfo@]host[:port]/path` — http(s) and ssh url forms. */
function urlHostPath(input: { rest: string }): { host: string; path: string } | null {
  const after = schemeTail(input)
  if (after === null || after.indexOf('/') === -1) {
    return null
  }
  return hostPathOf({ after })
}

/** `git@host:path` — the scp-like form. */
function scpHostPath(input: { rest: string }): { host: string; path: string } | null {
  const after = input.rest.slice('git@'.length)
  const colon = after.indexOf(':')
  const slash = after.indexOf('/')
  return colon > 0 && slash > colon
    ? { host: after.slice(0, colon).toLowerCase(), path: after.slice(colon + 1) }
    : null
}

/** A github thread's issue coordinate — the thread IS the issue url;
 *  repo from the remote parse (tail stripped), number from the tail.
 *  Callers that only need the repo can pass a bare repo url — `n`
 *  comes back null. */
export function issueKey(input: { thread: string }): { repo: GithubRepo | null; n: number | null } {
  const t = input.thread.trim()
  const m = /\/issues\/(\d+)$/.exec(t)
  return {
    repo: parseGithubRemote({ remote: t.replace(/\/issues\/\d+$/, '') }),
    n: m === null ? null : Number(m[1]),
  }
}

export interface GhResult {
  code: number
  out: string
  err: string
}

function gh(call: { args: string[]; input?: string }): GhResult {
  const p = spawnSync('gh', call.args, { // NOSONAR — PATH lookup is the contract (same as pull.ts's dolt)
    stdio: [call.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input: call.input,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  // spawnSync's types swear stdout/stderr are strings; on a spawn
  // error they are null at runtime — widen through unknown so the
  // guard is a real check in both worlds
  const stdout: unknown = p.stdout
  const stderr: unknown = p.stderr
  const err = (p.error !== undefined ? p.error.message : typeof stderr === 'string' ? stderr : '').trim()
  return {
    code: p.status ?? 1,
    out: typeof stdout === 'string' ? stdout : '',
    err: p.error !== undefined ? `gh unreachable — ${err || 'binary not found'}` : err,
  }
}

function ghJson<T>(call: { args: string[]; input?: string }): { data?: T; error?: string } {
  const r = gh(call)
  if (r.code !== 0) {
    return { error: r.err || r.out }
  }
  try {
    return { data: JSON.parse(r.out) as T }
  } catch {
    return { error: `gh api returned unparseable json` }
  }
}

/** The caller's authenticated github account — the `self` side of the
 *  author check. Absent when gh is missing or unauthenticated. */
export function selfLogin(): { login?: string; error?: string } {
  const r = ghJson<{ login?: string }>({ args: ['api', 'user'] })
  if (r.error !== undefined) {
    return { error: r.error }
  }
  return typeof r.data?.login === 'string' && r.data.login !== ''
    ? { login: r.data.login }
    : { error: 'gh api user returned no login' }
}

/** The label set that rides the issue — a QUERY INDEX, never the
 *  record. `mesh:thread:` is excluded (the thread is the issue url,
 *  unknowable before the POST and past the 50-char budget anyway);
 *  anything else over the cap drops whole. */
export function routingLabels(env: MeshEnvelope): string[] {
  return envelopeLabels(env).filter(
    (l) => l.length <= GITHUB_LABEL_MAX && !l.startsWith('mesh:thread:'),
  )
}

/** Prose for humans — what is wanted, from which rig, and where the
 *  record lives. Deliberately NO machine block: a body is editable by
 *  anyone with write access and a pull-only reader cannot authenticate
 *  the editor (no REST field names one; `issues.edited` is repo-side),
 *  so the record must not live where it can be silently rewritten. */
export function renderIssueBody(input: { from: string; to: string; body?: string }): string {
  return [
    input.body?.trim() || '(no description)',
    '',
    '---',
    `mesh/1 work request from \`${input.from}\` — the machine record is`,
    'the first comment on this issue; claim / result / accept / reject',
    'arrive as further fenced comments.',
  ].join('\n')
}

export function renderComment(env: MeshEnvelope): string {
  // a literal backtick-fence inside a string field would close the
  //  fence early — the JSON unicode escape restores it on parse
  return '```json\n' + JSON.stringify(env).replace(/`/g, '\\u0060') + '\n```'
}

/** fenced ```json block bodies, in document order — indexOf scanning,
 *  not a regex: the fence pattern on uncontrolled comment text is a
 *  polynomial-backtracking surface (CodeQL). A fence is ```json,
 *  whitespace up to the newline, payload to the next ```. */
function* fencedJsonBodies(comment: { body: string }): Generator<string> {
  const body = comment.body
  let i = 0
  for (;;) {
    const open = body.indexOf('```json', i)
    if (open === -1) {
      return
    }
    const after = open + '```json'.length
    const eol = body.indexOf('\n', after)
    if (eol === -1) {
      return
    }
    if (body.slice(after, eol).trim() !== '') {
      // ```json <junk> — not a record fence; keep scanning past it
      i = after
      continue
    }
    const close = body.indexOf('```', eol + 1)
    if (close === -1) {
      return
    }
    yield body.slice(eol + 1, close)
    i = close + '```'.length
  }
}

/** The LAST fenced ```json block that satisfies validateEnvelope — a
 *  comment is a shared editable document: authors append checklists,
 *  bots inject footers, GitHub adds cross-reference lines below, so
 *  the read never anchors on offsets. A comment with no qualifying
 *  block is not a mesh record — surfaced as an error line. */
export function parseComment(comment: { body: string }): { envelope?: MeshEnvelope; error?: string } {
  let last: MeshEnvelope | undefined
  for (const b of fencedJsonBodies(comment)) {
    let raw: unknown
    try {
      raw = JSON.parse(b)
    } catch {
      continue
    }
    if (validateEnvelope(raw).length === 0) {
      const env = toEnvelope(raw)
      if (env !== null) {
        last = env
      }
    }
  }
  return last === undefined
    ? { error: 'comment carries no valid mesh/1 record block' }
    : { envelope: last }
}

/** One authenticated comment → the record it carries. */
export interface GhRecord {
  /** the issue url — the thread anchor on this plane */
  issue: string
  /** the authenticated github login — the provenance */
  author: string
  envelope: MeshEnvelope
}

/** The html url is deterministic — the api's `html_url` field is never
 *  read: a value named `*html*` taints every sink it flows into for
 *  the unsanitized-HTML scanners, and `api.github.com` urls are not
 *  thread anchors anyway. */
function issueUrl(key: { repo: GithubRepo; n: number }): string {
  return `https://github.com/${key.repo.owner}/${key.repo.repo}/issues/${key.n}`
}

interface GhIssue {
  number: number
}

/** the wire shape BEFORE the row is verified — fields optional so the
 *  runtime guard is a real check, not a type assertion */
interface GhIssueRow {
  number?: number
}

function apiPath(call: { repo: GithubRepo; suffix: string }): string {
  return `repos/${call.repo.owner}/${call.repo.repo}/${call.suffix}`
}

/** Issues carrying the request label — the label is an index, so a
 *  miss means "no mesh traffic", not a crash; the API failure is the
 *  error line. `--paginate --slurp` wraps every page in its own array
 *  — the wire shape is pages-of-rows, so the read flattens before
 *  iterating. */
function listIssues(repo: GithubRepo): { issues: GhIssue[]; error?: string } {
  const r = ghJson<(GhIssueRow | GhIssueRow[])[]>({
    args: [
      'api',
      `${apiPath({ repo, suffix: 'issues' })}?labels=mesh:kind:request&state=all&per_page=100`,
      '--paginate',
      '--slurp',
    ],
  })
  if (r.error !== undefined) {
    return { issues: [], error: `${repo.owner}/${repo.repo}: issue list failed — ${r.error}` }
  }
  return {
    issues: filterIssueRows(slurpedRows(r.data)),
  }
}

interface GhCommentRow {
  user?: { login?: string }
  body?: string
}

/** Every envelope-bearing comment on one issue — comments that parse
 *  to nothing are error lines (a comment is not a record unless the
 *  last validating block says so). */
function collectIssueCommentRecords(
  repo: GithubRepo,
  issue: GhIssue,
  comments: GhCommentRow[],
): { records: GhRecord[]; errors: string[] } {
  const records: GhRecord[] = []
  const errors: string[] = []
  for (const c of comments) {
    const text = typeof c.body === 'string' ? c.body : ''
    if (!text.includes('```json')) {
      continue
    }
    const parsed = parseComment({ body: text })
    if (parsed.error !== undefined || parsed.envelope === undefined) {
      errors.push(`${repo.owner}/${repo.repo}#${issue.number}: ${parsed.error ?? 'no record'} (comment skipped)`)
      continue
    }
    records.push({
      issue: issueUrl({ repo, n: issue.number }),
      author: c.user?.login ?? '',
      envelope: parsed.envelope,
    })
  }
  return { records, errors }
}

function slurpedRows<T>(data: (T | T[])[] | undefined): T[] {
  const out: T[] = []
  for (const item of data ?? []) {
    if (Array.isArray(item)) {
      out.push(...(item as T[]))
    } else {
      out.push(item)
    }
  }
  return out
}

function filterIssueRows(rows: GhIssueRow[]): GhIssue[] {
  return rows.filter((i): i is GhIssue => typeof i === 'object' && typeof i.number === 'number')
}

export function issueComments(repo: GithubRepo, issue: GhIssue): { records: GhRecord[]; errors: string[] } {
  const r = ghJson<(GhCommentRow | GhCommentRow[])[]>({
    args: ['api', apiPath({ repo, suffix: `issues/${issue.number}/comments` }), '--paginate', '--slurp'],
  })
  if (r.error !== undefined) {
    return { records: [], errors: [`${repo.owner}/${repo.repo}#${issue.number}: comments failed — ${r.error}`] }
  }
  return collectIssueCommentRecords(repo, issue, slurpedRows(r.data))
}

function scanIssues(repo: GithubRepo, issues: GhIssue[]): { records: GhRecord[]; errors: string[] } {
  const records: GhRecord[] = []
  const errors: string[] = []
  for (const issue of issues) {
    const cs = issueComments(repo, issue)
    records.push(...cs.records)
    errors.push(...cs.errors)
  }
  return { records, errors }
}

/** The label-narrowed, comment-verified scan: every mesh record across
 *  every request-labelled issue on the peer's repo. */
export function scanGithub(input: { remote: string }): { records: GhRecord[]; errors: string[] } {
  const repo = parseGithubRemote(input)
  if (repo === null) {
    return { records: [], errors: [`remote "${input.remote}" is not a github url`] }
  }
  const listed = listIssues(repo)
  if (listed.error !== undefined) {
    return { records: [], errors: [listed.error] }
  }
  return scanIssues(repo, listed.issues)
}

/** The wire envelope for a posted request — id/thread are filled by
 *  the caller once the issue url exists. */
function requestEnvelope(input: {
  from: string
  to: string
  title: string
  body?: string
  refs?: MeshRef[]
  priority?: number
}): MeshEnvelope {
  return {
    v: MESH_VERSION,
    id: '',
    kind: 'request',
    thread: '',
    from: input.from,
    to: input.to,
    title: input.title,
    body: input.body ?? '',
    refs: input.refs ?? [],
    // out-of-band input clamps into the p0–p4 vocabulary — an
    // unclamped p9 fails validation on the receiving side
    terms: input.priority === undefined ? {} : { priority: priorityTerm(input.priority) },
    evidence: [],
  }
}

/** POST the prose issue; REST `labels[]` (not `gh issue create
 *  --label`) because the API creates missing labels on first use and
 *  a repo that never carried mesh labels must not fail its first
 *  delivery. */
function createIssue(call: {
  repo: GithubRepo
  input: { title: string; from: string; to: string; body?: string }
  labels: string[]
}): { issue?: string; number?: number; error?: string } {
  const created = ghJson<{ number?: number }>({
    args: ['api', apiPath({ repo: call.repo, suffix: 'issues' }), '--input', '-'],
    input: JSON.stringify({
      title: call.input.title,
      body: renderIssueBody(call.input),
      labels: call.labels,
    }),
  })
  if (created.error !== undefined) {
    return { error: `${call.repo.owner}/${call.repo.repo}: issue create failed — ${created.error}` }
  }
  const number = created.data?.number
  return typeof number === 'number'
    ? { issue: issueUrl({ repo: call.repo, n: number }), number }
    : { error: `${call.repo.owner}/${call.repo.repo}: issue create returned no number` }
}

/** Delivery: POST the prose issue, then POST the `request` record as
 *  the first comment — id = thread = the issue url, so every later
 *  lifecycle comment threads to it. */
export function postRequest(
  input: { remote: string; from: string; to: string; title: string; body?: string; refs?: MeshRef[]; priority?: number },
): { issue?: string; error?: string } {
  const repo = parseGithubRemote({ remote: input.remote })
  if (repo === null) {
    return { error: `remote "${input.remote}" is not a github url` }
  }
  const env = requestEnvelope(input)
  const created = createIssue({ repo, input, labels: routingLabels(env) })
  if (created.error !== undefined) {
    return { error: created.error }
  }
  if (created.issue === undefined || created.number === undefined) {
    return { error: `${repo.owner}/${repo.repo}: issue create returned no number` }
  }
  const env2 = { ...env, id: created.issue, thread: created.issue }
  const commented = ghJson<{ id?: number }>({
    args: ['api', apiPath({ repo, suffix: `issues/${created.number}/comments` }), '--input', '-'],
    input: JSON.stringify({ body: renderComment(env2) }),
  })
  if (commented.error !== undefined) {
    return { error: `issue ${created.issue} created but the record comment failed — ${commented.error}` }
  }
  return { issue: created.issue }
}

/** The provenance verdict for one github record — the authenticated
 *  comment AUTHOR checked against the bound peer's `login` (a peer
 *  found by login on the own-repo plane arrives as `peer` too) and
 *  this account. A binding with no `login` admits nothing and says
 *  so — never a fallback to the advisory `from`. The error is a
 *  reason string; the caller prefixes peer + record id. */
export function githubProvenance(rec: {
  author: string
  peer: { rig: string; login?: string } | undefined
  selfLogin: string | undefined
  ownRig: string | null
}): { provenance?: string; error?: string } {
  if (rec.peer !== undefined) {
    if (rec.peer.login === undefined) {
      return { error: `github binding has no login — records on this plane can't be authenticated` }
    }
    if (rec.author.toLowerCase() === rec.peer.login.toLowerCase()) {
      return { provenance: rec.peer.rig }
    }
  }
  if (rec.selfLogin !== undefined && rec.author.toLowerCase() === rec.selfLogin.toLowerCase()) {
    return rec.ownRig === null
      ? { error: `own record, but this rig's identity doesn't resolve` }
      : { provenance: rec.ownRig }
  }
  return {
    error: `comment author ${rec.author === '' ? 'unknown' : rec.author} is neither ${
      rec.peer === undefined ? 'a bound login' : `peer login ${rec.peer.login}`
    } nor this account`,
  }
}

/** A lifecycle record lands as another comment on the issue — the
 *  envelope's own id is `thread#kind` (one per kind per thread by
 *  lifecycle construction: a second claim is a stage error anyway). */
export function postComment(comment: { thread: string; env: MeshEnvelope }): { error?: string } {
  const key = issueKey({ thread: comment.thread })
  if (key.repo === null || key.n === null) {
    return { error: `thread "${comment.thread}" is not a github issue url` }
  }
  const repo = key.repo
  const n = key.n
  const r = ghJson<{ id?: number }>({
    args: ['api', apiPath({ repo, suffix: `issues/${n}/comments` }), '--input', '-'],
    input: JSON.stringify({ body: renderComment(comment.env) }),
  })
  if (r.error !== undefined) {
    return { error: `${repo.owner}/${repo.repo}#${n}: comment failed — ${r.error}` }
  }
  return {}
}

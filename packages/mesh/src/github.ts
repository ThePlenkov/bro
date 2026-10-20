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
import { envelopeLabels, toEnvelope, validateEnvelope, MESH_VERSION, type MeshEnvelope, type MeshRef } from './envelope.ts'

export const GITHUB_LABEL_MAX = 50

export interface GithubRepo {
  owner: string
  repo: string
}

/** remote → {owner, repo} when it names a github.com repository —
 *  https/ssh/git@ forms, `.git` suffix and trailing slash tolerated.
 *  Other hosts and non-URL remotes return null: the caller reports
 *  the gap, never guesses. */
export function parseGithubRemote(remote: string): GithubRepo | null {
  let rest = remote.trim()
  while (rest.endsWith('/')) {
    rest = rest.slice(0, -1)
  }
  if (rest.endsWith('.git')) {
    rest = rest.slice(0, -'.git'.length)
  }
  let host: string
  if (/^https?:\/\//.test(rest) || rest.startsWith('ssh://')) {
    const m = /^[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(rest)
    if (m === null) {
      return null
    }
    host = m[1]!
    rest = m[2]!
  } else if (rest.startsWith('git@')) {
    const m = /^git@([^:]+):(.+)$/.exec(rest)
    if (m === null) {
      return null
    }
    host = m[1]!
    rest = m[2]!
  } else {
    return null
  }
  if (host.toLowerCase() !== 'github.com') {
    return null
  }
  const parts = rest.split('/').filter((p) => p !== '')
  return parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined
    ? { owner: parts[0].toLowerCase(), repo: parts[1].toLowerCase() }
    : null
}

/** A github thread's repo — the thread IS the issue url; strip the
 *  `/issues/<n>` tail before the remote parse. */
export function issueRepo(thread: string): GithubRepo | null {
  return parseGithubRemote(thread.trim().replace(/\/issues\/\d+$/, ''))
}

export function issueNumber(thread: string): string | null {
  const m = /\/issues\/(\d+)$/.exec(thread.trim())
  return m === null ? null : m[1]!
}

export interface GhResult {
  code: number
  out: string
  err: string
}

function gh(args: string[], input?: string): GhResult {
  const p = spawnSync('gh', args, { // NOSONAR — PATH lookup is the contract (same as pull.ts's dolt)
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const err = (p.stderr ?? p.error?.message ?? '').trim()
  return {
    code: p.status ?? 1,
    out: p.stdout ?? '',
    err: p.error !== undefined ? `gh unreachable — ${err || 'binary not found'}` : err,
  }
}

function ghJson<T>(args: string[], input?: string): { data?: T; error?: string } {
  const r = gh(args, input)
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
  const r = ghJson<{ login?: string }>(['api', 'user'])
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
  return '```json\n' + JSON.stringify(env) + '\n```'
}

const JSON_FENCE = /```json\s*\n([\s\S]*?)```/g

/** The LAST fenced ```json block that satisfies validateEnvelope — a
 *  comment is a shared editable document: authors append checklists,
 *  bots inject footers, GitHub adds cross-reference lines below, so
 *  the read never anchors on offsets. A comment with no qualifying
 *  block is not a mesh record — surfaced as an error line. */
export function parseComment(body: string): { envelope?: MeshEnvelope; error?: string } {
  const blocks = [...body.matchAll(JSON_FENCE)]
  for (const b of blocks.reverse()) {
    let raw: unknown
    try {
      raw = JSON.parse(b[1]!)
    } catch {
      continue
    }
    if (validateEnvelope(raw).length === 0) {
      const env = toEnvelope(raw)
      if (env !== null) {
        return { envelope: env }
      }
    }
  }
  return { error: 'comment carries no valid mesh/1 record block' }
}

/** One authenticated comment → the record it carries. */
export interface GhRecord {
  /** the issue url — the thread anchor on this plane */
  issue: string
  /** the comment's own url — a stable record id */
  url: string
  /** the authenticated github login — the provenance */
  author: string
  envelope: MeshEnvelope
}

interface GhIssue {
  number: number
  /** the html url — the thread anchor; `url` is the api host, which
   *  neither `issueRepo` nor a human-facing thread id can use */
  html_url: string
}

function apiPath(repo: GithubRepo, suffix: string): string {
  return `repos/${repo.owner}/${repo.repo}/${suffix}`
}

/** Issues carrying the request label — the label is an index, so a
 *  miss means "no mesh traffic", not a crash; the API failure is the
 *  error line. */
function listIssues(repo: GithubRepo): { issues: GhIssue[]; error?: string } {
  const r = ghJson<GhIssue[]>(
    [
      'api',
      `${apiPath(repo, 'issues')}?labels=mesh:kind:request&state=all&per_page=100`,
      '--paginate',
      '--slurp',
    ],
  )
  if (r.error !== undefined) {
    return { issues: [], error: `${repo.owner}/${repo.repo}: issue list failed — ${r.error}` }
  }
  return { issues: (r.data ?? []).filter((i) => typeof i.number === 'number' && typeof i.html_url === 'string') }
}

/** Every envelope-bearing comment on one issue — comments that parse
 *  to nothing are error lines (a comment is not a record unless the
 *  last validating block says so). */
export function issueComments(repo: GithubRepo, issue: GhIssue): { records: GhRecord[]; errors: string[] } {
  const r = ghJson<{ html_url?: string; user?: { login?: string }; body?: string }[]>(
    ['api', apiPath(repo, `issues/${issue.number}/comments`), '--paginate', '--slurp'],
  )
  if (r.error !== undefined) {
    return { records: [], errors: [`${repo.owner}/${repo.repo}#${issue.number}: comments failed — ${r.error}`] }
  }
  const records: GhRecord[] = []
  const errors: string[] = []
  for (const c of r.data ?? []) {
    const parsed = parseComment(typeof c.body === 'string' ? c.body : '')
    if (parsed.error !== undefined) {
      errors.push(`${repo.owner}/${repo.repo}#${issue.number}: ${parsed.error} (${c.html_url ?? 'comment'})`)
      continue
    }
    records.push({
      issue: issue.html_url,
      url: c.html_url ?? '',
      author: c.user?.login ?? '',
      envelope: parsed.envelope!,
    })
  }
  return { records, errors }
}

/** The label-narrowed, comment-verified scan: every mesh record across
 *  every request-labelled issue on the peer's repo. */
export function scanGithub(remote: string): { records: GhRecord[]; errors: string[] } {
  const repo = parseGithubRemote(remote)
  if (repo === null) {
    return { records: [], errors: [`remote "${remote}" is not a github url`] }
  }
  const listed = listIssues(repo)
  if (listed.error !== undefined) {
    return { records: [], errors: [listed.error] }
  }
  const records: GhRecord[] = []
  const errors: string[] = []
  for (const issue of listed.issues) {
    const cs = issueComments(repo, issue)
    records.push(...cs.records)
    errors.push(...cs.errors)
  }
  return { records, errors }
}

/** Delivery: POST the prose issue, then POST the `request` record as
 *  the first comment — id = thread = the issue url, so every later
 *  lifecycle comment threads to it. REST `labels[]` (not `gh issue
 *  create --label`) because the API creates missing labels on first
 *  use and a repo that never carried mesh labels must not fail its
 *  first delivery. */
export function postRequest(
  remote: string,
  input: { from: string; to: string; title: string; body?: string; refs?: MeshRef[]; priority?: number },
): { issue?: string; error?: string } {
  const repo = parseGithubRemote(remote)
  if (repo === null) {
    return { error: `remote "${remote}" is not a github url` }
  }
  const env: MeshEnvelope = {
    v: MESH_VERSION,
    id: '',
    kind: 'request',
    thread: '',
    from: input.from,
    to: input.to,
    title: input.title,
    body: input.body ?? '',
    refs: input.refs ?? [],
    terms: input.priority === undefined ? {} : { priority: `p${input.priority}` },
    evidence: [],
  }
  const created = ghJson<{ number?: number; html_url?: string }>(
    ['api', apiPath(repo, 'issues'), '--input', '-'],
    JSON.stringify({
      title: input.title,
      body: renderIssueBody(input),
      labels: routingLabels(env),
    }),
  )
  if (created.error !== undefined) {
    return { error: `${repo.owner}/${repo.repo}: issue create failed — ${created.error}` }
  }
  const issue = created.data?.html_url
  const number = created.data?.number
  if (typeof issue !== 'string' || typeof number !== 'number') {
    return { error: `${repo.owner}/${repo.repo}: issue create returned no html_url` }
  }
  env.id = issue
  env.thread = issue
  const commented = ghJson<{ html_url?: string }>(
    ['api', apiPath(repo, `issues/${number}/comments`), '--input', '-'],
    JSON.stringify({ body: renderComment(env) }),
  )
  if (commented.error !== undefined) {
    return { error: `issue ${issue} created but the record comment failed — ${commented.error}` }
  }
  return { issue }
}

/** The provenance verdict for one github record — the authenticated
 *  comment AUTHOR checked against the bound peer's `login` (a peer
 *  found by login on the own-repo plane arrives as `peer` too) and
 *  this account. A binding with no `login` admits nothing and says
 *  so — never a fallback to the advisory `from`. The error is a
 *  reason string; the caller prefixes peer + record id. */
export function githubProvenance(
  author: string,
  peer: { rig: string; login?: string } | undefined,
  selfLogin: string | undefined,
  ownRig: string | null,
): { provenance?: string; error?: string } {
  if (peer !== undefined) {
    if (peer.login === undefined) {
      return { error: `github binding has no login — records on this plane can't be authenticated` }
    }
    if (author === peer.login) {
      return { provenance: peer.rig }
    }
  }
  if (selfLogin !== undefined && author === selfLogin) {
    return ownRig === null
      ? { error: `own record, but this rig's identity doesn't resolve` }
      : { provenance: ownRig }
  }
  return {
    error: `comment author ${author === '' ? 'unknown' : author} is neither ${
      peer === undefined ? 'a bound login' : `peer login ${peer.login}`
    } nor this account`,
  }
}

/** A lifecycle record lands as another comment on the issue — the
 *  envelope's own id is `thread#kind` (one per kind per thread by
 *  lifecycle construction: a second claim is a stage error anyway). */
export function postComment(remote: string, thread: string, env: MeshEnvelope): { url?: string; error?: string } {
  const repo = issueRepo(thread) ?? parseGithubRemote(remote)
  const n = issueNumber(thread)
  if (repo === null || n === null) {
    return { error: `thread "${thread}" is not a github issue url` }
  }
  const r = ghJson<{ html_url?: string }>(
    ['api', apiPath(repo, `issues/${n}/comments`), '--input', '-'],
    JSON.stringify({ body: renderComment(env) }),
  )
  if (r.error !== undefined) {
    return { error: `${repo.owner}/${repo.repo}#${n}: comment failed — ${r.error}` }
  }
  return { url: r.data?.html_url }
}

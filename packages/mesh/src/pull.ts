/**
 * beads-remote replication — the read-only pull path. Each peer's
 * dolt store materializes as a detached `dolt clone` under
 * `<git-common>/bro/mesh/peers/<alias>`; refreshes are `dolt pull`
 * inside the replica. The replica never merges into our working set
 * and never writes back — sovereignty is structural: the transport
 * has no write verb.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface DoltResult {
  code: number
  out: string
  err: string
}

function dolt(args: string[], cwd?: string): DoltResult {
  const p = spawnSync('dolt', args, {  // NOSONAR — PATH lookup is the contract (same as core/git.ts)
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: p.status ?? 1,
    out: p.stdout ?? '',
    err: (p.stderr ?? p.error?.message ?? '').trim(),
  }
}

export function replicaDir(gitCommon: string, alias: string): string {
  return join(gitCommon, 'bro', 'mesh', 'peers', alias)
}

/** Clone when absent, pull when present. Returns the replica path on
 *  success, or an error string — a peer that can't be fetched is an
 *  empty inbox, not a crash (fail-open, same policy as the bus). */
export function syncReplica(gitCommon: string, alias: string, remote: string): { path?: string; error?: string } {
  const dir = replicaDir(gitCommon, alias)
  if (remote.startsWith('-')) {
    return { error: `${alias}: invalid remote '${remote}' — must not start with '-'` }
  }
  const r = existsSync(join(dir, '.dolt'))
    ? dolt(['pull'], dir)
    : dolt(['clone', remote, dir])
  if (r.code !== 0 || !existsSync(join(dir, '.dolt'))) {
    return { error: `${alias}: replica sync failed — ${r.err || r.out}`.trim() }
  }
  return { path: dir }
}

export interface IssueRow {
  id: string
  title: string
  description?: string
  notes?: string
  status?: string
  priority?: number
  external_ref?: string | null
}

const MESH_SQL = `select id, title, description, status, priority, external_ref from issues where id in (select issue_id from labels where label = 'mesh:v:1')`

/** All mesh-labelled issues in a replica — labels are fetched per row
 *  (the fan-out is small by definition: mesh traffic is requests, not
 *  bulk). JSON rows come from `dolt sql -r json`. */
export function meshIssues(dir: string): { rows: IssueRow[]; error?: string } {
  const r = dolt(['sql', '-q', MESH_SQL, '-r', 'json'], dir)
  if (r.code !== 0) {
    return { rows: [], error: r.err || r.out }
  }
  try {
    const parsed = JSON.parse(r.out) as { rows?: IssueRow[] }
    return { rows: parsed.rows ?? [] }
  } catch {
    return { rows: [], error: `replica query returned unparseable json` }
  }
}

/** bd's ship rule restated on a replica: a CLOSED issue labelled
 *  provides:<capability> releases the dep. This is the one record the
 *  inbox path cannot return (scanReplica drops closed rows), and dolt
 *  sql is how a raw replica answers it — it is not a beads project, so
 *  `bd` cannot address it. */
/** a provides:<capability> id is a bead-id token — the charset is the
 *  allowlist the SQL interpolation boundary checks against */
export const CAPABILITY_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/

export function shippedIssues(dir: string, capability: string): { shipped?: boolean; error?: string } {
  // allowlist at the SQL boundary — the value is interpolated raw,
  // so anything outside the bead-id token charset refuses to query
  // rather than leaning on quote-escaping alone
  if (!CAPABILITY_RE.test(capability)) {
    return { error: `unsafe capability "${capability}" — refusing the query` }
  }
  const r = dolt(
    [
      'sql',
      '-q',
      `select i.id from issues i inner join labels l on l.issue_id = i.id ` +
        `where l.label = 'provides:${capability}' and i.status = 'closed'`,
      '-r',
      'json',
    ],
    dir,
  )
  if (r.code !== 0) {
    return { error: r.err || r.out }
  }
  try {
    const parsed = JSON.parse(r.out) as { rows?: { id?: string }[] }
    return { shipped: (parsed.rows ?? []).length > 0 }
  } catch {
    return { error: `replica query returned unparseable json` }
  }
}

/** ms since the replica last materialized — `.dolt/noms/manifest`'s
 *  mtime is the sync stamp (dolt rewrites it on clone/pull); missing
 *  pieces fall back to `.dolt`, then the replica root. undefined when
 *  nothing stats — the caller treats that as "no replica". */
export function replicaAgeMs(dir: string, now: number = Date.now()): number | undefined {
  for (const p of [join(dir, '.dolt', 'noms', 'manifest'), join(dir, '.dolt'), dir]) {
    try {
      return Math.max(0, now - statSync(p).mtimeMs)
    } catch {
      // absent — try the shallower stamp
    }
  }
  return undefined
}

export function issueLabels(dir: string, id: string): { labels: string[]; error?: string } {
  const r = dolt(
    ['sql', '-q', `select label from labels where issue_id = '${id.replaceAll("'", "''")}'`, '-r', 'json'],
    dir,
  )
  if (r.code !== 0) {
    return { labels: [], error: r.err || r.out }
  }
  try {
    const parsed = JSON.parse(r.out) as { rows?: { label: string }[] }
    return { labels: (parsed.rows ?? []).map((row) => row.label) }
  } catch {
    return { labels: [], error: `label query returned unparseable json` }
  }
}

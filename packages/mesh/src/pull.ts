/**
 * beads-remote replication — the read-only pull path. Each peer's
 * dolt store materializes as a detached `dolt clone` under
 * `<git-common>/bro/mesh/peers/<alias>`; refreshes are `dolt pull`
 * inside the replica. The replica never merges into our working set
 * and never writes back — sovereignty is structural: the transport
 * has no write verb.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

export function issueLabels(dir: string, id: string): string[] {
  const r = dolt(
    ['sql', '-q', `select label from labels where issue_id = '${id.replaceAll("'", "''")}'`, '-r', 'json'],
    dir,
  )
  if (r.code !== 0) {
    return []
  }
  try {
    const parsed = JSON.parse(r.out) as { rows?: { label: string }[] }
    return (parsed.rows ?? []).map((row) => row.label)
  } catch {
    return []
  }
}

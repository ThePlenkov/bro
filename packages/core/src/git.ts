/**
 * Git plumbing helpers — same shell-out contract as `gh`/`bd`: the user's
 * git, their config, their credentials.
 */
import { spawnSync } from 'node:child_process'

export function git(args: string[]): string {
  const proc = spawnSync('git', args, { // NOSONAR — PATH lookup is the contract (same as gh/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (proc.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(proc.stderr ?? '').trim()}`)
  }
  return proc.stdout ?? ''
}

export function gitTry(args: string[]): { code: number; out: string; err: string } {
  const proc = spawnSync('git', args, { // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err: (proc.stderr ?? '').trim() }
}

/** One commit of a `git log --name-only` pass — `paths` is every file
 *  the commit touched. */
export interface GitLogPathRecord {
  sha: string
  subject: string
  paths: string[]
}

/** `git log --format=%x1e%H%x09%s -z --name-only <ref>` parsed into
 *  per-commit records — callers filter subjects in-process (`--grep`
 *  would search bodies too). Each header is framed by the \x1e record
 *  separator, so a filename that happens to look like `<sha>\t<subject>`
 *  can't pose as a commit. Output is unbounded (full history × touched
 *  paths), so spawnSync gets an explicit cap rather than the 1 MB
 *  default. null on git failure — the caller decides the honest state
 *  (unborn ref, bad ref). */
export function gitLogPathRecords(dir: string, ref: string): GitLogPathRecord[] | null {
  const proc = spawnSync('git', ['-C', dir, 'log', '--format=%x1e%H%x09%s', '-z', '--name-only', ref], { // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (proc.status !== 0) {
    return null
  }
  const records: GitLogPathRecord[] = []
  let cur: GitLogPathRecord | undefined
  for (const tok of (proc.stdout ?? '').split('\0')) {
    if (tok === '') {
      continue
    }
    if (tok.charCodeAt(0) === 0x1e) {
      const tab = tok.indexOf('\t')
      cur = { sha: tok.slice(1, tab), subject: tok.slice(tab + 1), paths: [] }
      records.push(cur)
    } else if (cur !== undefined) {
      cur.paths.push(tok.replace(/^\n/, ''))
    }
  }
  return records
}

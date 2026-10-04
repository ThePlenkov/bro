/**
 * Git plumbing helpers — same shell-out contract as `gh`/`bd`: the user's
 * git, their config, their credentials.
 */
import { spawnSync } from 'node:child_process'

/** `git -C` must select the repo on argv alone — an inherited
 *  GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR silently retargets the probe at
 *  whatever repository the parent process was spawned inside (agent
 *  envs carry them). GIT_INDEX_FILE stays: data-ref writes use it as a
 *  private index. undefined for non-`-C` calls — inherit as usual. */
const GIT_REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const

function repoEnv(args: string[]): NodeJS.ProcessEnv | undefined {
  if (!args.includes('-C')) {
    return undefined
  }
  const env = { ...process.env }
  for (const k of GIT_REPO_ENV) {
    delete env[k]
  }
  return env
}

export function git(args: string[]): string {
  const proc = spawnSync('git', args, { // NOSONAR — PATH lookup is the contract (same as gh/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: repoEnv(args),
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
    env: repoEnv(args),
  })
  // status null = spawn failure or signal, not a real verdict —
  // callers read exit 1 as one, so surface git's own fatal code
  return {
    code: proc.status ?? 128,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
  }
}

/** The drift comparison ref — landed spec vs landed code, so a feature
 *  branch's own commits can't flag the spec it's about to update.
 *  Chain: `origin/HEAD` → local `main`/`master` → remote-tracking
 *  `origin/main`/`master` (a remote checkout with no local default
 *  branch) → `HEAD` (solo and no-remote repos). null when nothing
 *  resolves to a commit — unborn history is the caller's
 *  `unverifiable`, not a throw. Qualified refs so a tag named `main`
 *  can't shadow (or fake) the branch — `rev-parse` resolves
 *  refs/tags/ before refs/heads/. */
export function gitDriftRef(dir: string): string | null {
  for (const cand of [
    'refs/remotes/origin/HEAD',
    'refs/heads/main',
    'refs/heads/master',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'HEAD',
  ]) {
    const r = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', `${cand}^{commit}`])
    if (r.code === 0) {
      return cand
    }
  }
  return null
}

/** One commit's identity plus its committer date — `iso` (%cI) is for
 *  display, `ts` (%ct epoch seconds) is for ordering: strict-ISO
 *  strings don't sort across differing timezone offsets. */
export interface GitStamp {
  sha: string
  iso: string
  ts: number
}

export type GitLogStamp =
  | { state: 'commit'; stamp: GitStamp }
  | { state: 'none' } // log ran clean — nothing on <ref> touched the paths
  | { state: 'error'; err: string } // bad ref, unborn history, git failure

/** `git log -1` over pathspecs — the newest commit on `ref` touching
 *  any of them. `follow` opts into rename-following (spec side: a
 *  renamed spec isn't freshly written — `-M100% --diff-filter=r` drops
 *  the pure-rename commit so the stamp is the last content write, not
 *  the move; a rename that also edited content is below the similarity
 *  threshold, reads as a rewrite, and stamps that commit); git only
 *  honours it for a single path, so the scope side never passes it.
 *  Pathspecs are argv entries verbatim — magic like `:(exclude…)` is
 *  the caller's. */
export function gitLogStamp(
  dir: string,
  ref: string,
  pathspecs: string[],
  opts?: { follow?: boolean }
): GitLogStamp {
  if (pathspecs.length === 0) {
    // `git log ref --` with no pathspecs audits the whole repo —
    // silent widening, so an empty scope is an error, never fresh data
    return { state: 'error', err: 'empty pathspecs' }
  }
  const args = ['-C', dir, 'log', '-1', '--format=%H%x09%cI%x09%ct']
  if (opts?.follow === true) {
    args.push('--follow', '-M100%', '--diff-filter=r')
  }
  args.push('--end-of-options', ref, '--', ...pathspecs)
  const r = gitTry(args)
  if (r.code !== 0) {
    return { state: 'error', err: r.err }
  }
  const line = r.out.trim()
  if (line === '') {
    return { state: 'none' }
  }
  const [sha = '', iso = '', ts = ''] = line.split('\t')
  const epoch = ts === '' ? Number.NaN : Number(ts)
  if (sha === '' || Number.isNaN(epoch)) {
    return { state: 'error', err: `unparseable git log line: ${line}` }
  }
  return { state: 'commit', stamp: { sha, iso, ts: epoch } }
}

/** `git merge-base --is-ancestor` — the drift tie-break: equal
 *  committer timestamps on different SHAs resolve by ancestry (scope
 *  commit predating the spec commit is fresh). null when git can't
 *  answer (unknown object) — the caller treats that as unverifiable. */
export function gitIsAncestor(dir: string, ancestor: string, descendant: string): boolean | null {
  const r = gitTry(['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant])
  return r.code === 0 ? true : r.code === 1 ? false : null
}

/** Shallow check — boundary commits masquerade as roots, so a
 *  path-limited log can attribute spec and scope to the same boundary
 *  commit and fake `fresh`. null on git failure. */
export function gitIsShallow(dir: string): boolean | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--is-shallow-repository'])
  return r.code === 0 ? r.out.trim() === 'true' : null
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
  const args = ['-C', dir, 'log', '--format=%x1e%H%x09%s', '-z', '--name-only', '--end-of-options', ref]
  const proc = spawnSync('git', args, { // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: repoEnv(args),
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

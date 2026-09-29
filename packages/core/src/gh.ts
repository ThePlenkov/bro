/**
 * GitHub CLI helpers. `gh` is a hard dependency — bro shells out rather than
 * carrying an Octokit client, so auth, proxies and GHES setups just work.
 */
import { spawnSync } from 'node:child_process'

export function gh(args: string[], cwd?: string): string {
  const proc = spawnSync('gh', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (proc.status !== 0) {
    throw new Error(`gh ${args[0]} failed: ${(proc.stderr ?? '').trim()}`)
  }
  return proc.stdout ?? ''
}

export function ghJson<T>(args: string[], cwd?: string): T {
  return JSON.parse(gh(args, cwd)) as T
}

/**
 * `gh` without the throw — for commands whose exit code carries meaning
 * (`gh pr checks` exits 1 when checks fail while still printing JSON).
 */
export function ghTry(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const proc = spawnSync('gh', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err: (proc.stderr ?? '').trim() }
}

export function ensureGhAuth(): void {
  const proc = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }) // NOSONAR — PATH lookup is the contract
  if (proc.status !== 0) {
    console.error('error: gh not authenticated — run `gh auth login`')
    process.exit(1)
  }
}

/** `OWNER/REPO` from args, or `gh repo view` in the current clone. */
export function resolveRepo(positional: string[]): string {
  const [owner, repo] = positional
  if (owner && repo) {
    return `${owner}/${repo}`
  }
  const viewed = ghJson<{ owner: { login: string }; name: string }>([
    'repo',
    'view',
    '--json',
    'owner,name',
  ])
  return `${viewed.owner.login}/${viewed.name}`
}

/** `[#N](https://github.com/owner/repo/pull/N)` — the clickable form every
 *  user-facing PR reference must use; bare `#N` is just text. TSV/data rows
 *  keep the bare number — they are parsed, not read. */
export function prLink(ownerRepo: string, pr: number): string {
  return `[#${pr}](https://github.com/${ownerRepo}/pull/${pr})`
}

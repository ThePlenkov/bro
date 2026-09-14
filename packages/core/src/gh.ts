/**
 * GitHub CLI helpers. `gh` is a hard dependency — bro shells out rather than
 * carrying an Octokit client, so auth, proxies and GHES setups just work.
 */
import { spawnSync } from 'node:child_process'

export function gh(args: string[]): string {
  const proc = spawnSync('gh', args, {
    stdout: 'pipe',
    stderr: 'pipe',
    encoding: 'utf8',
  })
  if (proc.status !== 0) {
    throw new Error(`gh ${args[0]} failed: ${(proc.stderr ?? '').trim()}`)
  }
  return proc.stdout ?? ''
}

export function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T
}

export function ensureGhAuth(): void {
  const proc = spawnSync('gh', ['auth', 'status'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
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

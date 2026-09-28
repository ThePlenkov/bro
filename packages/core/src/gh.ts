/**
 * GitHub CLI helpers. `gh` is a hard dependency — bro shells out rather than
 * carrying an Octokit client, so auth, proxies and GHES setups just work.
 */
import { spawn, spawnSync } from 'node:child_process'

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

/** Async `gh` — the spawnSync variant blocks the event loop, so bulk
 *  probes that run host calls under a concurrency cap need this to
 *  actually overlap. Same contract: resolve stdout, throw on non-zero. */
export function ghAsync(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { // NOSONAR — PATH lookup is the contract (same as gh/git)
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(out)
      } else {
        reject(new Error(`gh ${args[0]} failed: ${err.trim()}`))
      }
    })
  })
}

export function ghJson<T>(args: string[], cwd?: string): T {
  return JSON.parse(gh(args, cwd)) as T
}

export async function ghJsonAsync<T>(args: string[], cwd?: string): Promise<T> {
  return JSON.parse(await ghAsync(args, cwd)) as T
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

/** `OWNER/REPO` from args, or `gh repo view` in the current clone. Any
 *  other arity is a usage error — silently falling back to the checkout's
 *  repo could target the wrong repository. */
export function resolveRepo(positional: string[], cwd?: string): string {
  const [owner, repo] = positional
  if (positional.length === 2 && owner && repo) {
    return `${owner}/${repo}`
  }
  if (positional.length !== 0) {
    throw new Error(`expected OWNER REPO, got: ${positional.join(' ')}`)
  }
  const viewed = ghJson<{ owner: { login: string }; name: string }>(
    ['repo', 'view', '--json', 'owner,name'],
    cwd
  )
  return `${viewed.owner.login}/${viewed.name}`
}

/** The GitHub host links should point at — GH_HOST is `gh`'s own
 *  override, so GitHub Enterprise installs link to their server instead
 *  of github.com. */
export function ghHost(): string {
  const h = process.env.GH_HOST
  return h !== undefined && h.trim() !== '' ? h.trim() : 'github.com'
}

/** `[#N](https://github.com/owner/repo/pull/N)` — the clickable form every
 *  user-facing PR reference must use; bare `#N` is just text. TSV/data rows
 *  keep the bare number — they are parsed, not read. */
export function prLink(ownerRepo: string, pr: number): string {
  return `[#${pr}](https://${ghHost()}/${ownerRepo}/pull/${pr})`
}

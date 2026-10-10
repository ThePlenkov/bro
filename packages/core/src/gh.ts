/**
 * GitHub CLI helpers. `gh` is a hard dependency — bro shells out rather than
 * carrying an Octokit client, so auth, proxies and GHES setups just work.
 */
import { spawnSync } from 'node:child_process'
import { spawnCollect } from './live-procs.ts'

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

/** Options the async `gh` twins accept — an env overlay for plans that
 *  pin `GH_HOST`/tokens without mutating process.env (spec bro-14h8.1:
 *  `env` entries are literal variables, merged over the inherited set). */
export interface GhOpts {
  env?: Record<string, string>
}

// Per-call pools bound one call site each — `pooled(…, 4)` in the
// annotation probe, the bulk-scan chunking — but overlapping gate
// probes still multiply children into the same cgroup (one watch
// heartbeat probes every fleet PR in parallel, each child ~50MB —
// bro-2l7r9's OOM). One process-wide budget caps the real fan-out.
// The spawnSync twins need none — a blocked event loop is already
// serial — and bdAsync stays uncapped: its overlap is the probe-
// latency contract, not a memory risk at bd's footprint.
const GH_CHILD_CAP = 8
let ghInFlight = 0
const ghWaiters: Array<() => void> = []

async function ghChild<T>(fn: () => Promise<T>): Promise<T> {
  while (ghInFlight >= GH_CHILD_CAP) {
    await new Promise<void>((resolve) => ghWaiters.push(resolve))
  }
  ghInFlight += 1
  try {
    return await fn()
  } finally {
    ghInFlight -= 1
    ghWaiters.shift()?.()
  }
}

/** Async `gh` — the spawnSync variant blocks the event loop, so bulk
 *  probes that run host calls under a concurrency cap need this to
 *  actually overlap. Same contract: resolve stdout, throw on non-zero. */
export function ghAsync(args: string[], cwd?: string, opts?: GhOpts): Promise<string> {
  return ghChild(() => {
    const { done } = spawnCollect('gh', args, cwd, opts?.env)
    return done.then(({ code, out, err, error }) => {
      if (error !== undefined) {
        throw error
      }
      if (code === 0) {
        return out
      }
      throw new Error(`gh ${args[0]} failed: ${err}`)
    })
  })
}

export function ghJson<T>(args: string[], cwd?: string): T {
  return JSON.parse(gh(args, cwd)) as T
}

export async function ghJsonAsync<T>(args: string[], cwd?: string, opts?: GhOpts): Promise<T> {
  return JSON.parse(await ghAsync(args, cwd, opts)) as T
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

/** Async ghTry — same exit-code contract without the event-loop block.
 *  The act-gate probe path stacks several gh calls; spawnSync would
 *  serialize them AND starve every other probe's timeout timer. */
export function ghTryAsync(
  args: string[],
  cwd?: string
): Promise<{ code: number; out: string; err: string }> {
  return ghChild(() => {
    const { done } = spawnCollect('gh', args, cwd)
    return done.then((r) => ({ code: r.code ?? 1, out: r.out, err: r.err }))
  })
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

/** Async resolveRepo — the gate probe's `gh repo view` must not freeze
 *  the sweep while a sync spawnSync is the only wait it has. */
export async function resolveRepoAsync(positional: string[], cwd?: string): Promise<string> {
  const [owner, repo] = positional
  if (positional.length === 2 && owner && repo) {
    return `${owner}/${repo}`
  }
  if (positional.length !== 0) {
    throw new Error(`expected OWNER REPO, got: ${positional.join(' ')}`)
  }
  const viewed = await ghJsonAsync<{ owner: { login: string }; name: string }>(
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
  // GH_HOST is a bare host per gh(1) — but a pasted URL with a scheme
  // would produce https://https://… links, so normalize it away
  return h !== undefined && h.trim() !== ''
    ? h.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : 'github.com'
}

/** `[#N](https://github.com/owner/repo/pull/N)` — the clickable form every
 *  user-facing PR reference must use; bare `#N` is just text. TSV/data rows
 *  keep the bare number — they are parsed, not read. */
export function prLink(ownerRepo: string, pr: number): string {
  return `[#${pr}](https://${ghHost()}/${ownerRepo}/pull/${pr})`
}

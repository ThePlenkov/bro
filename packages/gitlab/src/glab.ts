/**
 * GitLab CLI helpers. `glab` is the connector's runtime dependency — bro
 * shells out rather than carrying an API client, so auth, proxies and
 * self-hosted setups just work. Mirrors core's gh.ts; `env` in opts lets
 * the facade pin GITLAB_HOST to the detected remote's instance.
 */
import { spawn, spawnSync } from 'node:child_process'

export interface GlabOpts {
  cwd?: string
  /** Extra env for the spawned glab — the facade sets GITLAB_HOST here so
   *  a configured self-hosted instance is hit deterministically, not
   *  glab's default host. */
  env?: Record<string, string>
}

const procEnv = (env?: Record<string, string>): NodeJS.ProcessEnv | undefined =>
  env === undefined ? undefined : { ...process.env, ...env }

export function glab(args: string[], opts?: GlabOpts): string {
  const proc = spawnSync('glab', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
    cwd: opts?.cwd,
    env: procEnv(opts?.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (proc.status !== 0) {
    throw new Error(`glab ${args[0]} failed: ${(proc.stderr ?? '').trim()}`)
  }
  return proc.stdout ?? ''
}

/** Async `glab` — the spawnSync variant blocks the event loop, so bulk
 *  probes that run host calls under a concurrency cap need this to
 *  actually overlap. Same contract: resolve stdout, throw on non-zero. */
export function glabAsync(args: string[], opts?: GlabOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('glab', args, { // NOSONAR — PATH lookup is the contract (same as glab/gh)
      cwd: opts?.cwd,
      env: procEnv(opts?.env),
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
        reject(new Error(`glab ${args[0]} failed: ${err.trim()}`))
      }
    })
  })
}

export function glabJson<T>(args: string[], opts?: GlabOpts): T {
  return JSON.parse(glab(args, opts)) as T
}

export async function glabJsonAsync<T>(args: string[], opts?: GlabOpts): Promise<T> {
  return JSON.parse(await glabAsync(args, opts)) as T
}

/** `glab` without the throw — for calls whose exit code carries meaning
 *  (auth status, a refused merge/rebase). */
export function glabTry(
  args: string[],
  opts?: GlabOpts
): { code: number; out: string; err: string } {
  const proc = spawnSync('glab', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract
    cwd: opts?.cwd,
    env: procEnv(opts?.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err: (proc.stderr ?? '').trim() }
}

export interface GlabPagedOpts extends GlabOpts {
  limit?: number
}

/** GitLab REST list pagination — `?per_page=100&page=N` until a short
 *  page (glab's own --paginate shape varies by version; manual pages are
 *  version-proof). `limit` stops collection early. */
export function glabPaged<T>(endpoint: string, opts?: GlabPagedOpts): T[] {
  const out: T[] = []
  const sep = endpoint.includes('?') ? '&' : '?'
  for (let page = 1; ; page += 1) {
    const rows = glabJson<T[]>(['api', `${endpoint}${sep}per_page=100&page=${page}`], opts)
    out.push(...rows)
    if (rows.length < 100 || (opts?.limit !== undefined && out.length >= opts.limit)) {
      break
    }
  }
  return opts?.limit === undefined ? out : out.slice(0, opts.limit)
}

/** Async twin of glabPaged — bulk paths pool requests, so they must not
 *  block the event loop. */
export async function glabPagedAsync<T>(endpoint: string, opts?: GlabPagedOpts): Promise<T[]> {
  const out: T[] = []
  const sep = endpoint.includes('?') ? '&' : '?'
  for (let page = 1; ; page += 1) {
    const rows = await glabJsonAsync<T[]>(
      ['api', `${endpoint}${sep}per_page=100&page=${page}`],
      opts
    )
    out.push(...rows)
    if (rows.length < 100 || (opts?.limit !== undefined && out.length >= opts.limit)) {
      break
    }
  }
  return opts?.limit === undefined ? out : out.slice(0, opts.limit)
}

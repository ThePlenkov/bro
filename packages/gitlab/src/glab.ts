/**
 * GitLab CLI helpers. `glab` is the connector's runtime dependency — bro
 * shells out rather than carrying an API client, so auth, proxies and
 * self-hosted setups just work. Mirrors core's gh.ts.
 */
import { spawn, spawnSync } from 'node:child_process'

export function glab(args: string[], cwd?: string): string {
  const proc = spawnSync('glab', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
    cwd,
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
export function glabAsync(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('glab', args, { // NOSONAR — PATH lookup is the contract (same as glab/gh)
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
        reject(new Error(`glab ${args[0]} failed: ${err.trim()}`))
      }
    })
  })
}

export function glabJson<T>(args: string[], cwd?: string): T {
  return JSON.parse(glab(args, cwd)) as T
}

export async function glabJsonAsync<T>(args: string[], cwd?: string): Promise<T> {
  return JSON.parse(await glabAsync(args, cwd)) as T
}

/** `glab` without the throw — for calls whose exit code carries meaning
 *  (auth status, a refused merge/rebase). */
export function glabTry(
  args: string[],
  cwd?: string
): { code: number; out: string; err: string } {
  const proc = spawnSync('glab', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err: (proc.stderr ?? '').trim() }
}

/** GitLab REST list pagination — `?per_page=100&page=N` until a short
 *  page (glab's own --paginate shape varies by version; manual pages are
 *  version-proof). `limit` stops collection early. */
export function glabPaged<T>(endpoint: string, cwd?: string, limit?: number): T[] {
  const out: T[] = []
  const sep = endpoint.includes('?') ? '&' : '?'
  for (let page = 1; ; page += 1) {
    const rows = glabJson<T[]>(
      ['api', `${endpoint}${sep}per_page=100&page=${page}`],
      cwd
    )
    out.push(...rows)
    if (rows.length < 100 || (limit !== undefined && out.length >= limit)) {
      break
    }
  }
  return limit === undefined ? out : out.slice(0, limit)
}

/** Async twin of glabPaged — bulk paths pool requests, so they must not
 *  block the event loop. */
export async function glabPagedAsync<T>(
  endpoint: string,
  cwd?: string,
  limit?: number
): Promise<T[]> {
  const out: T[] = []
  const sep = endpoint.includes('?') ? '&' : '?'
  for (let page = 1; ; page += 1) {
    const rows = await glabJsonAsync<T[]>(
      ['api', `${endpoint}${sep}per_page=100&page=${page}`],
      cwd
    )
    out.push(...rows)
    if (rows.length < 100 || (limit !== undefined && out.length >= limit)) {
      break
    }
  }
  return limit === undefined ? out : out.slice(0, limit)
}

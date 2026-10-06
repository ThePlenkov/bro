/**
 * The `atlassian` connector — a `queries` facade over the operator's
 * `atlassian` CLI (spec bro-14h8.1, milestone 5). `atlassian gql` is a
 * raw-GraphQL passthrough: it takes the document verbatim, a
 * `--variables` JSON body, and prints `{data, errors}` — auth is the
 * CLI's own login (`atlassian auth login`, `ATLASSIAN_TOKEN`).
 *
 * Endpoint discipline: the effective `apiUrl` (config file or
 * ATLASSIAN_API_URL env, default https://api.atlassian.com) must be
 * https: before we spawn — the CLI sends its Authorization header to
 * whatever the endpoint names. A PLAN cannot set ATLASSIAN_API_URL at
 * all (parseQueryPlan rejects it); this check guards the operator's
 * own overlay and ambient env too.
 */
import { spawn } from 'node:child_process'
import type { Connector, QueryFacade, QueryResult } from '@broject/core'

const DEFAULT_API_URL = 'https://api.atlassian.com'

/** The endpoint `atlassian` would actually post to — env wins over the
 *  CLI's default (the CLI's own config file is opaque to us, so env is
 *  what we can honestly verify). Anything not https: fails closed. */
function effectiveApiUrl(env: Record<string, string> | undefined): string {
  return (env?.['ATLASSIAN_API_URL'] ?? process.env['ATLASSIAN_API_URL'])?.trim() || DEFAULT_API_URL
}

function assertHttps(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`atlassian endpoint is not a URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `atlassian endpoint must be https: — got ${parsed.protocol} (${url}); ` +
        `the CLI sends its Authorization header to this endpoint`
    )
  }
}

async function gql(
  doc: string,
  vars: Record<string, unknown> | undefined,
  env: Record<string, string> | undefined
): Promise<QueryResult> {
  assertHttps(effectiveApiUrl(env))
  const args = ['gql', doc]
  if (vars !== undefined && Object.keys(vars).length > 0) {
    args.push('--variables', JSON.stringify(vars))
  }
  args.push('--json')
  return new Promise((resolve, reject) => {
    const proc = spawn('atlassian', args, { // NOSONAR — PATH lookup is the contract (same as gh/glab)
      env: env === undefined ? undefined : { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`atlassian gql failed: ${err.trim()}`))
        return
      }
      try {
        const parsed = JSON.parse(out) as { data?: unknown; errors?: unknown }
        const res: QueryResult = {}
        if (parsed.data !== undefined) {
          res.data = parsed.data
        }
        if (parsed.errors !== undefined) {
          res.errors = parsed.errors
        }
        resolve(res)
      } catch {
        reject(new Error(`atlassian gql returned non-JSON output`))
      }
    })
  })
}

export const atlassianConnector: Connector = {
  name: 'atlassian',
  // opt-in only: nothing about a repo's remote or layout implies
  // Atlassian — a step names it, or connectors.queries pins it
  optIn: true,
  auth: () => null, // `atlassian auth` state is the CLI's own; a spawn failure reports it
  queries: (): QueryFacade => ({
    graphql: (doc, opts) => gql(doc, opts?.vars, opts?.env),
  }),
}

/**
 * The router's catalog, read over HTTP.
 *
 * The router is a PROCESS: its answer is `/v1/models`, and its
 * credential is the session token the provider plane demands (reads
 * included — an unauthenticated read would spend the upstream key
 * blinded to the answer).
 *
 * Discovery is the state file, not a port convention: the router
 * publishes `{pid, url, dir, token}` into the repo's common dir, the
 * same rule the fleet uses. The path lives in ONE function so the
 * router's move into this package moves the path with it.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { servedModels, type ServedModel } from './catalog.ts';
import type { RouterEndpoint } from './adapter.ts';

/** The hosts a session token may cross to in cleartext: this machine only.
 *  A Set, not a pattern — the host list is three names long, and a
 *  nested quantifier is a denial-of-service waiting for a caller. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The statuses that carry a redirect — the catalog read refuses them. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The URL without its trailing slashes — a loop, not a pattern: the
 *  scanners read these files, and a trailing slash is not worth a
 *  pattern. */
function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') {
    end -= 1;
  }
  return text.slice(0, end);
}

/** The router's URL, parsed — and without credentials in it: a url
 *  with a password would print it in every log that names the
 *  refusal. */
function parseRouterUrl(raw: string): URL {
  const url = URL.parse(raw);
  if (url === null) {
    throw new Error(`the router's url is not a valid URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`the router's url carries credentials — a router url never carries a password`);
  }
  return url;
}

/** Whether an origin may carry the session token: https anywhere,
 *  cleartext only to this machine. */
function tokenSafeOrigin(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** The router's URL, checked against the credential it carries.
 *
 *  The URL is the token's crossing point: the catalog read sends the
 *  session token in headers, and the proxy sends it again on the model
 *  call. A tampered state file — or a `--url` naming a foreign host —
 *  would carry the token there in cleartext, so the URL must be one
 *  this machine may carry it to: https anywhere, cleartext only to a
 *  loopback router. */
export function routerUrl(raw: string): string {
  const url = parseRouterUrl(raw);
  if (!tokenSafeOrigin(url)) {
    throw new Error(
      `the router's url ${url.protocol}//${url.host} cannot carry the session token — https or a ` +
        `loopback router (http://127.0.0.1:<port>) only; a plain-http host would carry it cleartext`
    );
  }
  return withoutTrailingSlashes(raw);
}

/** The git common dir — the directory every linked worktree shares.
 *  Pure: walk up for `.git`; a directory IS the common dir, a file (a
 *  linked worktree) names the worktree's gitdir, whose `worktrees/`
 *  parent holds the common dir. */
function gitCommonFromDot(dot: string, current: string): string | undefined {
  const stat = statSync(dot, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isDirectory()) return dot;
  if (!stat.isFile()) return undefined;
  const text = readFileSync(dot, 'utf8');
  const named = /^gitdir:\s*(.+)$/m.exec(text);
  if (named === null) return undefined;
  const raw = named[1].trim();
  if (raw === '') return undefined;
  let gitdir: string;
  if (isAbsolute(raw)) {
    gitdir = raw;
  } else {
    gitdir = resolve(current, raw);
  }
  const parent = dirname(gitdir);
  if (basename(parent) === 'worktrees') return dirname(parent);
  return gitdir;
}

export function gitCommonDir(dir: string): string | undefined {
  let current = resolve(dir);
  for (;;) {
    const found = gitCommonFromDot(join(current, '.git'), current);
    if (found !== undefined) return found;
    const up = dirname(current);
    if (up === current) return undefined;
    current = up;
  }
}

/** The router's state file — `<git-common-dir>/bro/serve.json`. */
export function routerStatePath(dir: string): string | undefined {
  const common = gitCommonDir(dir);
  return common === undefined ? undefined : join(common, 'bro', 'serve.json');
}

/** The endpoint a record states — undefined when the record is torn:
 *  a half-written record is not a router. A record whose URL cannot
 *  carry the token is NOT "no router": the router is running and bro
 *  refuses it, loudly. */
function endpointOf(bag: Record<string, unknown>): RouterEndpoint | undefined {
  const url = typeof bag.url === 'string' ? bag.url.trim() : '';
  const token = typeof bag.token === 'string' ? bag.token.trim() : '';
  if (url === '' || token === '') return undefined;
  return { url: routerUrl(url), token };
}

/** The endpoint the router published — undefined when there is no
 *  state file or it is torn (a half-written record is not a router). */
export function readRouterEndpoint(dir: string): RouterEndpoint | undefined {
  const path = routerStatePath(dir);
  if (path === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  return endpointOf(raw as Record<string, unknown>);
}

/** The catalog's own url — the router's /v1/models, with the limit it
 *  was asked for. */
function catalogUrl(endpoint: RouterEndpoint, limit: number): string {
  return `${routerUrl(endpoint.url)}/v1/models?limit=${limit}`;
}

/** The catalog, read from the router. A router that is not up is an
 *  honest error — never an empty catalog that reads like a whole one.
 *
 *  The read asks ONE url — the router's own /v1/models — and it does
 *  not follow redirects: the client carries the request's headers to
 *  the hop's target, so the session token would ride to a host the
 *  guard never checked, over cleartext if the hop chose it. A redirect
 *  is an error that names its target. */
export async function readCatalog(
  endpoint: RouterEndpoint,
  opts: { limit?: number; timeoutMs?: number } = {}
): Promise<{ models: ServedModel[]; dropped: number }> {
  const url = catalogUrl(endpoint, opts.limit ?? 1000);
  const res = await fetch(url, {
    headers: {
      'x-api-key': endpoint.token,
      authorization: `Bearer ${endpoint.token}`,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    // never auto-follow — the session token would ride to a host the
    // guard never checked
    redirect: 'manual',
  });
  const location = res.headers.get('location');
  if (REDIRECT_STATUSES.has(res.status)) {
    throw new Error(
      `the router answered ${res.status} with a redirect to ${location ?? ''} — the catalog read does not ` +
        `follow redirects: the session token would ride to a host the guard never checked`
    );
  }
  if (!res.ok) {
    throw new Error(`the router answered ${res.status} on ${url}`);
  }
  return servedModels(await res.json());
}

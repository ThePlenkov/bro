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
import { routerUrl } from './router-url.ts';
import type { RouterEndpoint } from './adapter.ts';

/** The statuses that carry a redirect — the read refuses them. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The gitdir a `.git` FILE names — a linked worktree's gitdir. The
 *  name is absolute as written, relative to the directory that holds
 *  the `.git` file. undefined when the file names none. */
function gitDirFromFile(dot: string): string | undefined {
  const stat = statSync(dot, { throwIfNoEntry: false });
  if (stat?.isFile() !== true) return undefined;
  // the gitdir line, read without backtracking: a character class (not
  // `\s`, which crosses a line) and no `$` after the capture — the
  // capture stops at the line end by itself
  const named = /^gitdir:[ \t]*(.*)/m.exec(readFileSync(dot, 'utf8'));
  if (named?.[1] === undefined) return undefined;
  const path = named[1].trim();
  // an empty gitdir names no gitdir: resolving it would answer the
  // directory that holds the .git file, and that directory is not the
  // common dir
  if (path === '') return undefined;
  return isAbsolute(path) ? path : resolve(dirname(dot), path);
}

/** A worktree's gitdir → the common dir every linked worktree shares.
 *  A gitdir that is not a worktree's IS the common dir. */
function commonFromGitDir(gitdir: string): string {
  const parent = dirname(gitdir);
  return basename(parent) === 'worktrees' ? dirname(parent) : gitdir;
}

/** The git common dir — the directory every linked worktree shares.
 *  Pure: walk up for `.git`; a directory IS the common dir, a file (a
 *  linked worktree) names the worktree's gitdir, whose `worktrees/`
 *  parent holds the common dir. */
export function gitCommonDir(dir: string): string | undefined {
  let current = resolve(dir);
  for (;;) {
    const dot = join(current, '.git');
    const stat = statSync(dot, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return dot;
    const gitdir = gitDirFromFile(dot);
    if (gitdir !== undefined) return commonFromGitDir(gitdir);
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

/** The endpoint the router published — undefined when there is no
 *  state file or it is torn (a half-written record is not a router).
 *  A record whose URL cannot carry the token is NOT "no router": the
 *  router is running and bro refuses it, loudly. */
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
  const bag = raw as Record<string, unknown>;
  const url = typeof bag.url === 'string' ? bag.url.trim() : '';
  const token = typeof bag.token === 'string' ? bag.token.trim() : '';
  if (url === '' || token === '') return undefined;
  return { url: routerUrl(url), token };
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
  const limit = opts.limit ?? 1000;
  const url = `${routerUrl(endpoint.url)}/v1/models?limit=${limit}`;
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
  if (REDIRECT_STATUSES.has(res.status)) {
    const location = res.headers.get('location') ?? '';
    throw new Error(
      `the router answered ${res.status} with a redirect to ${location} — the catalog read does not ` +
        `follow redirects: the session token would ride to a host the guard never checked`
    );
  }
  if (!res.ok) {
    throw new Error(`the router answered ${res.status} on ${res.url}`);
  }
  return servedModels(await res.json());
}

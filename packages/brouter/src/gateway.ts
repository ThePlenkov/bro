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
import { fetchTokenSafe } from './redirect.ts';
import { routerUrl } from './router-url.ts';
import type { RouterEndpoint } from './adapter.ts';

/** The gitdir a `.git` FILE names — a linked worktree's gitdir. The
 *  name is absolute as written, relative to the directory that holds
 *  the `.git` file. undefined when the file names none. */
function gitDirFromFile(dot: string): string | undefined {
  const stat = statSync(dot, { throwIfNoEntry: false });
  if (stat?.isFile() !== true) return undefined;
  const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
  if (named?.[1] === undefined) return undefined;
  const path = named[1].trim();
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
 *  The read follows redirects by hand: every hop is checked before the
 *  session token rides it (see redirect.ts). */
export async function readCatalog(
  endpoint: RouterEndpoint,
  opts: { limit?: number; timeoutMs?: number } = {}
): Promise<{ models: ServedModel[]; dropped: number }> {
  const limit = opts.limit ?? 1000;
  const res = await fetchTokenSafe(
    endpoint,
    limit,
    {
      'x-api-key': endpoint.token,
      authorization: `Bearer ${endpoint.token}`,
      'anthropic-version': '2023-06-01',
    },
    AbortSignal.timeout(opts.timeoutMs ?? 20_000)
  );
  if (!res.ok) {
    // the hop that answered, not the one the read started at
    throw new Error(`the router answered ${res.status} on ${res.url}`);
  }
  return servedModels(await res.json());
}

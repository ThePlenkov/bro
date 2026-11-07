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
  const bag = raw as Record<string, unknown>;
  const url = typeof bag.url === 'string' ? bag.url.trim() : '';
  const token = typeof bag.token === 'string' ? bag.token.trim() : '';
  if (url === '' || token === '') return undefined;
  return { url: url.replace(/\/+$/, ''), token };
}

/** The catalog, read from the router. A router that is not up is an
 *  honest error — never an empty catalog that reads like a whole one. */
export async function readCatalog(
  endpoint: RouterEndpoint,
  opts: { limit?: number; timeoutMs?: number } = {}
): Promise<{ models: ServedModel[]; dropped: number }> {
  const limit = opts.limit ?? 1000;
  const url = `${endpoint.url}/v1/models?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      'x-api-key': endpoint.token,
      authorization: `Bearer ${endpoint.token}`,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) {
    throw new Error(`the router answered ${res.status} on ${url}`);
  }
  return servedModels(await res.json());
}

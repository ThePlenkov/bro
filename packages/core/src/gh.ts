/**
 * GitHub CLI helpers. `gh` is a hard dependency — bro shells out rather than
 * carrying an Octokit client, so auth, proxies and GHES setups just work.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { spawnCollect } from './live-procs.ts';

/** Node's `spawnSync` caps a child's output at 1 MiB and KILLS it with
 *  ENOBUFS past that — `status` goes null, and the caller cannot tell a
 *  killed child from a quiet one. A bulk listing crosses that cap easily
 *  (the open-PR REST page carries every body), so the sync helpers get a
 *  real budget: 64 MiB sits orders of magnitude above the listing sizes
 *  these calls produce and stays bounded — a `--paginate` listing over a
 *  very large repo can still exceed it, and then the caller reads the
 *  ENOBUFS reason instead of silence. The async twins stream into a
 *  string and never had the cap. */
const GH_MAX_BUFFER = 64 * 1024 * 1024;

/** Why a `gh` call failed — stderr when the CLI spoke, else the spawn
 *  error (a killed child can leave stderr empty), else a bounded head of
 *  stdout (some tools print the diagnosis there), else the signal or the
 *  exit code. Never empty on a failure: an undiagnosable failure is its
 *  own bug. */
function ghFailure(proc: SpawnSyncReturns<string>): string {
  const err = (proc.stderr ?? '').trim();
  if (err !== '') return err;
  if (proc.error !== undefined) return proc.error.message;
  const out = (proc.stdout ?? '').trim();
  if (out !== '') return out.length > 200 ? `${out.slice(0, 200)}…` : out;
  if (proc.signal !== null && proc.signal !== undefined) return `signal ${proc.signal}`;
  return `exit ${proc.status ?? 'unknown'}`;
}

export function gh(args: string[], cwd?: string): string {
  const proc = spawnSync('gh', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: GH_MAX_BUFFER,
  });
  if (proc.status !== 0) {
    throw new Error(`gh ${args[0]} failed: ${ghFailure(proc)}`);
  }
  return proc.stdout ?? '';
}

/** Options the async `gh` twins accept — an env overlay for plans that
 *  pin `GH_HOST`/tokens without mutating process.env (spec bro-14h8.1:
 *  `env` entries are literal variables, merged over the inherited set). */
export interface GhOpts {
  env?: Record<string, string>;
}

// Per-call pools bound one call site each — `pooled(…, 4)` in the
// annotation probe, the bulk-scan chunking — but overlapping gate
// probes still multiply children into the same cgroup (one watch
// heartbeat probes every fleet PR in parallel, each child ~50MB —
// bro-2l7r9's OOM). One process-wide budget caps the real fan-out.
// The spawnSync twins need none — a blocked event loop is already
// serial — and bdAsync stays uncapped: its overlap is the probe-
// latency contract, not a memory risk at bd's footprint.
const GH_CHILD_CAP = 8;
let ghInFlight = 0;
const ghWaiters: Array<() => void> = [];

async function ghChild<T>(fn: () => Promise<T>): Promise<T> {
  while (ghInFlight >= GH_CHILD_CAP) {
    await new Promise<void>(resolve => ghWaiters.push(resolve));
  }
  ghInFlight += 1;
  try {
    return await fn();
  } finally {
    ghInFlight -= 1;
    ghWaiters.shift()?.();
  }
}

/** Async `gh` — the spawnSync variant blocks the event loop, so bulk
 *  probes that run host calls under a concurrency cap need this to
 *  actually overlap. Same contract: resolve stdout, throw on non-zero. */
export function ghAsync(args: string[], cwd?: string, opts?: GhOpts): Promise<string> {
  return ghChild(() => {
    const { done } = spawnCollect('gh', args, cwd, opts?.env);
    return done.then(({ code, out, err, error }) => {
      if (error !== undefined) {
        throw error;
      }
      if (code === 0) {
        return out;
      }
      throw new Error(`gh ${args[0]} failed: ${err}`);
    });
  });
}

export function ghJson<T>(args: string[], cwd?: string): T {
  return JSON.parse(gh(args, cwd)) as T;
}

export async function ghJsonAsync<T>(args: string[], cwd?: string, opts?: GhOpts): Promise<T> {
  return JSON.parse(await ghAsync(args, cwd, opts)) as T;
}

/**
 * `gh` without the throw — for commands whose exit code carries meaning
 * (`gh pr checks` exits 1 when checks fail while still printing JSON).
 */
export function ghTry(args: string[], cwd?: string): { code: number; out: string; err: string } {
  // user-installed CLI — PATH lookup is the contract; the NOSONAR must
  // share the callee's line (biome reflows a trailing one inside {})
  const proc = /* NOSONAR */ spawnSync('gh', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: GH_MAX_BUFFER,
  });
  const err = (proc.stderr ?? '').trim();
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    // a silent success stays silent; a silent FAILURE says why
    err: err !== '' || proc.status === 0 ? err : ghFailure(proc),
  };
}

/** Async ghTry — same exit-code contract without the event-loop block.
 *  The act-gate probe path stacks several gh calls; spawnSync would
 *  serialize them AND starve every other probe's timeout timer. */
export function ghTryAsync(
  args: string[],
  cwd?: string
): Promise<{ code: number; out: string; err: string }> {
  return ghChild(() => {
    const { done } = spawnCollect('gh', args, cwd);
    return done.then(r => ({ code: r.code ?? 1, out: r.out, err: r.err }));
  });
}

/** `OWNER/REPO` from args, or `gh repo view` in the current clone. Any
 *  other arity is a usage error — silently falling back to the checkout's
 *  repo could target the wrong repository. */
export function resolveRepo(positional: string[], cwd?: string): string {
  const [owner, repo] = positional;
  if (positional.length === 2 && owner && repo) {
    return `${owner}/${repo}`;
  }
  if (positional.length !== 0) {
    throw new Error(`expected OWNER REPO, got: ${positional.join(' ')}`);
  }
  const viewed = ghJson<{ owner: { login: string }; name: string }>(
    ['repo', 'view', '--json', 'owner,name'],
    cwd
  );
  return `${viewed.owner.login}/${viewed.name}`;
}

/** Async resolveRepo — the gate probe's `gh repo view` must not freeze
 *  the sweep while a sync spawnSync is the only wait it has. */
export async function resolveRepoAsync(positional: string[], cwd?: string): Promise<string> {
  const [owner, repo] = positional;
  if (positional.length === 2 && owner && repo) {
    return `${owner}/${repo}`;
  }
  if (positional.length !== 0) {
    throw new Error(`expected OWNER REPO, got: ${positional.join(' ')}`);
  }
  const viewed = await ghJsonAsync<{ owner: { login: string }; name: string }>(
    ['repo', 'view', '--json', 'owner,name'],
    cwd
  );
  return `${viewed.owner.login}/${viewed.name}`;
}

/** The GitHub host links should point at — GH_HOST is `gh`'s own
 *  override, so GitHub Enterprise installs link to their server instead
 *  of github.com. */
export function ghHost(): string {
  const h = process.env.GH_HOST;
  if (h === undefined || h.trim() === '') return 'github.com';
  // GH_HOST is a bare host per gh(1) — but a pasted URL with a scheme
  // would produce https://https://… links, so normalize it away. The
  // trailing-slash trim is a loop, not /\/+$/: a greedy quantifier
  // pinned to end-of-input backtracks super-linearly on hostile input
  let host = h.trim().replace(/^https?:\/\//, '');
  while (host.endsWith('/')) {
    host = host.slice(0, -1);
  }
  return host;
}

/** `[#N](https://github.com/owner/repo/pull/N)` — the clickable form every
 *  user-facing PR reference must use; bare `#N` is just text. TSV/data rows
 *  keep the bare number — they are parsed, not read. The host defaults to
 *  the connector's own — a claim that names another host links there. */
export function prLink(ownerRepo: string, pr: number, host?: string): string {
  return `[#${pr}](https://${host ?? ghHost()}/${ownerRepo}/pull/${pr})`;
}

/** `[#N](https://github.com/owner/repo/issues/N)` — the same clickable
 *  form for issue references (bead mirrors land as issues, and `Fixes
 *  #N` output must not be bare either). */
export function issueLink(ownerRepo: string, issue: number): string {
  return `[#${issue}](https://${ghHost()}/${ownerRepo}/issues/${issue})`;
}

/** A PR reference found in free text. */
export interface PrRef {
  pr: number;
  /** `owner/repo` when the reference carried a link — the bare form
   *  names no repo, and the caller supplies the one it works in. */
  repo?: string;
  /** the host the link named — `github.com`, or the GHES host. The
   *  bare form names no host. */
  host?: string;
}

/** A markdown link found in free text — where it sits, and the URL it
 *  carries. */
interface MarkdownLink {
  url: string;
  /** the offset of the link's `[` */
  start: number;
  /** the offset just past the link's `)` */
  end: number;
}

/** Is this an ASCII digit? */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** The run of ASCII digits starting at `from` — how many, zero when the
 *  text there is not a digit. */
function digitRun(text: string, from: number): number {
  let n = 0;
  while (from + n < text.length && isDigit(text[from + n])) n += 1;
  return n;
}

/** The next markdown link at or after `from` — a string walk, not a
 *  regex: a regex over untrusted text is super-linear on hostile input
 *  (CodeQL), and this text is whatever an agent wrote. The label holds
 *  no `]` and the URL holds no `)` — markdown's own rule. */
function nextLink(text: string, from: number): MarkdownLink | null {
  let bracket = -1;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '[') {
      // the leftmost `[` wins — the label may hold more of them
      if (bracket < 0) bracket = i;
      i += 1;
      continue;
    }
    if (ch !== ']') {
      i += 1;
      continue;
    }
    // a `]` ends the label — a link needs `(` right after it, and a
    // `]` without one kills every `[` before it
    if (text[i + 1] !== '(') {
      bracket = -1;
      i += 1;
      continue;
    }
    if (bracket < 0) {
      i += 1;
      continue;
    }
    const urlEnd = text.indexOf(')', i + 2);
    if (urlEnd < 0) {
      // no ')' left in the text — no later candidate can close a link
      // either, so the scan ends here instead of re-reading the tail
      // for every ']'
      return null;
    }
    return { url: text.slice(i + 2, urlEnd), start: bracket, end: urlEnd + 1 };
  }
  return null;
}

/** Every markdown link in free text. */
function markdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let from = 0;
  for (;;) {
    const link = nextLink(text, from);
    if (link === null) break;
    links.push(link);
    from = link.end;
  }
  return links;
}

/** The host and the path a URL names — null when the URL is not an
 *  HTTP(S) URL with a host and a path. */
function urlParts(url: string): { host: string; path: string } | null {
  const u = url.trimEnd();
  const schemeEnd = u.indexOf('://');
  if (schemeEnd < 0) return null;
  const scheme = u.slice(0, schemeEnd);
  if (scheme !== 'http' && scheme !== 'https') return null;
  const hostEnd = u.indexOf('/', schemeEnd + 3);
  if (hostEnd < 0 || hostEnd === schemeEnd + 3) return null;
  return { host: u.slice(schemeEnd + 3, hostEnd), path: u.slice(hostEnd + 1) };
}

/** Is this a path segment — not empty, no whitespace? */
function isPathSegment(s: string): boolean {
  return s !== '' && !/\s/.test(s);
}

/** Is this a run of digits? */
function isDigits(s: string): boolean {
  return s !== '' && /^\d+$/.test(s);
}

/** The `owner/repo/pull/N` a link's path names — null when the path
 *  names no PR: an issue link (`/issues/N`) is a different object, and
 *  reading it as a PR would verify the wrong one. */
function pullPath(path: string): { owner: string; repo: string; num: string } | null {
  const segments = path.split('/');
  if (segments.length !== 4) return null;
  const [owner, repo, kind, num] = segments;
  if (kind !== 'pull') return null;
  if (!isPathSegment(owner) || !isPathSegment(repo)) return null;
  if (!isDigits(num)) return null;
  return { owner, repo, num };
}

/** The PR a link names — `https://host/owner/repo/pull/N`. */
function pullRef(url: string): { pr: number; repo: string; host: string } | null {
  const parts = urlParts(url);
  if (parts === null) return null;
  const path = pullPath(parts.path);
  if (path === null) return null;
  const pr = Number(path.num);
  if (!Number.isInteger(pr) || pr <= 0) return null;
  return { pr, repo: `${path.owner}/${path.repo}`, host: parts.host };
}

/** The PRs the markdown links name — the link's own `#N` label is not a
 *  second reference. */
function linkRefs(links: MarkdownLink[]): PrRef[] {
  const out: PrRef[] = [];
  for (const link of links) {
    const ref = pullRef(link.url);
    if (ref === null) continue;
    out.push({ pr: ref.pr, repo: ref.repo, host: ref.host });
  }
  return out;
}

/** The bare `#N` references — outside the markdown links, where the
 *  link's own label already carries the number. */
function bareRefs(text: string, links: MarkdownLink[]): PrRef[] {
  const out: PrRef[] = [];
  let i = 0;
  // the link spans are ordered and disjoint — the cursor advances past
  // the ones the scan has left behind, so a text with many links and
  // many references costs one pass, not one pass per reference
  let link = 0;
  let span = links[link];
  while (i < text.length) {
    if (text[i] !== '#') {
      i += 1;
      continue;
    }
    const at = i;
    const digits = digitRun(text, i + 1);
    i += 1 + digits;
    if (digits === 0) continue;
    const pr = Number(text.slice(at + 1, at + 1 + digits));
    if (!Number.isInteger(pr) || pr <= 0) continue;
    while (span !== undefined && span.end <= at) {
      link += 1;
      span = links[link];
    }
    if (span !== undefined && at >= span.start) continue;
    out.push({ pr });
  }
  return out;
}

/** The identity of a reference — the PR, with the host and the
 *  repository that name it. The bare form names neither, so it keeps
 *  its own key. */
function refKey(ref: PrRef): string {
  if (ref.repo === undefined) return `#${ref.pr}`;
  return `${ref.host ?? ''}/${ref.repo}#${ref.pr}`;
}

/** The PR references in free text — the clickable `[#N](…/pull/N)` form
 *  (which carries the repo) and the bare `#N` (which does not). The two
 *  forms of the same PR are one reference: the link's own `#N` is not a
 *  second, bare hit.
 *
 *  Only the `/pull/N` path counts — an issue link (`/issues/N`) is a
 *  different thing, and reading it as a PR would verify the wrong
 *  object. */
export function prRefs(text: string): PrRef[] {
  const links = markdownLinks(text);
  const out: PrRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...linkRefs(links), ...bareRefs(text, links)]) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

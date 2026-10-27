/**
 * Git plumbing helpers — same shell-out contract as `gh`/`bd`: the user's
 * git, their config, their credentials.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { killGroup, spawnCollect } from './live-procs.ts';

/** `git -C` must select the repo on argv alone — an inherited
 *  GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR silently retargets the probe at
 *  whatever repository the parent process was spawned inside (agent
 *  envs carry them). GIT_INDEX_FILE stays: data-ref writes use it as a
 *  private index. undefined for non-`-C` calls — inherit as usual. */
const GIT_REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const;
export const GIT_SYNC_PROBE_TIMEOUT_MS = 1_500;

function repoEnv(args: string[]): NodeJS.ProcessEnv | undefined {
  if (!args.includes('-C')) {
    return undefined;
  }
  const env = { ...process.env };
  for (const k of GIT_REPO_ENV) {
    delete env[k];
  }
  return env;
}

/** git's own argv is a command runner — `--upload-pack=cmd`,
 *  `--receive-pack=cmd`, `--exec=cmd`, a `--template` dir shipping
 *  hooks, or an `ext::` "URL" turns fetch-family plumbing into an exec
 *  of argv data. Callers feed data (dirs, refs, remote names) through
 *  these helpers, so the helper is the boundary: an arg spelling a
 *  command-runner is rejected, never forwarded to the child. `-c`/`-u`
 *  stay legal — config overrides (`-c status.showUntrackedFiles=all`)
 *  and `ls-files -u` are real call sites; `--exec` must still not eat
 *  the innocent `--exec-path`. */
const GIT_COMMAND_ARG = /^(--(upload-pack|receive-pack|exec|template)(=|$)|ext::)/;

function assertGitArgs(args: string[]): void {
  for (const a of args) {
    if (GIT_COMMAND_ARG.test(a)) {
      throw new Error(`git arg rejected — command-runner flag: ${a}`);
    }
  }
}

export function git(args: string[]): string {
  assertGitArgs(args);
  const proc = spawnSync('git', args, {
    // NOSONAR — PATH lookup is the contract (same as gh/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    env: repoEnv(args),
  });
  if (proc.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(proc.stderr ?? '').trim()}`);
  }
  return proc.stdout ?? '';
}

export function gitTry(
  args: string[],
  timeoutMs?: number
): { code: number; out: string; err: string } {
  try {
    assertGitArgs(args);
  } catch (err) {
    // fail-open contract — a rejected arg is a failure result,
    // never a throw (gitTryAsync reports the same code 128)
    return { code: 128, out: '', err: err instanceof Error ? err.message : String(err) };
  }
  const proc = spawnSync('git', args, {
    // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    env: repoEnv(args),
    timeout: timeoutMs,
  });
  // status null = spawn failure or signal, not a real verdict —
  // callers read exit 1 as one, so surface git's own fatal code
  return {
    code: proc.status ?? 128,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
  };
}

/** Async git probe — bounded and fail-open for hook paths. */
export function gitTryAsync(
  args: string[],
  timeoutMs = GIT_SYNC_PROBE_TIMEOUT_MS
): Promise<{ code: number; out: string; err: string }> {
  try {
    assertGitArgs(args);
    const { proc, done } = spawnCollect('git', args, undefined, repoEnv(args), {
      detached: true,
      envMode: 'replace',
    });
    return new Promise(resolve => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(proc);
      }, timeoutMs);
      timer.unref?.();
      void done.then(({ code, out, err }) => {
        clearTimeout(timer);
        resolve(
          timedOut
            ? { code: 124, out, err: `timed out after ${timeoutMs}ms` }
            : { code: code ?? 128, out, err }
        );
      });
    });
  } catch (err) {
    return Promise.resolve({
      code: 128,
      out: '',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

type GitCommonDirCacheEntry =
  | { value: string; expiresAt: number }
  | { value: null; expiresAt: number; budgetMs: number };
const GIT_COMMON_DIR_TIMEOUT_TTL_MS = 30_000;
const GIT_COMMON_DIR_POSITIVE_TTL_MS = 60_000;
const gitCommonDirCache = new Map<string, GitCommonDirCacheEntry>();

function cachedGitCommonDir(key: string, timeoutMs?: number): string | null | undefined {
  const cached = gitCommonDirCache.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAt <= Date.now()) {
    gitCommonDirCache.delete(key);
    return undefined;
  }
  if (cached.value === null) {
    return timeoutMs !== undefined && timeoutMs <= cached.budgetMs ? null : undefined;
  }
  if (existsSync(cached.value)) return cached.value;
  gitCommonDirCache.delete(key);
  return undefined;
}

function cacheGitCommonDir(key: string, value: string): void {
  gitCommonDirCache.set(key, {
    value,
    expiresAt: Date.now() + GIT_COMMON_DIR_POSITIVE_TTL_MS,
  });
}

/** Shared call scaffold for the common-dir twins — the resolved cache
 *  key, the shared deadline reader, and the negative-cache writer for
 *  a caller budget already spent (a timed-out probe reads as failure →
 *  null, and a LATER call with a bigger budget still gets a real
 *  probe). */
function commonDirCall(
  dir: string,
  timeoutMs?: number
): { key: string; remaining: () => number | undefined; cacheTimeout: () => boolean } {
  const key = resolve(dir);
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const remaining = (): number | undefined =>
    deadline === undefined ? undefined : deadline - Date.now();
  const cacheTimeout = (): boolean => {
    if (timeoutMs === undefined) return false;
    const rem = remaining();
    if (rem === undefined || rem > 0) {
      return false;
    }
    // a racing sibling probe that already answered owns the entry — a
    // timed-out write must not replace its success with 30s of "no repo"
    const cur = gitCommonDirCache.get(key);
    if (cur !== undefined && cur.value !== null && cur.expiresAt > Date.now()) {
      return true;
    }
    gitCommonDirCache.set(key, {
      value: null,
      expiresAt: Date.now() + GIT_COMMON_DIR_TIMEOUT_TTL_MS,
      budgetMs: timeoutMs,
    });
    return true;
  };
  return { key, remaining, cacheTimeout };
}

/** A fallback answer is relative to `dir` — resolve() absolutizes it
 *  the same way `--path-format=absolute` does, but keeps a symlinked
 *  dir's alias, and callers hash the result (busSocketPath) —
 *  canonicalize so one repo yields one socket. */
function cacheResolvedCommon(key: string, dir: string, common: string): string {
  const abs = resolve(dir, common);
  try {
    const canonical = realpathSync(abs);
    cacheGitCommonDir(key, canonical);
    return canonical;
  } catch {
    cacheGitCommonDir(key, abs);
    return abs;
  }
}

/** The repo's common git dir, absolute — the one place per-repo runtime
 *  state belongs, so linked worktrees resolve to the SAME directory
 *  instead of each getting its own copy. `--path-format=absolute` keeps
 *  it absolute even when git would print a relative `.git`. null outside
 *  a repository, and on git failure: callers treat "no repo" as an
 *  ordinary state, never a throw. Canonical probe for the several
 *  features that keep re-inlining it (agents registry, mailbox, serve
 *  state, broker socket). `timeoutMs` bounds the CALL, not each probe —
 *  an advisory caller pointing at a possibly-stalled mount passes one
 *  so the check degrades instead of hanging (a timed-out probe reads
 *  as failure → null, same contract). The deadline is shared: a
 *  primary probe that burns the whole budget buys no fallback. */
export function gitCommonDir(dir: string, timeoutMs?: number): string | null {
  const call = commonDirCall(dir, timeoutMs);
  const cached = cachedGitCommonDir(call.key, timeoutMs);
  if (cached !== undefined) return cached;
  const r = gitTry(
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    call.remaining()
  );
  if (r.code === 0) {
    const common = r.out.trim();
    if (common === '') {
      call.cacheTimeout();
      return null;
    }
    cacheGitCommonDir(call.key, common);
    return common;
  }
  // --path-format arrived in git 2.31: on older git the option itself
  // fails, which must not read as "not a repository".
  if (call.cacheTimeout()) {
    return null;
  }
  const fallback = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'], call.remaining());
  const common = fallback.code === 0 ? fallback.out.trim() : '';
  if (common === '') {
    call.cacheTimeout();
    return null;
  }
  return cacheResolvedCommon(call.key, dir, common);
}

/** Async `gitCommonDir` — the probe-path twin (spec bro-36sx7.2): the
 *  sync form's spawnSync freezes a parallel hook sweep, so async
 *  callers (hook probes, the act connector's watch reads) take this
 *  one. Same cache, same shared-deadline semantics; each probe also
 *  carries gitTryAsync's own bound, so an unbudgeted call still
 *  degrades instead of parking the sweep on a stalled mount. */
export async function gitCommonDirAsync(dir: string, timeoutMs?: number): Promise<string | null> {
  const call = commonDirCall(dir, timeoutMs);
  const cached = cachedGitCommonDir(call.key, timeoutMs);
  if (cached !== undefined) return cached;
  const r = await gitTryAsync(
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    call.remaining()
  );
  if (r.code === 0) {
    const common = r.out.trim();
    if (common === '') {
      call.cacheTimeout();
      return null;
    }
    cacheGitCommonDir(call.key, common);
    return common;
  }
  if (call.cacheTimeout()) {
    return null;
  }
  const fallback = await gitTryAsync(
    ['-C', dir, 'rev-parse', '--git-common-dir'],
    call.remaining()
  );
  const common = fallback.code === 0 ? fallback.out.trim() : '';
  if (common === '') {
    call.cacheTimeout();
    return null;
  }
  return cacheResolvedCommon(call.key, dir, common);
}

/** This worktree's own git dir, absolute — `<repo>/.git` on the main
 *  checkout, `<common>/worktrees/<name>` on a linked one, so
 *  per-worktree state dies with `git worktree remove`. The `--git-dir`
 *  sibling of gitCommonDir (`--git-common-dir` is the SHARED dir).
 *  null outside a repository or on git failure. */
export function worktreeGitDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir']);
  if (r.code === 0 && r.out.trim() !== '') {
    return r.out.trim();
  }
  const f = gitTry(['-C', dir, 'rev-parse', '--git-dir']);
  const p = f.code === 0 ? f.out.trim() : '';
  return p === '' ? null : resolve(dir, p);
}

/** C-style unquote for porcelain paths — git wraps a path carrying
 *  specials in `"…"` with `\"`, `\\`, the `\a\b\f\n\r\t\v` escapes,
 *  and `\NNN` octal BYTES for non-ASCII. JSON.parse can't read the
 *  octal form (its \uXXXX is code units, not bytes), so the octal
 *  decode is by hand: escapes → bytes → UTF-8, and `f\303\244o`
 *  comes back `fäo` rather than literal backslashes. */
export function unquoteGitPath(raw: string): string {
  const escapes: Record<string, number> = {
    '"': 0x22,
    '\\': 0x5c,
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  };
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '\\' && i + 1 < inner.length) {
      const n = inner[i + 1]!;
      if (n >= '0' && n <= '7') {
        const oct = /^[0-7]{1,3}/.exec(inner.slice(i + 1))![0];
        bytes.push(parseInt(oct, 8) & 0xff);
        i += oct.length;
        continue;
      }
      bytes.push(escapes[n] ?? n.charCodeAt(0));
      i += 1;
      continue;
    }
    for (const b of Buffer.from(c, 'utf8')) {
      bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The MAIN worktree's root, absolute — linked worktrees share the
 *  repo's common dir, but an anchor that must outlive any one checkout
 *  (a serve's recorded dir, a respawned process's cwd) belongs to the
 *  primary tree. From inside the main worktree `own === common` and
 *  `--show-toplevel` answers directly — the one branch that needs no
 *  layout assumption at all. From a linked checkout a `.git` FILE
 *  claiming `gitdir: <common>` is the only link to the real checkout
 *  when the gitdir was moved (`--separate-git-dir`): git keeps no
 *  back-pointer, `worktree list` reports the gitdir's parent (named
 *  `.git`) or the gitdir itself (any other name) — both wrong. The
 *  marker scan runs before the positional `<main>/.git` shortcut
 *  because a moved gitdir named `.git` verifies that same guess
 *  falsely — its parent is no checkout. Linked worktrees' markers name
 *  `common/worktrees/<n>`, never common itself, so a match is
 *  unambiguous. `worktree list` stays last resort; a bare first record
 *  or the common dir itself is not a checkout — null there so callers
 *  keep their own dir. */
export function mainWorktreeRoot(dir: string): string | null {
  const common = gitCommonDir(dir);
  if (common === null) {
    return null;
  }
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const own = worktreeGitDir(dir);
  if (own !== null && real(own) === real(common)) {
    const top = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel']);
    if (top.code === 0 && top.out.trim() !== '') {
      return top.out.trim();
    }
  }
  const marked = checkoutByMarker(dirname(common), common, real, 3);
  if (marked !== null) {
    return marked;
  }
  if (basename(common) === '.git') {
    const candidate = dirname(common);
    const theirs = worktreeGitDir(candidate);
    if (theirs !== null && real(theirs) === real(common)) {
      return candidate;
    }
    // an external gitdir literally named `.git` — its parent is not a
    // worktree; the fallback below answers what git itself reports
  }
  return worktreeListMain(dir, common, real);
}

/** `git worktree list`'s first record — the main worktree as git
 *  itself reports it, the last resort when neither the marker scan
 *  nor the `.git`-parent shortcut settled the anchor. `-z` terminates
 *  every FIELD with NUL, so a record ends with an empty field
 *  (`\0\0`); the plain form C-quotes paths carrying specials. null
 *  when the first record is bare or IS the common dir — a moved
 *  gitdir reports itself, and git storage is no anchor either way. */
function worktreeListMain(dir: string, common: string, real: (p: string) => string): string | null {
  const z = gitTry(['-C', dir, 'worktree', 'list', '--porcelain', '-z']);
  if (z.code === 0 && z.out.startsWith('worktree ')) {
    const recordEnd = z.out.indexOf('\0\0');
    const fields = z.out.slice(0, recordEnd === -1 ? undefined : recordEnd).split('\0');
    if (fields.includes('bare')) {
      return null;
    }
    const first = fields[0]!.slice('worktree '.length);
    return real(first) === real(common) ? null : first;
  }
  // no -z support (pre-2.36 git): the same first record, possibly
  // C-quoted when the path carries specials
  const p = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']);
  const firstRecord = p.code === 0 ? (p.out.split(/\r?\n\r?\n/, 1)[0] ?? '') : '';
  const m = /^worktree (.+)$/m.exec(firstRecord);
  if (m === null || firstRecord.split(/\r?\n/).includes('bare')) {
    return null;
  }
  const raw = m[1]!.trim();
  const answer = raw.startsWith('"') && raw.endsWith('"') ? unquoteGitPath(raw) : raw;
  return real(answer) === real(common) ? null : answer;
}

/** Every worktree checkout's root — `git worktree list` records, main
 *  first, bare records dropped (a bare repo's own entry is git storage,
 *  not a checkout; its LINKED worktrees still count). `-z` terminates
 *  fields with NUL so a path carrying specials survives verbatim; the
 *  plain form C-quotes them — unquoteGitPath decodes. [] outside a
 *  repository or on git failure — callers read "no siblings" and keep
 *  their own dir. */
export function gitWorktreeRoots(dir: string): string[] {
  const z = gitTry(['-C', dir, 'worktree', 'list', '--porcelain', '-z']);
  if (z.code === 0) {
    return z.out
      .split('\0\0')
      .map(worktreeRootZ)
      .filter((r): r is string => r !== null);
  }
  // no -z support (pre-2.36 git): records split on blank lines, paths
  // C-quoted when they carry specials
  const p = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']);
  if (p.code !== 0) {
    return [];
  }
  return p.out
    .split(/\r?\n\r?\n/)
    .map(worktreeRootPlain)
    .filter((r): r is string => r !== null);
}

/** One `-z` porcelain record (fields NUL-joined) → its checkout root;
 *  null for a bare record or a fragment that isn't a record head. */
function worktreeRootZ(rec: string): string | null {
  const fields = rec.split('\0');
  const head = fields.find(f => f !== '');
  if (head === undefined || !head.startsWith('worktree ') || fields.includes('bare')) {
    return null;
  }
  return head.slice('worktree '.length);
}

/** One plain porcelain record → its checkout root — the bare record
 *  drops out; the `worktree` line's C-quoting decodes. */
function worktreeRootPlain(rec: string): string | null {
  const m = /^worktree (.+)$/m.exec(rec);
  if (m === null || rec.split(/\r?\n/).includes('bare')) {
    return null;
  }
  const raw = m[1]!.trim();
  return raw.startsWith('"') && raw.endsWith('"') ? unquoteGitPath(raw) : raw;
}

/** Depth-bounded search under `root` for a directory whose `.git` FILE
 *  claims `gitdir: <common>` — the marker a moved gitdir's real
 *  checkout carries. Directories holding their own `.git` entry (some
 *  checkout — the answer never nests inside another worktree), the
 *  common dir itself, and dependency trees are pruned. null when
 *  nothing claims the gitdir. */
function checkoutByMarker(
  root: string,
  common: string,
  real: (p: string) => string,
  depth: number
): string | null {
  if (depth < 0) {
    return null;
  }
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  // the comparison target is loop-invariant — canonicalize it once
  // per level, not once per directory entry
  const realCommon = real(common);
  const descend: string[] = [];
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') {
      continue;
    }
    const sub = join(root, name);
    const verdict = markerVerdict(sub, realCommon, real);
    if (verdict === 'hit') {
      return sub;
    }
    if (verdict === 'descend') {
      descend.push(sub);
    }
  }
  for (const sub of descend) {
    const hit = checkoutByMarker(sub, common, real, depth - 1);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

/** One entry's verdict under the marker scan: `hit` — its `.git` FILE
 *  claims the common dir, the moved gitdir's checkout found;
 *  `descend` — no readable `.git` entry, a checkout may nest below;
 *  `prune` — not a directory, the common dir itself, a checkout of
 *  its own (`.git` dir), or a worktree of some other repo — the
 *  answer never nests inside either. */
function markerVerdict(
  sub: string,
  realCommon: string,
  real: (p: string) => string
): 'hit' | 'descend' | 'prune' {
  try {
    if (!statSync(sub).isDirectory() || real(sub) === realCommon) {
      return 'prune';
    }
  } catch {
    return 'prune'; // unreadable entry — skip
  }
  const marker = join(sub, '.git');
  try {
    if (!statSync(marker).isFile()) {
      return 'prune'; // .git dir — sub is a checkout; prune
    }
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
    return m !== null && real(resolve(sub, m[1].trim())) === realCommon ? 'hit' : 'prune';
  } catch {
    return 'descend'; // no readable .git — a checkout may nest below
  }
}

/** The drift comparison ref — landed spec vs landed code, so a feature
 *  branch's own commits can't flag the spec it's about to update.
 *  Chain: `origin/HEAD` → local `main`/`master` → remote-tracking
 *  `origin/main`/`master` (a remote checkout with no local default
 *  branch) → `HEAD` (solo and no-remote repos). null when nothing
 *  resolves to a commit — unborn history is the caller's
 *  `unverifiable`, not a throw. Qualified refs so a tag named `main`
 *  can't shadow (or fake) the branch — `rev-parse` resolves
 *  refs/tags/ before refs/heads/. */
export function gitDriftRef(dir: string): string | null {
  for (const cand of [
    'refs/remotes/origin/HEAD',
    'refs/heads/main',
    'refs/heads/master',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'HEAD',
  ]) {
    const r = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
    if (r.code === 0) {
      return cand;
    }
  }
  return null;
}

/** One commit's identity plus its committer date — `iso` (%cI) is for
 *  display, `ts` (%ct epoch seconds) is for ordering: strict-ISO
 *  strings don't sort across differing timezone offsets. */
export interface GitStamp {
  sha: string;
  iso: string;
  ts: number;
}

export type GitLogStamp =
  | { state: 'commit'; stamp: GitStamp }
  | { state: 'none' } // log ran clean — nothing on <ref> touched the paths
  | { state: 'error'; err: string }; // bad ref, unborn history, git failure

/** `git log -1` over pathspecs — the newest commit on `ref` touching
 *  any of them. `follow` opts into rename-following (spec side: a
 *  renamed spec isn't freshly written — `-M100% --diff-filter=r` drops
 *  the pure-rename commit so the stamp is the last content write, not
 *  the move; a rename that also edited content is below the similarity
 *  threshold, reads as a rewrite, and stamps that commit); git only
 *  honours it for a single path, so the scope side never passes it.
 *  Pathspecs are argv entries verbatim — magic like `:(exclude…)` is
 *  the caller's. */
export function gitLogStamp(
  dir: string,
  ref: string,
  pathspecs: string[],
  opts?: { follow?: boolean }
): GitLogStamp {
  if (pathspecs.length === 0) {
    // `git log ref --` with no pathspecs audits the whole repo —
    // silent widening, so an empty scope is an error, never fresh data
    return { state: 'error', err: 'empty pathspecs' };
  }
  const args = ['-C', dir, 'log', '-1', '--format=%H%x09%cI%x09%ct'];
  if (opts?.follow === true) {
    args.push('--follow', '-M100%', '--diff-filter=r');
  }
  args.push('--end-of-options', ref, '--', ...pathspecs);
  const r = gitTry(args);
  if (r.code !== 0) {
    return { state: 'error', err: r.err };
  }
  const line = r.out.trim();
  if (line === '') {
    return { state: 'none' };
  }
  const [sha = '', iso = '', ts = ''] = line.split('\t');
  const epoch = ts === '' ? Number.NaN : Number(ts);
  if (sha === '' || Number.isNaN(epoch)) {
    return { state: 'error', err: `unparseable git log line: ${line}` };
  }
  return { state: 'commit', stamp: { sha, iso, ts: epoch } };
}

/** The commit messages `head` carries since it forked from `baseRef` —
 *  `git log --format=%B <merge-base>..<head>` tried against
 *  `origin/<base>` first, then the local ref (a PR's base may exist
 *  only remote-side). `headSha === ''` means the local tip; a pushed
 *  head that isn't fetched (a remote-only update-branch commit) falls
 *  back to `HEAD`. `dir` scopes the calls — linked worktrees share the
 *  object db, so any checkout of the repo resolves the same objects;
 *  undefined runs in cwd. '' when no merge-base or log resolves —
 *  callers read that as "the log is unknown", never as a clean answer. */
export function gitBranchLog(headSha: string, baseRef: string, dir?: string): string {
  const scoped = dir === undefined ? [] : ['-C', dir];
  for (const head of headSha === '' ? ['HEAD'] : [headSha, 'HEAD']) {
    for (const ref of [`origin/${baseRef}`, baseRef]) {
      const mb = gitTry([...scoped, 'merge-base', head, ref]);
      if (mb.code !== 0 || !mb.out.trim()) {
        continue;
      }
      const log = gitTry([...scoped, 'log', '--format=%B', `${mb.out.trim()}..${head}`]);
      if (log.code === 0) {
        return log.out;
      }
    }
  }
  return '';
}

/** `git merge-base --is-ancestor` — the drift tie-break: equal
 *  committer timestamps on different SHAs resolve by ancestry (scope
 *  commit predating the spec commit is fresh). null when git can't
 *  answer (unknown object) — the caller treats that as unverifiable. */
export function gitIsAncestor(dir: string, ancestor: string, descendant: string): boolean | null {
  const r = gitTry(['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant]);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** Shallow check — boundary commits masquerade as roots, so a
 *  path-limited log can attribute spec and scope to the same boundary
 *  commit and fake `fresh`. null on git failure. */
export function gitIsShallow(dir: string): boolean | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--is-shallow-repository']);
  return r.code === 0 ? r.out.trim() === 'true' : null;
}

/** One commit of a `git log --name-only` pass — `paths` is every file
 *  the commit touched. */
export interface GitLogPathRecord {
  sha: string;
  subject: string;
  paths: string[];
}

/** The scan's wall-clock bound — hooks host these probes on a 10–25s
 *  budget (spec: bro-nkn6, "probes must be argv-git/file reads with
 *  their own bounds"), and a full-history `--name-only` walk on a large
 *  repo is the one read that can blow it. Overrun returns null — the
 *  caller's `unverifiable`, never a stalled hook. */
const LOG_SCAN_TIMEOUT_MS = 10_000;

/** `git log --format=%x1e%H%x09%s -z --name-only <ref>` parsed into
 *  per-commit records — callers filter subjects in-process (`--grep`
 *  would search bodies too). Each header is framed by the \x1e record
 *  separator, so a filename that happens to look like `<sha>\t<subject>`
 *  can't pose as a commit. Output is unbounded (full history × touched
 *  paths), so spawnSync gets explicit caps — a 256 MB buffer and a
 *  LOG_SCAN_TIMEOUT_MS wall clock — rather than the 1 MB/unbounded
 *  defaults. null on git failure or overrun — the caller decides the
 *  honest state (unborn ref, bad ref). */
export function gitLogPathRecords(
  dir: string,
  ref: string,
  opts?: { timeoutMs?: number }
): GitLogPathRecord[] | null {
  const args = [
    '-C',
    dir,
    'log',
    '--format=%x1e%H%x09%s',
    '-z',
    '--name-only',
    '--end-of-options',
    ref,
  ];
  const proc = spawnSync('git', args, {
    // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? LOG_SCAN_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    env: repoEnv(args),
  });
  if (proc.status !== 0) {
    return null;
  }
  const records: GitLogPathRecord[] = [];
  let cur: GitLogPathRecord | undefined;
  for (const tok of (proc.stdout ?? '').split('\0')) {
    if (tok === '') {
      continue;
    }
    if (tok.charCodeAt(0) === 0x1e) {
      const tab = tok.indexOf('\t');
      cur = { sha: tok.slice(1, tab), subject: tok.slice(tab + 1), paths: [] };
      records.push(cur);
    } else if (cur !== undefined) {
      cur.paths.push(tok.replace(/^\n/, ''));
    }
  }
  return records;
}

/** How far the checkout trails its recorded upstream — `@{u}` resolves
 *  the branch's configured tracking ref, `rev-list --count` the drift.
 *  Strictly LOCAL — the remote-tracking ref is only as fresh as the
 *  last fetch, and surfacing exactly that staleness is the point (a
 *  stale main fabricates phantom reverts — bro-6k3f4); fetching here
 *  would turn a board/hook read into a network call. null when there
 *  is no upstream, the count fails, or the checkout is current —
 *  callers surface positive drift only. */
export function gitUpstreamBehind(dir: string): { behind: number; upstream: string } | null {
  const up = gitTry(['-C', dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = up.code === 0 ? up.out.trim() : '';
  if (upstream === '') {
    return null;
  }
  const n = gitTry(['-C', dir, 'rev-list', '--count', 'HEAD..@{u}']);
  const behind = n.code === 0 ? Number.parseInt(n.out.trim(), 10) : Number.NaN;
  return Number.isFinite(behind) && behind > 0 ? { behind, upstream } : null;
}

/** Async twin of gitUpstreamBehind for hook probes. */
export async function gitUpstreamBehindAsync(
  dir: string
): Promise<{ behind: number; upstream: string } | null> {
  const up = await gitTryAsync([
    '-C',
    dir,
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const upstream = up.code === 0 ? up.out.trim() : '';
  if (upstream === '') {
    return null;
  }
  const n = await gitTryAsync(['-C', dir, 'rev-list', '--count', `HEAD..${upstream}`]);
  if (n.code !== 0) {
    return null;
  }
  const behind = Number(n.out.trim());
  return Number.isFinite(behind) && behind > 0 ? { behind, upstream } : null;
}

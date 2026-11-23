/**
 * tmp-dir sweep — the shared reaper behind `bro cleanup` and
 * `bro work prune` (spec bro-d9znu). `/tmp` is a small tmpfs on this
 * fleet; stale `tmp-*`/`npm-*`/`npx-*`/`node-*`/`bro-published-*`
 * directories accumulate from killed processes (nx daemons' `nx@latest`
 * probe installs, aborted publish-surface probes) until the filesystem
 * is full.
 *
 * Safety contract: only directories owned by the current uid are
 * candidates. `tmp-<pid>-*` names (the `tmp` npm package's `dirSync`
 * shape — nx's daemon embeds its own pid) are governed by owner
 * liveness: alive owner keeps, dead owner is reaped after
 * `DEAD_OWNER_GRACE_MS` (10min). Everything else keeps the original
 * `bro cleanup` contract — older than `STALE_MS` (1h) and untouched by
 * any live `/proc` fd/cwd/root/exe.
 *
 * The /proc scan is positive-evidence only: on ptrace_scope≥1 hosts we
 * can inspect just our own descendants' fd tables, so 'unverifiable'
 * (unreadable fd table — every foreign-uid process, plus same-uid
 * session daemons) cannot be allowed to block or the sweep is a no-op.
 * It blocks deletion only for group/other-accessible dirs, where a
 * process we cannot inspect could legitimately sit inside; uid-private
 * 0700 dirs have no such holder. Owner liveness on `tmp-<pid>-*` names
 * is the stronger signal the scan cannot provide — it is what keeps a
 * live nx daemon's `nx@latest` install safe (spec bro-d9znu).
 *
 * One more guard sits between the verdict and rm: a 'delete' candidate
 * must prove its whole tree sits on one device (spec bro-wb8wf).
 * rmSync(recursive) descends a filesystem mounted inside a stale dir
 * and deletes foreign-device content — the mount scan fails CLOSED,
 * so anything it cannot prove keeps the dir.
 */
import {
  type Dir,
  type Dirent,
  lstatSync,
  opendirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  acquireAgentRegistryLock,
  type AgentRegistryEntry,
  agentRegistryPath,
  gitCommonDir,
  pidAlive,
  readAgentRegistryFile,
} from '@broject/core';
import { registryEntryHoldsClaim } from '@broject/rig';

const STALE_MS = 60 * 60 * 1000; // 1 hour
/** Dead-owner dirs get a shorter leash than the general TTL: the
 *  creator is gone, so only a grace period against path-passing races
 *  (a child handed the dir by path, not yet holding an fd) remains. */
const DEAD_OWNER_GRACE_MS = 10 * 60 * 1000;

/** Bro-owned and package-manager temp prefixes. `bro-published-*` is
 *  the publish-surface probe fixture (scripts/published-surface.ts);
 *  the rest are the shapes npx/npm/node and the `tmp` package leave. */
const TARGET_PATTERNS = [/^tmp-/, /^npm-/, /^npx-/, /^node-/, /^bro-published-/];

/** `tmp-<pid>-<rand>` — the `tmp` package's default dirSync name. The
 *  pid is the creating process's; anything else under `tmp-` (mkdtemp's
 *  `tmp-XXXXXX`) carries no owner and stays TTL-only. */
const TMP_PID_RE = /^tmp-(\d+)-/;

export interface TmpSweepInput {
  isDir: boolean;
  /** st.uid === current uid — foreign-owned entries are never ours to take */
  ownedByUs: boolean;
  /** dir age in ms */
  ageMs: number;
  /** pid parsed from a `tmp-<pid>-*` name; null when the name carries none */
  ownerPid: number | null;
  /** pidAlive(ownerPid) — consulted only when ownerPid is set; a live or
   *  unverifiable pid reads true and keeps the TTL path */
  ownerAlive: boolean;
  /** lazy /proc scan — invoked only past the age gate, never for young dirs */
  inUse: () => boolean;
}

export type TmpSweepVerdict = 'delete' | 'keep' | 'skip';

/** The per-entry decision, pure so the rule is unit-testable without
 *  touching /tmp or /proc.
 *
 *  `tmp-<pid>-*` names carry their creator's pid, and owner liveness is
 *  the use signal the /proc scan cannot provide: on ptrace_scope≥1
 *  hosts we can only inspect our own descendants' fd tables, so a live
 *  owner's temp dir (an nx daemon's `nx@latest` install) reads
 *  unverifiable and would be deleted out from under it. Alive owner →
 *  keep, dead owner → delete once past the grace. Pid-less patterns
 *  (`bro-published-*`, `npm-*`, `npx-*`, `node-*`, mkdtemp `tmp-*`)
 *  have no owner signal: the 1h TTL plus a positive-evidence in-use
 *  check carries them. */
export function tmpSweepVerdict(f: TmpSweepInput): TmpSweepVerdict {
  if (!f.isDir || !f.ownedByUs) {
    return 'skip';
  }
  if (f.ownerPid !== null) {
    return ownerPidVerdict(f);
  }
  return ttlVerdict(f);
}

/** `tmp-<pid>-*` names: alive owner keeps unconditionally, dead owner
 *  gets the shorter grace before the in-use check. */
function ownerPidVerdict(f: TmpSweepInput): TmpSweepVerdict {
  if (f.ownerAlive) {
    return 'keep';
  }
  if (f.ageMs < DEAD_OWNER_GRACE_MS) {
    return 'skip';
  }
  return f.inUse() ? 'keep' : 'delete';
}

/** Pid-less patterns: the 1h TTL, then the positive-evidence in-use
 *  check — a failed/absent scan reads 'in use' inside isPathInUse. */
function ttlVerdict(f: TmpSweepInput): TmpSweepVerdict {
  if (f.ageMs < STALE_MS) {
    return 'skip';
  }
  return f.inUse() ? 'keep' : 'delete';
}

function isVanished(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isPermission(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function linkMatches(linkPath: string, candidate: string): 'use' | 'none' | 'unverifiable' {
  try {
    const resolved = canonicalPath(readlinkSync(linkPath));
    if (resolved === candidate || resolved.startsWith(`${candidate}/`)) {
      return 'use';
    }
    return 'none';
  } catch (err) {
    if (isVanished(err)) return 'none';
    if (isPermission(err)) return 'unverifiable';
    return 'none';
  }
}

function processUsesPath(pidDir: string, candidate: string): 'use' | 'none' | 'unverifiable' {
  let fds: string[];
  try {
    fds = readdirSync(join(pidDir, 'fd'));
  } catch (err) {
    if (isVanished(err)) return 'none';
    return 'unverifiable';
  }
  for (const fd of fds) {
    const result = linkMatches(join(pidDir, 'fd', fd), candidate);
    if (result !== 'none') return result;
  }
  for (const name of ['cwd', 'root', 'exe']) {
    const result = linkMatches(join(pidDir, name), candidate);
    if (result !== 'none') return result;
  }
  return 'none';
}

/** Owner uid of a /proc/<pid> dir, or null when it cannot be read —
 *  the dir's own metadata is world-readable even when the process's
 *  fd table is not. */
function procOwnerUid(pidDir: string): number | null {
  try {
    return statSync(pidDir).uid;
  } catch {
    return null;
  }
}

/** The sweep runner's own uid — undefined when userInfo can't answer
 *  (every pid then scans, the old conservative behavior). */
function ourUid(): number | undefined {
  try {
    return userInfo().uid;
  } catch {
    return undefined;
  }
}

/** The foreign-uid gate for one /proc/<pid>: 'veto' — a foreign
 *  process on a group/other-accessible dir keeps the candidate
 *  outright (its fd table is unreadable by construction, so the scan
 *  could never prove 'none'); 'skip' — uid-private dirs can't host a
 *  foreign holder; 'scan' — same-uid or unknown owner, inspect. */
type ForeignGate = 'scan' | 'skip' | 'veto';

function foreignGate(pidDir: string, uid: number | undefined, accessible: boolean): ForeignGate {
  if (uid === undefined) {
    return 'scan';
  }
  const owner = procOwnerUid(pidDir);
  if (owner === null || owner === uid) {
    return 'scan';
  }
  return accessible ? 'veto' : 'skip';
}

/** True when any live process holds the path open (fd, cwd, root, or
 *  exe). Non-Linux hosts and unreadable /proc answer "in use" — the
 *  sweep errs toward keeping.
 *
 *  Foreign-uid processes are skipped for uid-private candidates: the
 *  package-manager/tmp-package dirs this sweep targets are mode 0700,
 *  so a foreign process cannot legitimately sit inside one — and its
 *  fd table is unreadable anyway, which used to read as 'unverifiable'
 *  and kept EVERY candidate forever (root daemons alone made the sweep
 *  a no-op, spec bro-d9znu). A group/other-accessible dir could host a
 *  foreign process, so those stay conservative: unverifiable keeps. */
export function isPathInUse(path: string, procDir: string = '/proc'): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  const candidate = canonicalPath(path);
  let foreignAccessible = true;
  try {
    foreignAccessible = (statSync(path).mode & 0o077) !== 0;
  } catch {
    // mode unreadable — stay conservative
  }
  const uid = ourUid();
  let pids: string[];
  try {
    pids = readdirSync(procDir).filter((p: string) => /^\d+$/.test(p));
  } catch {
    return true;
  }
  for (const pid of pids) {
    const pidDir = join(procDir, pid);
    const gate = foreignGate(pidDir, uid, foreignAccessible);
    if (gate === 'veto') {
      return true;
    }
    if (gate === 'skip') {
      continue;
    }
    const result = processUsesPath(pidDir, candidate);
    if (result === 'use') {
      return true;
    }
    // 'unverifiable' only blocks on a group/other-accessible dir: a
    // process we cannot inspect (non-descendant under ptrace_scope, or
    // foreign uid) could legitimately sit inside a shared dir, but a
    // 0700 tmp dir has no such holder — counting it kept EVERY
    // candidate forever (spec bro-d9znu)
    if (result === 'unverifiable' && foreignAccessible) {
      return true;
    }
  }
  return false;
}

export interface TmpSweepOptions {
  /** suppress per-dir `keep` lines — the noise floor when a supervisor
   *  relays this output (drive's `work prune --loop` child). Deleted and
   *  summary lines still print. */
  quietKeeps?: boolean;
  /** Extra roots swept under the same verdict — the worker tmpdirs the
   *  spawn pins point at (spec bro-v96mp, workerTmpRoots). A root that
   *  cannot be listed warns and is skipped, never fatal like tmpdir. */
  extraRoots?: string[];
  /** mount-scan dev probe — test seam only (spec bro-wb8wf). Real
   *  mounts need privileges a test lacks; faking one path's st_dev
   *  simulates the boundary. */
  lstat?: DevProbe;
}

/** Direct child directory names, [] on any listing failure — a sweep
 *  helper never dies on a vanished tree. A missing base is routine
 *  (most worktrees grow no bro-tmp, and an absent `worktrees/` dir is
 *  the common case), so ENOENT stays quiet; a real failure — EACCES,
 *  EIO — silently skipping a base would hide worker roots from the
 *  sweep entirely, so it warns the same way an unlistable root does
 *  and the remaining bases still sweep. */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch (err) {
    if (!isVanished(err)) {
      console.error(
        `cleanup: cannot list ${dir} (${err instanceof Error ? err.message : err}) — skipped`
      );
    }
    return [];
  }
}

/** Every worker tmpdir the connector's TMPDIR pin can write to
 *  (spec bro-v96mp): `<common>/bro-tmp/<agentId>` for the main
 *  checkout, plus each linked worktree's
 *  `<common>/worktrees/<n>/bro-tmp/<agentId>`. Inside an agentId dir
 *  sit the same `tmp-*`/`npm-*` leaf shapes os.tmpdir() collects — so
 *  each one is a sweep root, not a candidate itself. `dir` is any
 *  path in the repo; outside one the answer is []. */
export function workerTmpRoots(dir: string): string[] {
  const common = gitCommonDir(dir);
  if (common === null) {
    return [];
  }
  const bases = [join(common, 'bro-tmp')];
  for (const wt of listDirs(join(common, 'worktrees'))) {
    bases.push(join(common, 'worktrees', wt, 'bro-tmp'));
  }
  const roots: string[] = [];
  for (const base of bases) {
    for (const agent of listDirs(base)) {
      roots.push(join(base, agent));
    }
  }
  return roots;
}

/** `rmdir` only — a root that refilled (or never emptied) stays. The
 *  emptied `<agentId>` shell is litter of the same class as its
 *  contents. */
function rmdirIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // not empty / gone / not ours — all keeps
  }
}

/** The emptied extra-root's owner verdict (spec bro-v96mp). A
 *  `bro-tmp/<agentId>` shell is a live worker's pinned TMPDIR — the
 *  leaf sweep can empty it while the worker still runs, and rmdir'ing
 *  it out from under the worker makes its next mkdtemp die ENOENT,
 *  worse than the litter the shell held. 'live' — a registry agent
 *  still holding its claim owns the shell; 'free' — the registry
 *  proves no owner (or none exists — orphan litter); 'unknown' —
 *  nothing could be proved, the fail-open verdict. `regPath` is the
 *  agents.json the caller resolved — passed in so a failed git probe
 *  can answer 'unknown' instead of masquerading as an empty registry
 *  (readAgentRegistry answers {} on a probe failure — 'free' over a
 *  live worker's shell is exactly the ENOENT race above). */
function rootOwnerVerdict(root: string, regPath: string): 'live' | 'free' | 'unknown' {
  let reg: Record<string, AgentRegistryEntry>;
  try {
    reg = readAgentRegistryFile(regPath);
  } catch {
    // a corrupt/unreadable registry can't prove orphan — keep
    return 'unknown';
  }
  const agentId = basename(root);
  const home = join(dirname(regPath), 'agents');
  for (const e of Object.values(reg)) {
    if (e.agentId === agentId && registryEntryHoldsClaim(home, e)) {
      return 'live';
    }
  }
  return 'free';
}

/** rmdir an emptied extra root only when nothing can still write to
 *  it (spec bro-v96mp). Two keeps before the rmdir: a dir mtime inside
 *  the TTL — something just created or drained entries (this pass's
 *  own leaf deletes included — an emptied shell earns one stale
 *  window before it goes), and a live registry owner. A stale shell
 *  with no live owner is the litter the PIN meant for `git worktree
 *  remove` — this reap is only for what outlived its tree. */
function rmdirRootIfOrphaned(root: string, ctx: RootCtx): void {
  try {
    if (ctx.now - statSync(root).mtimeMs < STALE_MS) {
      return;
    }
  } catch {
    return; // vanished or unreadable — nothing to prove against
  }
  const gitdir = dirname(dirname(root));
  // the registry path resolves BEFORE the lock — a probe that cannot
  // answer is 'unknown' (keep), never the empty-registry 'free' a
  // failed read would fake; and a stalled git must not hold the
  // spawn-side lock a probe would sit inside
  const regPath = agentRegistryPath(gitdir);
  if (regPath === null) {
    return;
  }
  // verdict + rmdir under the same registry lock a spawn holds: a claim
  // that lands between 'free' and the rmdir would pin TMPDIR at a shell
  // the sweep then deletes — the worker's next mkdtemp dies ENOENT.
  // A lock failure keeps the root — an unreaped empty shell is cheaper
  // than a dead worker.
  let release: (() => void) | undefined;
  try {
    release = acquireAgentRegistryLock(gitdir, { waitMs: 2_000 });
  } catch {
    return; // contention or no registry to lock — nothing proven, keep
  }
  try {
    // re-prove staleness inside the lock — the early check sampled
    // mtime BEFORE the lock wait (up to 2s of contention), and a root
    // that filled and drained in between carries a fresh mtime the
    // stale sample can't see; rmdir'ing on it strands the very writes
    // that refreshed it
    let mtimeMs: number;
    try {
      mtimeMs = statSync(root).mtimeMs;
    } catch {
      return; // vanished or unreadable under the lock — nothing to remove
    }
    if (ctx.now - mtimeMs < STALE_MS) {
      return;
    }
    if (rootOwnerVerdict(root, regPath) === 'free') {
      rmdirIfEmpty(root);
    }
  } finally {
    release();
  }
}

/** Shared sweep context — everything a per-entry decision needs that
 *  doesn't vary across the listing. */
interface SweepCtx {
  tmp: string;
  now: number;
  currentUid: number | undefined;
  dryRun: boolean;
  quietKeeps: boolean;
  inUseMessage: string;
  /** mount-scan dev probe — the test seam for faking a second
   *  filesystem; production leaves it undefined (lstatSync). */
  lstat?: DevProbe;
}

function logKeep(fullPath: string, reason: string, quietKeeps: boolean): void {
  if (!quietKeeps) {
    console.log(`  keep ${fullPath} (${reason})`);
  }
}

/** The pre-delete mount scan's probe — lstat, not stat: rm unlinks a
 *  symlink in place, so only an entry's OWN device can sit on a mount
 *  boundary, and `isSymbolicLink` is what proves a candidate root is
 *  such a link (vacuously clean — its target is never descended).
 *  Injectable so a test can fake a second filesystem without a
 *  privileged mount (the seam topFillers set — spec bro-v96mp). */
export type DevProbe = (p: string) => Pick<Stats, 'dev' | 'isSymbolicLink'>;

/** The mount scan's verdict (spec bro-wb8wf). Only 'clean' permits rm
 *  — deletion fails CLOSED: 'mount' (a device boundary, `at` names it)
 *  and 'uncertain' (the proof could not finish — an unstat-able or
 *  unlistable entry, a spent bound) both keep the dir. Opposite of the
 *  reporting-side topFillers, where unproven reads fail open. */
export type MountVerdict =
  | { verdict: 'clean' }
  | { verdict: 'mount'; at: string }
  | { verdict: 'uncertain'; reason: string };

/** Bounded pre-delete mount scan: prove a 'delete' candidate's whole
 *  tree sits on ONE device before rmSync(recursive) — a filesystem
 *  mounted inside a stale tmp dir would be descended and its content
 *  deleted. A candidate that IS a symlink is vacuously clean: rm
 *  unlinks the link in place, the target is never descended — a stale
 *  `tmp-*` link onto another fs is litter to unlink, not a mount to
 *  keep. A real root is checked against its parent (a mount AT the
 *  candidate empties the mounted fs identically), then every entry's
 *  dev against the root's — files included: a bind-mounted file
 *  carries the source fs's dev and unlinking it removes the name off
 *  that device. The bound (topFillers' own 60k nodes / 1.5s) keeps a
 *  pathological tree from stalling the sweep; a spent bound is
 *  'uncertain', never waved through as 'clean'. */
export function mountVerdict(
  root: string,
  opts: { lstat?: DevProbe; budget?: { nodes: number; ms: number } } = {}
): MountVerdict {
  const lstat = opts.lstat ?? lstatSync;
  const budget = opts.budget ?? { nodes: 60_000, ms: 1500 };
  const t0 = Date.now();
  let nodes = 0;
  const spent = (): boolean => nodes > budget.nodes || Date.now() - t0 > budget.ms;

  let rootSt: Pick<Stats, 'dev' | 'isSymbolicLink'>;
  try {
    rootSt = lstat(root);
  } catch {
    return { verdict: 'uncertain', reason: `cannot stat ${root}` };
  }
  if (rootSt.isSymbolicLink()) {
    return { verdict: 'clean' };
  }
  const rootDev = rootSt.dev;
  const parent = dirname(root);
  try {
    if (rootDev !== lstat(parent).dev) {
      return { verdict: 'mount', at: root };
    }
  } catch {
    return { verdict: 'uncertain', reason: `cannot stat ${parent}` };
  }

  /** One dir's entries, streamed through opendir so a huge listing is
   *  charged against the bound AS it enumerates — an eager readdirSync
   *  materializes the whole dirent array before the first spent()
   *  check, so one wide dir could out-cost the whole walk in time and
   *  memory (topFillers' lazy-listing precedent, spec bro-v96mp). The
   *  bound check runs before each dirent yields; a consumer's early
   *  exit closes the handle through the finally. Errors propagate out
   *  of the iteration — the caller maps vanished-vs-unproven. */
  const dirEntries = function* (dir: string): Generator<Dirent> {
    let d: Dir | undefined;
    try {
      d = opendirSync(dir);
      for (let e = d.readSync(); e !== null; e = d.readSync()) {
        if (spent()) {
          return;
        }
        nodes += 1;
        yield e;
      }
    } finally {
      try {
        d?.closeSync();
      } catch {
        // already closed — nothing to leak
      }
    }
  };

  const stack: string[] = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    try {
      for (const e of dirEntries(dir)) {
        const p = join(dir, e.name);
        let dev: number;
        try {
          dev = lstat(p).dev;
        } catch (err) {
          // vanished mid-walk is no boundary; anything else is unproven
          if (!isVanished(err)) {
            return { verdict: 'uncertain', reason: `cannot stat ${p}` };
          }
          continue;
        }
        if (dev !== rootDev) {
          return { verdict: 'mount', at: p };
        }
        // symlinks are not followed — their dirent reads isSymbolicLink,
        // never isDirectory, and rm unlinks them in place the same way
        if (e.isDirectory()) {
          stack.push(p);
        }
      }
    } catch (err) {
      // a dir that vanished mid-walk holds nothing to descend; an
      // unlistable-yet-present dir hides whatever it holds — unproven
      if (!isVanished(err)) {
        return { verdict: 'uncertain', reason: `cannot list ${dir}` };
      }
      continue;
    }
    // the generator also stops yielding at the bound — a cut listing
    // leaves the proof unfinished, never clean
    if (spent()) {
      return { verdict: 'uncertain', reason: 'scan bound reached' };
    }
  }
  return { verdict: 'clean' };
}

/** The keep reason a non-'clean' scan reports — mount paths and
 *  unproven proofs both surface, never silently. */
function mountKeepReason(m: Exclude<MountVerdict, { verdict: 'clean' }>): string {
  return m.verdict === 'mount' ? `mount point inside: ${m.at}` : `mount scan unproven: ${m.reason}`;
}

/** The delete attempt + its failure taxonomy: a path that came back
 *  in-use between verdict and rm is a keep, not an error; anything
 *  else warns and sets exitCode — same contract the original sweep
 *  had. Returns true only on a real (or dry-run) delete. */
function removeEntry(fullPath: string, ctx: SweepCtx): boolean {
  try {
    rmSync(fullPath, { recursive: true, force: true });
    console.log(`  deleted ${fullPath}`);
    return true;
  } catch (err) {
    if (isPathInUse(fullPath)) {
      logKeep(fullPath, ctx.inUseMessage, ctx.quietKeeps);
      return false;
    }
    console.error(`  error deleting ${fullPath}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return false;
  }
}

/** The `tmp-<pid>-*` name's owner facts — pid parse plus liveness;
 *  a pid-less name has no owner to consult (alive = vacuous). */
function ownerFacts(name: string): { ownerPid: number | null; ownerAlive: boolean } {
  const pidMatch = TMP_PID_RE.exec(name);
  const ownerPid = pidMatch === null ? null : Number(pidMatch[1]);
  return { ownerPid, ownerAlive: ownerPid === null ? true : pidAlive(ownerPid) };
}

/** Why a 'keep' verdict kept — owner-alive keeps never consulted
 *  /proc, so they say 'owner pid alive', not 'in use'. */
const keepReason = (ownerPid: number | null, ownerAlive: boolean, ctx: SweepCtx): string =>
  ownerPid !== null && ownerAlive ? 'owner pid alive' : ctx.inUseMessage;

/** One candidate entry → verdict, side effects (log lines, delete,
 *  exitCode), and whether it counts toward the summary. An
 *  unstat-able entry skips silently — vanished mid-listing is not an
 *  error. */
function sweepEntry(name: string, ctx: SweepCtx): boolean {
  const fullPath = join(ctx.tmp, name);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(fullPath);
  } catch {
    return false; // skip if can't stat
  }
  try {
    const { ownerPid, ownerAlive } = ownerFacts(name);
    const verdict = tmpSweepVerdict({
      isDir: st.isDirectory(),
      ownedByUs: ctx.currentUid !== undefined && st.uid === ctx.currentUid,
      ageMs: ctx.now - (st.mtimeMs || st.mtime.getTime()),
      ownerPid,
      ownerAlive,
      inUse: () => isPathInUse(fullPath),
    });
    if (verdict === 'skip') {
      return false;
    }
    if (verdict === 'keep') {
      logKeep(fullPath, keepReason(ownerPid, ownerAlive, ctx), ctx.quietKeeps);
      return false;
    }
    // 'delete' — before rm (and before a dry-run's report of it) the
    // tree must prove it holds no mount: rmSync(recursive) descends a
    // mounted fs and deletes foreign-device content (spec bro-wb8wf).
    // Fails closed — an unproven scan keeps, warned on stderr so the
    // surviving litter stays explainable even under quietKeeps.
    // Ordering: the in-use re-verify runs FIRST so the mount proof is
    // the last check before rm — the verdict→delete window narrows to
    // the rmSync call itself (the /proc rescan no longer sits between
    // them). A mount landing inside that syscall gap is the accepted
    // residual: no userspace primitive makes a recursive delete atomic
    // against mount(2), so proof-then-immediate-rm is the strongest
    // bound available — the same one tmpwatch/systemd-tmpfiles carry.
    if (!ctx.dryRun && isPathInUse(fullPath)) {
      logKeep(fullPath, ctx.inUseMessage, ctx.quietKeeps);
      return false;
    }
    const mount = mountVerdict(fullPath, { lstat: ctx.lstat });
    if (mount.verdict !== 'clean') {
      console.error(`  keep ${fullPath} (${mountKeepReason(mount)})`);
      return false;
    }
    if (ctx.dryRun) {
      console.log(`  would delete ${fullPath}`);
      return true;
    }
    return removeEntry(fullPath, ctx);
  } catch {
    // any per-entry probe failure skips — the sweep never dies mid-listing
    return false;
  }
}

/** Shared context fields that don't vary between roots. */
type RootCtx = Omit<SweepCtx, 'tmp'>;

/** The verdict loop for one root's pattern-matching children. */
function sweepEntries(root: string, entries: string[], ctx: RootCtx): number {
  let deleted = 0;
  for (const name of entries.filter(e => TARGET_PATTERNS.some(re => re.test(e)))) {
    if (sweepEntry(name, { ...ctx, tmp: root })) {
      deleted++;
    }
  }
  return deleted;
}

/** An extra root (a worker tmpdir — spec bro-v96mp): same verdicts,
 *  but an unlistable root warns-and-skips rather than failing the run,
 *  and an emptied root is rmdir'd only once it is provably orphaned —
 *  stale AND no live registry owner (rmdirRootIfOrphaned). */
function sweepExtraRoot(root: string, ctx: RootCtx): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    console.error(
      `cleanup: cannot list ${root} (${err instanceof Error ? err.message : err}) — skipped`
    );
    return 0;
  }
  const deleted = sweepEntries(root, entries, ctx);
  if (!ctx.dryRun) {
    rmdirRootIfOrphaned(root, ctx);
  }
  return deleted;
}

/** Delete stale temp directories in `os.tmpdir()` plus any
 *  `opts.extraRoots` (the per-worker `bro-tmp` dirs — spec bro-v96mp).
 *  `dryRun` reports without removing. Per-entry failures warn and
 *  continue; the tmpdir itself failing to list sets exitCode — same
 *  contract the original `bro cleanup` sweep had. */
export function cleanupTmpDirs(dryRun: boolean, opts: TmpSweepOptions = {}): void {
  const tmp = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch (err) {
    console.error(`cleanup: failed to read ${tmp} (${err instanceof Error ? err.message : err})`);
    process.exitCode = 1;
    return;
  }

  const ctx: RootCtx = {
    now: Date.now(),
    currentUid: ourUid(),
    dryRun,
    quietKeeps: opts.quietKeeps === true,
    inUseMessage: process.platform !== 'linux' ? 'usage unverifiable on this platform' : 'in use',
    lstat: opts.lstat,
  };

  let deleted = sweepEntries(tmp, entries, ctx);
  for (const root of opts.extraRoots ?? []) {
    deleted += sweepExtraRoot(root, ctx);
  }
  if (deleted > 0) {
    console.log(`cleanup: ${dryRun ? 'would delete' : 'deleted'} ${deleted} tmp item(s)`);
  }
}

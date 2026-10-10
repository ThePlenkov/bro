/**
 * `post-merge` freshness hook (bro-sovl3) — a pull must mean
 * install+build+patch, never build alone. A merge that lands a new
 * package dep and rebuilds against a stale node_modules produces dist
 * that statically imports a package npm never installed — every spawned
 * bro then dies on ERR_MODULE_NOT_FOUND inside a second, and a loop
 * supervisor respawns into the crash (observed: #383 → @broject/linear).
 *
 *   bro hooks post-merge       git-hook entrypoint — dispatcher only:
 *                              gates, then spawns the worker detached so
 *                              `git pull` never waits on npm
 *   bro hooks post-merge-run   the worker — serialized refresh under
 *                              <gitdir>/bro/post-merge.lock:
 *                              install (dep manifests moved) → build →
 *                              patch; done-sha advances only on success
 *
 * State lives in the worktree's OWN git dir (`--git-dir`, not
 * `--git-common-dir`): per-worktree done-sha/log, reaped with
 * `git worktree remove`. Everything fail-open — a hook must never block
 * or break a merge.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  gitTry,
  loadConfig,
  LockTimeout,
  withFileLock,
  type ConfigSection,
} from '@broject/core'

/** `freshness` config section — the post-merge refresh's command slots.
 *  Absent = auto (lockfile-detected install, `scripts.build`, the
 *  conventional hotpatch path); a string replaces the step; `false`
 *  disables it. `patch` is the machine-local hotpatch slot (bro-te73m) —
 *  it re-applies dist patches until upstream lands them. */
export interface FreshnessConfig {
  install?: string | false
  build?: string | false
  patch?: string | false
}

const step = (v: unknown): string | false | undefined => {
  if (v === false) {
    return false
  }
  if (typeof v === 'string' && v.trim() !== '') {
    return v.trim()
  }
  return undefined
}

export const freshnessSection: ConfigSection<FreshnessConfig> = (raw) => {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  return { install: step(o.install), build: step(o.build), patch: step(o.patch) }
}

/** Files whose move between two commits means node_modules is stale —
 *  matched at any depth so workspace members count too. */
export const DEP_MANIFEST =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc\.yml|bun\.lock|bun\.lockb)$/

/** This worktree's own git dir, absolute — `<repo>/.git` on the main
 *  checkout, `<common>/worktrees/<name>` on a linked one, so refresh
 *  state is per-worktree and dies with `git worktree remove`. */
export function worktreeGitDir(cwd: string): string | null {
  const r = gitTry(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir'])
  if (r.code === 0 && r.out.trim() !== '') {
    return r.out.trim()
  }
  const f = gitTry(['-C', cwd, 'rev-parse', '--git-dir'])
  const p = f.code === 0 ? f.out.trim() : ''
  return p === '' ? null : resolve(cwd, p)
}

const revParse = (cwd: string, ref: string): string | null => {
  const r = gitTry(['-C', cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null
}

/** Did `from..to` touch a dep manifest? A failed diff reads as changed —
 *  an unneeded install is cheap, a skipped one is the bug. */
export function depsChanged(cwd: string, from: string, to: string): boolean {
  const d = gitTry(['-C', cwd, 'diff', '--name-only', from, to])
  if (d.code !== 0) {
    return true
  }
  return d.out.split('\n').some((p) => DEP_MANIFEST.test(p.trim()))
}

/** Lockfile → package manager, most specific first. npm is the default:
 *  a bare package.json is npm's to install. */
function detectPm(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (existsSync(join(cwd, 'yarn.lock'))) {
    return 'yarn'
  }
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) {
    return 'bun'
  }
  return 'npm'
}

/** sh single-quote escape: a literal ' inside '…' is written '\'' —
 *  String.raw keeps the backslash literal. */
const SH_SQUOTE = String.raw`'\''`

/** Conventional hotpatch slots — `$XDG_DATA_HOME/bro/hotpatch.sh` first,
 *  then the path the original local patch already runs from. Only
 *  executable files count: a chmod -x script is the operator's off
 *  switch, not an auto step. */
function defaultPatch(): string | undefined {
  const xdg = process.env.XDG_DATA_HOME
  const data =
    typeof xdg === 'string' && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share')
  for (const p of [join(data, 'bro', 'hotpatch.sh'), join(data, 'bro-hotpatch.sh')]) {
    try {
      accessSync(p, constants.X_OK)
      return `bash '${p.replaceAll("'", SH_SQUOTE)}'`
    } catch {
      // missing or not executable — try the next slot
    }
  }
  return undefined
}

/** The ordered refresh for this worktree — `changed` gates the install
 *  slot; build and patch resolve unconditionally (config wins over
 *  detection; `false` removes the step). */
export function resolveSteps(
  cwd: string,
  cfg: FreshnessConfig,
  changed: boolean
): string[] {
  const pm = detectPm(cwd)
  const steps: string[] = []
  const pmInstall = pm === 'npm' ? 'npm install --no-audit --no-fund' : `${pm} install`
  const install = cfg.install === false ? undefined : (cfg.install ?? pmInstall)
  if (changed && install !== undefined) {
    steps.push(install)
  }
  const pmBuild = hasBuildScript(cwd) ? `${pm} run build` : undefined
  const build = cfg.build === false ? undefined : (cfg.build ?? pmBuild)
  if (build !== undefined) {
    steps.push(build)
  }
  const patch = cfg.patch === false ? undefined : (cfg.patch ?? defaultPatch())
  if (patch !== undefined) {
    steps.push(patch)
  }
  return steps
}

function hasBuildScript(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    return typeof pkg.scripts?.build === 'string'
  } catch {
    return false
  }
}

// --- dispatcher -----------------------------------------------------------------

/** Cap the log — append-only state in a .git dir still shouldn't grow
 *  without bound; keep the tail where the fresh entries are. */
const LOG_CAP = 512 * 1024

function logPath(stateDir: string): string {
  const p = join(stateDir, 'post-merge.log')
  try {
    if (statSync(p).size > LOG_CAP) {
      const tail = readFileSync(p, 'utf8').slice(-LOG_CAP / 2)
      writeFileSync(p, tail)
    }
  } catch {
    // no log yet or unreadable — the append creates it
  }
  return p
}

/** The git-hook half — gate cheap, spawn the worker detached, exit.
 *  Skips trees that can't host a refresh (no package.json, or no
 *  node_modules yet — a fresh worktree bootstraps first). The worker is
 *  this same CLI (`hooks post-merge-run` on the entry script) so a dev
 *  checkout and the dist bundle both respawn themselves. */
export function emitPostMerge(
  cwd: string,
  spawnWorker?: (logFd: number) => void
): void {
  if (!existsSync(join(cwd, 'package.json')) || !existsSync(join(cwd, 'node_modules'))) {
    return
  }
  const gitdir = worktreeGitDir(cwd)
  if (entrypoint() === null || gitdir === null) {
    return
  }
  const stateDir = join(gitdir, 'bro')
  try {
    mkdirSync(stateDir, { recursive: true })
    const log = logPath(stateDir)
    appendFileSync(log, `\n--- post-merge ${new Date().toISOString()} cwd=${cwd}\n`)
    const fd = openSync(log, 'a')
    try {
      ;(spawnWorker ?? ((fd2) => spawnDetached(cwd, fd2)))(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // fail-open — a logging/spawn failure must never break the merge
  }
}

function spawnDetached(cwd: string, logFd: number): void {
  const entry = entrypoint()
  if (entry === null) {
    return
  }
  const child = spawn(process.execPath, [entry, 'hooks', 'post-merge-run'], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.on('error', () => {})
  child.unref()
}

/** The entry script this process was launched as — `packages/cli/dist/
 *  index.js` on installs, `src/index.ts` in dev (node ≥22.18 strips
 *  types). Null when argv is not bro-shaped (tests import directly). */
function entrypoint(): string | null {
  const entry = process.argv[1]
  return entry !== undefined && existsSync(entry) ? entry : null
}

// --- worker ---------------------------------------------------------------------

const DONE_FILE = 'post-merge.done'
const LOCK_FILE = 'post-merge.lock'
/** A merge landing mid-refresh queues another pass — bounded so a merge
 *  storm can't hold the worker forever; the next hook respawns it. */
const MAX_PASSES = 8

const defaultRun =
  (cwd: string) =>
  (cmd: string): number => {
    console.log(`$ ${cmd}`)
    const r = spawnSync('sh', ['-c', cmd], { cwd, stdio: 'inherit' }) // NOSONAR — operator-configured freshness steps
    return r.status ?? 1
  }

const readDoneSha = (doneFile: string): string => {
  try {
    return readFileSync(doneFile, 'utf8').trim()
  } catch {
    return ''
  }
}

/** The sha the last completed refresh recorded —
 *  `<worktree-gitdir>/bro/post-merge.done`, '' when a refresh never
 *  completed, null outside a worktree. `bro rig` asserts its refresh
 *  verdict from this, never from a worker's log. */
export function postMergeDoneSha(cwd: string): string | null {
  const gitdir = worktreeGitDir(cwd)
  if (gitdir === null) {
    return null
  }
  return readDoneSha(join(gitdir, 'bro', DONE_FILE))
}

/** One refresh pass — false stops the loop: HEAD done or unresolvable,
 *  or a step failed (done-sha stays frozen so the next merge retries
 *  the whole range). */
function refreshPass(
  cwd: string,
  doneFile: string,
  cfg: FreshnessConfig,
  run: (cmd: string) => number
): boolean {
  const head = revParse(cwd, 'HEAD')
  if (head === null) {
    return false
  }
  const done = readDoneSha(doneFile)
  if (done === head) {
    return false
  }
  // diff from the last refreshed head when it still resolves — two
  // merges inside one refresh window would otherwise leave the first
  // one's dep changes unseen by ORIG_HEAD's retarget
  const base = (done !== '' ? revParse(cwd, done) : null) ?? revParse(cwd, 'ORIG_HEAD')
  const changed = base === null || depsChanged(cwd, base, head)
  const steps = resolveSteps(cwd, cfg, changed)
  console.log(
    `refresh ${done === '' ? '(first run)' : done.slice(0, 12)}..${head.slice(0, 12)}: ` +
      (steps.length === 0 ? 'nothing to do' : steps.join(' && '))
  )
  for (const cmd of steps) {
    if (run(cmd) !== 0) {
      console.log(`post-merge: step failed — done-sha NOT advanced, next merge retries`)
      return false
    }
  }
  writeFileSync(doneFile, `${head}\n`)
  return true
}

/** The serialized refresh: loop until HEAD stops moving under us (each
 *  pass re-reads it — a merge mid-install queues the next diff), with
 *  the file lock making back-to-back post-merge dispatches sequential
 *  instead of racing npm against npm. */
export function runPostMergeRefresh(
  cwd: string,
  run: (cmd: string) => number = defaultRun(cwd)
): void {
  const gitdir = worktreeGitDir(cwd)
  if (gitdir === null) {
    return
  }
  const stateDir = join(gitdir, 'bro')
  const doneFile = join(stateDir, DONE_FILE)
  const cfg =
    (loadConfig(cwd, { freshness: freshnessSection }) as { freshness?: FreshnessConfig })
      .freshness ?? {}
  try {
    withFileLock(
      join(stateDir, LOCK_FILE),
      () => {
        for (let pass = 0; pass < MAX_PASSES; pass += 1) {
          if (!refreshPass(cwd, doneFile, cfg, run)) {
            break
          }
        }
      },
      { waitMs: 10 * 60_000, label: 'post-merge refresh lock' }
    )
  } catch (err) {
    // a held lock means a sibling worker is mid-refresh and its HEAD
    // re-read covers this merge — a timeout is a skip, never a failure
    if (err instanceof LockTimeout) {
      console.log(`post-merge: refresh already running — skipped`)
      return
    }
    console.log(`post-merge: refresh failed — ${err instanceof Error ? err.message : String(err)}`)
  }
}

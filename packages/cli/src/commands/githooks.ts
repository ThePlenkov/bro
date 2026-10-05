/**
 * Commit provenance — bro's git-hook half of `bro hooks`.
 *
 *   bro hooks install                          write the prepare-commit-msg shim
 *   bro hooks uninstall                        remove it (restore a chained hook)
 *   bro hooks prepare-commit-msg <file> [src]  git-hook entrypoint — append
 *                                              Agent/Agent-Model/Session/Bead/
 *                                              Molecule trailers to the message
 *
 * Provenance is read from env markers the session exports (BRO_* pins a
 * bro-spawned worker carries, AI_AGENT runtimes badge themselves with)
 * plus best-effort fallbacks: the branch name, the session markers
 * post-tool hooks arm under <git-common>/bro/hooks/, and `bd show` for
 * the bead's molecule parent. Human commits get nothing — an agent
 * identity (env badge or an agent-shaped process ancestor) must resolve
 * before any trailer is written. Fail-open everywhere: a hook that can't
 * decide exits 0 and the commit proceeds untagged, never blocked.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bdTry, gitTry, markerLive } from '@broject/core'
import { agentOwner } from './proc-owner.ts'

/** The CLI's own version — baked into the installed shim's npx
 *  fallback so the hook runs the bro that installed it. Walks up from
 *  this module for the @broject/bro package.json (src/commands →
 *  packages/cli, dist bundle → packages/cli the same way); '0' is the
 *  major-pin fallback, matching how hooks.json npx-pins. */
export function cliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pj.name === '@broject/bro' && typeof pj.version === 'string') {
        return pj.version
      }
    } catch {
      // keep walking
    }
    const up = dirname(dir)
    if (up === dir) {
      break
    }
    dir = up
  }
  return '0'
}

/** Markers older than this are residue, not a live session — same
 *  window the parallel-work nudge uses. */
const LIVE_SESSION_MS = 24 * 60 * 60 * 1000

/** `<slug>` that names a bead — `bro-fzot`, `fx-9`, `bro-mol-h7cp`.
 *  Bead-ish enough for provenance; a worktree slug that isn't a bead
 *  just skips the fallback, it never invents one. */
const BEAD_ID = /^[a-z]\w*-[\w.]+$/i

export interface CommitProvenance {
  agent?: string
  model?: string
  session?: string
  bead?: string
  molecule?: string
}

/** `AI_AGENT=devin_3000-11-3_agent` → `devin` — the runtime badges the
 *  versioned binary name; the trailer wants the cli. */
function normalizeAgentCli(raw: string): string {
  const first = raw.trim().split(/[\s_]/)[0] ?? ''
  return first.toLowerCase()
}

const MODEL_ENV = [
  'BRO_AGENT_MODEL',
  'DEVIN_MODEL',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'AI_MODEL',
  'CLAUDE_MODEL',
] as const

const SESSION_ENV = [
  'BRO_SESSION_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
] as const

const firstEnv = (env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined => {
  for (const k of keys) {
    const v = env[k]?.trim()
    if (v) {
      return v
    }
  }
  return undefined
}

/** The env-marker half — everything a session pins on itself. */
export function envProvenance(env: NodeJS.ProcessEnv): CommitProvenance {
  const p: CommitProvenance = {}
  const agent = env.BRO_AGENT?.trim() ?? env.AI_AGENT?.trim()
  if (agent) {
    p.agent = normalizeAgentCli(agent)
  }
  const model = firstEnv(env, MODEL_ENV)
  if (model) {
    p.model = model
  }
  const session = firstEnv(env, SESSION_ENV)
  if (session) {
    p.session = session
  }
  if (env.BRO_BEAD_ID?.trim()) {
    p.bead = env.BRO_BEAD_ID.trim()
  }
  if (env.BRO_MOL_ID?.trim()) {
    p.molecule = env.BRO_MOL_ID.trim()
  }
  return p
}

/** One marker file → its session + aspect, or null when it isn't a
 *  live session marker (subdir, no extension, stale, unreadable). */
function markerInfo(
  path: string,
  file: string,
  now: number
): { session: string; isTask: boolean } | null {
  try {
    const st = statSync(path)
    const dot = file.lastIndexOf('.')
    // hinted/, trace/ subdirs are not markers; neither are extensionless files
    if (!st.isFile() || dot <= 0) {
      return null
    }
    const head = readFileSync(path, 'utf8').split('\n')[0]
    if (!markerLive(head, st.mtimeMs, LIVE_SESSION_MS, now)) {
      return null
    }
    return { session: file.slice(0, dot), isTask: file.endsWith('.task') }
  } catch {
    return null // unreadable marker — skip
  }
}

/** Live sessions under `<git-common>/bro/hooks/` → bead ids their
 *  `.task` markers recorded. Session = filename minus the last
 *  `.aspect`; a session is live while ANY of its markers is (owner pid
 *  or mtime window — markerLive decides). Only `.task` detail lines
 *  carry bead ids; other aspects' details (PR numbers, worktree slugs)
 *  are never bead candidates. */
export function liveSessionClaims(
  hooksDir: string,
  now: number = Date.now()
): Map<string, string[]> {
  const live = new Set<string>()
  const taskFiles: string[] = []
  let files: string[]
  try {
    files = readdirSync(hooksDir)
  } catch {
    return new Map()
  }
  for (const f of files) {
    const info = markerInfo(join(hooksDir, f), f, now)
    if (info !== null) {
      live.add(info.session)
      if (info.isTask) {
        taskFiles.push(f)
      }
    }
  }
  const out = new Map<string, string[]>()
  for (const f of taskFiles) {
    const session = f.slice(0, -'.task'.length)
    if (!live.has(session)) {
      continue
    }
    try {
      const beads = [
        ...new Set(
          readFileSync(join(hooksDir, f), 'utf8')
            .split('\n')
            .slice(1)
            .map((l) => l.trim())
            .filter((l) => BEAD_ID.test(l))
        ),
      ]
      out.set(session, beads)
    } catch {
      // unreadable — no claims for this session
    }
  }
  return out
}

/** `work/bro-fzot` / `loop/fx-9` → the bead — bro's own worktree
 *  namespaces name their task even when the env pins never reached this
 *  shell. Only those two prefixes count: `feature/user-login` is prose,
 *  not a bead, and must not fabricate a trailer. */
export function branchBead(branch: string): string | undefined {
  const tail = /^(?:work|loop)\/(.+)$/.exec(branch)?.[1] ?? ''
  return BEAD_ID.test(tail) ? tail : undefined
}

/** The bead's molecule parent — `bd show` reports `parent` on mol
 *  steps. Best-effort: a missing bd or a root bead is "no molecule". */
function beadMolecule(bead: string, cwd: string): string | undefined {
  const r = bdTry(['show', bead, '--json'], 10_000, cwd)
  if (r.code !== 0) {
    return undefined
  }
  try {
    const parent = (JSON.parse(r.out) as { parent?: unknown }[])[0]?.parent
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  } catch {
    return undefined
  }
}

/** Is this commit running inside an agent session? Env badges cover
 *  spawned workers and runtimes that mark their process tree; the
 *  /proc ancestor walk covers interactive plugin sessions whose hook
 *  payloads carry session_id but whose env doesn't (and is honest on
 *  systems without /proc — no data, no claim). */
export function inAgentSession(env: NodeJS.ProcessEnv): boolean {
  return (
    env.BRO_AGENT !== undefined ||
    env.BRO_AGENT_ID !== undefined ||
    env.AI_AGENT !== undefined ||
    agentOwner() !== null
  )
}

interface TrailersOpts {
  env: NodeJS.ProcessEnv
  cwd: string
  /** Injectable for tests — defaults to the real marker dir under cwd's
   *  git-common-dir; null skips the marker fallback. */
  hooksDir?: string | null
  branch?: string
  moleculeOf?: (bead: string) => string | undefined
  /** Injectable agent-ancestor verdict — tests can't shape /proc. */
  agentProc?: boolean
}

/** Single-live-session fallback — fills only fields env/branch left
 *  empty, and only when exactly one session is live: two agents in one
 *  repo tag from env/branch or not at all, never by coin flip. */
function markerFallback(
  opts: TrailersOpts,
  session: string | undefined,
  bead: string | undefined
): { session: string | undefined; bead: string | undefined } {
  const hooksDir =
    opts.hooksDir === undefined ? defaultHooksDir(opts.cwd) : (opts.hooksDir ?? undefined)
  if (hooksDir === undefined || (session !== undefined && bead !== undefined)) {
    return { session, bead }
  }
  const claims = liveSessionClaims(hooksDir)
  if (claims.size !== 1) {
    return { session, bead }
  }
  const [id, beads] = [...claims.entries()][0]!
  return {
    session: session ?? id,
    bead: bead ?? (beads.length === 1 ? beads[0] : undefined),
  }
}

/** All trailers for this commit — empty when no agent identity
 *  resolves (a human commit stays clean). Fallbacks fill only fields
 *  env didn't pin, and only unambiguous ones. */
export function commitTrailers(opts: TrailersOpts): [string, string][] {
  const env = envProvenance(opts.env)
  if (
    env.agent === undefined &&
    opts.env.BRO_AGENT_ID === undefined &&
    !(opts.agentProc ?? agentOwner() !== null)
  ) {
    return []
  }
  const beadFromBranch = opts.branch !== undefined ? branchBead(opts.branch) : undefined
  const { session, bead } = markerFallback(opts, env.session, env.bead ?? beadFromBranch)
  const moleculeOf = opts.moleculeOf ?? ((b: string) => beadMolecule(b, opts.cwd))
  const molecule = env.molecule ?? (bead !== undefined ? moleculeOf(bead) : undefined)
  const out: [string, string][] = [['Agent', env.agent ?? 'agent']]
  if (env.model !== undefined) {
    out.push(['Agent-Model', env.model])
  }
  if (session !== undefined) {
    out.push(['Session', session])
  }
  if (bead !== undefined) {
    out.push(['Bead', bead])
  }
  if (molecule !== undefined) {
    out.push(['Molecule', molecule])
  }
  return out
}

// --- message-file mutation ----------------------------------------------------

/** Append trailers to the commit message file. `doNothing` on existing
 *  keys — first writer wins, so a rebase/amend keeps its original
 *  provenance and a committer's own trailer is never clobbered. */
export function applyTrailers(msgFile: string, trailers: [string, string][], cwd: string): void {
  if (trailers.length === 0) {
    return
  }
  const args = ['-C', cwd, 'interpret-trailers', '--in-place', '--if-exists', 'doNothing']
  for (const [k, v] of trailers) {
    args.push('--trailer', `${k}: ${v}`)
  }
  args.push(msgFile)
  gitTry(args)
}

/** git-hook entrypoint — `prepare-commit-msg <file> [source] [sha]`.
 *  Fires with cwd at the worktree top level; everything is best-effort
 *  and the caller (`bro hooks`) already gates on bro-enabled repos. */
export function emitCommitTrailers(argv: string[]): void {
  try {
    const msgFile = argv[0]
    if (msgFile === undefined || !existsSync(msgFile)) {
      return
    }
    const cwd = process.cwd()
    const branch = gitTry(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const trailers = commitTrailers({
      env: process.env,
      cwd,
      branch: branch.code === 0 ? branch.out.trim() : undefined,
    })
    applyTrailers(msgFile, trailers, cwd)
  } catch {
    // a provenance failure must never block a commit
  }
}

// --- install / uninstall --------------------------------------------------------

/** Recognizes bro's shim — install is idempotent on it, uninstall
 *  refuses to touch a hook it didn't write. */
export const BRO_HOOK_MARK = '# bro: prepare-commit-msg — commit provenance'

const LOCAL_HOOK = 'prepare-commit-msg.local'
const HOOK_NAME = 'prepare-commit-msg'

/** The shim: a pre-existing hook (renamed .local) runs first and keeps
 *  its veto — a nonzero exit propagates, aborting the commit the way
 *  the un-chained hook would have — then bro adds its trailers
 *  (fail-open): PATH first, npx-pinned fallback baked at install time. */
export function hookShim(version: string): string {
  return `#!/bin/sh
${BRO_HOOK_MARK} — https://github.com/theplenkov/bro
chain="$(dirname "$0")/${LOCAL_HOOK}"
if [ -x "$chain" ]; then
  "$chain" "$@" || exit $?
fi
if command -v bro >/dev/null 2>&1; then
  bro hooks prepare-commit-msg "$@" || true
elif command -v npx >/dev/null 2>&1; then
  npx -y --prefer-offline "@broject/bro@${version}" hooks prepare-commit-msg "$@" || true
fi
exit 0
`
}

/** Directory prepare-commit-msg lands in: `core.hooksPath` when the
 *  repo overrode it, else `<git-common>/hooks` — shared by every
 *  linked worktree, so one install covers `bro work enter` siblings.
 *  A RELATIVE hooksPath is resolved against the worktree root (where
 *  git runs the hook), not cwd — installing from a repo subdirectory
 *  must land the same hook. */
export function gitHooksDir(cwd: string): string | null {
  const hp = gitTry(['-C', cwd, 'config', '--get', 'core.hooksPath'])
  if (hp.code === 0 && hp.out.trim() !== '') {
    const p = hp.out.trim()
    if (p.startsWith('/')) {
      return p
    }
    const top = gitTry(['-C', cwd, 'rev-parse', '--show-toplevel'])
    if (top.code !== 0 || top.out.trim() === '') {
      return null
    }
    return resolve(top.out.trim(), p)
  }
  const common = gitTry(['-C', cwd, 'rev-parse', '--git-common-dir'])
  if (common.code !== 0 || common.out.trim() === '') {
    return null
  }
  const p = common.out.trim()
  return join(p.startsWith('/') ? p : resolve(cwd, p), 'hooks')
}

function defaultHooksDir(cwd: string): string | undefined {
  const common = gitTry(['-C', cwd, 'rev-parse', '--git-common-dir'])
  if (common.code !== 0 || common.out.trim() === '') {
    return undefined
  }
  const p = common.out.trim()
  return join(p.startsWith('/') ? p : resolve(cwd, p), 'bro', 'hooks')
}

export type InstallResult =
  | { state: 'installed' | 'already' | 'chained' | 'removed' | 'restored' | 'absent'; path: string }
  | { state: 'error'; err: string }

export function installCommitHook(cwd: string, version: string): InstallResult {
  const dir = gitHooksDir(cwd)
  if (dir === null) {
    return { state: 'error', err: 'not a git repository' }
  }
  const hook = join(dir, HOOK_NAME)
  const local = join(dir, LOCAL_HOOK)
  try {
    if (existsSync(hook)) {
      const cur = readFileSync(hook, 'utf8')
      if (cur.includes(BRO_HOOK_MARK)) {
        if (cur === hookShim(version)) {
          return { state: 'already', path: hook }
        }
        // stale bro shim — refresh in place (a .local chain survives)
        writeFileSync(hook, hookShim(version))
        chmodSync(hook, 0o755)
        return { state: 'installed', path: hook }
      }
      if (existsSync(local)) {
        return {
          state: 'error',
          err: `${LOCAL_HOOK} already exists — refusing to chain a second hook; uninstall it or merge manually`,
        }
      }
      renameSync(hook, local)
      try {
        writeFileSync(hook, hookShim(version))
        chmodSync(hook, 0o755)
      } catch (e) {
        // restore — a failed shim write must not strand the user's hook
        // as .local-only, where git would never run it again
        renameSync(local, hook)
        throw e
      }
      return { state: 'chained', path: hook }
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(hook, hookShim(version))
    chmodSync(hook, 0o755)
    return { state: 'installed', path: hook }
  } catch (e) {
    return { state: 'error', err: (e as Error).message }
  }
}

export function uninstallCommitHook(cwd: string): InstallResult {
  const dir = gitHooksDir(cwd)
  if (dir === null) {
    return { state: 'error', err: 'not a git repository' }
  }
  const hook = join(dir, HOOK_NAME)
  const local = join(dir, LOCAL_HOOK)
  try {
    const had = existsSync(hook)
    if (had) {
      if (!readFileSync(hook, 'utf8').includes(BRO_HOOK_MARK)) {
        return { state: 'error', err: `${HOOK_NAME} is not bro's — refusing to remove it` }
      }
      rmSync(hook)
    }
    if (existsSync(local)) {
      renameSync(local, hook)
      return { state: 'restored', path: hook }
    }
    return { state: had ? 'removed' : 'absent', path: hook }
  } catch (e) {
    return { state: 'error', err: (e as Error).message }
  }
}

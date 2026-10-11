/**
 * `bro stamp` — session attribution for shared mutable outputs
 * (bro-fatja, specs/bro-fatja.md). Parallel sessions already arm
 * markers under <git-common>/bro/hooks/; nothing attributes the
 * WRITES they make to shared mutable state (dist/, node_modules/, any
 * generated tree). The incident: a rebuild in the main checkout
 * reverted a live dist hotpatch and the file watcher reported
 * unattributed "user action".
 *
 *   bro stamp            read the record back — "who last wrote here"
 *   bro stamp <via>      record THIS session's write (a build, a
 *                        hotpatch) under the caller-chosen label
 *
 * Record: <worktree-gitdir>/bro/last-build.json — the worktree's own
 * git dir (same place post-merge.done lives): outputs are
 * per-worktree, so attribution is too, and the record dies with
 * `git worktree remove`. Single record, last writer wins — it names
 * the CURRENT owner of the output, never a history.
 *
 *   {session, ts, head, inputs, via}
 *
 * `inputs` fingerprints what the write was made FROM (HEAD + tracked
 * content via `git stash create` + porcelain states/untracked names)
 * so a rebuild over moved code reads differently from an idempotent
 * one. Everything is advisory and fail-open: a missing or corrupt
 * record reads as "no stamp", and stamping must never fail a build.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitCommonDir, gitTry, worktreeGitDir } from '@broject/core'
import { envProvenance, liveSessionIds } from './githooks.ts'
import { flag, positionals } from './args.ts'

export interface BuildStamp {
  /** Resolved session id of the writer, or 'unknown' — attribution
   *  degrades to `via`, never to a guessed name. */
  session: string
  /** Epoch ms of the write. */
  ts: number
  /** HEAD at write time — '' on an unborn branch. */
  head: string
  /** sha256 fingerprint of the build inputs. */
  inputs: string
  /** Writer label: 'post-merge' for the refresh worker, caller-chosen
   *  for `bro stamp` ('build', 'patch', …). */
  via: string
}

export const STAMP_FILE = 'last-build.json'

/** `<gitdir>/bro/last-build.json` — null outside a worktree. */
export function stampPath(dir: string): string | null {
  const gitdir = worktreeGitDir(dir)
  return gitdir === null ? null : join(gitdir, 'bro', STAMP_FILE)
}

/** The recorded stamp, or null — absent, unreadable, or corrupt all
 *  mean "no stamp", never an error. */
export function readStamp(dir: string): BuildStamp | null {
  const path = stampPath(dir)
  if (path === null || !existsSync(path)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildStamp>
    if (typeof raw.ts !== 'number' || typeof raw.via !== 'string') {
      return null
    }
    return {
      session: typeof raw.session === 'string' && raw.session !== '' ? raw.session : 'unknown',
      ts: raw.ts,
      head: typeof raw.head === 'string' ? raw.head : '',
      inputs: typeof raw.inputs === 'string' ? raw.inputs : '',
      via: raw.via,
    }
  } catch {
    return null
  }
}

/** Fingerprint of the state a write was made from: HEAD anchors the
 *  base, `git stash create` commits the index+tracked worktree content
 *  (an unreachable object — the standard whole-state hash), porcelain
 *  adds per-file states and untracked names. Content churn inside a
 *  never-tracked file without a rename is the documented gap. */
export function inputsFingerprint(dir: string): string {
  const head = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const stash = gitTry(['-C', dir, 'stash', 'create'])
  const porcelain = gitTry(['-C', dir, 'status', '--porcelain'])
  const h = createHash('sha256')
  h.update(head.out.trim())
  h.update('\n')
  h.update(stash.code === 0 ? stash.out.trim() : '')
  h.update('\n')
  h.update(porcelain.out)
  return h.digest('hex')
}

/** Who is writing — env pins first (a spawned worker's BRO_SESSION_ID
 *  is its agent id), then BRO_AGENT_ID, then the unambiguous marker
 *  fallback: exactly one live session under <git-common>/bro/hooks/
 *  names it; zero or many leave it undefined rather than guess. */
export function stampSession(dir: string, env: NodeJS.ProcessEnv): string | undefined {
  const envSession = envProvenance(env).session ?? env.BRO_AGENT_ID?.trim()
  if (envSession !== undefined && envSession !== '') {
    return envSession
  }
  const common = gitCommonDir(dir)
  if (common === null) {
    return undefined
  }
  const live = liveSessionIds(join(common, 'bro', 'hooks'))
  return live.size === 1 ? [...live][0] : undefined
}

/** Record a write to this worktree's outputs. Returns the stamp, or
 *  null outside a worktree. `session` overrides resolution (tests,
 *  scripts that know their id) — absent, the env/marker chain runs. */
export function writeStamp(
  dir: string,
  opts: { via: string; session?: string }
): BuildStamp | null {
  const path = stampPath(dir)
  if (path === null) {
    return null
  }
  const head = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const stamp: BuildStamp = {
    session: opts.session ?? stampSession(dir, process.env) ?? 'unknown',
    ts: Date.now(),
    head: head.code === 0 ? head.out.trim() : '',
    inputs: inputsFingerprint(dir),
    via: opts.via,
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return stamp
}

/** "12m ago" / "2h5m ago" — the stamp's age in board/doctor detail. */
export const stampAgo = (ts: number, now: number): string => {
  const m = Math.max(0, Math.round((now - ts) / 60_000))
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ''} ago`
}

/** `bro stamp [via]` — bare reads the record (the "was my write
 *  overwritten?" check: the newest stamp naming another session or
 *  via after yours is the overwrite), a label writes this session's.
 *  `--session <id>` pins the writer; `--json` prints the record. */
export function runStampCommand(argv: string[]): void {
  const via = positionals(argv, new Set(['--session']), {
    boolFlags: new Set(['--json']),
    strict: true,
  })
  if (via.length > 1) {
    console.error('usage: bro stamp [<via>] [--session <id>] [--json]')
    process.exit(2)
  }
  const dir = process.cwd()
  const json = argv.includes('--json')
  if (via.length === 0) {
    const stamp = readStamp(dir)
    if (stamp === null) {
      console.error('no stamped build — nothing recorded a write here yet')
      process.exit(1)
    }
    if (json) {
      console.log(JSON.stringify(stamp, null, 2))
      return
    }
    console.log(
      `last write: ${stamp.session} (${stamp.via}) ${stampAgo(stamp.ts, Date.now())}` +
        (stamp.head !== '' ? ` @ ${stamp.head.slice(0, 12)}` : '')
    )
    return
  }
  const session = flag(argv, '--session')
  let stamp: BuildStamp | null
  try {
    stamp = writeStamp(dir, { via: via[0]!, ...(session !== undefined && { session }) })
  } catch (err) {
    console.error(`stamp: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  if (stamp === null) {
    console.error('stamp: not inside a git worktree — the record needs the worktree git dir')
    process.exit(1)
  }
  console.log(json ? JSON.stringify(stamp, null, 2) : `stamped ${stamp.session} (${stamp.via})`)
}

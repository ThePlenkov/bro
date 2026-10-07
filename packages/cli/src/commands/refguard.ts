/**
 * `reference-transaction` ref guard — bro-1c78. Sessions sharing a git
 * common dir (the main checkout plus every linked worktree) share one
 * ref namespace; an agent that runs `git reset --hard origin/<branch>`
 * in the wrong checkout moves a branch another session owns. Prompts
 * can't stop that — a git hook can.
 *
 *   bro hooks reference-transaction prepared <ppid>   git-hook entrypoint
 *
 * On the `prepared` phase every pending update is judged:
 *
 *   - only `refs/heads/*` — pseudo-refs (ORIG_HEAD, AUTO_MERGE, HEAD
 *     symrefs, FETCH_HEAD), remote-tracking, stash, tags, and data refs
 *     pass untouched;
 *   - deletes (new = 0), same-oid writes, and fast-forward moves (old
 *     is ancestor of new) always pass. A recorded old = 0 is NOT
 *     trusted as a create — unverified writes (`update-ref`, `branch
 *     -f`, `switch -C`, forced fetch) report 0 for existing refs, so
 *     the on-disk value is resolved via `rev-parse --verify`; only a
 *     ref that truly does not exist counts as a create;
 *   - a non-fast-forward move is judged by the invoking verb — the
 *     argv of the git process that fired the hook (/proc/<ppid>/cmdline,
 *     the shim passes $PPID). Content producers (commit/amend, merge,
 *     rebase — and `pull`, which arrives as its inner merge/rebase)
 *     pass; ref movers (reset, fetch, update-ref, branch, checkout,
 *     switch) and every unknown verb veto. No cmdline data → allow:
 *     the guard is strictly additive, never a wedge.
 *
 * `BRO_REF_GUARD=off` in the invoking env passes everything — the
 * deliberate-rewrite escape hatch. Failure policy is asymmetric:
 * the veto path exits non-zero; every internal error exits 0.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gitTry } from '@broject/core'

export const REFGUARD_HOOK_MARK = '# bro: reference-transaction — shared-branch ref guard'
export const REFGUARD_HOOK_NAME = 'reference-transaction'
export const REFGUARD_LOCAL_HOOK = 'reference-transaction.local'

const HEADS = 'refs/heads/'
const ZERO = '0'.repeat(40)

export interface RefUpdate {
  oldSha: string
  newSha: string
  ref: string
}

/** `reference-transaction` stdin — one `<old> <new> <ref>` per update.
 *  A symref update arrives as `<old> ref:<target> HEAD`; the ref field
 *  is never refs/heads, so it drops out at isHeadMove. Malformed lines
 *  are skipped rather than failing the parse. */
export function parseRefUpdates(stdinText: string): RefUpdate[] {
  const out: RefUpdate[] = []
  for (const line of stdinText.split('\n')) {
    const t = line.trim()
    if (t === '') {
      continue
    }
    const fields = t.split(/\s+/)
    if (fields.length !== 3) {
      continue
    }
    out.push({ oldSha: fields[0]!, newSha: fields[1]!, ref: fields[2]! })
  }
  return out
}

/** A move of an existing local branch: refs/heads only, not a create,
 *  delete, or no-op write. Deletes keep git's own checks (checked-out
 *  branches are already ref-locked; `branch -D` is explicit force).
 *
 *  The recorded old is NOT trusted: unverified writes (`update-ref`
 *  without an old arg, `branch -f`, `switch -C`, forced fetch refspecs)
 *  report old = 0 even when the ref exists — git only logs the real old
 *  for updates it verified. resolveRef reads the on-disk value, which at
 *  `prepared` time is still the pre-transaction ref — old = 0 means
 *  "unverified", not "create". */
function effectiveOld(
  u: RefUpdate,
  resolveRef: (ref: string) => string | null
): string | null {
  if (!u.ref.startsWith(HEADS) || u.newSha === ZERO) {
    return null // not a local branch, or a delete
  }
  const old = u.oldSha !== ZERO ? u.oldSha : resolveRef(u.ref)
  if (old === null || old === ZERO || old === u.newSha) {
    return null // genuine create or no-op write
  }
  return old
}

/** git global options that consume the NEXT argv token — skipped so
 *  `git -C <dir>`/`-c k=v`/`--namespace <n>` don't read as the verb.
 *  Inline `--git-dir=<d>` forms are caught by the flag check below. */
const GIT_ARG_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
])
const GIT_INLINE_OPTS = [
  '--git-dir=',
  '--work-tree=',
  '--namespace=',
  '--exec-path=',
  '--config-env=',
  '--list-cmds=',
  '--super-prefix=',
]

/** The subcommand out of a git process argv (/proc cmdline split).
 *  argv0's basename must be `git`/`git.exe` or a dashed `git-<verb>`
 *  builtin (`git-rebase` → `rebase`) — anything else is not a git
 *  invocation and returns undefined (no data, never a verdict). */
export function gitSubcommand(argv: string[]): string | undefined {
  const exe = basename(argv[0] ?? '')
  if (exe.startsWith('git-')) {
    return exe.slice(4)
  }
  if (exe !== 'git' && exe !== 'git.exe') {
    return undefined
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (GIT_ARG_OPTS.has(a)) {
      i++
      continue
    }
    if (a.startsWith('-') || GIT_INLINE_OPTS.some((p) => a.startsWith(p))) {
      continue
    }
    return a
  }
  return undefined
}

/** Verbs whose ref writes are produced content — a non-ff move under
 *  one of these is the command's own semantics (amend, rebase), not a
 *  clobber. `pull` never appears: it writes the branch ref from an
 *  inner `git merge`/`git rebase` process — the argv the hook sees IS
 *  that inner verb. */
const CONTENT_VERBS = new Set([
  'am',
  'apply',
  'bisect',
  'cherry-pick',
  'commit',
  'merge',
  'pull',
  'rebase',
  'revert',
  'stash',
])

export type RefGuardVerdict =
  | { verdict: 'allow' }
  | { verdict: 'veto'; ref: string; oldSha: string; newSha: string; verb: string }

/** The guard's core. opts.argv is the invoking git process's argv;
 *  undefined means no cmdline data (no /proc, stale pid) → every move
 *  passes — the guard is strictly additive on platforms it can't see.
 *  opts.isAncestor and opts.resolveRef are injectable for tests: null
 *  = git can't decide → allow. */
export function refGuardVerdict(
  updates: RefUpdate[],
  opts: {
    env: NodeJS.ProcessEnv
    cwd: string
    argv?: string[]
    isAncestor?: (oldSha: string, newSha: string) => boolean | null
    resolveRef?: (ref: string) => string | null
  }
): RefGuardVerdict {
  if (['off', '0', 'false'].includes((opts.env.BRO_REF_GUARD ?? '').toLowerCase())) {
    return { verdict: 'allow' }
  }
  const isAncestor =
    opts.isAncestor ??
    ((o: string, n: string): boolean | null => {
      const r = gitTry(['-C', opts.cwd, 'merge-base', '--is-ancestor', o, n])
      return r.code === 0 ? true : r.code === 1 ? false : null
    })
  const resolveRef =
    opts.resolveRef ??
    ((ref: string): string | null => {
      const r = gitTry(['-C', opts.cwd, 'rev-parse', '--verify', '--quiet', ref])
      return r.code === 0 ? r.out.trim() : null
    })
  const verb = opts.argv === undefined ? undefined : gitSubcommand(opts.argv)
  for (const u of updates) {
    const oldSha = effectiveOld(u, resolveRef)
    if (oldSha === null) {
      continue
    }
    const ff = isAncestor(oldSha, u.newSha)
    if (ff !== false) {
      continue // ff — or unverifiable; both allow
    }
    if (verb === undefined || CONTENT_VERBS.has(verb)) {
      continue
    }
    return { verdict: 'veto', ref: u.ref, oldSha, newSha: u.newSha, verb }
  }
  return { verdict: 'allow' }
}

/** /proc/<pid>/cmdline → argv; undefined when unreadable (no /proc,
 *  dead pid). */
function readProcArgv(pid: number): string[] | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    const argv = raw.split('\0').filter((s) => s !== '')
    return argv.length > 0 ? argv : undefined
  } catch {
    return undefined
  }
}

/** git-hook entry — `bro hooks reference-transaction prepared <ppid>`
 *  with the update list on stdin (the shim buffers and replays it).
 *  The veto path sets exitCode 1 and explains on stderr; every other
 *  path — allow, no-data, internal error — exits 0. */
export function emitRefGuard(argv: string[], stdinText: string): void {
  try {
    if (argv[0] !== 'prepared') {
      return
    }
    const ppid = Number(argv[1])
    const invoker =
      Number.isInteger(ppid) && ppid > 0 ? readProcArgv(ppid) : undefined
    const v = refGuardVerdict(parseRefUpdates(stdinText), {
      env: process.env,
      cwd: process.cwd(),
      argv: invoker,
    })
    if (v.verdict === 'veto') {
      console.error(
        `bro refguard: refusing non-fast-forward move of ${v.ref} ` +
          `(${v.oldSha.slice(0, 8)} → ${v.newSha.slice(0, 8)}) by 'git ${v.verb}' — ` +
          `a repo with shared worktrees moves branches forward only ` +
          `(commit/rebase/merge/pull). A vetoed \`reset --hard\` may have ` +
          `already reset the worktree — inspect \`git status\`; the ` +
          `branch's commits are intact. Deliberate rewrite: ` +
          `BRO_REF_GUARD=off git …`
      )
      process.exitCode = 1
    }
  } catch {
    // fail-open — a broken guard must never wedge git
  }
}

/** The installed shim. Same chain convention as prepare-commit-msg: a
 *  pre-existing hook renamed .local runs first and keeps its veto —
 *  stdin is buffered once and replayed to each consumer since a hook's
 *  stdin is read-once. Fast-paths run before spawning bro: non-
 *  `prepared` phases and transactions without a refs/heads update
 *  (fetches, stash writes, AUTO_MERGE noise) never pay a node spawn.
 *  $PPID — the shim's parent — is the git process under judgment; it
 *  rides argv so the guard never has to walk /proc ancestry. */
export function refGuardShim(version: string): string {
  return `#!/bin/sh
${REFGUARD_HOOK_MARK} — https://github.com/theplenkov/bro
input="$(cat)"
chain="$(dirname "$0")/${REFGUARD_LOCAL_HOOK}"
if [ -x "$chain" ]; then
  printf '%s\\n' "$input" | "$chain" "$@" || exit $?
fi
[ "$1" = "prepared" ] || exit 0
case "$input" in
  *" refs/heads/"*) ;;
  *) exit 0 ;;
esac
if command -v bro >/dev/null 2>&1; then
  printf '%s\\n' "$input" | bro hooks reference-transaction "$1" "$PPID"
elif command -v npx >/dev/null 2>&1; then
  printf '%s\\n' "$input" | npx -y --prefer-offline "@broject/bro@${version}" hooks reference-transaction "$1" "$PPID"
else
  exit 0
fi
`
}

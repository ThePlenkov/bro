/**
 * Thin `bd` (beads) wrapper — the single PATH/exec contract for every
 * package. PATH lookup is the contract (same as gh); a generous maxBuffer
 * keeps large `bd list --json` payloads from hitting Node's 1 MiB default.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function bd(args: string[]): string {
  return execFileSync('bd', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // a wedged bd must degrade, not stall — hooks call this inline in the
    // agent lifecycle
    timeout: 15_000,
  })
}

export function bdJson<T>(args: string[]): T {
  const out = bd([...args, '--json'])
  try {
    return JSON.parse(out) as T
  } catch (err) {
    throw new Error(
      `bd returned malformed JSON — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Classify a provenance ref — shared by drill and retro evidence. */
export function refKind(ref: string): string {
  if (/\/pull\/|\/merge_requests\//.test(ref)) {
    return 'pr'
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return 'git-sha'
  }
  return 'work-id'
}

/** Provenance event kind for an evidence ref — a work-id is not a commit. */
export function evidenceKind(ref: string): 'land' | 'commit' | 'used' {
  switch (refKind(ref)) {
    case 'pr':
      return 'land'
    case 'git-sha':
      return 'commit'
    default:
      return 'used'
  }
}

/**
 * Stealth-init `.beads` in the current repo when missing — the single init
 * flags contract shared by debt sync and `bro setup` (local exclude,
 * nothing lands in git). Returns true when it initialized.
 */
export function initBeadsStealth(): boolean {
  if (existsSync(join(process.cwd(), '.beads'))) {
    return false
  }
  try {
    bd(['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'])
    return true
  } catch (err) {
    // Two first-time inits can race: both pass the existence check, the
    // loser's `bd init` fails while the winner's workspace lands. Tolerate
    // that race — callers verify completeness (`bd list` in checkBeads) —
    // but never swallow a real init failure.
    if (existsSync(join(process.cwd(), '.beads'))) {
      return false
    }
    throw err
  }
}

export function checkBeads(): void {
  try {
    bd(['--version'])
  } catch (err) {
    // ENOENT = the binary is absent; anything else is a real failure to surface
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('bd not found — install beads first (https://github.com/gastownhall/beads)')
    }
    throw err
  }
  try {
    bd(['list', '--json', '-n', '1'])
  } catch (err) {
    // preserve the real failure — "not initialized" is only one cause
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new Error(
      `bd list failed — ${stderr || (err instanceof Error ? err.message : String(err))} ` +
        '(run `bd init` if beads is not initialized here)'
    )
  }
}

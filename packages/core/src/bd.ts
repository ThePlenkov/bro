/**
 * Thin `bd` (beads) wrapper — the single PATH/exec contract for every
 * package. PATH lookup is the contract (same as gh); a generous maxBuffer
 * keeps large `bd list --json` payloads from hitting Node's 1 MiB default.
 */
import { execFileSync } from 'node:child_process'

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

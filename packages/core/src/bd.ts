/**
 * Thin `bd` wrapper — the beads CLI is a user-installed runtime dep; PATH
 * lookup is the contract (same as gh). Shared by the bead-backed domains
 * (drill frames, retrospection) instead of per-package copies.
 */
import { execFileSync } from 'node:child_process'

export function bd(args: string[]): string {
  // maxBuffer: unbounded listings (`-n 0`) can exceed execFileSync's 1 MiB
  // default once a repo accumulates labeled beads
  return execFileSync('bd', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
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
    // preserve the underlying failure — a permission or version error is
    // not "not initialized"
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /not initialized|run `bd init`/i.test(msg)
        ? 'beads not initialized in this repo — run `bd init` first'
        : `bd check failed — ${msg}`
    )
  }
}

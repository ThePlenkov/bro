/**
 * Thin `bd` wrapper for retro beads. Same contract as @bro/drill's
 * projection: bd is a user-installed CLI, PATH lookup is the contract.
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

export function checkBeads(): void {
  try {
    bd(['--version'])
  } catch {
    throw new Error('bd not found — install beads first (https://github.com/gastownhall/beads)')
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

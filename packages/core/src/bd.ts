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

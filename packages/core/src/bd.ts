/**
 * Thin `bd` (beads) wrapper — the single PATH/exec contract for every
 * package. PATH lookup is the contract (same as gh); a generous maxBuffer
 * keeps large `bd list --json` payloads from hitting Node's 1 MiB default.
 */
import { execFileSync } from 'node:child_process'

export function bd(args: string[]): string {
  return execFileSync('bd', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }) // NOSONAR — user-installed CLI; PATH lookup is the contract
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

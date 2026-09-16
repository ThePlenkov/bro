/**
 * Thin `bd` wrapper for drill frames. Same contract as @bro/debt's
 * projection: bd is a user-installed CLI, PATH lookup is the contract.
 */
import { execFileSync } from 'node:child_process'

export function bd(args: string[]): string {
  return execFileSync('bd', args, { encoding: 'utf8' }) // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
}

export function bdJson<T>(args: string[]): T {
  return JSON.parse(bd([...args, '--json'])) as T
}

export function checkBeads(): void {
  try {
    bd(['--version'])
  } catch {
    throw new Error('bd not found — install beads first (https://github.com/gastownhall/beads)')
  }
  try {
    bd(['list', '--json', '-n', '1'])
  } catch {
    throw new Error('beads not initialized in this repo — run `bd init` first')
  }
}

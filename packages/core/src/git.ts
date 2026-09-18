/**
 * Git plumbing helpers — same shell-out contract as `gh`/`bd`: the user's
 * git, their config, their credentials.
 */
import { spawnSync } from 'node:child_process'

export function git(args: string[]): string {
  const proc = spawnSync('git', args, { // NOSONAR — PATH lookup is the contract (same as gh/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (proc.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(proc.stderr ?? '').trim()}`)
  }
  return proc.stdout ?? ''
}

export function gitTry(args: string[]): { code: number; out: string; err: string } {
  const proc = spawnSync('git', args, { // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err: (proc.stderr ?? '').trim() }
}

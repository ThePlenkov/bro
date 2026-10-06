/**
 * Live child-process registry — the hook's exit hygiene. Async spawns
 * (bdAsync/ghAsync and friends) keep node's event loop alive until they
 * close: a probe that raced past its timeout leaves its child running,
 * so the hook process outlives the answer it already sent. Tracking
 * every spawn lets the hooks entrypoint unref the stragglers — command
 * paths never call this, so ordinary `await`ed spawns still pin the
 * process exactly like before.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'

const live = new Set<ChildProcess>()

/** Register a spawned child for later unref — deregisters itself on
 *  close, so settled spawns cost nothing. */
export function trackChild(proc: ChildProcess): void {
  live.add(proc)
  proc.on('close', () => {
    live.delete(proc)
  })
}

export interface SpawnResult {
  code: number | null
  out: string
  err: string
  /** Set when 'error' (spawn failure) beat 'close' — the raw Error. */
  error?: Error
}

/** Spawn `cmd` with piped stdout/stderr collected — the shared skeleton
 *  behind the async CLI twins (bdAsync, ghTryAsync, …). Timeouts and
 *  exit-code policy stay with the caller; `done` resolves exactly once,
 *  on 'close' or 'error' (a spawn failure still surfaces via `error`
 *  with its message merged into `err`). */
export function spawnCollect(
  cmd: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>
): { proc: ChildProcess; done: Promise<SpawnResult> } {
  const proc = spawn(cmd, args, { // NOSONAR — PATH lookup is the contract (same as gh/git)
    cwd,
    env: env === undefined ? undefined : { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  trackChild(proc)
  let out = ''
  let err = ''
  proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
  proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
  const done = new Promise<SpawnResult>((resolve) => {
    proc.on('error', (error) =>
      resolve({ code: null, out, err: (err + '\n' + error.message).trim(), error })
    )
    proc.on('close', (code) => resolve({ code, out, err: err.trim() }))
  })
  return { proc, done }
}

/** Unref every still-running child and its stdio pipes — the pipes are
 *  handles too and would keep the loop alive on their own. Called by the
 *  hooks entrypoint after dispatch: any child still open belongs to a
 *  probe that already timed out, and its late output is discarded. */
export function unrefPendingChildren(): void {
  for (const proc of live) {
    proc.unref()
    // piped stdio are Sockets under the Readable type — handles that
    // keep the loop alive on their own
    ;(proc.stdout as Socket | null)?.unref()
    ;(proc.stderr as Socket | null)?.unref()
  }
}

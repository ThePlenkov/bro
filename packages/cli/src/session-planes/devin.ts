/** The devin session plane — every local devin CLI session
 *  (interactive, `-p`, `acp`) drops a `<name>.lock` under
 *  `$XDG_DATA_HOME/devin/cli/session_locks` holding its pid; live
 *  sessions dedupe by pid because a resumed session leaves a second
 *  lock for the same process. Cloud-side sessions
 *  (devin_session_create via MCP) never write a local lock — this is
 *  a host-local count, and that blind spot is deliberate: the plane
 *  reports what this host can verify.

 *  This is vendor knowledge living at the plugin layer — core's
 *  session-planes module owns the mutex/reservation/quota mechanics,
 *  this file owns ONLY how devin marks and counts its sessions. */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  pidAlive,
  registerSessionPlane,
  SpawnError,
  type SessionPlane,
} from '@broject/core'

/** Devin's session-lock dir — `agents.devin.lockDir` overrides for odd
 *  installs/tests; `env` is the environment the derivation reads (a
 *  worker spawned under its own XDG_DATA_HOME/HOME resolves a
 *  different dir — its locks land THERE). */
export function devinLocksDir(
  bag?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): string {
  const override = bag?.['lockDir']
  if (typeof override === 'string' && override.trim() !== '') {
    return override
  }
  const xdg = env['XDG_DATA_HOME']
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : join(env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir(), '.local', 'share')
  return join(base, 'devin', 'cli', 'session_locks')
}

/** One lock file → its pid. A file that vanished mid-scan was never
 *  counted; anything else unreadable fails the whole count closed.
 *  Non-pid content returns nothing — the strict digit check keeps a
 *  corrupt `123oops`/`0x10` lock from aliasing an unrelated live pid. */
function lockPid(dir: string, name: string): number | undefined {
  let raw: string
  try {
    raw = readFileSync(join(dir, name), 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new SpawnError(
      `cannot verify devin session count — ${dir}/${name}: ${(err as Error).message}`,
      'unavailable'
    )
  }
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined
}

/** Every dir a count must cover: the spawner's resolved lock dir plus
 *  the worker's own effective one — spec.env can hand the spawned
 *  session a different XDG_DATA_HOME/HOME, and its devin lock lands
 *  THERE, invisible to a scan of only the spawner's dir. */
function devinSessionDirs(
  bag: Record<string, unknown>,
  workerEnv?: Record<string, string>
): string[] {
  const dirs = [devinLocksDir(bag)]
  if (workerEnv !== undefined) {
    const eff = devinLocksDir(bag, { ...process.env, ...workerEnv })
    if (eff !== dirs[0]) {
      dirs.push(eff)
    }
  }
  return dirs
}

/** Live devin session pids across the dirs — lock files whose pid is
 *  alive, deduplicated (a resumed session leaves a second lock for the
 *  same process). A missing dir means no devin install → empty; any
 *  OTHER read failure throws SpawnError('unavailable') — an
 *  unverifiable count fails closed, never silently admits. */
function liveDevinLockPids(dirs: string[]): Set<number> {
  const live = new Set<number>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw new SpawnError(
        `cannot verify devin session count — ${dir}: ${(err as Error).message}`,
        'unavailable'
      )
    }
    for (const name of names) {
      if (!name.endsWith('.lock')) {
        continue
      }
      const pid = lockPid(dir, name)
      if (pid !== undefined && pidAlive(pid)) {
        live.add(pid)
      }
    }
  }
  return live
}

/** Live devin sessions — lock files whose pid is alive, deduplicated.
 *  A missing dir means no devin install → zero sessions; any OTHER
 *  read failure throws SpawnError('unavailable') — an unverifiable
 *  count fails closed, never silently admits. */
export function countDevinSessions(dirs: string[]): number {
  return liveDevinLockPids(dirs).size
}

/** Worker classification for one locked pid — a spawned (never
 *  interactive) devin session. Two /proc probes, either suffices:
 *  the BRO_AGENT_ID env badge every bro backend pins into the worker's
 *  env (inherited by the devin child a wrapper spawns), and a
 *  non-terminal stdin (`fd/0` outside /dev/pts — headless pipes, null,
 *  sockets; interactive devin reads a pty).
 *
 *  A pid neither probe verifies is NOT a worker: unreadable state only
 *  undercounts the worker lane, deferring to the maxSessions ceiling —
 *  while phantom workers would refuse real spawns, re-creating the
 *  starvation the lane exists to remove. `procDir` injectable for
 *  tests; absent /proc (macOS) simply yields non-workers. */
export function devinPidIsWorker(pid: number, procDir = '/proc'): boolean {
  const dir = join(procDir, String(pid))
  try {
    // NUL-anchored: environ entries are NUL-separated and an
    // unanchored match would take `XBRO_AGENT_ID=` (proc-owner's
    // AGENT_ENV_RE convention)
    if (/(?:^|\0)BRO_AGENT_ID=/.test(readFileSync(join(dir, 'environ'), 'utf8'))) {
      return true
    }
  } catch {
    // unreadable environ — the stdin probe still applies
  }
  try {
    return !readlinkSync(join(dir, 'fd', '0')).startsWith('/dev/pts/')
  } catch {
    return false
  }
}

/** Live worker sessions — the spawned subset of liveDevinLockPids.
 *  `isWorker` injectable for tests; the default is the /proc
 *  classifier. */
export function countDevinWorkers(
  dirs: string[],
  isWorker: (pid: number) => boolean = devinPidIsWorker
): number {
  let workers = 0
  for (const pid of liveDevinLockPids(dirs)) {
    if (isWorker(pid)) {
      workers++
    }
  }
  return workers
}

/** The builtin plane — registers on import. */
export const devinSessionPlane: SessionPlane = {
  kind: 'devin',
  detectsCli: (cliName) => cliName === 'devin',
  countLive(bag, workerEnv) {
    return countDevinSessions(devinSessionDirs(bag, workerEnv))
  },
  countWorkers(bag, workerEnv) {
    return countDevinWorkers(devinSessionDirs(bag, workerEnv))
  },
}

registerSessionPlane(devinSessionPlane)

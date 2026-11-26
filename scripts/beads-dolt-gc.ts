/**
 * Safely reclaim unreachable objects from a beads Dolt store and its git
 * mirror.
 *
 * Dry-run is the default.  A real collection requires `--run`:
 *   node scripts/beads-dolt-gc.ts --run [--beads /path/to/.beads]
 *
 * This is deliberately an operator maintenance operation, not part of the
 * write path.  Dolt's embedded engine does not expose a cross-process
 * maintenance lock to bd, so collection refuses to start while a bd or dolt
 * process is running.  This conservative check avoids relying on whether
 * bd put BEADS_DIR in its argv (it commonly comes from the environment).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export interface MaintenanceCommand {
  readonly cwd: string
  readonly args: readonly string[]
  readonly label: string
}

export interface ProcessProbe {
  readonly pid: number
  readonly command: string
}

const lockName = '.bro-dolt-gc.lock'

export function storesUnder(beads: string): string[] {
  return ['embeddeddolt', 'dolt']
    .map((name) => join(beads, name))
    .filter((root) => existsSync(root))
    .flatMap((root) =>
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, '.dolt')))
        .map((entry) => join(root, entry.name)),
    )
}

export function commandsFor(beads: string): MaintenanceCommand[] {
  const commands = storesUnder(beads).map((cwd) => ({ cwd, args: ['gc'], label: `dolt gc (${cwd})` }))
  const mirror = join(beads, 'dolt-mirror-origin.git')
  return existsSync(join(mirror, 'HEAD'))
    ? [...commands, { cwd: mirror, args: ['gc', '--prune=now'], label: `git gc (${mirror})` }]
    : commands
}

export function runningProcesses(selfPid = process.pid): ProcessProbe[] {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) throw new Error(`cannot inspect processes: ${result.stderr?.trim() || 'ps failed'}`)
  return (result.stdout ?? '')
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (!match || Number(match[1]) === selfPid || !/(?:^|\s)(?:bd|dolt)(?:\s|$)/.test(match[2])) return []
      return [{ pid: Number(match[1]), command: match[2] }]
    })
}

export function acquireLock(beads: string): () => void {
  const path = join(beads, lockName)
  try {
    mkdirSync(path)
    writeFileSync(join(path, 'pid'), `${process.pid}\n`) // NOSONAR -- path is the realpathed operator-selected beads store plus a fixed lock filename.
  } catch {
    recoverLock(path)
  }
  return () => rmSync(path, { recursive: true, force: true })
}

function recoverLock(path: string): void {
  const owner = lockOwner(path)
  if (owner !== undefined && processIsAlive(owner)) {
    throw new Error(`maintenance lock is held by pid ${owner}: ${path}`)
  }
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path)
  writeFileSync(join(path, 'pid'), `${process.pid}\n`) // NOSONAR -- path is the realpathed operator-selected beads store plus a fixed lock filename.
}

function lockOwner(path: string): number | undefined {
  try {
    const value = readFileSync(join(path, 'pid'), 'utf8') // NOSONAR -- path is the realpathed operator-selected beads store plus a fixed lock filename.
    return /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function runCommand(command: MaintenanceCommand): void {
  const result = spawnSync(command.label.startsWith('git') ? 'git' : 'dolt', [...(command.label.startsWith('git') ? ['gc', '--prune=now'] : command.args)], {
    cwd: command.cwd,
    stdio: 'inherit',
    timeout: 30 * 60_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command.label} failed with exit ${result.status ?? 'unknown'}`)
}

function discoverBeads(flag: string | undefined): string {
  const candidate = flag ?? process.env.BEADS_DIR ?? join(process.cwd(), '.beads')
  const beads = realpathSync(resolve(candidate))
  if (!existsSync(join(beads, 'metadata.json'))) throw new Error(`${beads} is not a beads store (metadata.json missing)`)
  return beads
}

export function main(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'boolean' }, beads: { type: 'string' } } })
  const beads = discoverBeads(values.beads)
  const commands = commandsFor(beads)
  const active = runningProcesses()
  if (active.length > 0) {
    throw new Error(`quiet window unavailable; active bd/dolt processes: ${active.map((p) => `${p.pid} ${p.command}`).join('; ')}`)
  }
  console.log(`beads: ${beads}`)
  console.log(commands.length ? commands.map((command) => `would run: ${command.label}`).join('\n') : 'no Dolt stores or origin mirror found')
  if (!values.run) {
    console.log('dry run — pass --run during a quiet window to collect')
    return
  }
  const release = acquireLock(beads)
  try {
    const stillActive = runningProcesses()
    if (stillActive.length > 0) throw new Error('quiet window ended before collection started')
    for (const command of commands) runCommand(command)
  } finally {
    release()
  }
}

const script = process.argv[1] ? realpathSync(resolve(process.argv[1])) : ''
if (script === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) {
    console.error(`beads-dolt-gc: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

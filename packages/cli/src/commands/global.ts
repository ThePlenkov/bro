/**
 * `bro global` — the user-level beads store: separate database, explicit
 * access only.
 *
 *   bro global init [--prefix P]   create + validate the store
 *   bro global path                print the resolved store dir
 *   bro global <bd args…>          run bd against the store
 *                                  (`bro global ready`, `bro global create …`)
 *   bro next --global              schedule from the global queue
 *
 * Project beads and global beads never mix: the store is a plain
 * `bd init` directory — default ~/.local/share/bro/beads, overridden by
 * the `beads.global` key in bro.config.json or the BRO_GLOBAL_BEADS env
 * var (env wins). Local-only by default; point the store's own dolt
 * remote at a private repo for a cross-machine queue.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bdTry, DEFAULT_GLOBAL_BEADS_DIR } from '@bro/core'
import { flag } from './args.ts'
import { loadBroConfig } from '../plugins.ts'

/** Where the global store lives — config/env/default resolution. */
export function resolveGlobalDir(cwd: string = process.cwd()): string {
  const cfg = loadBroConfig(cwd) as { beads?: { global?: string } }
  return resolve(cfg.beads?.global ?? DEFAULT_GLOBAL_BEADS_DIR)
}

/** The store dir when it must exist — scheduling from a store that was
 *  never initialized must fail loudly, not read an empty queue. */
export function requireGlobalStore(cwd: string = process.cwd()): string {
  const dir = resolveGlobalDir(cwd)
  if (!existsSync(join(dir, '.beads'))) {
    console.error(`error: no global beads store at ${dir} — run \`bro global init\` first`)
    process.exit(2)
  }
  return dir
}

function usage(): never {
  console.error(`Usage: bro global <command> [args…]

Commands:
  init [--prefix P]    Create + validate the global beads store
  path                 Print the resolved store dir
  <bd args…>           Run bd against the store — e.g. \`bro global ready --json\`

Store: beads.global in bro.config.json or $BRO_GLOBAL_BEADS
       (default ${DEFAULT_GLOBAL_BEADS_DIR})`)
  process.exit(2)
}

function cmdInit(argv: string[]): void {
  const dir = resolveGlobalDir()
  const prefix = flag(argv, '--prefix') ?? 'global'
  mkdirSync(dir, { recursive: true })
  const res = spawnSync(
    'bd',
    ['init', '--prefix', prefix, '--non-interactive', '--init-if-missing'],
    { cwd: dir, stdio: 'inherit' } // NOSONAR — PATH lookup is the contract
  )
  if (res.status !== 0) {
    console.error(`error: bd init failed in ${dir}`)
    process.exit(1)
  }
  // validate: a store that can't answer config is broken, not created
  const check = bdTry(['config', 'get', 'issue_prefix'], 15_000, dir)
  if (check.code !== 0) {
    console.error(`error: store created but unusable — ${check.err || 'bd config failed'}`)
    process.exit(1)
  }
  console.log(`global store ready: ${dir} (prefix ${prefix})`)
  console.log('  queue: bro global ready — schedule: bro next --global')
}

export function runGlobalCommand(argv: string[]): void {
  const sub = argv[0]
  if (sub === undefined || sub === '--help' || sub === '-h') {
    usage()
  }
  if (sub === 'init') {
    cmdInit(argv.slice(1))
    return
  }
  if (sub === 'path') {
    console.log(resolveGlobalDir())
    return
  }
  // passthrough — every other bd subcommand runs against the store
  const dir = requireGlobalStore()
  const res = spawnSync('bd', argv, { cwd: dir, stdio: 'inherit' }) // NOSONAR — PATH contract
  process.exit(res.status ?? 1)
}

/**
 * `store` doc type — the beads stores bro knows: the project store at
 * the repo root and the user-level global store.
 *
 *   bro store list                   both stores, path + prefix + health
 *   bro store show --global          details of the resolved global dir
 *   bro store init --global          create + validate the global store
 *   bro store path --global          print the resolved store dir
 *
 * The global store defaults to ~/.local/share/bro/beads — `beads.global`
 * in bro.config.json or $BRO_GLOBAL_BEADS (env wins) relocate it.
 * Project and global beads never mix: the store is a plain `bd init`
 * directory addressed by cwd, not by merged state.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bdTry, DEFAULT_GLOBAL_BEADS_DIR, gitTry } from '@bro/core'
import type { DocAdapter, DocCtx, DocFlags, DocType, Scope } from '@bro/core'
import { loadBroConfig } from '../plugins.ts'

export interface StoreInfo {
  name: 'project' | 'global'
  path: string
  /** .beads present → usable store */
  initialized: boolean
  prefix?: string
}

/** Where the global store lives — config/env/default resolution. A
 *  relative `beads.global` anchors at `cwd` (the dir the config was
 *  loaded for), not at whatever process.cwd happens to be — absolute
 *  or `~/…` paths are preferred and skip the warning. */
export function resolveGlobalDir(cwd: string = process.cwd()): string {
  const cfg = loadBroConfig(cwd) as { beads?: { global?: string } }
  const p = cfg.beads?.global ?? DEFAULT_GLOBAL_BEADS_DIR
  if (!isAbsolute(p)) {
    console.error(`bro: relative beads.global '${p}' resolves against ${cwd} — prefer an absolute or ~/… path`)
  }
  return resolve(cwd, p)
}

/** The store dir when it must exist — scheduling from a store that was
 *  never initialized must fail loudly, not read an empty queue. */
export function requireGlobalStore(cwd: string = process.cwd()): string {
  const dir = resolveGlobalDir(cwd)
  if (!existsSync(join(dir, '.beads'))) {
    console.error(`error: no global beads store at ${dir} — run \`bro store init --global\` first`)
    process.exit(2)
  }
  return dir
}

function storeInfo(name: Scope, path: string): StoreInfo {
  // usable = answers bd — a linked worktree can lack .beads yet share
  // the project store (bd routes by repo), so probe rather than stat
  const probe = bdTry(['config', 'get', 'issue_prefix'], 15_000, path)
  const raw = probe.code === 0 ? probe.out.trim() : ''
  const prefix = raw && raw !== '(not set)' ? raw : undefined
  return { name, path, initialized: probe.code === 0, prefix }
}

/** Project store root — the repo top-level when inside one. */
function projectRoot(cwd: string): string {
  const top = gitTry(['-C', cwd, 'rev-parse', '--show-toplevel']).out.trim()
  return top || cwd
}

function storePath(name: Scope, root: string): string {
  return name === 'global' ? resolveGlobalDir(root) : projectRoot(root)
}

/** The store a verb targets: explicit ref ("global"/"project") wins,
 *  else the resolved scope. */
function storeName(ref: string | undefined, scope: Scope): Scope | undefined {
  if (ref === 'project' || ref === 'global') {
    return ref
  }
  if (ref !== undefined) {
    return undefined
  }
  return scope
}

function initStore(name: Scope, flags: DocFlags, root: string): void {
  const dir = storePath(name, root)
  const prefix = flags['prefix'] ?? (name === 'global' ? 'global' : undefined)
  mkdirSync(dir, { recursive: true })
  const args = ['init', '--non-interactive', '--init-if-missing']
  if (prefix) {
    args.push('--prefix', prefix)
  }
  const res = spawnSync(
    'bd', // NOSONAR — PATH lookup is the contract (same as the bd wrapper)
    args,
    { cwd: dir, stdio: 'inherit' }
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
  const suffix = prefix ? ` (prefix ${prefix})` : ''
  console.log(`${name} store ready: ${dir}${suffix}`)
}

function storeAdapter(ctx: DocCtx): DocAdapter<StoreInfo> {
  const named = (ref: string | undefined): Scope | undefined => storeName(ref, ctx.scope)
  return {
    list: () => (['project', 'global'] as const).map((n) => storeInfo(n, storePath(n, ctx.root))),
    get: (ref) => {
      const name = named(ref)
      return name ? storeInfo(name, storePath(name, ctx.root)) : null
    },
    init: (ref: string | undefined, flags: DocFlags) => {
      const name = named(ref)
      if (!name) {
        console.error(`error: unknown store "${ref}" — project|global`)
        process.exit(2)
      }
      initStore(name, flags, ctx.root)
    },
    path: (ref: string | undefined) => {
      const name = named(ref)
      if (!name) {
        console.error(`error: unknown store "${ref}" — project|global`)
        process.exit(2)
      }
      console.log(storePath(name, ctx.root))
    },
  }
}

export const storeDoc: DocType<StoreInfo> = {
  name: 'store',
  aliases: ['stores'],
  scopes: ['project', 'global'],
  render(s) {
    const state = s.initialized ? (s.prefix ?? '?') : 'uninitialized'
    return `${s.name.padEnd(8)} ${state.padEnd(13)} ${s.path}`
  },
  adapter: storeAdapter,
}

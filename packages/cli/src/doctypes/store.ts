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
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_GLOBAL_BEADS_DIR, gitTry, taskStore } from '@broject/core'
import type { DocAdapter, DocCtx, DocFlags, DocType, Scope } from '@broject/core'
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
  // usable = answers the store — a linked worktree can lack .beads yet
  // share the project store (bd routes by repo), so probe rather than
  // stat. prefix() throws on an unreachable store — that's the health
  // probe. This doctype addresses the store by cwd, so the beads-side
  // taskStore() is the port handle (connectors.tasks selects *which*
  // backend; a .beads dir is always beads).
  try {
    const prefix = taskStore(path).prefix()
    return { name, path, initialized: true, prefix }
  } catch {
    return { name, path, initialized: false }
  }
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

/** Report an init failure precisely — a missing binary throws ENOENT,
 *  and "bd init failed" would bury that diagnostic. A freshly-created
 *  dir is removed so a failed init doesn't strand an empty store. */
function initFailed(err: unknown, dir: string, created: boolean): never {
  const enoent = (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  console.error(
    enoent
      ? 'error: bd not found — install beads first (https://github.com/gastownhall/beads)'
      : `error: store init failed in ${dir}${err instanceof Error ? ` (${err.message})` : ''}`
  )
  if (created) {
    // we made the dir this run — any failure strands an empty store
    // otherwise, not just a missing-bd ENOENT
    rmSync(dir, { recursive: true, force: true })
  }
  process.exit(1)
}

/** Exported for tests — the ENOENT/prefix paths are the contract a
 *  missing or mismatched bd installation must surface, not swallow. */
export function initStore(name: Scope, flags: DocFlags, root: string): void {
  const dir = storePath(name, root)
  const prefix = flags['prefix'] ?? (name === 'global' ? 'global' : undefined)
  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  const store = taskStore(dir) // a .beads dir is always beads — the connector's init capability
  try {
    const out = store.init?.({ prefix })
    if (out) {
      process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
    }
  } catch (err) {
    initFailed(err, dir, created)
  }
  // validate: a store that can't answer is broken, not created — and a
  // store that accepts --prefix but doesn't apply it must not report a
  // prefix it never set, so verify what it actually recorded
  let reported: string | undefined
  try {
    reported = store.prefix()
  } catch (err) {
    console.error(
      `error: store created but unusable — ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }
  if (prefix && reported !== prefix) {
    console.error(
      `error: store in ${dir} recorded prefix "${reported ?? '(not set)'}" — expected "${prefix}"`
    )
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

/**
 * `bro plugins` — two surfaces (spec: specs/bro-1qpk.1.md):
 *
 *   bro plugins                                BroPlugin registry table
 *   bro plugins list [--json]                  client × scope install matrix
 *   bro plugins install <client> [--global] [--local] [--dry-run]
 *   bro plugins uninstall <client> [--global] [--local] [--dry-run] [--force]
 *
 * The adapter surface materializes a client plugin module into that
 * client's plugin dirs — opencode: `$XDG_CONFIG_HOME/opencode/plugins/
 * bro.ts` (default ~/.config) and `<repo>/.opencode/plugins/bro.ts`.
 * Neither scope flag means both. Install is idempotent by content:
 * a current file is a no-op, a differing one is `updated`. Uninstall
 * refuses a foreign/hand-edited file without `--force`.
 *
 * PLUGINS is injected by the registry — importing it here would close
 * an import cycle (the registry imports this module for `run`).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitTry, type BroPlugin } from '@broject/core'
import { positionals } from './args.ts'

export type PluginScope = 'global' | 'local'
/** installed = bytes match the shipped artifact; stale = bytes differ;
 *  present = file exists but no artifact resolved to compare against. */
export type InstallState = 'installed' | 'stale' | 'present' | 'absent'

export interface PluginRow {
  client: string
  scope: PluginScope
  state: InstallState
  path: string
}

interface ClientSpec {
  /** The shippable module's source path, or null when unresolvable. */
  artifact(cwd: string): string | null
  targets(cwd: string, env: NodeJS.ProcessEnv): Record<PluginScope, string>
}

/** The bro package root — this module sits at src/commands/ in a
 *  checkout and bundles into dist/index.js in the tarball, so anchor on
 *  the package.json, not on the module's own depth. */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(dir, 'package.json')
    try {
      if (
        existsSync(manifest) &&
        (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@broject/bro'
      ) {
        return dir
      }
    } catch {
      // unreadable manifest — keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

function gitRoot(cwd: string): string | null {
  const r = gitTry(['-C', cwd, 'rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null
}

function firstExisting(candidates: Array<string | null>): string | null {
  for (const c of candidates) {
    if (c !== null && existsSync(c)) {
      return c
    }
  }
  return null
}

/** Artifact sources in preference order: the TS source (checkout), the
 *  bundled dist entry (npm tarball — self-contained: opencode.ts imports
 *  node builtins only, so its bundle has no internal chunks), then the
 *  repo-distributed adapter a bro clone carries under plugins/. */
function opencodeArtifact(cwd: string): string | null {
  const pkg = packageRoot()
  const root = gitRoot(cwd)
  return firstExisting([
    pkg === null ? null : join(pkg, 'src', 'opencode.ts'),
    pkg === null ? null : join(pkg, 'dist', 'opencode.js'),
    root === null ? null : join(root, 'plugins', 'opencode', 'bro', 'bro.ts'),
  ])
}

const CLIENTS: Record<string, ClientSpec> = {
  opencode: {
    artifact: opencodeArtifact,
    targets: (cwd, env) => ({
      global: join(
        env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'opencode',
        'plugins',
        'bro.ts'
      ),
      local: join(gitRoot(cwd) ?? cwd, '.opencode', 'plugins', 'bro.ts'),
    }),
  },
}

export function clientNames(): string[] {
  return Object.keys(CLIENTS)
}

/** The materialized module's fingerprint — holds for the TS source and
 *  the compiled bundle (`export default {id:"bro",server:BroPlugin}`),
 *  so any version we ever shipped is recognized as ours. */
export function isBroAdapter(text: string): boolean {
  return /\bid:\s*["']bro["']/.test(text) && /\bserver:\s*BroPlugin\b/.test(text)
}

function stateAt(target: string, artifact: string | null): InstallState {
  if (!existsSync(target)) {
    return 'absent'
  }
  if (artifact === null) {
    return 'present'
  }
  return readFileSync(target, 'utf8') === readFileSync(artifact, 'utf8')
    ? 'installed'
    : 'stale'
}

/** The client × scope matrix — `bro plugins list` and doctor's row. */
export function pluginRows(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): PluginRow[] {
  const rows: PluginRow[] = []
  for (const [name, client] of Object.entries(CLIENTS)) {
    const artifact = client.artifact(cwd)
    const targets = client.targets(cwd, env)
    for (const scope of ['global', 'local'] as const) {
      const path = targets[scope]
      rows.push({ client: name, scope, state: stateAt(path, artifact), path })
    }
  }
  return rows
}

/** `write tmp; rename` — a torn write must never leave a half module. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export interface MutateOpts {
  dryRun: boolean
  force: boolean
  cwd: string
  env: NodeJS.ProcessEnv
}

export type Action =
  | 'installed'
  | 'updated'
  | 'current'
  | 'removed'
  | 'absent'
  | 'refused'
  | 'would-install'
  | 'would-update'
  | 'would-remove'

export interface Outcome {
  client: string
  scope: PluginScope
  action: Action
  path: string
}

function knownClient(name: string): ClientSpec {
  const client = CLIENTS[name]
  if (client === undefined) {
    console.error(`plugins: unknown client "${name}" — known: ${clientNames().join(', ')}`)
    process.exit(2)
  }
  return client
}

export function installClient(
  name: string,
  scopes: PluginScope[],
  opts: MutateOpts
): Outcome[] {
  const client = knownClient(name)
  const artifact = client.artifact(opts.cwd)
  if (artifact === null) {
    console.error(`plugins install: cannot resolve the ${name} adapter module`)
    process.exit(1)
  }
  const content = readFileSync(artifact, 'utf8')
  const targets = client.targets(opts.cwd, opts.env)
  return scopes.map((scope): Outcome => {
    const path = targets[scope]
    const prior = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (prior === content) {
      return { client: name, scope, action: 'current', path }
    }
    if (opts.dryRun) {
      return {
        client: name,
        scope,
        action: prior === null ? 'would-install' : 'would-update',
        path,
      }
    }
    atomicWrite(path, content)
    return { client: name, scope, action: prior === null ? 'installed' : 'updated', path }
  })
}

export function uninstallClient(
  name: string,
  scopes: PluginScope[],
  opts: MutateOpts
): Outcome[] {
  const client = knownClient(name)
  const targets = client.targets(opts.cwd, opts.env)
  return scopes.map((scope): Outcome => {
    const path = targets[scope]
    if (!existsSync(path)) {
      return { client: name, scope, action: 'absent', path }
    }
    if (!opts.force && !isBroAdapter(readFileSync(path, 'utf8'))) {
      return { client: name, scope, action: 'refused', path }
    }
    if (opts.dryRun) {
      return { client: name, scope, action: 'would-remove', path }
    }
    rmSync(path)
    return { client: name, scope, action: 'removed', path }
  })
}

function printOutcomes(outcomes: Outcome[]): void {
  for (const o of outcomes) {
    const note =
      o.action === 'refused'
        ? ' — not a bro adapter; remove manually or pass --force'
        : ''
    console.log(`${o.client} ${o.scope}: ${o.action} — ${o.path}${note}`)
  }
}

function clientArg(rest: string[]): string {
  const pos = positionals(rest, new Set())
  if (pos.length !== 1) {
    console.error(
      `usage: bro plugins install|uninstall <${clientNames().join('|')}> [--global] [--local] [--dry-run] [--force]`
    )
    process.exit(2)
  }
  return pos[0]!
}

/** Neither scope flag means both — `--global` or `--local` alone narrows. */
export function scopesOf(rest: string[]): PluginScope[] {
  const global = rest.includes('--global')
  const local = rest.includes('--local')
  return global === local ? ['global', 'local'] : global ? ['global'] : ['local']
}

function printRegistry(plugins: BroPlugin[]): void {
  for (const p of plugins) {
    const src = p.external ? 'ext' : 'core'
    const plan = p.planSchema ? 'plan' : '-'
    console.log(
      `${p.name.padEnd(12)} ${(p.skill ?? '-').padEnd(10)} ${(p.configKey ?? '-').padEnd(8)} ${src.padEnd(4)} ${plan.padEnd(4)} ${p.summary}`
    )
  }
}

export function runPluginsCommand(argv: string[], plugins: BroPlugin[]): void {
  const [sub, ...rest] = argv
  switch (sub) {
    case undefined:
      printRegistry(plugins)
      return
    case 'list': {
      const rows = pluginRows()
      if (rest.includes('--json')) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      for (const r of rows) {
        console.log(
          `${r.client.padEnd(10)} ${r.scope.padEnd(7)} ${r.state.padEnd(10)} ${r.path}`
        )
      }
      return
    }
    case 'install':
    case 'uninstall': {
      const name = clientArg(rest)
      const opts: MutateOpts = {
        dryRun: rest.includes('--dry-run'),
        force: rest.includes('--force'),
        cwd: process.cwd(),
        env: process.env,
      }
      const mutate = sub === 'install' ? installClient : uninstallClient
      const outcomes = mutate(name, scopesOf(rest), opts)
      printOutcomes(outcomes)
      if (outcomes.some((o) => o.action === 'refused')) {
        process.exit(1)
      }
      return
    }
    default:
      console.error(
        'usage: bro plugins [list [--json] | install <client> [--global] [--local] [--dry-run] | uninstall <client> [--global] [--local] [--dry-run] [--force]]'
      )
      process.exit(2)
  }
}

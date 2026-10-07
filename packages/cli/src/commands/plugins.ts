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
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

/** A manifest step beyond the module file — kilo's global install also
 *  needs a file:/// entry in kilo.json's `plugin` array. */
interface Registration {
  /** Reading this parses the manifest — a malformed one exits before
   *  any file is written. */
  readonly registered: boolean
  register(): void
  unregister(): void
}

/** A second module file installed beside the primary — opencode's TUI
 *  plugin lands as `bro-cli.ts` next to `bro.ts`. Extras carry their own
 *  artifact ladder; they never own a registration (where a manifest
 *  entry exists it belongs to the primary module). */
interface ExtraFile {
  artifact: string | null
  targets: Record<PluginScope, string>
}

interface ClientSpec {
  /** The shippable module's source path, or null when unresolvable. */
  artifact(cwd: string): string | null
  targets(cwd: string, env: NodeJS.ProcessEnv): Record<PluginScope, string>
  extras?(cwd: string, env: NodeJS.ProcessEnv): ExtraFile[]
  registration?(
    scope: PluginScope,
    path: string,
    env: NodeJS.ProcessEnv
  ): Registration | null
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

/** The TUI half's ladder mirrors the server module's — source, bundled
 *  dist (`./tui` export → dist/opencode-tui.js), the repo artifact. */
function opencodeTuiArtifact(cwd: string): string | null {
  const pkg = packageRoot()
  const root = gitRoot(cwd)
  return firstExisting([
    pkg === null ? null : join(pkg, 'src', 'opencode-tui.ts'),
    pkg === null ? null : join(pkg, 'dist', 'opencode-tui.js'),
    root === null ? null : join(root, 'plugins', 'opencode', 'bro', 'cli.ts'),
  ])
}

function kiloConfigDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kilo')
}

function kiloManifestPath(env: NodeJS.ProcessEnv): string {
  return join(kiloConfigDir(env), 'kilo.json')
}

/** kilo.json is strict JSON — kilo.jsonc exists too but kilo merges both
 *  files, so writing only kilo.json is always correct and a comment-
 *  bearing file we can't parse is left for the user, never rewritten. */
function readKiloManifest(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = kiloManifestPath(env)
  if (!existsSync(path)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    console.error(
      `plugins: ${path} is not plain JSON — edit the "plugin" array by hand`
    )
    process.exit(1)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`plugins: ${path} must be a JSON object — edit it by hand`)
    process.exit(1)
  }
  return parsed as Record<string, unknown>
}

function kiloRegistration(path: string, env: NodeJS.ProcessEnv): Registration {
  const manifestPath = kiloManifestPath(env)
  const entry = pathToFileURL(path).href
  const pluginList = (m: Record<string, unknown>): unknown[] =>
    Array.isArray(m.plugin) ? m.plugin : []
  const writeManifest = (m: Record<string, unknown>): void => {
    atomicWrite(manifestPath, `${JSON.stringify(m, null, 2)}\n`)
  }
  return {
    get registered() {
      return pluginList(readKiloManifest(env)).includes(entry)
    },
    register() {
      const fresh = !existsSync(manifestPath)
      const m = readKiloManifest(env)
      const list = pluginList(m)
      if (list.includes(entry)) {
        return
      }
      const body = fresh
        ? { $schema: 'https://app.kilo.ai/config.json', ...m }
        : m
      writeManifest({ ...body, plugin: [...list, entry] })
    },
    unregister() {
      if (!existsSync(manifestPath)) {
        return
      }
      const m = readKiloManifest(env)
      const list = pluginList(m)
      if (!list.includes(entry)) {
        return
      }
      writeManifest({ ...m, plugin: list.filter((e) => e !== entry) })
    },
  }
}

/** kilo's artifact ladder mirrors opencode's — but the global target is
 *  NOT `plugin/`/`plugins/` (kilo auto-scans those; a file there would
 *  double-register against the kilo.json `plugin[]` entry). */
function kiloArtifact(cwd: string): string | null {
  const pkg = packageRoot()
  const root = gitRoot(cwd)
  return firstExisting([
    pkg === null ? null : join(pkg, 'src', 'kilo.ts'),
    pkg === null ? null : join(pkg, 'dist', 'kilo.js'),
    root === null ? null : join(root, 'plugins', 'kilo', 'bro', 'bro.ts'),
  ])
}

/** Same artifact ladder as opencode — source, bundled dist, the repo
 *  adapter. jiti loads the raw .ts, so the source entry is the real
 *  artifact; the dist bundle is the tarball fallback. */
function piArtifact(cwd: string): string | null {
  const pkg = packageRoot()
  const root = gitRoot(cwd)
  return firstExisting([
    pkg === null ? null : join(pkg, 'src', 'pi.ts'),
    pkg === null ? null : join(pkg, 'dist', 'pi.js'),
    root === null ? null : join(root, 'plugins', 'pi', 'bro', 'bro.ts'),
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
    extras: (cwd, env) => [
      {
        artifact: opencodeTuiArtifact(cwd),
        targets: {
          global: join(
            env.XDG_CONFIG_HOME || join(homedir(), '.config'),
            'opencode',
            'plugins',
            'bro-cli.ts'
          ),
          local: join(gitRoot(cwd) ?? cwd, '.opencode', 'plugins', 'bro-cli.ts'),
        },
      },
    ],
  },
  kilo: {
    artifact: kiloArtifact,
    targets: (cwd, env) => ({
      global: join(kiloConfigDir(env), 'bro', 'bro.ts'),
      local: join(gitRoot(cwd) ?? cwd, '.kilo', 'plugin', 'bro.ts'),
    }),
    registration: (scope, path, env) =>
      scope === 'global' ? kiloRegistration(path, env) : null,
  },
  pi: {
    artifact: piArtifact,
    // pi discovers <cwd>/.pi/extensions/ locally and
    // <agentDir>/extensions/ globally; the agent dir is
    // $PI_CODING_AGENT_DIR or ~/.pi/agent
    targets: (cwd, env) => ({
      global: join(
        env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
        'extensions',
        'bro.ts'
      ),
      local: join(gitRoot(cwd) ?? cwd, '.pi', 'extensions', 'bro.ts'),
    }),
  },
}

export function clientNames(): string[] {
  return Object.keys(CLIENTS)
}

/** The materialized module's fingerprint — holds for the TS source and
 *  the compiled bundle. Every adapter ships an invariant
 *  `bro-adapter` sentinel comment (the marker no rename can break);
 *  pre-marker artifacts are recognized by the `id:"bro"` claim plus a
 *  family shape token: opencode ships `server:<anything>` (its TUI
 *  module ships `id:"bro.cli"` + `kind:"opencode-tui"`); the pi
 *  extension ships `kind:"pi-extension"`. */
export function isBroAdapter(text: string): boolean {
  // the invariant sentinel wins — no rename of a surrounding identifier
  // can invalidate it (a stale-era `server: bro` read as foreign once:
  // retro bro-g2f9). Shape checks below recognize adapters shipped
  // before the marker existed.
  if (text.includes('bro-adapter')) {
    return true
  }
  if (!/\bid:\s*["']bro(?:\.cli)?["']/.test(text)) {
    return false
  }
  return (
    /\bserver:\s*\w+/.test(text) ||
    /\bkind:\s*["']pi-extension["']/.test(text) ||
    /\bkind:\s*["']opencode-tui["']/.test(text)
  )
}

function stateAt(
  target: string,
  artifact: string | null,
  reg: Registration | null
): InstallState {
  if (!existsSync(target)) {
    return 'absent'
  }
  if (artifact === null) {
    return 'present'
  }
  const current = readFileSync(target, 'utf8') === readFileSync(artifact, 'utf8')
  // a matching file with its manifest entry missing is "install me again"
  return current && (reg === null || reg.registered) ? 'installed' : 'stale'
}

/** The client × scope matrix — `bro plugins list` and doctor's row. A
 *  client's extra files get their own rows, distinguished by path. */
export function pluginRows(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): PluginRow[] {
  const rows: PluginRow[] = []
  for (const [name, client] of Object.entries(CLIENTS)) {
    const files = [
      { artifact: client.artifact(cwd), targets: client.targets(cwd, env), primary: true },
      ...(client.extras?.(cwd, env) ?? []).map((e) => ({ ...e, primary: false })),
    ]
    for (const scope of ['global', 'local'] as const) {
      for (const f of files) {
        const path = f.targets[scope]
        const reg = f.primary ? (client.registration?.(scope, path, env) ?? null) : null
        rows.push({ client: name, scope, state: stateAt(path, f.artifact, reg), path })
      }
    }
  }
  return rows
}

/** `write tmp; rename` — a torn write must never leave a half module.
 *  The tmp file gets umask defaults, so a restrictive existing mode is
 *  copied over before the rename: a 0600 kilo.json carrying permission
 *  rules must not silently widen to 0644. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  try {
    chmodSync(tmp, statSync(path).mode)
  } catch {
    // no prior file — the default mode stands
  }
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
  /** refusal reason, when action === 'refused' */
  note?: string
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
  // extras with no resolvable artifact are additive surfaces — skipped,
  // never fatal (an old dist may predate the module)
  const extras = (client.extras?.(opts.cwd, opts.env) ?? [])
    .filter((e): e is ExtraFile & { artifact: string } => e.artifact !== null)
    .map((e) => ({ content: readFileSync(e.artifact, 'utf8'), targets: e.targets }))
  const outcomes: Outcome[] = []
  for (const scope of scopes) {
    for (const f of [{ content, targets, primary: true }, ...extras.map((e) => ({ ...e, primary: false }))]) {
      outcomes.push(installOne(name, scope, f, f.primary ? client : { ...client, registration: undefined }, opts))
    }
  }
  return outcomes
}

function installOne(
  name: string,
  scope: PluginScope,
  file: { content: string; targets: Record<PluginScope, string> },
  client: ClientSpec,
  opts: MutateOpts
): Outcome {
  const { content } = file
  const path = file.targets[scope]
  // registration parses the manifest — a malformed one exits here,
  // before the module file is touched
  const reg = client.registration?.(scope, path, opts.env) ?? null
  const needsRegistration = reg !== null && !reg.registered
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (prior === content && !needsRegistration) {
    return { client: name, scope, action: 'current', path }
  }
  // a file already holding the slot that carries no bro sentinel is a
  // foreign plugin under our name — clobbering it needs --force. A
  // sentinel-bearing difference is a shipped version → plain update.
  if (prior !== null && prior !== content && !isBroAdapter(prior) && !opts.force) {
    return {
      client: name,
      scope,
      action: 'refused',
      path,
      note: 'a foreign file holds this slot — pass --force to overwrite',
    }
  }
  if (opts.dryRun) {
    return {
      client: name,
      scope,
      action: prior === null ? 'would-install' : 'would-update',
      path,
    }
  }
  if (prior !== content) {
    atomicWrite(path, content)
  }
  if (needsRegistration) {
    reg.register()
  }
  return {
    client: name,
    scope,
    action: prior === null ? 'installed' : 'updated',
    path,
    note: needsRegistration ? 'registered in kilo.json' : undefined,
  }
}

export function uninstallClient(
  name: string,
  scopes: PluginScope[],
  opts: MutateOpts
): Outcome[] {
  const client = knownClient(name)
  const targets = client.targets(opts.cwd, opts.env)
  const artifact = client.artifact(opts.cwd)
  const clean = artifact === null ? null : readFileSync(artifact, 'utf8')
  // extras keep a possibly-null artifact — no artifact to compare means
  // the sentinel check alone decides ownership, same as the primary
  const extras = (client.extras?.(opts.cwd, opts.env) ?? []).map((e) => ({
    clean: e.artifact === null ? null : readFileSync(e.artifact, 'utf8'),
    targets: e.targets,
  }))
  const outcomes: Outcome[] = []
  for (const scope of scopes) {
    for (const f of [{ clean, targets, primary: true }, ...extras.map((e) => ({ ...e, primary: false }))]) {
      outcomes.push(uninstallOne(name, scope, f, f.primary ? client : { ...client, registration: undefined }, opts))
    }
  }
  return outcomes
}

function uninstallOne(
  name: string,
  scope: PluginScope,
  file: { clean: string | null; targets: Record<PluginScope, string> },
  client: ClientSpec,
  opts: MutateOpts
): Outcome {
  const { clean } = file
  const path = file.targets[scope]
  const reg = client.registration?.(scope, path, opts.env) ?? null
  if (!existsSync(path)) {
    return absentOutcome(name, scope, path, reg, opts.dryRun)
  }
  const wasRegistered = reg?.registered ?? false
  const prior = readFileSync(path, 'utf8')
  // provably ours = byte-equal to this bro's artifact. A sentinel-only
  // match is a different version or a hand edit — indistinguishable by
  // shape, and deletion is irreversible, so it refuses without --force
  // (sentinel alone only suffices when no artifact resolves to compare)
  const ours = clean === null ? isBroAdapter(prior) : prior === clean
  if (!opts.force && !ours) {
    return {
      client: name,
      scope,
      action: 'refused',
      path,
      note: isBroAdapter(prior)
        ? 'differs from this bro’s adapter (stale or edited) — pass --force to remove'
        : 'not a bro adapter — pass --force to remove',
    }
  }
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path }
  }
  rmSync(path)
  if (wasRegistered) {
    reg!.unregister()
  }
  return {
    client: name,
    scope,
    action: 'removed',
    path,
    note: wasRegistered ? 'removed kilo.json entry' : undefined,
  }
}

/** The plugin file is already gone — an absent slot can still carry a
 *  dangling manifest entry, which gets swept here. */
function absentOutcome(
  name: string,
  scope: PluginScope,
  path: string,
  reg: Registration | null,
  dryRun: boolean
): Outcome {
  const wasRegistered = reg?.registered ?? false
  if (wasRegistered && !dryRun) {
    reg!.unregister()
  }
  return {
    client: name,
    scope,
    action: 'absent',
    path,
    note: wasRegistered
      ? `${dryRun ? 'would remove' : 'removed'} dangling kilo.json entry`
      : undefined,
  }
}

function printOutcomes(outcomes: Outcome[]): void {
  for (const o of outcomes) {
    console.log(`${o.client} ${o.scope}: ${o.action} — ${o.path}${o.note ? ` (${o.note})` : ''}`)
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

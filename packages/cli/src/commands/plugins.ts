/**
 * `bro plugins` — two surfaces (spec: specs/bro-1qpk.1.md):
 *
 *   bro plugins                                BroPlugin registry table
 *   bro plugins list [--json]                  client × scope install matrix
 *   bro plugins install <client> [--global] [--local] [--dry-run]
 *   bro plugins uninstall <client> [--global] [--local] [--dry-run] [--force]
 *
 * The adapter surface materializes a client plugin into that client's
 * plugin dirs. Two shapes exist:
 *
 *   file    one module at a path — kilo, pi, omp.
 *   bundle  a DIRECTORY of modules installed as one unit — opencode v2's
 *           catalog plugin: `bro/{index.ts,tui.tsx,rpc.ts}`. opencode
 *           loads a TUI half only for a package that also has a server,
 *           so the three files must land in one directory.
 *
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
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BroPlugin, CommandError, EXIT, gitTry, hasHelpFlag, printUsage } from '@broject/core';
import { collectEmbedded, type EmbeddedData } from '../embedded.ts';
import { positionals } from './args.ts';

export type PluginScope = 'global' | 'local';
/** installed = bytes match the shipped artifact; stale = bytes differ;
 *  present = file exists but no artifact resolved to compare against. */
export type InstallState = 'installed' | 'stale' | 'present' | 'absent';

export interface PluginRow {
  client: string;
  scope: PluginScope;
  state: InstallState;
  path: string;
}

/** A manifest step beyond the module file — a client whose plugin
 *  surface needs a config entry in addition to the materialized file. */
interface Registration {
  /** Reading this parses the manifest — a malformed one exits before
   *  any file is written. */
  readonly registered: boolean;
  register(): void;
  unregister(): void;
}

/** One file of a bundle surface — where it comes from and the name it
 *  takes inside the bundle's directory. */
interface SurfaceFile {
  /** the source path, or null when the artifact cannot be resolved or
   *  the bytes arrive inline via `content` */
  artifact: string | null;
  /** the file name inside the bundle directory */
  name: string;
  /** inline bytes for snapshot members — the embedded skills tree
   *  ships as one JSON asset, so its files have no per-file source
   *  path to point `artifact` at */
  content?: string;
}

/** An installable unit. `file` is one module; `bundle` is a directory of
 *  modules installed as one unit — opencode v2's catalog plugin (the
 *  server entrypoint, the TUI half and the RPC contract both halves
 *  share) is a bundle, because opencode loads a TUI half only for a
 *  package that also has a server. */
type Surface =
  | { kind: 'file'; artifact: string | null; targets: Record<PluginScope, string> }
  | { kind: 'bundle'; files: SurfaceFile[]; dirs: Record<PluginScope, string> };

interface ClientSpec {
  /** The surfaces this client installs, in order — the first one owns
   *  the manifest registration (where a client has one). */
  surfaces(cwd: string, env: NodeJS.ProcessEnv): Surface[];
  /** Loose files an earlier layout used. opencode v1 shipped `bro.ts` +
   *  `bro-cli.ts` beside the v2 plugin directory; a stale module in the
   *  plugins dir is still LOADED by opencode, so it has to go when the
   *  current layout lands. */
  legacy?(cwd: string, env: NodeJS.ProcessEnv): Record<PluginScope, string[]>;
  registration?(scope: PluginScope, path: string, env: NodeJS.ProcessEnv): Registration | null;
  /** Hosts that load project and global copies of the same extension
   *  without dedupe — a dual install conflicts on tool/command names
   *  (bro-b7mae). When both scopes are requested the install collapses
   *  to global (it covers the repo too) and this note explains why;
   *  an explicit single scope still installs, with a warning when the
   *  other scope already holds a bro copy. */
  singleScope?: string;
}

/** The bro package root — this module sits at src/commands/ in a
 *  checkout and bundles into dist/index.js in the tarball, so anchor on
 *  the package.json, not on the module's own depth. */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    try {
      if (
        existsSync(manifest) &&
        (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@broject/bro'
      ) {
        return dir;
      }
    } catch {
      // unreadable manifest — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function gitRoot(cwd: string): string | null {
  const r = gitTry(['-C', cwd, 'rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null;
}

/** Find an agent plugin package root in the monorepo or installed. */
function agentPluginPackageRoot(pkgName: string): string | null {
  // monorepo layout: packages/agent-plugins/<dir> or packages/<dir>
  const cli = packageRoot();
  if (cli !== null) {
    // cli is .../packages/cli or .../packages/cli/dist-context; walk up to packages/
    const packagesDir = dirname(cli);
    for (const dir of [join(packagesDir, 'agent-plugins', pkgName), join(packagesDir, pkgName)]) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) return dir;
    }
  }
  return null;
}

function firstExisting(candidates: Array<string | null>): string | null {
  for (const c of candidates) {
    if (c !== null && existsSync(c)) {
      return c;
    }
  }
  return null;
}

/** Artifact sources in preference order: the repo-distributed catalog
 *  bundle (self-contained — adapter-core inlined, only the host SDK
 *  stays external), then the copy that rides the tarball, then the
 *  built adapter, and the raw TS source last — it imports workspace
 *  packages (`@broject/adapter-core`) a host runtime cannot resolve
 *  once the file lands outside this checkout. The names differ — the
 *  checkout keeps the server as `opencode.ts`, the installed catalog
 *  plugin serves it as the directory's `index.ts`. */
function opencodeArtifact(cwd: string, src: string, shipped: string): string | null {
  const ap = agentPluginPackageRoot('opencode');
  const cli = packageRoot();
  const repo = cli === null ? null : dirname(dirname(cli));
  return firstExisting([
    repo === null ? null : join(repo, 'plugins', 'opencode', 'bro', shipped),
    cli === null ? null : join(cli, 'dist', 'plugins', 'opencode', 'bro', shipped),
    ap === null ? null : join(ap, 'dist', shipped.replace(/\.(ts|tsx)$/, '.js')),
    ap === null ? null : join(ap, 'src', src),
  ]);
}

/** bro's skill tree as bundle members — `skills/<name>/<file>` inline
 *  from the embedded snapshot. The plugin's collectBroSkills reads
 *  `<bundle>/skills/` first, so materializing here is what makes the
 *  registry surface work for installed copies (spec AGT-6: skills
 *  registered from plugin dir). Resolution order: the shipped
 *  `dist/generated/skills-data.json` snapshot (present in every built
 *  CLI — dev and tarball alike), then the live repo tree for
 *  pre-build checkouts. Never the TARGET repo's skills/ — those are
 *  the operator's, not bro's. */
function broSkillFiles(): SurfaceFile[] {
  const cli = packageRoot();
  let files: Record<string, string> | null = null;
  const artifact = cli === null ? null : join(cli, 'dist', 'generated', 'skills-data.json');
  if (artifact !== null && existsSync(artifact)) {
    try {
      files = (JSON.parse(readFileSync(artifact, 'utf8')) as EmbeddedData).SKILL_FILES;
    } catch {
      files = null;
    }
  }
  if (files === null && cli !== null) {
    const repo = join(cli, '..', '..');
    try {
      if (existsSync(join(repo, 'skills'))) {
        files = collectEmbedded(repo).SKILL_FILES;
      }
    } catch {
      files = null;
    }
  }
  if (files === null) {
    return [];
  }
  const skillMap = files;
  return Object.keys(skillMap)
    .sort((a, b) => a.localeCompare(b))
    .map(rel => ({ name: `skills/${rel}`, artifact: null, content: skillMap[rel] }));
}

/** The opencode v2 catalog plugin — one directory, three modules:
 *  `index.ts` is the server entrypoint (opencode's plugin loader reads
 *  the directory's index), `tui.tsx` the terminal half, `rpc.ts` the
 *  contract both halves share. The server's `./rpc.ts` import resolves
 *  inside the installed directory. `skills/` rides along so the
 *  plugin's skill registry has its tree beside the modules. */
function opencodeBundle(cwd: string, env: NodeJS.ProcessEnv): Surface {
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const localDir = join(gitRoot(cwd) ?? cwd, '.opencode');
  return {
    kind: 'bundle',
    files: [
      { name: 'index.ts', artifact: opencodeArtifact(cwd, 'opencode.ts', 'index.ts') },
      { name: 'tui.tsx', artifact: opencodeArtifact(cwd, 'tui.tsx', 'tui.tsx') },
      { name: 'rpc.ts', artifact: opencodeArtifact(cwd, 'rpc.ts', 'rpc.ts') },
      ...broSkillFiles(),
    ],
    dirs: {
      global: join(configDir, 'opencode', 'plugins', 'bro'),
      local: join(localDir, 'plugins', 'bro'),
    },
  };
}

/** The v1-era loose modules opencode used to load from the plugins dir. */
function opencodeLegacy(cwd: string, env: NodeJS.ProcessEnv): Record<PluginScope, string[]> {
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const localDir = join(gitRoot(cwd) ?? cwd, '.opencode');
  return {
    global: [
      join(configDir, 'opencode', 'plugins', 'bro.ts'),
      join(configDir, 'opencode', 'plugins', 'bro-cli.ts'),
    ],
    local: [join(localDir, 'plugins', 'bro.ts'), join(localDir, 'plugins', 'bro-cli.ts')],
  };
}

/** Single-module adapter artifact resolution — every client searches the
 *  same four sources, differing only in preference order: the catalog
 *  bundle (self-contained, adapter-core inlined — preferred in repo
 *  checkouts), the tarball copy inside cli dist, then the adapter
 *  package's built js and its TS source (whose workspace imports only
 *  resolve inside this checkout). */
type ArtSrc = 'repo' | 'pkgPlugins' | 'apDist' | 'apSrc' | 'pkgDist';

function adapterArtifact(client: string, order: readonly ArtSrc[]): string | null {
  const ap = agentPluginPackageRoot(client);
  const pkg = packageRoot();
  const repo = pkg === null ? null : dirname(dirname(pkg));
  const js = `${client}.js`;
  const src = `${client}.ts`;
  const shipped = join('plugins', client, 'bro', 'bro.ts');
  const cand: Record<ArtSrc, string | null> = {
    repo: repo === null ? null : join(repo, shipped),
    pkgPlugins: pkg === null ? null : join(pkg, 'dist', shipped),
    apDist: ap === null ? null : join(ap, 'dist', js),
    apSrc: ap === null ? null : join(ap, 'src', src),
    pkgDist: pkg === null ? null : join(pkg, 'dist', js),
  };
  return firstExisting(order.map(k => cand[k]));
}

function kiloArtifact(_cwd: string): string | null {
  return adapterArtifact('kilo', ['repo', 'pkgPlugins', 'apDist', 'apSrc']);
}

function kiloConfigDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kilo');
}

function piArtifact(_cwd: string): string | null {
  return adapterArtifact('pi', ['repo', 'apDist', 'apSrc', 'pkgDist', 'pkgPlugins']);
}

function ompArtifact(_cwd: string): string | null {
  return adapterArtifact('omp', ['repo', 'apDist', 'apSrc', 'pkgDist', 'pkgPlugins']);
}

/** omp's active agent directory — the user profile's config root.
 *  `OMP_AGENT_DIR` relocates it; `PI_CODING_AGENT_DIR` is accepted for
 *  pi-coding-agent/OMP lineage compatibility; a named profile lives under
 *  `~/.omp/profiles/<name>/agent`. */
function ompAgentDir(env: NodeJS.ProcessEnv): string {
  const override = env.OMP_AGENT_DIR || env.PI_CODING_AGENT_DIR;
  if (override !== undefined && override !== '') {
    return override;
  }
  const profile = env.OMP_PROFILE;
  if (profile !== undefined && profile !== '') {
    return join(homedir(), '.omp', 'profiles', profile, 'agent');
  }
  return join(homedir(), '.omp', 'agent');
}

interface FileClientTarget {
  artifact(cwd: string): string | null;
  global(env: NodeJS.ProcessEnv): string;
  local(cwd: string): string;
}

const FILE_CLIENT_TARGETS: Record<string, FileClientTarget> = {
  kilo: {
    artifact: kiloArtifact,
    global: env => join(kiloConfigDir(env), 'plugin', 'bro.ts'),
    local: cwd => join(gitRoot(cwd) ?? cwd, '.kilo', 'plugin', 'bro.ts'),
  },
  pi: {
    artifact: piArtifact,
    global: env =>
      join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'extensions', 'bro.ts'),
    local: cwd => join(gitRoot(cwd) ?? cwd, '.pi', 'extensions', 'bro.ts'),
  },
  omp: {
    artifact: ompArtifact,
    global: env => join(ompAgentDir(env), 'extensions', 'bro.ts'),
    local: cwd => join(gitRoot(cwd) ?? cwd, '.omp', 'extensions', 'bro.ts'),
  },
};

function fileClientSurface(client: string, cwd: string, env: NodeJS.ProcessEnv): Surface {
  const target = FILE_CLIENT_TARGETS[client];
  if (target === undefined) {
    throw new CommandError(`plugins: no file target configured for "${client}"`, EXIT.error);
  }
  return {
    kind: 'file',
    artifact: target.artifact(cwd),
    targets: { global: target.global(env), local: target.local(cwd) },
  };
}

const CLIENTS: Record<string, ClientSpec> = {
  opencode: {
    // the v2 catalog plugin — a directory of three modules
    surfaces: (cwd, env) => [opencodeBundle(cwd, env)],
    legacy: (cwd, env) => opencodeLegacy(cwd, env),
    // verified on opencode 2.3.0: `opencode run` executes plugin
    // modules from BOTH ~/.config/opencode/plugins/ and
    // <repo>/.opencode/plugins/ — identical id `bro` loads twice, so
    // hooks/tools/commands/RPC would all double-register (bro-b7mae)
    singleScope:
      'opencode loads project and global plugin copies without dedupe — ' +
      'hooks, tools and commands would double-register (bro-b7mae)',
  },
  kilo: {
    surfaces: (cwd, env) => [fileClientSurface('kilo', cwd, env)],
    // verified on kilo 7.8.27: `kilo run` executes BOTH the config-dir
    // and the project plugin files — the same no-dedupe collision class
    // as pi/omp (probe plugins logged GLOBAL+LOCAL on one load)
    singleScope:
      'kilo loads project and global copies of the same plugin without ' +
      'dedupe — tool names conflict (bro-b7mae)',
  },
  pi: {
    // pi discovers <cwd>/.pi/extensions/ locally and
    // <agentDir>/extensions/ globally; the agent dir is
    // $PI_CODING_AGENT_DIR or ~/.pi/agent
    surfaces: (cwd, env) => [fileClientSurface('pi', cwd, env)],
    singleScope:
      'pi loads project and global copies of the same extension without ' +
      'dedupe — tool names conflict (bro-b7mae)',
  },
  omp: {
    // omp discovers <cwd>/.omp/extensions/ locally and
    // <agentDir>/extensions/ globally — the same loose-extension shape
    // pi uses. The full plugin (skills, hooks, commands, WATCHDOG) is
    // omp's own package surface: `omp plugin install ./plugins/omp/bro`.
    surfaces: (cwd, env) => [fileClientSurface('omp', cwd, env)],
    singleScope:
      'omp loads project and global copies of the same extension without ' +
      'dedupe — tool names conflict (bro-b7mae)',
  },
};

export function clientNames(): string[] {
  return Object.keys(CLIENTS);
}

/** The materialized module's fingerprint — holds for the TS source and
 *  the compiled bundle. Every adapter ships an invariant
 *  `bro-adapter` sentinel comment (the marker no rename can break);
 *  pre-marker artifacts are recognized by the `id:"bro"` claim plus a
 *  family shape token: the opencode v2 plugin ships `Plugin.define(`;
 *  the pi extension ships `kind:"pi-extension"`; the omp extension
 *  ships `kind:"omp-extension"`. The v1 shapes (`server:` and
 *  `kind:"opencode-tui"`) are recognized too — not as support, but so
 *  an old install can still be cleaned up instead of shadowing the
 *  current layout. */
export function isBroAdapter(text: string): boolean {
  // ownership needs the `id:"bro"` claim AND a family token — a bare
  // `bro-adapter` mention in a foreign file must not read as ours.
  // The sentinel survives renames of every other identifier (a
  // stale-era `server: bro` read as foreign once: retro bro-g2f9);
  // shape checks recognize adapters shipped before the marker existed.
  if (!/\bid:\s*["']bro(?:\.cli)?["']/.test(text)) {
    return false;
  }
  return (
    text.includes('bro-adapter') ||
    /\bserver:\s*\w+/.test(text) ||
    /\bPlugin\.define\s*\(/.test(text) ||
    /\bkind:\s*["']pi-extension["']/.test(text) ||
    /\bkind:\s*["']omp-extension["']/.test(text) ||
    /\bkind:\s*["']opencode-tui["']/.test(text)
  );
}

/** The bytes of a surface's file — null when the artifact cannot be
 *  resolved (nothing to compare against). */
function surfaceBytes(artifact: string | null): string | null {
  return artifact === null ? null : readFileSync(artifact, 'utf8');
}

/** A bundle member's bytes — inline `content` wins (snapshot files),
 *  else the artifact path is read. */
function surfaceContent(f: SurfaceFile): string | null {
  return f.content ?? surfaceBytes(f.artifact);
}

function stateAt(surface: Surface, scope: PluginScope, reg: Registration | null): InstallState {
  if (surface.kind === 'file') return fileStateAt(surface, scope, reg);
  return bundleStateAt(surface, scope);
}

function fileStateAt(
  surface: FileSurface,
  scope: PluginScope,
  reg: Registration | null
): InstallState {
  const path = surface.targets[scope];
  if (!existsSync(path)) return 'absent';
  if (surface.artifact === null) return 'present';
  const current = readFileSync(path, 'utf8') === readFileSync(surface.artifact, 'utf8');
  // a matching file with its manifest entry missing is "install me again"
  return current && (reg === null || reg.registered) ? 'installed' : 'stale';
}

function bundleStateAt(surface: BundleSurface, scope: PluginScope): InstallState {
  const dir = surface.dirs[scope];
  if (!existsSync(dir)) {
    return 'absent';
  }
  const comparable = surface.files.filter(f => f.artifact !== null);
  if (comparable.length === 0) {
    return 'present';
  }
  const all = comparable.every(f => {
    const path = join(dir, f.name);
    return existsSync(path) && readFileSync(path, 'utf8') === readFileSync(f.artifact!, 'utf8');
  });
  return all ? 'installed' : 'stale';
}

/** The client × scope matrix — `bro plugins list` and doctor's row. A
 *  client's surfaces get their own rows, distinguished by path. */
export function pluginRows(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): PluginRow[] {
  const rows: PluginRow[] = [];
  for (const [name, client] of Object.entries(CLIENTS)) {
    const surfaces = client.surfaces(cwd, env);
    for (const scope of ['global', 'local'] as const) {
      for (const [idx, surface] of surfaces.entries()) {
        const path = surface.kind === 'file' ? surface.targets[scope] : surface.dirs[scope];
        const reg = idx === 0 ? (client.registration?.(scope, path, env) ?? null) : null;
        rows.push({ client: name, scope, state: stateAt(surface, scope, reg), path });
      }
    }
  }
  return rows;
}

/** `write tmp; rename` — a torn write must never leave a half module.
 *  The tmp file gets umask defaults, so a restrictive existing mode is
 *  copied over before the rename: a restrictive-mode config file must
 *  not silently widen to umask defaults. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  try {
    chmodSync(tmp, statSync(path).mode);
  } catch {
    // no prior file — the default mode stands
  }
  renameSync(tmp, path);
}

export interface MutateOpts {
  dryRun: boolean;
  force: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
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
  | 'would-remove';

export interface Outcome {
  client: string;
  scope: PluginScope;
  action: Action;
  path: string;
  /** refusal reason, when action === 'refused' */
  note?: string;
}

function knownClient(name: string): ClientSpec {
  const client = CLIENTS[name];
  if (client === undefined) {
    throw new CommandError(
      `plugins: unknown client "${name}" — known: ${clientNames().join(', ')}`,
      EXIT.usage
    );
  }
  return client;
}

export function installClient(name: string, scopes: PluginScope[], opts: MutateOpts): Outcome[] {
  const client = knownClient(name);
  const surfaces = client.surfaces(opts.cwd, opts.env);
  // singleScope clients cannot hold both copies — the host loads them
  // and the duplicate registrations collide. A bare `install` converges
  // to ONE scope: whichever already holds a bro copy (refreshing the
  // user's existing choice beats silently adding the other), global
  // when neither or both do. An explicit scope flag is still honored.
  const wantsBoth = scopes.includes('global') && scopes.includes('local');
  const effective =
    client.singleScope !== undefined && wantsBoth
      ? ([preferredSingleScope(surfaces)] as PluginScope[])
      : scopes;
  const collapsed = effective !== scopes;
  const ctx: InstallCtx = { name, client, surfaces, opts };
  const outcomes = installScopes(ctx, effective);
  if (client.singleScope !== undefined) {
    convergeSingleScope(ctx, effective, collapsed, outcomes);
  }
  return outcomes;
}

interface InstallCtx {
  name: string;
  client: ClientSpec;
  surfaces: Surface[];
  opts: MutateOpts;
}

/** The singleScope tail of installClient — converge the host to one
 *  bro copy (remove ours in unchosen scopes, sentinel-checked), then
 *  report the collapse + any cross-scope conflict on the first outcome. */
function convergeSingleScope(
  ctx: InstallCtx,
  effective: PluginScope[],
  collapsed: boolean,
  outcomes: Outcome[]
): void {
  const notes: string[] = [];
  if (collapsed) {
    const scope = effective[0];
    notes.push(
      `${ctx.client.singleScope}; only the ${scope}-scope copy was installed ` +
        '— pass an explicit scope flag to choose the other one instead'
    );
  }
  // converge — the host must never hold bro copies in both scopes.
  // Remove ours outside the installed set (sentinel-checked; a
  // foreign file at the path is never touched), including stale
  // legacy-layout modules the host would still load.
  for (const scope of ['global', 'local'] as PluginScope[]) {
    if (effective.includes(scope)) {
      continue;
    }
    pruneScopeCopies(ctx, scope, outcomes);
  }
  const conflict = crossScopeBroCopy(ctx.surfaces, effective);
  if (conflict !== null) {
    notes.push(conflict);
  }
  const first = outcomes[0];
  if (notes.length > 0 && first !== undefined) {
    first.note = first.note === undefined ? notes.join('; ') : `${first.note}; ${notes.join('; ')}`;
  }
}

/** Drop every bro copy one scope holds — live surfaces plus the
 *  stale legacy-layout modules the host would still load. */
function pruneScopeCopies(ctx: InstallCtx, scope: PluginScope, outcomes: Outcome[]): void {
  for (const surface of ctx.surfaces) {
    const outcome = convergeScopeCopy(ctx.name, scope, surface, ctx.opts);
    if (outcome !== null) {
      outcomes.push(outcome);
    }
  }
  for (const legacy of ctx.client.legacy?.(ctx.opts.cwd, ctx.opts.env)[scope] ?? []) {
    const outcome = legacyOutcome(ctx.name, scope, legacy, ctx.opts);
    if (outcome !== null) {
      outcomes.push(outcome);
    }
  }
}

function installScopes(ctx: InstallCtx, scopes: PluginScope[]): Outcome[] {
  const outcomes: Outcome[] = [];
  for (const scope of scopes) {
    for (const [idx, surface] of ctx.surfaces.entries()) {
      const owner = idx === 0 ? ctx.client : { ...ctx.client, registration: undefined };
      outcomes.push(installSurface(ctx, scope, surface, owner));
    }
    for (const legacy of ctx.client.legacy?.(ctx.opts.cwd, ctx.opts.env)[scope] ?? []) {
      const outcome = legacyOutcome(ctx.name, scope, legacy, ctx.opts);
      if (outcome !== null) outcomes.push(outcome);
    }
  }
  return outcomes;
}

function installSurface(
  ctx: InstallCtx,
  scope: PluginScope,
  surface: Surface,
  owner: ClientSpec
): Outcome {
  return surface.kind === 'file'
    ? mutateFileSurface({
        operation: 'install',
        name: ctx.name,
        scope,
        surface,
        client: owner,
        opts: ctx.opts,
      })
    : mutateBundleSurface({
        operation: 'install',
        name: ctx.name,
        scope,
        files: surface.files,
        dir: surface.dirs[scope],
        opts: ctx.opts,
      });
}

/** Sentinel gate: the path exists AND verifies as a bro adapter —
 *  anything else (missing, foreign file) leaves it untouched. */
function broCopyAt(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return isBroAdapter(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/** Remove a bro copy sitting in a scope the install did not choose —
 *  singleScope hosts load both scopes, so leaving it would collide.
 *  Sentinel-gated like every other removal: only a verified bro
 *  adapter (or our own bundle dir) is touched. */
function convergeScopeCopy(
  name: string,
  scope: PluginScope,
  surface: Surface,
  opts: MutateOpts
): Outcome | null {
  return surface.kind === 'file'
    ? convergeFileCopy(name, scope, surface, opts)
    : convergeBundleCopy(name, scope, surface, opts);
}

function convergeFileCopy(
  name: string,
  scope: PluginScope,
  surface: Extract<Surface, { kind: 'file' }>,
  opts: MutateOpts
): Outcome | null {
  const note = 'single-scope convergence (bro-b7mae)';
  const target = surface.targets[scope];
  if (!broCopyAt(target)) {
    return null;
  }
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path: target, note };
  }
  rmSync(target);
  return { client: name, scope, action: 'removed', path: target, note };
}

function convergeBundleCopy(
  name: string,
  scope: PluginScope,
  surface: Extract<Surface, { kind: 'bundle' }>,
  opts: MutateOpts
): Outcome | null {
  const note = 'single-scope convergence (bro-b7mae)';
  const dir = surface.dirs[scope];
  if (!broCopyAt(join(dir, 'index.ts'))) {
    return null;
  }
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path: dir, note };
  }
  for (const f of surface.files) {
    const path = join(dir, f.name);
    if (existsSync(path)) {
      rmSync(path);
    }
  }
  pruneEmptyDirs(dir, surface);
  try {
    rmdirSync(dir);
  } catch {
    // not empty — something of the user's lives here, leave the directory
  }
  return { client: name, scope, action: 'removed', path: dir, note };
}

/** nested bundle members (skills/<name>/…) leave empty dirs behind —
 *  rmdir deepest-first so a foreign file keeps its directory alive. */
function pruneEmptyDirs(dir: string, surface: Extract<Surface, { kind: 'bundle' }>): void {
  const dirs = new Set<string>();
  for (const f of surface.files) {
    let rel = dirname(f.name);
    while (rel !== '.' && rel !== '') {
      dirs.add(rel);
      rel = dirname(rel);
    }
  }
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(dir, rel));
    } catch {
      // not empty — something of the user's lives here, leave it
    }
  }
}

/** Which scope a collapsed singleScope install lands in: the scope
 *  that already holds a bro copy wins (a bare install refreshes the
 *  user's existing choice instead of adding the colliding twin);
 *  global is the default when neither — or both — do. */
function preferredSingleScope(surfaces: Surface[]): PluginScope {
  const holders = (['global', 'local'] as PluginScope[]).filter(scope =>
    surfaces.some(surface => scopeHasBroCopy(surface, scope))
  );
  const only = holders.length === 1 ? holders[0] : undefined;
  return only ?? 'global';
}

function scopeHasBroCopy(surface: Surface, scope: PluginScope): boolean {
  const target =
    surface.kind === 'file' ? surface.targets[scope] : join(surface.dirs[scope], 'index.ts');
  if (!existsSync(target)) {
    return false;
  }
  try {
    return isBroAdapter(readFileSync(target, 'utf8'));
  } catch {
    return false;
  }
}

/** A bro copy already sitting in the scope opposite the ones just
 *  installed — the host will load both and the duplicate registrations
 *  collide, so the install warns rather than discovering it live. */
function crossScopeBroCopy(surfaces: Surface[], scopes: PluginScope[]): string | null {
  for (const surface of surfaces) {
    for (const scope of scopes) {
      const other = scope === 'global' ? 'local' : 'global';
      const target =
        surface.kind === 'file' ? surface.targets[other] : join(surface.dirs[other], 'index.ts');
      if (!existsSync(target)) {
        continue;
      }
      try {
        if (isBroAdapter(readFileSync(target, 'utf8'))) {
          return (
            `a ${other}-scope copy exists at ${target} — the host loads both ` +
            'scopes and the duplicate tool/command names conflict; remove one'
          );
        }
      } catch {
        // unreadable — not ours to judge
      }
    }
  }
  return null;
}

type FileSurface = Extract<Surface, { kind: 'file' }>;
type BundleSurface = Extract<Surface, { kind: 'bundle' }>;

interface FileMutation {
  name: string;
  scope: PluginScope;
  surface: FileSurface;
  client: ClientSpec;
  opts: MutateOpts;
}

interface BundleMutation {
  name: string;
  scope: PluginScope;
  files: SurfaceFile[];
  dir: string;
  opts: MutateOpts;
}

type SurfaceOperation = 'install' | 'uninstall';

interface SurfaceMutation {
  operation: SurfaceOperation;
  name: string;
  scope: PluginScope;
  opts: MutateOpts;
}

function mutateFileSurface(
  input: SurfaceMutation & { surface: FileSurface; client: ClientSpec }
): Outcome {
  return input.operation === 'install' ? installFileSurface(input) : uninstallFileSurface(input);
}

function installFileSurface({ name, scope, surface, client, opts }: FileMutation): Outcome {
  const { path, content, reg } = fileInstallInputs({ name, scope, surface, client, opts });
  const needsRegistration = reg !== null && !reg.registered;
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const current = currentInstall({ name, scope, path, prior, content, needsRegistration });
  if (current !== null) return current;
  // a file already holding the slot that carries no bro sentinel is a
  // foreign plugin under our name — clobbering it needs --force. A
  // sentinel-bearing difference is a shipped version → plain update.
  if (isForeignFile(prior, content, opts.force)) {
    return refusedOutcome(name, scope, path);
  }
  if (opts.dryRun) {
    return {
      client: name,
      scope,
      action: prior === null ? 'would-install' : 'would-update',
      path,
    };
  }
  if (prior !== content) {
    atomicWrite(path, content);
  }
  if (needsRegistration) {
    reg.register();
  }
  return {
    client: name,
    scope,
    action: prior === null ? 'installed' : 'updated',
    path,
    note: needsRegistration ? 'registered in host config' : undefined,
  };
}

function fileInstallInputs({ name, scope, surface, client, opts }: FileMutation): {
  path: string;
  content: string;
  reg: Registration | null;
} {
  if (surface.artifact === null) {
    throw new CommandError(
      `plugins install: cannot resolve the ${name} adapter module`,
      EXIT.error
    );
  }
  const path = surface.targets[scope];
  // registration parses the manifest — a malformed one exits here,
  // before the module file is touched
  return {
    path,
    content: readFileSync(surface.artifact, 'utf8'),
    reg: client.registration?.(scope, path, opts.env) ?? null,
  };
}

function currentInstall(input: {
  name: string;
  scope: PluginScope;
  path: string;
  prior: string | null;
  content: string;
  needsRegistration: boolean;
}): Outcome | null {
  return input.prior === input.content && !input.needsRegistration
    ? { client: input.name, scope: input.scope, action: 'current', path: input.path }
    : null;
}

/** A bundle surface — a directory of modules installed as one unit. The
 *  outcome path is the directory; a refusal names the file that holds
 *  it. */
function mutateBundleSurface(input: SurfaceMutation & BundleMutation): Outcome {
  return input.operation === 'install'
    ? installBundleSurface(input)
    : uninstallBundleSurface(input);
}

function installBundleSurface({ name, scope, files, dir, opts }: BundleMutation): Outcome {
  const contents = files
    .map(f => ({ name: f.name, content: surfaceContent(f) }))
    .filter((c): c is { name: string; content: string } => c.content !== null);
  ensureBundleContents(name, contents);
  // a file already holding the slot that carries no bro sentinel is a
  // foreign plugin under our name — clobbering it needs --force
  const foreign = contents.find(c => isForeignBundleFile(dir, c, opts.force));
  if (foreign !== undefined) {
    return refusedOutcome(name, scope, join(dir, foreign.name));
  }
  const existed = existsSync(dir);
  if (opts.dryRun) {
    return {
      client: name,
      scope,
      action: existed ? 'would-update' : 'would-install',
      path: dir,
    };
  }
  let changed = !existed;
  changed = writeBundleContents(dir, contents, changed);
  return {
    client: name,
    scope,
    action: changed ? (existed ? 'updated' : 'installed') : 'current',
    path: dir,
  };
}

function ensureBundleContents(name: string, contents: { name: string; content: string }[]): void {
  if (contents.length === 0) {
    throw new CommandError(
      `plugins install: cannot resolve the ${name} adapter module`,
      EXIT.error
    );
  }
}

function isForeignFile(prior: string | null, content: string, force: boolean): boolean {
  return prior !== null && prior !== content && !isBroAdapter(prior) && !force;
}

function refusedOutcome(name: string, scope: PluginScope, path: string): Outcome {
  return {
    client: name,
    scope,
    action: 'refused',
    path,
    note: 'a foreign file holds this slot — pass --force to overwrite',
  };
}

function isForeignBundleFile(
  dir: string,
  file: { name: string; content: string },
  force: boolean
): boolean {
  const path = join(dir, file.name);
  if (!existsSync(path)) return false;
  const prior = readFileSync(path, 'utf8');
  return isForeignFile(prior, file.content, force);
}

function writeBundleContents(
  dir: string,
  contents: { name: string; content: string }[],
  changed: boolean
): boolean {
  let anyWritten = changed;
  for (const c of contents) {
    const path = join(dir, c.name);
    if (existsSync(path) && readFileSync(path, 'utf8') === c.content) continue;
    atomicWrite(path, c.content);
    anyWritten = true;
  }
  return anyWritten;
}

/** A loose file from an earlier layout. A foreign file is left alone —
 *  it is not ours to delete. */
function legacyOutcome(
  name: string,
  scope: PluginScope,
  path: string,
  opts: MutateOpts
): Outcome | null {
  if (!existsSync(path)) {
    return null;
  }
  if (!isBroAdapter(readFileSync(path, 'utf8'))) {
    return null;
  }
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path, note: 'legacy layout' };
  }
  rmSync(path);
  return { client: name, scope, action: 'removed', path, note: 'legacy layout' };
}

export function uninstallClient(name: string, scopes: PluginScope[], opts: MutateOpts): Outcome[] {
  const client = knownClient(name);
  const surfaces = client.surfaces(opts.cwd, opts.env);
  const outcomes: Outcome[] = [];
  for (const scope of scopes) {
    for (const [idx, surface] of surfaces.entries()) {
      const owner = idx === 0 ? client : { ...client, registration: undefined };
      outcomes.push(
        surface.kind === 'file'
          ? mutateFileSurface({
              operation: 'uninstall',
              name,
              scope,
              surface,
              client: owner,
              opts,
            })
          : mutateBundleSurface({
              operation: 'uninstall',
              name,
              scope,
              files: surface.files,
              dir: surface.dirs[scope],
              opts,
            })
      );
    }
    for (const legacy of client.legacy?.(opts.cwd, opts.env)[scope] ?? []) {
      const outcome = legacyOutcome(name, scope, legacy, opts);
      if (outcome !== null) {
        outcomes.push(outcome);
      }
    }
  }
  return outcomes;
}

function uninstallFileSurface({ name, scope, surface, client, opts }: FileMutation): Outcome {
  const path = surface.targets[scope];
  const clean = surfaceBytes(surface.artifact);
  const reg = client.registration?.(scope, path, opts.env) ?? null;
  if (!existsSync(path)) {
    return absentOutcome({ name, scope, path, reg, dryRun: opts.dryRun });
  }
  const wasRegistered = reg?.registered ?? false;
  const prior = readFileSync(path, 'utf8');
  // provably ours = byte-equal to this bro's artifact. A sentinel-only
  // match is a different version or a hand edit — indistinguishable by
  // shape, and deletion is irreversible, so it refuses without --force
  // (sentinel alone only suffices when no artifact resolves to compare)
  const ours = clean === null ? isBroAdapter(prior) : prior === clean;
  const refusal = removalRefusal({ name, scope, path, prior, force: opts.force, ours });
  if (refusal !== null) return refusal;
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path };
  }
  rmSync(path);
  if (wasRegistered) {
    reg!.unregister();
  }
  return {
    client: name,
    scope,
    action: 'removed',
    path,
    note: wasRegistered ? 'removed host config entry' : undefined,
  };
}

/** A bundle surface — every module of the directory must be ours before
 *  the directory goes. Files we don't know (a user's own module beside
 *  ours) stay; the directory itself goes only when it is empty. */
function uninstallBundleSurface({ name, scope, files, dir, opts }: BundleMutation): Outcome {
  if (!existsSync(dir)) {
    return { client: name, scope, action: 'absent', path: dir };
  }
  const foreign = files.find(file => foreignRemoval(dir, file, opts.force));
  if (foreign !== undefined) {
    return refusedRemoval(
      name,
      scope,
      join(dir, foreign.name),
      readFileSync(join(dir, foreign.name), 'utf8')
    );
  }
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path: dir };
  }
  removeBundleContents(dir, files);
  pruneBundleDir(dir, files);
  return { client: name, scope, action: 'removed', path: dir };
}

function removalRefusal(input: {
  name: string;
  scope: PluginScope;
  path: string;
  prior: string;
  force: boolean;
  ours: boolean;
}): Outcome | null {
  return !input.force && !input.ours
    ? refusedRemoval(input.name, input.scope, input.path, input.prior)
    : null;
}

function refusedRemoval(name: string, scope: PluginScope, path: string, prior: string): Outcome {
  return {
    client: name,
    scope,
    action: 'refused',
    path,
    note: isBroAdapter(prior)
      ? 'differs from this bro’s adapter (stale or edited) — pass --force to remove'
      : 'not a bro adapter — pass --force to remove',
  };
}

function foreignRemoval(dir: string, file: SurfaceFile, force: boolean): boolean {
  const path = join(dir, file.name);
  if (!existsSync(path)) return false;
  const prior = readFileSync(path, 'utf8');
  const clean = surfaceContent(file);
  const ours = clean === null ? isBroAdapter(prior) : prior === clean;
  return !force && !ours;
}

function removeBundleContents(dir: string, files: SurfaceFile[]): void {
  for (const file of files) {
    const path = join(dir, file.name);
    if (existsSync(path)) rmSync(path);
  }
}

function pruneBundleDir(dir: string, files: SurfaceFile[]): void {
  const dirs = new Set<string>();
  for (const file of files) {
    let rel = dirname(file.name);
    while (rel !== '.' && rel !== '') {
      dirs.add(rel);
      rel = dirname(rel);
    }
  }
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(dir, rel));
    } catch {
      // not empty — something of the user's lives here, leave it
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // not empty — something of the user's lives here, leave the directory
  }
}

/** The plugin file is already gone — an absent slot can still carry a
 *  dangling manifest entry, which gets swept here. */
function absentOutcome({
  name,
  scope,
  path,
  reg,
  dryRun,
}: {
  name: string;
  scope: PluginScope;
  path: string;
  reg: Registration | null;
  dryRun: boolean;
}): Outcome {
  const wasRegistered = reg?.registered ?? false;
  if (wasRegistered && !dryRun) {
    reg!.unregister();
  }
  return {
    client: name,
    scope,
    action: 'absent',
    path,
    note: wasRegistered
      ? `${dryRun ? 'would remove' : 'removed'} dangling host config entry`
      : undefined,
  };
}

function printOutcomes(outcomes: Outcome[]): void {
  for (const o of outcomes) {
    console.log(`${o.client} ${o.scope}: ${o.action} — ${o.path}${o.note ? ` (${o.note})` : ''}`);
  }
}

/** The flags `bro plugins install|uninstall` accepts — a mistyped flag
 *  must not be silently dropped: dropping it hides both the typo and
 *  whatever value it was supposed to carry. */
const PLUGIN_FLAGS = new Set(['--global', '--local', '--dry-run', '--force']);

function clientArg(rest: string[]): string {
  const pos = positionals(rest, new Set(), { boolFlags: PLUGIN_FLAGS, strict: true });
  if (pos.length !== 1) {
    throw new CommandError(
      `usage: bro plugins install|uninstall <${clientNames().join('|')}> [--global] [--local] [--dry-run] [--force]`,
      EXIT.usage
    );
  }
  return pos[0]!;
}

/** Neither scope flag means both — `--global` or `--local` alone narrows. */
export function scopesOf(rest: string[]): PluginScope[] {
  const global = rest.includes('--global');
  const local = rest.includes('--local');
  return global === local ? ['global', 'local'] : global ? ['global'] : ['local'];
}

function printRegistry(plugins: BroPlugin[]): void {
  for (const p of plugins) {
    const src = p.external ? 'ext' : 'core';
    const plan = p.planSchema ? 'plan' : '-';
    console.log(
      `${p.name.padEnd(12)} ${(p.skill ?? '-').padEnd(10)} ${(p.configKey ?? '-').padEnd(8)} ${src.padEnd(4)} ${plan.padEnd(4)} ${p.summary}`
    );
  }
}

/** The registry as data — generators (command reference) read this. */
function registryRows(plugins: BroPlugin[]) {
  return plugins.map(p => ({
    name: p.name,
    group: p.group,
    summary: p.summary,
    skill: p.skill,
    configKey: p.configKey,
    hidden: p.hidden === true,
    aliasOf: p.aliasOf,
    deprecated: p.deprecated,
    plan: p.planSchema !== undefined,
    planVersion: p.planVersion,
    external: p.external === true,
  }));
}

const PLUGINS_USAGE =
  'usage: bro plugins [list [--json] | install <client> [--global] [--local] [--dry-run] | uninstall <client> [--global] [--local] [--dry-run] [--force]]';

export function runPluginsCommand(argv: string[], plugins: BroPlugin[]): void {
  const [sub, ...rest] = argv;
  if (hasHelpFlag(argv)) {
    printUsage(PLUGINS_USAGE, 0);
  }
  runPluginSubcommand(sub, rest, plugins);
}

function runPluginSubcommand(sub: string | undefined, rest: string[], plugins: BroPlugin[]): void {
  switch (sub) {
    case undefined:
      printRegistry(plugins);
      return;
    case '--json':
      console.log(JSON.stringify(registryRows(plugins), null, 2));
      return;
    case 'list': {
      const rows = pluginRows();
      if (rest.includes('--json')) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const r of rows) {
        console.log(`${r.client.padEnd(10)} ${r.scope.padEnd(7)} ${r.state.padEnd(10)} ${r.path}`);
      }
      return;
    }
    case 'install':
    case 'uninstall': {
      return runMutation(sub, rest);
    }
    default:
      throw new CommandError(PLUGINS_USAGE, EXIT.usage);
  }
}

function runMutation(sub: 'install' | 'uninstall', rest: string[]): void {
  const name = clientArg(rest);
  const opts: MutateOpts = {
    dryRun: rest.includes('--dry-run'),
    force: rest.includes('--force'),
    cwd: process.cwd(),
    env: process.env,
  };
  const mutate = sub === 'install' ? installClient : uninstallClient;
  const outcomes = mutate(name, scopesOf(rest), opts);
  printOutcomes(outcomes);
  if (outcomes.some(o => o.action === 'refused')) {
    throw new CommandError('plugins: refused', EXIT.error);
  }
}

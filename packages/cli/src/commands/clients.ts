/**
 * `bro clients` — the agents that use bro (spec: specs/bro-cl1.md,
 * moving the client half of specs/bro-1qpk.1.md out of `bro plugins`):
 *
 *   bro clients [list [--json]]                client × scope install matrix
 *   bro clients install <client> [--global] [--local] [--dry-run]
 *   bro clients uninstall <client> [--global] [--local] [--dry-run] [--force]
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
 * Manifest-based clients (claude, codex, cursor) consume the repo-root
 * plugin through their own marketplace machinery — no adapter module to
 * materialize. They appear in `list` through a read-only probe (and in
 * doctor's plugins row with it); install/uninstall refuse with the
 * client's own install command.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitTry, hasHelpFlag, printUsage, CommandError, EXIT } from '@broject/core';
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

/** A manifest step beyond the module file — kilo's global install also
 *  needs a file:/// entry in kilo.json's `plugin` array. */
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
  /** the source path, or null when the artifact cannot be resolved */
  artifact: string | null;
  /** the file name inside the bundle directory */
  name: string;
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

/** An adapter installed as a loose host extension must carry its implementation
 *  with it. In particular, never mistake a generated re-export shim for the
 *  bundled artifact: its relative import points back into a checkout which
 *  may not exist when the host loads the extension. */
function firstStandalone(candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    if (candidate === null || !existsSync(candidate)) {
      continue;
    }
    const source = readFileSync(candidate, 'utf8');
    if (!/\b(?:from|import|export)\s*["']\./.test(source)) {
      return candidate;
    }
  }
  return null;
}

/** Artifact sources in preference order: the TS source (checkout), then the
 *  repo-distributed adapter a bro clone carries under plugins/, then the
 *  copy that rides the tarball. The names differ — the checkout keeps
 *  the server as `opencode.ts`, the installed catalog plugin serves it
 *  as the directory's `index.ts`.
 *
 *  The tarball copy is the one that works OUTSIDE a checkout: an
 *  installed bro has no `packages/agent-plugins/` tree and no repo
 *  clone, and the adapter packages are not published on their own — so
 *  without it `bro clients install opencode` had nothing to write. */
function opencodeArtifact(cwd: string, src: string, shipped: string): string | null {
  const ap = agentPluginPackageRoot('opencode');
  const root = gitRoot(cwd);
  const cli = packageRoot();
  return firstExisting([
    ap === null ? null : join(ap, 'src', src),
    root === null ? null : join(root, 'plugins', 'opencode', 'bro', shipped),
    cli === null ? null : join(cli, 'dist', 'plugins', 'opencode', 'bro', shipped),
  ]);
}

/** The opencode v2 catalog plugin — one directory, three modules:
 *  `index.ts` is the server entrypoint (opencode's plugin loader reads
 *  the directory's index), `tui.tsx` the terminal half, `rpc.ts` the
 *  contract both halves share. The server's `./rpc.ts` import resolves
 *  inside the installed directory. */
function opencodeBundle(cwd: string, env: NodeJS.ProcessEnv): Surface {
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const localDir = join(gitRoot(cwd) ?? cwd, '.opencode');
  return {
    kind: 'bundle',
    files: [
      { name: 'index.ts', artifact: opencodeArtifact(cwd, 'opencode.ts', 'index.ts') },
      { name: 'tui.tsx', artifact: opencodeArtifact(cwd, 'tui.tsx', 'tui.tsx') },
      { name: 'rpc.ts', artifact: opencodeArtifact(cwd, 'rpc.ts', 'rpc.ts') },
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

function kiloArtifact(cwd: string): string | null {
  const ap = agentPluginPackageRoot('kilo');
  const pkg = packageRoot();
  const root = gitRoot(cwd);
  return firstExisting([
    ap === null ? null : join(ap, 'src', 'kilo.ts'),
    ap === null ? null : join(ap, 'dist', 'kilo.js'),
    pkg === null ? null : join(pkg, 'dist', 'kilo.js'),
    root === null ? null : join(root, 'plugins', 'kilo', 'bro', 'bro.ts'),
  ]);
}

function kiloConfigDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kilo');
}

function kiloManifestPath(env: NodeJS.ProcessEnv): string {
  return join(kiloConfigDir(env), 'kilo.json');
}

/** kilo.json is strict JSON — kilo.jsonc exists too but kilo merges both
 *  files, so writing only kilo.json is always correct and a comment-
 *  bearing file we can't parse is left for the user, never rewritten. */
function readKiloManifest(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = kiloManifestPath(env);
  if (!existsSync(path)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CommandError(
      `clients: ${path} is not plain JSON — edit the "plugin" array by hand`,
      EXIT.error
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError(`clients: ${path} must be a JSON object — edit it by hand`, EXIT.error);
  }
  return parsed as Record<string, unknown>;
}

function kiloRegistration(path: string, env: NodeJS.ProcessEnv): Registration {
  const manifestPath = kiloManifestPath(env);
  const entry = pathToFileURL(path).href;
  const pluginList = (m: Record<string, unknown>): unknown[] =>
    Array.isArray(m.plugin) ? m.plugin : [];
  const writeManifest = (m: Record<string, unknown>): void => {
    atomicWrite(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  };
  return {
    get registered() {
      return pluginList(readKiloManifest(env)).includes(entry);
    },
    register(): void {
      const fresh = !existsSync(manifestPath);
      const m = readKiloManifest(env);
      const list = pluginList(m);
      if (list.includes(entry)) {
        return;
      }
      const body = fresh ? { $schema: 'https://app.kilo.ai/config.json', ...m } : m;
      writeManifest({ ...body, plugin: [...list, entry] });
    },
    unregister(): void {
      if (!existsSync(manifestPath)) {
        return;
      }
      const m = readKiloManifest(env);
      const list = pluginList(m);
      if (!list.includes(entry)) {
        return;
      }
      writeManifest({ ...m, plugin: list.filter(e => e !== entry) });
    },
  };
}

function piArtifact(cwd: string): string | null {
  const ap = agentPluginPackageRoot('pi');
  const pkg = packageRoot();
  const root = gitRoot(cwd);
  return firstStandalone([
    root === null ? null : join(root, 'plugins', 'pi', 'bro', 'bro.ts'),
    ap === null ? null : join(ap, 'dist', 'pi.js'),
    ap === null ? null : join(ap, 'src', 'pi.ts'),
    pkg === null ? null : join(pkg, 'dist', 'pi.js'),
  ]);
}

function ompArtifact(cwd: string): string | null {
  const ap = agentPluginPackageRoot('omp');
  const pkg = packageRoot();
  const root = gitRoot(cwd);
  return firstStandalone([
    root === null ? null : join(root, 'plugins', 'omp', 'bro', 'bro.ts'),
    ap === null ? null : join(ap, 'dist', 'omp.js'),
    ap === null ? null : join(ap, 'src', 'omp.ts'),
    pkg === null ? null : join(pkg, 'dist', 'omp.js'),
  ]);
}

/** omp's active agent directory — the user profile's config root.
 *  Explicit omp configuration wins over the compatibility environment
 *  variable: `OMP_AGENT_DIR` > `PI_CODING_AGENT_DIR` > profile > default.
 *  A named profile lives under `~/.omp/profiles/<name>/agent`. */
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

const CLIENTS: Record<string, ClientSpec> = {
  opencode: {
    // the v2 catalog plugin — a directory of three modules
    surfaces: (cwd, env) => [opencodeBundle(cwd, env)],
    legacy: (cwd, env) => opencodeLegacy(cwd, env),
  },
  kilo: {
    surfaces: (cwd, env) => [
      {
        kind: 'file',
        artifact: kiloArtifact(cwd),
        targets: {
          global: join(kiloConfigDir(env), 'bro', 'bro.ts'),
          local: join(gitRoot(cwd) ?? cwd, '.kilo', 'plugin', 'bro.ts'),
        },
      },
    ],
    registration: (scope, path, env) => (scope === 'global' ? kiloRegistration(path, env) : null),
  },
  pi: {
    // pi discovers <cwd>/.pi/extensions/ locally and
    // <agentDir>/extensions/ globally; the agent dir is
    // $PI_CODING_AGENT_DIR or ~/.pi/agent
    surfaces: (cwd, env) => [
      {
        kind: 'file',
        artifact: piArtifact(cwd),
        targets: {
          global: join(
            env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
            'extensions',
            'bro.ts'
          ),
          local: join(gitRoot(cwd) ?? cwd, '.pi', 'extensions', 'bro.ts'),
        },
      },
    ],
  },
  omp: {
    // omp discovers <cwd>/.omp/extensions/ locally and
    // <agentDir>/extensions/ globally — the same loose-extension shape
    // pi uses. The full plugin (skills, hooks, commands, WATCHDOG) is
    // omp's own package surface: `omp plugin install ./plugins/omp/bro`.
    surfaces: (cwd, env) => [
      {
        kind: 'file',
        artifact: ompArtifact(cwd),
        targets: {
          global: join(ompAgentDir(env), 'extensions', 'bro.ts'),
          local: join(gitRoot(cwd) ?? cwd, '.omp', 'extensions', 'bro.ts'),
        },
      },
    ],
  },
};

export function clientNames(): string[] {
  return Object.keys(CLIENTS);
}

/** Manifest-based clients — claude, codex, cursor, devin, herdr — consume
 *  the repo-root plugin through their own marketplace machinery. bro
 *  emits no adapter module for them, so there is nothing to materialize;
 *  what bro CAN own is the answer to "is it installed": the list matrix
 *  and doctor's plugins row read a read-only probe per client. devin has
 *  no local install surface (cloud sessions) and herdr is this rig's own
 *  multiplexer — neither gets a row. */
interface ManifestClientSpec {
  /** how the client's own marketplace installs bro — printed by the
   *  mutate verbs instead of a silent unknown-client error */
  readonly installHint: string;
  probes(cwd: string, env: NodeJS.ProcessEnv): Array<Omit<PluginRow, 'client'>>;
}

/** Numeric triple compare — '0.10.0' must not sort below '0.9.0'. */
function semverKey(v: string): number[] {
  return v.split('.').map(n => parseInt(n, 10) || 0);
}

function newerThan(a: string, b: string): boolean {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i] ?? 0;
    const y = kb[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return false;
}

/** This bro's own version — the bar a cached plugin copy is measured
 *  against; unresolvable (no package root) means no staleness verdict. */
function broVersion(): string | null {
  const root = packageRoot();
  if (root === null) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

/** The newest `x.y.z` directory holding a plugin manifest — the cache
 *  layout claude (plugins/cache/<name>/<name>/<ver>) and codex
 *  (plugins/cache/bro/bro/<ver>) both use. */
function newestCachedVersion(cacheDir: string): string | null {
  let best: string | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+\.\d+\.\d+/.test(e) || !existsSync(join(cacheDir, e, 'plugin.json'))) {
      continue;
    }
    if (best === null || newerThan(e, best)) {
      best = e;
    }
  }
  return best;
}

/** Shared shape for the marketplace+cache clients (claude, codex):
 *  registered in the client's own marketplace config AND a cached plugin
 *  copy at or above this bro's version = installed; a cache older than
 *  this bro = stale; a cache without the registration — or either half
 *  alone — is a half install, and a half install is present, never
 *  stale (stale means "an update is pending", present means "not fully
 *  wired"). */
function marketplaceCacheProbe(registered: boolean, cacheDir: string): Omit<PluginRow, 'client'> {
  const ver = newestCachedVersion(cacheDir);
  let state: InstallState = 'absent';
  if (ver !== null) {
    if (!registered) {
      state = 'present';
    } else {
      const current = broVersion();
      state = current === null || !newerThan(current, ver) ? 'installed' : 'stale';
    }
  } else if (registered) {
    state = 'present';
  }
  return { scope: 'global', state, path: ver === null ? cacheDir : join(cacheDir, ver) };
}

function claudeProbes(cwd: string, env: NodeJS.ProcessEnv): Array<Omit<PluginRow, 'client'>> {
  const home = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let registered = false;
  try {
    const m = JSON.parse(readFileSync(join(home, 'plugins', 'known_marketplaces.json'), 'utf8'));
    registered = m !== null && typeof m === 'object' && 'bro' in m;
  } catch {
    // no marketplaces file or unreadable — treat as unregistered
  }
  return [marketplaceCacheProbe(registered, join(home, 'plugins', 'cache', 'bro', 'bro'))];
}

function codexProbes(cwd: string, env: NodeJS.ProcessEnv): Array<Omit<PluginRow, 'client'>> {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  let registered = false;
  try {
    registered = /^\[marketplaces\.bro\]\s*$/m.test(
      readFileSync(join(home, 'config.toml'), 'utf8')
    );
  } catch {
    // no config.toml — treat as unregistered
  }
  return [marketplaceCacheProbe(registered, join(home, 'plugins', 'cache', 'bro', 'bro'))];
}

/** The cursor plugin manifest's identity — the "is this slot ours"
 *  test plus the version the staleness verdict compares, the role
 *  isBroAdapter plays for emitted adapters. */
function cursorManifest(dir: string): { name: string | null; version: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.cursor-plugin', 'plugin.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

function cursorPluginStateAt(dir: string): { state: InstallState; path: string } {
  // lstat, not existsSync — a dangling symlink (the checkout it pointed
  // at moved) is stale, not absent, and existsSync follows links
  let entry;
  try {
    entry = lstatSync(dir);
  } catch {
    return { state: 'absent', path: dir };
  }
  if (entry.isSymbolicLink()) {
    try {
      statSync(dir);
    } catch {
      return { state: 'stale', path: dir };
    }
  }
  const manifest = cursorManifest(dir);
  if (manifest.name !== 'bro') {
    return { state: 'present', path: dir };
  }
  // an older manifest at the slot — an update this bro ships is pending
  const current = broVersion();
  if (manifest.version !== null && current !== null && newerThan(current, manifest.version)) {
    return { state: 'stale', path: dir };
  }
  return { state: 'installed', path: dir };
}

function cursorProbes(cwd: string, env: NodeJS.ProcessEnv): Array<Omit<PluginRow, 'client'>> {
  // CURSOR_CONFIG_DIR is honored by Cursor's CLI where set; the tests
  // use it as their seam
  const home = env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor');
  // the documented local install — the symlink Cursor's plugin README
  // prescribes (plugins/cursor/bro → plugins/local/bro)
  const local = cursorPluginStateAt(join(home, 'plugins', 'local', 'bro'));
  if (local.state !== 'absent') {
    return [{ scope: 'global', ...local }];
  }
  // the marketplace path — a cloned marketplace repo holding the
  // manifest; look one owner deep under github.com/, the layout
  // Cursor's marketplace clones use
  const marketplaces = join(home, 'plugins', 'marketplaces');
  try {
    for (const owner of readdirSync(join(marketplaces, 'github.com'))) {
      for (const repo of readdirSync(join(marketplaces, 'github.com', owner))) {
        const dir = join(marketplaces, 'github.com', owner, repo);
        try {
          const parsed = JSON.parse(
            readFileSync(join(dir, '.cursor-plugin', 'marketplace.json'), 'utf8')
          ) as { name?: string };
          if (parsed.name === 'bro') {
            return [{ scope: 'global', state: 'installed', path: dir }];
          }
        } catch {
          // not a bro marketplace clone — keep scanning
        }
      }
    }
  } catch {
    // no marketplaces dir — fall through to absent
  }
  return [{ scope: 'global', ...local }];
}

const MANIFEST_CLIENTS: Record<string, ManifestClientSpec> = {
  claude: {
    installHint: 'claude plugin marketplace add <path-or-repo> && claude plugin install bro@bro',
    probes: claudeProbes,
  },
  codex: {
    installHint: 'codex plugin marketplace add <path-or-repo>, then codex plugin install bro@bro',
    probes: codexProbes,
  },
  cursor: {
    installHint:
      '/add-plugin https://github.com/ThePlenkov/bro in Cursor (Customize → bro), or symlink plugins/cursor/bro to ~/.cursor/plugins/local/bro',
    probes: cursorProbes,
  },
};

/** The manifest clients — listed and doctor-visible, but their install
 *  belongs to their own marketplace machinery. */
export function manifestClientNames(): string[] {
  return Object.keys(MANIFEST_CLIENTS);
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

function stateAt(surface: Surface, scope: PluginScope, reg: Registration | null): InstallState {
  if (surface.kind === 'file') {
    const path = surface.targets[scope];
    if (!existsSync(path)) {
      return 'absent';
    }
    if (surface.artifact === null) {
      return 'present';
    }
    const current = readFileSync(path, 'utf8') === readFileSync(surface.artifact, 'utf8');
    // a matching file with its manifest entry missing is "install me again"
    return current && (reg === null || reg.registered) ? 'installed' : 'stale';
  }
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
  for (const [name, client] of Object.entries(MANIFEST_CLIENTS)) {
    for (const probe of client.probes(cwd, env)) {
      rows.push({ client: name, ...probe });
    }
  }
  return rows;
}

/** `write tmp; rename` — a torn write must never leave a half module.
 *  The tmp file gets umask defaults, so a restrictive existing mode is
 *  copied over before the rename: a 0600 kilo.json carrying permission
 *  rules must not silently widen to 0644. */
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
    const manifest = MANIFEST_CLIENTS[name];
    if (manifest !== undefined) {
      throw new CommandError(
        `clients: "${name}" installs through its own marketplace — ${manifest.installHint}`,
        EXIT.usage
      );
    }
    throw new CommandError(
      `clients: unknown client "${name}" — known: ${[...clientNames(), ...manifestClientNames()].join(', ')}`,
      EXIT.usage
    );
  }
  return client;
}

export function installClient(name: string, scopes: PluginScope[], opts: MutateOpts): Outcome[] {
  const client = knownClient(name);
  const surfaces = client.surfaces(opts.cwd, opts.env);
  const outcomes: Outcome[] = [];
  for (const scope of scopes) {
    for (const [idx, surface] of surfaces.entries()) {
      const owner = idx === 0 ? client : { ...client, registration: undefined };
      outcomes.push(
        surface.kind === 'file'
          ? installOne(name, scope, surface, owner, opts)
          : installBundle(name, scope, surface.files, surface.dirs[scope], opts)
      );
    }
    // a module from an earlier layout is still loaded by the host — it
    // goes when the current layout lands
    for (const legacy of client.legacy?.(opts.cwd, opts.env)[scope] ?? []) {
      const outcome = legacyOutcome(name, scope, legacy, opts);
      if (outcome !== null) {
        outcomes.push(outcome);
      }
    }
  }
  return outcomes;
}

function installOne(
  name: string,
  scope: PluginScope,
  surface: { kind: 'file'; artifact: string | null; targets: Record<PluginScope, string> },
  client: ClientSpec,
  opts: MutateOpts
): Outcome {
  const { artifact, targets } = surface;
  if (artifact === null) {
    throw new CommandError(
      `clients install: cannot resolve the ${name} adapter module`,
      EXIT.error
    );
  }
  const content = readFileSync(artifact, 'utf8');
  const path = targets[scope];
  // registration parses the manifest — a malformed one exits here,
  // before the module file is touched
  const reg = client.registration?.(scope, path, opts.env) ?? null;
  const needsRegistration = reg !== null && !reg.registered;
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (prior === content && !needsRegistration) {
    return { client: name, scope, action: 'current', path };
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
    };
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
    note: needsRegistration ? 'registered in kilo.json' : undefined,
  };
}

/** A bundle surface — a directory of modules installed as one unit. The
 *  outcome path is the directory; a refusal names the file that holds
 *  it. */
function installBundle(
  name: string,
  scope: PluginScope,
  files: SurfaceFile[],
  dir: string,
  opts: MutateOpts
): Outcome {
  const contents = files
    .map(f => ({ name: f.name, content: surfaceBytes(f.artifact) }))
    .filter((c): c is { name: string; content: string } => c.content !== null);
  if (contents.length === 0) {
    throw new CommandError(
      `clients install: cannot resolve the ${name} adapter module`,
      EXIT.error
    );
  }
  // a file already holding the slot that carries no bro sentinel is a
  // foreign plugin under our name — clobbering it needs --force
  for (const c of contents) {
    const path = join(dir, c.name);
    if (!existsSync(path)) {
      continue;
    }
    const prior = readFileSync(path, 'utf8');
    if (prior !== c.content && !isBroAdapter(prior) && !opts.force) {
      return {
        client: name,
        scope,
        action: 'refused',
        path,
        note: 'a foreign file holds this slot — pass --force to overwrite',
      };
    }
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
  for (const c of contents) {
    const path = join(dir, c.name);
    if (existsSync(path) && readFileSync(path, 'utf8') === c.content) {
      continue;
    }
    atomicWrite(path, c.content);
    changed = true;
  }
  return {
    client: name,
    scope,
    action: changed ? (existed ? 'updated' : 'installed') : 'current',
    path: dir,
  };
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
          ? uninstallOne(name, scope, surface, owner, opts)
          : uninstallBundle(name, scope, surface.files, surface.dirs[scope], opts)
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

function uninstallOne(
  name: string,
  scope: PluginScope,
  surface: { kind: 'file'; artifact: string | null; targets: Record<PluginScope, string> },
  client: ClientSpec,
  opts: MutateOpts
): Outcome {
  const path = surface.targets[scope];
  const clean = surfaceBytes(surface.artifact);
  const reg = client.registration?.(scope, path, opts.env) ?? null;
  if (!existsSync(path)) {
    return absentOutcome(name, scope, path, reg, opts.dryRun);
  }
  const wasRegistered = reg?.registered ?? false;
  const prior = readFileSync(path, 'utf8');
  // provably ours = byte-equal to this bro's artifact. A sentinel-only
  // match is a different version or a hand edit — indistinguishable by
  // shape, and deletion is irreversible, so it refuses without --force
  // (sentinel alone only suffices when no artifact resolves to compare)
  const ours = clean === null ? isBroAdapter(prior) : prior === clean;
  if (!opts.force && !ours) {
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
    note: wasRegistered ? 'removed kilo.json entry' : undefined,
  };
}

/** A bundle surface — every module of the directory must be ours before
 *  the directory goes. Files we don't know (a user's own module beside
 *  ours) stay; the directory itself goes only when it is empty. */
function uninstallBundle(
  name: string,
  scope: PluginScope,
  files: SurfaceFile[],
  dir: string,
  opts: MutateOpts
): Outcome {
  if (!existsSync(dir)) {
    return { client: name, scope, action: 'absent', path: dir };
  }
  for (const f of files) {
    const path = join(dir, f.name);
    if (!existsSync(path)) {
      continue;
    }
    const prior = readFileSync(path, 'utf8');
    const clean = surfaceBytes(f.artifact);
    const ours = clean === null ? isBroAdapter(prior) : prior === clean;
    if (!opts.force && !ours) {
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
  }
  if (opts.dryRun) {
    return { client: name, scope, action: 'would-remove', path: dir };
  }
  for (const f of files) {
    const path = join(dir, f.name);
    if (existsSync(path)) {
      rmSync(path);
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // not empty — something of the user's lives here, leave the directory
  }
  return { client: name, scope, action: 'removed', path: dir };
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
      ? `${dryRun ? 'would remove' : 'removed'} dangling kilo.json entry`
      : undefined,
  };
}

function printOutcomes(outcomes: Outcome[]): void {
  for (const o of outcomes) {
    console.log(`${o.client} ${o.scope}: ${o.action} — ${o.path}${o.note ? ` (${o.note})` : ''}`);
  }
}

/** The flags `bro clients install|uninstall` accepts — a mistyped flag
 *  must not be silently dropped: dropping it hides both the typo and
 *  whatever value it was supposed to carry. */
const PLUGIN_FLAGS = new Set(['--global', '--local', '--dry-run', '--force']);

function clientArg(rest: string[]): string {
  const pos = positionals(rest, new Set(), { boolFlags: PLUGIN_FLAGS, strict: true });
  if (pos.length !== 1) {
    throw new CommandError(
      `usage: bro clients install|uninstall <${clientNames().join('|')}> [--global] [--local] [--dry-run] [--force]`,
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

const CLIENTS_USAGE =
  'usage: bro clients [list [--json] | install <client> [--global] [--local] [--dry-run] | uninstall <client> [--global] [--local] [--dry-run] [--force]]';

export function runClientsCommand(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (hasHelpFlag(argv)) {
    printUsage(CLIENTS_USAGE, 0);
  }
  switch (sub) {
    case undefined:
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
        throw new CommandError('clients: refused', EXIT.error);
      }
      return;
    }
    default:
      throw new CommandError(CLIENTS_USAGE, EXIT.usage);
  }
}

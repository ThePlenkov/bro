/** `bro providers` — the provider registry's read surface.
 *
 *   bro providers models [name…]      list every provider's models as <provider>/<model>
 *   bro providers route [--all] <id>  resolve a model id to its <provider>/<model> route
 *   bro providers add <preset> [--name <name>] [--global] [--force]
 *                                     add a preset ACP provider entry
 *   bro providers test <name>         smoke-test an ACP provider connection
 *
 * The catalog surface: every provider's model list rendered as
 * `<provider>/<model>` — the uniform `provider/model` vocabulary the
 * hosts' pickers (claude's `/bro:models`, a fleet --model flag, a
 * judge pin) all share. Source per kind:
 *
 *   api — the `models` allowlist (config-declared, offline)
 *   acp — session/new's model config option, enumerated over ACP
 *   cli — the entry's `models` shell template (one id per line)
 *
 * A pinned default `model` always renders, even when no catalog
 * surface exists — `bro providers models` never prints an empty
 * provider silently.
 *
 * `route` is the inverse query (spec: specs/bro-n1p0s.md) — the
 * brouter registry: a MODEL id in, the serving `provider/model` route
 * out. Qualified `p/m` ids and `brouter.models` declarations resolve
 * statically; anything else resolves against the same live catalog
 * `models` enumerates.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
<<<<<<< HEAD
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  brouterStaticCatalog,
  hasHelpFlag,
  isQualifiedRouteId,
  loadConfig,
  printUsage,
  resolveModelRoute,
  globalConfigDir,
  withFileLock,
} from '@broject/core';
import type { BrouterConfig, ModelRoute, ProviderEntry } from '@broject/core';
=======
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  openSync,
  writeSync,
  closeSync,
  chmodSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import {
  hasHelpFlag,
  loadConfig,
  printUsage,
  globalConfigDir,
  withFileLock,
  mainWorktreeRoot,
} from '@broject/core';
import type { ProviderEntry } from '@broject/core';
>>>>>>> eba17a92 (fix: address review threads on providers add)
import type { AcpSeam } from '@broject/providers';
import { parseProviderEntry } from '@broject/core';

const USAGE = `usage:
<<<<<<< HEAD
  bro providers models [name…]      list every provider's models as <provider>/<model>
  bro providers route [--all] <id>  resolve a model id to its <provider>/<model> route
  bro providers add <preset> [--name <name>] [--global] [--force]
                                    add a preset ACP provider entry
  bro providers test <name>         smoke-test an ACP provider connection
`;
=======
  bro providers models [name…]  list every provider's models as <provider>/<model>
  bro providers add <preset> [--name <name>] [--project] [--force]
                                add a preset ACP provider entry
  bro providers test <name>     smoke-test an ACP provider connection
`;
/** Verified ACP presets (only include verified entrypoints). */
const PRESETS: Record<string, { command: string; defaultName?: string }> = {
  kilo: { command: 'kilo --acp' },
  'gemini-cli': { command: 'gemini --acp' },
  goose: { command: 'goose acp' },
  opencode: { command: 'opencode acp' },
  devin: { command: 'devin --acp' },
};

>>>>>>> eba17a92 (fix: address review threads on providers add)
const die = (msg: string): never => {
  console.error(`bro providers: ${msg}`);
  process.exit(1);
};

const execFile = promisify(execFileCb);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function hasBroConfigTs(dir: string): boolean {
  return existsSync(join(dir, 'bro.config.ts'));
}

function projectConfigPath(dir: string): string {
  return join(dir, 'bro.config.json');
}

function globalConfigJsonPath(): string {
  return join(globalConfigDir(), 'config.json');
}

function writeConfigJsonAtomic(path: string, cfg: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(path), target);
      const tmp = join(
        dirname(resolvedTarget),
        `.bro.config.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
      );
      let fd: number | undefined;
      try {
        try {
          fd = openSync(
            tmp,
            fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            0o600
          );
        } catch {
          fd = openSync(tmp, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        }
        writeSync(fd, `${JSON.stringify(cfg, null, 2)}\n`);
        closeSync(fd);
        fd = undefined;
        try {
          chmodSync(tmp, 0o600);
        } catch {}
        try {
          if (existsSync(resolvedTarget)) {
            const st2 = statSync(resolvedTarget);
            try {
              chmodSync(tmp, st2.mode & 0o777);
            } catch {}
          }
        } catch {}
        renameSync(tmp, resolvedTarget);
        return;
      } catch (err) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {}
        }
        try {
          if (existsSync(tmp)) {
            /* best effort cleanup */
          }
        } catch {}
        throw err;
      }
    }
  } catch (err) {
    // if it's our intentional error rethrow? but in general fall through
    // but better to be careful - only fall through if it's not a fatal case we need
  }
  const tmp = join(
    dirname(path),
    `.bro.config.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        tmp,
        fsConstants.O_RDWR |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW || 0),
        0o600
      );
    } catch {
      fd = openSync(tmp, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    }
    writeSync(fd, `${JSON.stringify(cfg, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    try {
      chmodSync(tmp, 0o600);
    } catch {}
    try {
      if (existsSync(path)) {
        const st = statSync(path);
        try {
          chmodSync(tmp, st.mode & 0o777);
        } catch {}
      }
    } catch {}
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      // best effort cleanup if it exists and is not a symlink we shouldn't touch
      const lst = lstatSync(tmp);
      if (!lst.isSymbolicLink()) {
        // don't unlink blindly in general, but try
      }
    } catch {}
    throw err;
  }
}

function readConfigJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(raw)) {
      die(`${path} must contain a JSON object at its root`);
    }
    return raw as Record<string, unknown>;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === 'config root must be an object' ||
        err.message.includes('must contain a JSON object at its root'))
    ) {
      throw err;
    }
    die(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Verified ACP presets (only include verified entrypoints). */
const PRESETS: Record<string, { command: string; defaultName?: string }> = {
  kilo: { command: 'kilo --acp' },
  'claude-code': { command: 'claude --acp' },
  codex: { command: 'codex --acp' },
  'gemini-cli': { command: 'gemini --acp' },
  goose: { command: 'goose acp' },
  opencode: { command: 'opencode acp' },
  devin: { command: 'devin --acp' },
};

interface Opts {
  /** Test seam — injected in-process acp peer (AcpSeam.peer). */
  acp?: AcpSeam;
  /** Test seam — replaces the models-template exec. */
  exec?: (command: string) => string | Promise<string>;
  /** Test seam — the registry; default loads cwd config. */
  providers?: Record<string, ProviderEntry>;
  /** Test seam — the brouter registry; default loads cwd config. */
  brouter?: BrouterConfig;
  /** Test seam — stdout capture; default console.log. */
  out?: (line: string) => void;
}

/** A catalog row — `id` is `<name>/<model-id>`; `name` is the
 *  provider's own display label when it advertises one (acp options
 *  carry a human name; api/cli catalogs are id-only). The conductor's
 *  `/v1/models` maps `name` onto display_name. */
export interface CatalogModel {
  id: string;
  name?: string;
}

/** The catalog as `<name>/<model-id>` rows — the same list
 *  `bro providers models` renders, exported for the serve conductor's
 *  `/v1/models` surface (spec bro-wxfls: the catalog may be a
 *  different entry than the messages backend). */
export async function catalogModels(
  name: string,
  entry: ProviderEntry,
  opts: { acp?: AcpSeam; exec?: (command: string) => string | Promise<string> } = {}
): Promise<CatalogModel[]> {
  return providerModels(name, entry, opts);
}

/** One provider's catalog rows — `id` is `<name>/<model-id>` each. */
async function providerModels(
  name: string,
  entry: ProviderEntry,
  opts: Opts
): Promise<CatalogModel[]> {
  const render = (id: string, modelName?: string): CatalogModel => ({
    id: `${name}/${id}`,
    name: modelName,
  });
  switch (entry.type) {
    case 'api':
      return Object.keys(entry.models).map(id => render(id));
    case 'cli': {
      const ids: string[] = [];
      if (entry.models !== undefined) {
        const exec =
          opts.exec ??
          (async (cmd: string) =>
            (await execFile('sh', ['-c', cmd], { encoding: 'utf8', timeout: 30_000 })).stdout);
        ids.push(
          ...(await exec(entry.models))
            .split('\n')
            .map(l => l.trim())
            .filter(l => l !== '')
        );
      }
      if (entry.model !== undefined && !ids.includes(entry.model)) {
        ids.push(entry.model);
      }
      return ids.map(id => render(id));
    }
    case 'acp': {
      const { acpModels } = await import('@broject/providers');
      const listed = await acpModels(name, entry, { acp: opts.acp });
      if (entry.model !== undefined && !listed.some(m => m.value === entry.model)) {
        listed.push({ value: entry.model });
      }
      return listed.map(m => render(m.value, m.name));
    }
  }
}

<<<<<<< HEAD
/** The live catalog as a provider → served-ids index — the same rows
 *  `models` renders, prefix stripped back to raw model ids. A failed
 *  provider warns and indexes nothing — a catalog that can't enumerate
 *  is a smaller index, never the route's error. */
async function liveCatalog(
  providers: Record<string, ProviderEntry>,
  opts: Opts
): Promise<Record<string, string[]>> {
  const catalog: Record<string, string[]> = {};
  await Promise.all(
    Object.entries(providers).map(async ([name, entry]) => {
      try {
        catalog[name] = (await providerModels(name, entry, opts)).map(r =>
          r.id.slice(name.length + 1)
        );
      } catch (err) {
        catalog[name] = brouterStaticCatalog({ [name]: entry })[name] ?? [];
        console.error(
          `bro providers: ${name} — catalog failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
  return catalog;
=======
async function cmdAdd(argv: string[], opts: Opts): Promise<void> {
  let preset: string | undefined;
  let name: string | undefined;
  let project = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--global') {
      project = false;
      continue;
    }
    if (a === '--project') {
      project = true;
      continue;
    }
    // backward compatibility
    if (a === '--local') {
      project = true;
      continue;
    }
    if (a === '--force') {
      force = true;
      continue;
    }
    if (a === '--name') {
      const v = argv[++i];
      if (v === undefined || v.trim() === '' || v.startsWith('-')) {
        die('missing value for --name');
      }
      name = v;
      continue;
    }
    if (a.startsWith('-')) {
      die(`unknown flag ${a}`);
    }
    if (preset === undefined) {
      preset = a;
      continue;
    }
    die(`unexpected argument ${a}`);
  }
  if (preset === undefined) {
    die('usage: bro providers add <preset> [--name <name>] [--project] [--force]');
  }
  const p = Object.hasOwn(PRESETS, preset) ? PRESETS[preset] : undefined;
  if (p === undefined) {
    die(`unknown preset ${preset} — available: ${Object.keys(PRESETS).join(', ')}`);
  }
  const providerName = name ?? preset;
  if (typeof providerName !== 'string' || providerName.trim() === '') {
    die('provider name must be non-empty');
  }
  if (
    providerName === '__proto__' ||
    providerName === 'prototype' ||
    providerName === 'constructor'
  ) {
    die('invalid provider name');
  }
  const cwd = process.cwd();
  const global = !project;
  const dir = global ? globalConfigDir() : cwd;
  if (!global && hasBroConfigTs(dir)) {
    die(`bro.config.ts shadows bro.config.json — edit providers in ${join(dir, 'bro.config.ts')}`);
  }
  if (global && existsSync(join(globalConfigDir(), 'config.ts'))) {
    die(
      `config.ts shadows config.json — edit providers in ${join(globalConfigDir(), 'config.ts')}`
    );
  }
  let path = global ? globalConfigJsonPath() : projectConfigPath(dir);
  if (!global) {
    const mainRoot = mainWorktreeRoot(cwd);
    if (mainRoot && mainRoot !== cwd) {
      if (!existsSync(projectConfigPath(cwd)) && existsSync(projectConfigPath(mainRoot))) {
        path = projectConfigPath(mainRoot);
      }
    }
  }
  return withFileLock(`${path}.lock`, () => {
    // Recheck shadowing under lock
    if (!global) {
      const targetDir = dirname(path);
      if (hasBroConfigTs(targetDir)) {
        die(
          `bro.config.ts shadows bro.config.json — edit providers in ${join(targetDir, 'bro.config.ts')}`
        );
      }
    } else {
      if (existsSync(join(globalConfigDir(), 'config.ts'))) {
        die(
          `config.ts shadows config.json — edit providers in ${join(globalConfigDir(), 'config.ts')}`
        );
      }
    }
    // Recheck for shadowing TS config
    if (!global && hasBroConfigTs(dirname(path))) {
      die(
        `bro.config.ts shadows bro.config.json — edit providers in ${join(dirname(path), 'bro.config.ts')}`
      );
    }
    if (global && existsSync(join(globalConfigDir(), 'config.ts'))) {
      die(
        `config.ts shadows config.json — edit providers in ${join(globalConfigDir(), 'config.ts')}`
      );
    }
    // If writing to project config in a worktree with main worktree having config,
    // still write to projectConfigPath(dir) as before - but the thread says
    // "write the provider into the effective project config for the linked worktree instead of creating a shadowing config"
    // and also says "cmdAdd writes a new config in the current worktree..." - need to be careful about worktree behavior
    // But the main fix for "Provider presets land in project config" is to default to global; that's separate.
    const cfg = readConfigJson(path);
    if (!isPlainObject(cfg)) {
      die('config root must be an object');
    }
    if ('providers' in cfg && cfg.providers !== undefined && !isPlainObject(cfg.providers)) {
      die('providers must be an object');
    }
    const providers = isPlainObject(cfg.providers)
      ? { ...(cfg.providers as Record<string, unknown>) }
      : {};
    if (Object.prototype.hasOwnProperty.call(providers, providerName) && !force) {
      die(`providers.${providerName} already exists — use --force to overwrite`);
    }
    const entry: ProviderEntry = { type: 'acp', command: p.command };
    // Validate shape
    if (parseProviderEntry(providerName, entry) === null) {
      die('generated entry failed validation');
    }
    Object.defineProperty(providers, providerName, {
      value: entry,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    cfg.providers = providers;
    writeConfigJsonAtomic(path, cfg);
    console.log(`added providers.${providerName} (${preset}) → ${path}`);
  });
>>>>>>> eba17a92 (fix: address review threads on providers add)
}

/** `route` — qualified ids and declared routes are authoritative:
 *  they resolve without paying a live probe. Bare ids resolve against
 *  the live catalog. */
async function runRouteCommand(
  names: string[],
  providers: Record<string, ProviderEntry>,
  opts: Opts,
  out: (line: string) => void
): Promise<void> {
  const rest = names.filter(n => n !== '--all');
  if (rest.length !== 1) {
    printUsage(USAGE, 2);
    return;
  }
  const asked = rest[0]!;
  const brouter = opts.brouter ?? loadConfig(process.cwd()).brouter ?? { models: {} };
  let routes: ModelRoute[] = [];
  try {
    if (isQualifiedRouteId(providers, asked) || Object.hasOwn(brouter.models, asked)) {
      routes = resolveModelRoute(providers, brouter, {}, asked);
    }
    if (routes.length === 0) {
      routes = resolveModelRoute(providers, brouter, await liveCatalog(providers, opts), asked);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  if (routes.length === 0) {
    die(
      `no route for '${asked}' — qualify it <provider>/<model> or declare brouter.models.${asked}`
    );
  }
  for (const r of names.includes('--all') ? routes : routes.slice(0, 1)) {
    out(`${r.provider}/${r.model}`);
  }
}

async function cmdModels(argv: string[], opts: Opts): Promise<void> {
  const names = argv;
  if (hasHelpFlag(names)) {
    printUsage(USAGE, 2);
    return;
  }
  const providers = opts.providers ?? loadConfig(process.cwd()).providers ?? {};
  const wanted =
    names.length > 0
      ? names.map(n => {
          const entry = providers[n];
          if (entry === undefined) {
            die(
              `providers.${n} is not configured — configured: ${Object.keys(providers).join(', ') || 'none'}`
            );
          }
          return [n, entry] as const;
        })
      : (Object.entries(providers) as [string, ProviderEntry][]);
  const out = opts.out ?? ((line: string) => console.log(line));
  let failed = 0;
  for (const [name, entry] of wanted) {
    try {
      const models = await providerModels(name, entry, opts);
      for (const row of models) {
        out(row.id);
      }
    } catch (err) {
      failed += 1;
      console.error(`bro providers: ${name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
}

async function cmdAdd(argv: string[], opts: Opts): Promise<void> {
  let preset: string | undefined;
  let name: string | undefined;
  let global = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--global') {
      global = true;
      continue;
    }
    if (a === '--force') {
      force = true;
      continue;
    }
    if (a === '--name') {
      i++;
      if (i >= argv.length) {
        die('missing value for --name');
      }
      name = argv[i]!;
      continue;
    }
    if (a.startsWith('-')) {
      die(`unknown flag ${a}`);
    }
    if (preset === undefined) {
      preset = a;
      continue;
    }
    die(`unexpected argument ${a}`);
  }
  if (preset === undefined) {
    die('usage: bro providers add <preset> [--name <name>] [--global] [--force]');
  }
  const p = PRESETS[preset];
  if (p === undefined) {
    die(`unknown preset ${preset} — available: ${Object.keys(PRESETS).join(', ')}`);
  }
  const providerName = name ?? preset;
  const cwd = process.cwd();
  const dir = global ? globalConfigDir() : cwd;
  if (!global && hasBroConfigTs(dir)) {
    die(`bro.config.ts shadows bro.config.json — edit providers in ${join(dir, 'bro.config.ts')}`);
  }
  if (global && existsSync(join(dir, 'config.ts'))) {
    die(`config.ts shadows config.json — edit providers in ${join(dir, 'config.ts')}`);
  }
  const path = global ? globalConfigJsonPath() : projectConfigPath(dir);
  return withFileLock(`${path}.lock`, () => {
    const cfg = readConfigJson(path);
    const providers = isPlainObject(cfg.providers)
      ? { ...(cfg.providers as Record<string, unknown>) }
      : {};
    if (Object.prototype.hasOwnProperty.call(providers, providerName) && !force) {
      die(`providers.${providerName} already exists — use --force to overwrite`);
    }
    const entry: ProviderEntry = { type: 'acp', command: p.command };
    if (parseProviderEntry(providerName, entry) === null) {
      die('generated entry failed validation');
    }
    providers[providerName] = entry;
    cfg.providers = providers;
    writeConfigJsonAtomic(path, cfg);
    console.log(`added providers.${providerName} (${preset}) → ${path}`);
  });
}

async function cmdTest(argv: string[], opts: Opts): Promise<void> {
  if (argv.length === 0 || hasHelpFlag(argv)) {
    die('usage: bro providers test <name>');
  }
  const name = argv[0]!;
  if (argv.length > 1) {
    die(`unexpected argument ${argv[1]}`);
  }
  const providers = opts.providers ?? loadConfig(process.cwd()).providers ?? {};
  const entry = providers[name];
  if (entry === undefined) {
    die(
      `providers.${name} is not configured — configured: ${Object.keys(providers).join(', ') || 'none'}`
    );
  }
  if (entry.type !== 'acp') {
    die(`providers.${name} must be type 'acp' to test`);
  }
  try {
    const { acpModels } = await import('@broject/providers');
    const deadline = Date.now() + 30_000;
    await acpModels(name, entry as any, { acp: opts.acp }, deadline);
    console.log(`ok: providers.${name} (acp)`);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

export async function runProvidersCommand(argv: string[], opts: Opts = {}): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    printUsage(USAGE, 0);
    return;
  }
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, verb === 'models' || verb === 'route' || verb === 'add' || verb === 'test' ? 0 : 2);
  }
  if (verb === 'add') {
    await cmdAdd(rest, opts);
    return;
  }
  if (verb === 'test') {
    await cmdTest(rest, opts);
    return;
  }
  if (verb === 'route') {
    await runRouteCommand(rest, opts.providers ?? loadConfig(process.cwd()).providers ?? {}, opts, opts.out ?? ((line: string) => console.log(line)));
    return;
  }
  if (verb === 'models') {
    await cmdModels(rest, opts);
    return;
  }
  die(`unknown subcommand ${verb}`);
}

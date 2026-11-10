/** `bro providers` — the provider registry's read surface.
 *
 *   bro providers models [name…]      list every provider's models as <provider>/<model>
 *   bro providers route [--all] <id>  resolve a model id to its <provider>/<model> route
 *   bro providers add <preset> [--name <name>] [--global] [--force]
 *                                     add a preset ACP provider entry
 *   bro providers test <name>         smoke-test an ACP provider connection
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  brouterStaticCatalog,
  hasHelpFlag,
  isQualifiedRouteId,
  loadConfig,
  printUsage,
  resolveModelRoute,
  globalConfigDir,
  withFileLock,
  CommandError,
  EXIT,
} from '@broject/core';
import type { BrouterConfig, ModelRoute, ProviderEntry } from '@broject/core';
import type { AcpSeam } from '@broject/providers';
import { parseProviderEntry } from '@broject/core';

const USAGE = `usage:
  bro providers models [name…]      list every provider's models as <provider>/<model>
  bro providers route [--all] <id>  resolve a model id to its <provider>/<model> route
  bro providers add <preset> [--name <name>] [--global] [--force]
                                    add a preset ACP provider entry
  bro providers test <name>         smoke-test an ACP provider connection
`;
const die = (msg: string): never => {
  throw new CommandError(`bro providers: ${msg}`, EXIT.error);
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

// per-process counter — pid+ms alone collide when two writes land in the
// same millisecond, and 'wx' below turns that collision into an EEXIST
// that must not delete the other write's tmp
let tmpCounter = 0;

function writeConfigJsonAtomic(path: string, cfg: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.bro.config.json.tmp.${process.pid}.${Date.now()}.${tmpCounter++}`
  );
  try {
    // 'wx' (O_CREAT|O_EXCL) + 0600 — a predictable tmp name must never
    // follow a pre-existing symlink into an attacker-chosen file
    writeFileSync(
      tmp,
      `${JSON.stringify(cfg, null, 2)}
`,
      { flag: 'wx', mode: 0o600 }
    );
    renameSync(tmp, path);
  } catch (err) {
    // an EEXIST means the tmp belongs to someone else — never rm a file
    // this call did not create
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
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
      die(`${path}: root must be an object`);
    }
    return raw;
  } catch (err) {
    return die(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const PRESETS: Record<string, { command: string }> = {
  kilo: { command: 'kilo --acp' },
  'claude-code': { command: 'claude --acp' },
  codex: { command: 'codex --acp' },
  'gemini-cli': { command: 'gemini --acp' },
  goose: { command: 'goose acp' },
  opencode: { command: 'opencode acp' },
  devin: { command: 'devin --acp' },
};

interface Opts {
  acp?: AcpSeam;
  exec?: (command: string) => string | Promise<string>;
  providers?: Record<string, ProviderEntry>;
  brouter?: BrouterConfig;
  out?: (line: string) => void;
  /** The catalog read's budget — absolute ms. Absent keeps the 30s the
   *  acp catalog has always had; a caller that OWNS a budget (the serve
   *  conductor, whose lane carries the operator's timeout) passes its
   *  own, so a slow agent is bounded by the lane's deadline and not by a
   *  constant baked into the provider layer. */
  deadline?: number;
}

export interface CatalogModel {
  id: string;
  name?: string;
}

export async function catalogModels(
  name: string,
  entry: ProviderEntry,
  opts: {
    acp?: AcpSeam;
    exec?: (command: string) => string | Promise<string>;
    /** The read's budget — absolute ms; absent keeps the 30s default. */
    deadline?: number;
  } = {}
): Promise<CatalogModel[]> {
  return providerModels(name, entry, opts);
}

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
        // async exec — the conductor serves this path on /v1/models and a
        // sync spawn would stall the event loop; the timeout matches the
        // acp catalog's bound, or the caller's own deadline when it has one
        const budget =
          opts.deadline === undefined
            ? 30_000
            : Math.min(2_147_483_647, Math.max(1, opts.deadline - Date.now()));
        const exec =
          opts.exec ??
          (async (cmd: string) =>
            (await execFile('sh', ['-c', cmd], { encoding: 'utf8', timeout: budget })).stdout); // NOSONAR — operator-configured models template, same contract as command
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
      // the deadline rides in — a lane's budget bounds its own catalog read
      const listed = await acpModels(name, entry, { acp: opts.acp }, opts.deadline);
      if (entry.model !== undefined && !listed.some(m => m.value === entry.model)) {
        listed.push({ value: entry.model });
      }
      return listed.map(m => render(m.value, m.name));
    }
  }
}

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
}

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
    throw new CommandError('bro providers: failed to list some models', EXIT.error);
  }
}

interface ParsedAdd {
  preset?: string;
  name?: string;
  global: boolean;
  force: boolean;
}

function parseAddArgs(argv: string[]): ParsedAdd {
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
      if (i >= argv.length) die('missing value for --name');
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
  return { preset, name, global, force };
}

/** Shadow check for `bro providers add` — returns the conflicting
 *  .ts path when a TypeScript config would shadow the .json write. */
function addConfigShadow(global: boolean, dir: string): string | undefined {
  if (!global && hasBroConfigTs(dir)) {
    return join(dir, 'bro.config.ts');
  }
  if (global && existsSync(join(dir, 'config.ts'))) {
    return join(dir, 'config.ts');
  }
  return undefined;
}

function getAddConfigPath(global: boolean): string {
  const dir = global ? globalConfigDir() : process.cwd();
  return global ? globalConfigJsonPath() : projectConfigPath(dir);
}

async function cmdAdd(argv: string[], opts: Opts): Promise<void> {
  const parsed = parseAddArgs(argv);
  if (parsed.preset === undefined) {
    die('usage: bro providers add <preset> [--name <name>] [--global] [--force]');
  }
  const presetName = parsed.preset!;
  const p = PRESETS[presetName];
  if (p === undefined) {
    die(`unknown preset ${presetName} — available: ${Object.keys(PRESETS).join(', ')}`);
  }
  const providerName = parsed.name ?? presetName;
  if (!/^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9][\w.-]*$/.test(providerName)) {
    die(
      `unsafe provider name ${JSON.stringify(providerName)} — use [A-Za-z0-9._-], not __proto__/constructor/prototype`
    );
  }
  const dir = parsed.global ? globalConfigDir() : process.cwd();
  const shadow = addConfigShadow(parsed.global, dir);
  if (shadow !== undefined) {
    die(
      `${basename(shadow)} shadows ${basename(shadow, '.ts')}.json — edit providers in ${shadow}`
    );
  }
  const path = getAddConfigPath(parsed.global);
  return withFileLock(`${path}.lock`, () => {
    const cfg = readConfigJson(path);
    const providers = isPlainObject(cfg.providers)
      ? { ...(cfg.providers as Record<string, unknown>) }
      : {};
    if (Object.prototype.hasOwnProperty.call(providers, providerName) && !parsed.force) {
      die(`providers.${providerName} already exists — use --force to overwrite`);
    }
    const entry: ProviderEntry = { type: 'acp', command: p.command };
    if (parseProviderEntry(providerName, entry) === null) {
      die('generated entry failed validation');
    }
    providers[providerName] = entry;
    cfg.providers = providers;
    writeConfigJsonAtomic(path, cfg);
    console.log(`added providers.${providerName} (${parsed.preset}) → ${path}`);
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
    await acpModels(name, entry as any, { acp: opts.acp });
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
    printUsage(USAGE, 0);
  }
  if (verb === 'add') {
    await cmdAdd(rest, opts);
    return;
  }
  if (verb === 'test') {
    await cmdTest(rest, opts);
    return;
  }
  const providers = opts.providers ?? loadConfig(process.cwd()).providers ?? {};
  const out = opts.out ?? ((line: string) => console.log(line));
  if (verb === 'route') {
    await runRouteCommand(rest, providers, opts, out);
    return;
  }
  if (verb === 'models') {
    await cmdModels(rest, opts);
    return;
  }
  die(`unknown subcommand ${verb}`);
}

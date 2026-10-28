/** `bro providers` — the provider registry's read surface.
 *
 *   bro providers models [name…]
 *   bro providers route [--all] <model>
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
import {
  brouterStaticCatalog,
  hasHelpFlag,
  isQualifiedRouteId,
  loadConfig,
  printUsage,
  resolveModelRoute,
} from '@broject/core';
import type { BrouterConfig, ModelRoute, ProviderEntry } from '@broject/core';
import type { AcpSeam } from '@broject/providers';

const USAGE = `usage:
  bro providers models [name…]      list every provider's models as <provider>/<model>
  bro providers route [--all] <id>  resolve a model id to its <provider>/<model> route
`;
const die = (msg: string): never => {
  console.error(`bro providers: ${msg}`);
  process.exit(1);
};

const execFile = promisify(execFileCb);

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
      // the allowlist IS the catalog — a model not declared can't run
      return Object.keys(entry.models).map(id => render(id));
    case 'cli': {
      const ids: string[] = [];
      if (entry.models !== undefined) {
        // async exec — the conductor serves this path on /v1/models and a
        // sync spawn would stall the event loop; the timeout matches the
        // acp catalog's 30s bound
        const exec =
          opts.exec ??
          (async (cmd: string) =>
            (await execFile('sh', ['-c', cmd], { encoding: 'utf8', timeout: 30_000 })).stdout); // NOSONAR — operator-configured models template, same contract as command
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
        // statically-known ids still route — a probe failure shrinks the
        // live index, it never drops an api allowlist or a pinned model
        catalog[name] = brouterStaticCatalog({ [name]: entry })[name] ?? [];
        console.error(
          `bro providers: ${name} — catalog failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
  return catalog;
}

/** `route` — qualified ids and declared routes are authoritative:
 *  they resolve without paying a live probe. Bare ids resolve against
 *  the live catalog (which subsumes the static index — pins append on
 *  every kind, api allowlists ARE the api catalog, and a failed probe
 *  falls back to the static ids) so `--all` still reports every
 *  candidate the live catalog would serve (spec: specs/bro-n1p0s.md). */
async function runRouteCommand(
  names: string[],
  providers: Record<string, ProviderEntry>,
  opts: Opts,
  out: (line: string) => void
): Promise<void> {
  const rest = names.filter(n => n !== '--all');
  if (rest.length !== 1) {
    printUsage(USAGE, 2);
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

export async function runProvidersCommand(argv: string[], opts: Opts = {}): Promise<void> {
  const [verb, ...names] = argv;
  if ((verb !== 'models' && verb !== 'route') || hasHelpFlag(names)) {
    printUsage(USAGE, verb === undefined || hasHelpFlag(argv) ? 0 : 2);
  }
  const providers = opts.providers ?? loadConfig(process.cwd()).providers ?? {};
  const out = opts.out ?? ((line: string) => console.log(line));
  if (verb === 'route') {
    await runRouteCommand(names, providers, opts, out);
    return;
  }

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
  let failed = 0;
  for (const [name, entry] of wanted) {
    try {
      for (const row of await providerModels(name, entry, opts)) {
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

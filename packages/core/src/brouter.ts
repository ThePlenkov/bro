/**
 * brouter — the model-centric provider routing registry (spec:
 * specs/bro-n1p0s.md). Model ids are the routing key: a consumer asks
 * for a MODEL and the registry answers which `providers.<name>` serves
 * it — the inverse of today's provider-first selection
 * (`agents.<backend>.provider`, `fleet.routing` chains).
 *
 * Three sources, first hit wins: qualified `provider/model` ids (head
 * must be a configured provider), `brouter.models` declarations, and
 * the catalog index (who advertises the id — caller-supplied, since
 * live enumeration is a CLI-side probe the spawn path never pays).
 *
 * Core holds types + the pure resolver — no IO. Live catalog
 * enumeration (cli `models` templates, acp `configOptions`) stays in
 * the CLI layer; `brouterStaticCatalog` is the offline face.
 */
import type { ProviderEntry } from './providers.ts';

/** One declared route — the provider pick plus the upstream model id
 *  it serves. `model` absent = the registry key verbatim (the bare
 *  provider-name shorthand). */
export interface BrouterRoute {
  provider: string;
  model?: string;
}

/** `brouter.models` normalized — every entry an ordered candidate
 *  list; list order is preference order, [0] the primary pick. */
export type BrouterModels = Record<string, BrouterRoute[]>;

/** The `brouter` config section — `models` is the whole registry. */
export interface BrouterConfig {
  models: BrouterModels;
}

/** A declared route named a provider no entry resolves to — a config
 *  error naming the brouter key, never a skipped entry. */
export class BrouterConfigError extends Error {
  constructor(key: string, providerName: string) {
    super(
      `brouter.models.${key} — providers.${providerName} is not configured — ` +
        'name a configured provider entry'
    );
    this.name = 'BrouterConfigError';
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `{provider, model?}` route form — `provider` is required, a
 *  present-but-bad `model` drops the field, not the route. */
function routeObject(at: string, v: Record<string, unknown>): BrouterRoute | null {
  const provider = str(v.provider);
  if (provider === undefined) {
    console.error(`bro.config: brouter.models.${at} requires "provider" — route dropped`);
    return null;
  }
  const model = v.model === undefined ? undefined : str(v.model);
  if (v.model !== undefined && model === undefined) {
    console.error(
      `bro.config: brouter.models.${at}.model must be a non-empty string — field dropped`
    );
  }
  return model === undefined ? { provider } : { provider, model };
}

/** One route value — `"<provider>"` or `{provider, model?}`. Bad
 *  entries drop with a warning; a key whose routes all dropped falls
 *  out of the registry (providers.ts' field-vs-entry convention). */
function routeEntry(at: string, v: unknown): BrouterRoute | null {
  if (typeof v === 'string' && v.trim() !== '') {
    return { provider: v.trim() };
  }
  if (isPlainObject(v)) {
    return routeObject(at, v);
  }
  console.error(
    `bro.config: brouter.models.${at} must be a provider name or {provider, model} — route dropped`
  );
  return null;
}

/** One registry key's route list — `v` is a route value or an ordered
 *  array of them; a key whose routes all dropped leaves the registry. */
function routeList(key: string, v: unknown): BrouterRoute[] | null {
  const routes = (Array.isArray(v) ? v : [v])
    .map((e, i) => routeEntry(Array.isArray(v) ? `${key}[${i}]` : key, e))
    .filter((r): r is BrouterRoute => r !== null);
  if (routes.length === 0) {
    console.error(`bro.config: brouter.models.${key} has no usable routes — entry dropped`);
    return null;
  }
  return routes;
}

/** The section's `models` bag after shape checks — a malformed
 *  `brouter` or `brouter.models` warns and yields undefined (sections
 *  parse independently; the absent registry is 'off', not an error). */
function modelsBag(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) {
      console.error('bro.config: brouter must be an object — section dropped');
    }
    return {};
  }
  if (raw.models !== undefined && !isPlainObject(raw.models)) {
    console.error('bro.config: brouter.models must be an object — field dropped');
    return {};
  }
  return isPlainObject(raw.models) ? raw.models : {};
}

/** `brouter` section parse — shape only; route providers resolve
 *  against `providers` at use (sections parse independently — an
 *  unknown name is a use-time config error naming the model key, same
 *  rule as `fleet.routing` chain entries). */
export function parseBrouter(raw: unknown): BrouterConfig {
  const models: BrouterModels = {};
  for (const [id, v] of Object.entries(modelsBag(raw))) {
    const key = id.trim();
    if (key === '') {
      console.error('bro.config: brouter.models keys must be non-empty model ids — entry dropped');
      continue;
    }
    const routes = routeList(key, v);
    if (routes === null) {
      continue;
    }
    // defineProperty, not assignment — a model id like '__proto__'
    // must land as an own key, never trigger the prototype setter
    // (same guard as providers' model ids)
    Object.defineProperty(models, key, {
      value: routes,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { models };
}

/** The registry's offline catalog — every model id statically known
 *  to be served: the api kind's allowlist keys, plus each entry's
 *  pinned `model`. Live surfaces (cli `models` template, acp session
 *  options) are a CLI-side probe — the spawn path resolves on this
 *  index so a spawn never pays a catalog call. */
export function brouterStaticCatalog(
  providers: Record<string, ProviderEntry>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(providers)) {
    const ids = entry.type === 'api' ? Object.keys(entry.models) : [];
    if (entry.model !== undefined && !ids.includes(entry.model)) {
      ids.push(entry.model);
    }
    out[name] = ids;
  }
  return out;
}

/** A resolved route — the provider pick and the upstream model id it
 *  serves (the asked id verbatim unless the route rewrote it).
 *  Provenance records THIS model, never the alias. */
export interface ModelRoute {
  provider: string;
  model: string;
}

/** The source-1 test — `asked` is `<provider>/<model>` with a
 *  configured provider head and a non-empty model tail. Callers that
 *  short-circuit static sources use this to know a qualified hit is
 *  guaranteed without resolving. */
export function isQualifiedRouteId(
  providers: Record<string, ProviderEntry>,
  asked: string
): boolean {
  const slash = asked.indexOf('/');
  return slash > 0 && slash < asked.length - 1 && Object.hasOwn(providers, asked.slice(0, slash));
}

/** Model → ordered route candidates. Sources, first hit wins:
 *
 *  1. qualified `<provider>/<model>` — head is a configured provider;
 *     the route is verbatim (provider-side validation judges
 *     servability downstream). A head that isn't configured is not a
 *     qualifier — vendor-namespaced ids (`opencode/x`, `kilo/orca/…`)
 *     fall through to the bare-id sources.
 *  2. `brouter.models.<id>` — its declared order; a route naming an
 *     unconfigured provider throws BrouterConfigError naming the key.
 *  3. the catalog — providers serving the id exactly, in `providers`
 *     insertion order.
 *
 *  Empty = unresolved — the caller owns the verdict (a read surface
 *  reports it, a spawn path falls back to label provenance). */
export function resolveModelRoute(
  providers: Record<string, ProviderEntry>,
  brouter: BrouterConfig | undefined,
  catalog: Record<string, string[]>,
  asked: string
): ModelRoute[] {
  const slash = asked.indexOf('/');
  if (isQualifiedRouteId(providers, asked)) {
    return [{ provider: asked.slice(0, slash), model: asked.slice(slash + 1) }];
  }
  if (brouter !== undefined && Object.hasOwn(brouter.models, asked)) {
    return brouter.models[asked]!.map((r, i) => {
      if (!Object.hasOwn(providers, r.provider)) {
        const at = brouter.models[asked]!.length > 1 ? `${asked}[${i}]` : asked;
        throw new BrouterConfigError(at, r.provider);
      }
      return { provider: r.provider, model: r.model ?? asked };
    });
  }
  return Object.keys(providers)
    .filter(name => (catalog[name] ?? []).includes(asked))
    .map(provider => ({ provider, model: asked }));
}
